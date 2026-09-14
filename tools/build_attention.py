"""Precompute GPT-2 attention for the two canned sentences in the attention chapter.

Run with `npm run data:attention` (needs the venv: `python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`).
Writes site/data/attention.json:

  { "model": "gpt2", "layers": 12, "heads": 12,
    "sentences": [ { "text": "...", "tokens": ["The", " patient", ...],
                     "highlights": [ { "from": 7, "to": 5, "layer": 7, "head": 8, "weight": 0.703, "argmax": true,
                                       "row": [...], "mean_row": [...] } ] } ] }

For each highlight (a pronoun or verb and the earlier word it should point back to) we search every head in layers
MIN_LAYER and up for the one where the `from` token puts the most attention on the `to` token. Layers 0-1 are skipped:
their heads mostly track position and the first token, so a high weight there is not the "looking back at the noun"
behaviour the chapter is about. `row` is that head's full attention row for `from` (so the UI can draw an arc to
every earlier token); `mean_row` is the same row averaged over the layer's heads; `argmax` says whether `to` is the
token that row attends to most. A highlight whose best weight is under WEAK_BELOW is kept but flagged `"weak": true`.
Indices are 0-based.

Candidate mode: `.venv/bin/python tools/build_attention.py --candidates ["<sentence>::from>to[,from>to]" ...]`
evaluates the built-in CANDIDATES (plus any given on the command line) without writing anything, and prints a table
of the best (layer, head, weight) per highlight and whether `to` is the argmax of that row. Use it to pick sentences
where GPT-2 resolves the reference clearly before adding them to SENTENCES.
"""
import json
import sys
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "gpt2"
WEAK_BELOW = 0.3
MIN_LAYER = 2
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "attention.json"

# (sentence, [(from_word, to_word), ...]). Fictional, PHI-free.
SENTENCES = [
    ("The patient stopped taking her medication because it made her dizzy.",
     [("it", "medication"), ("her", "patient")]),
    # Chosen with --candidates: GPT-2 puts 0.64 of "she"'s attention on "mother" (layer 5, head 10) and that is the
    # row's argmax; the earlier "The nurse gave the child an inhaler, and she..." only reached 0.18 in layers >= 2.
    ("After the pharmacist explained the dose, the mother said she understood.",
     [("she", "mother")]),
]

# Sentences tried for slot 2 with `--candidates`; the first entry is the current sentence 2 for reference.
CANDIDATES = [
    ("The nurse gave the child an inhaler, and she began breathing more easily.", [("she", "child")]),
    ("The doctor handed the boy his inhaler, and he began breathing more easily.", [("he", "boy")]),
    ("The nurse gave the child an inhaler because she was wheezing.", [("she", "child")]),
    ("After the pharmacist explained the dose, the mother said she understood.", [("she", "mother")]),
    ("The surgeon called the patient because he had missed his appointment.", [("he", "patient")]),
    ("The pharmacist told the patient that his prescription was ready.", [("his", "patient")]),
    ("The child took the medicine, and it tasted terrible.", [("it", "medicine")]),
    ("The nurse checked the patient's blood pressure because it had been high.", [("it", "pressure")]),
]


def load():
    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL, attn_implementation="eager", output_attentions=True)
    model.eval()
    return tokenizer, model


def word_spans(tokens):
    """Group token indices into words: a token starting with a space (or the first token) begins a new word."""
    spans, current = [], []
    for i, tok in enumerate(tokens):
        if (tok.startswith(" ") or i == 0) and current:
            spans.append(current)
            current = []
        current.append(i)
    if current:
        spans.append(current)
    return spans


def find_word(tokens, spans, word, after=-1):
    """First span (starting after index `after`) whose joined, stripped, de-punctuated text equals `word`."""
    for span in spans:
        if span[0] <= after:
            continue
        text = "".join(tokens[i] for i in span).strip().strip(".,;:!?'\"")
        if text == word or text.rstrip("'s") == word:
            return span
    raise SystemExit(f"could not find the word {word!r} in {tokens}")


def r3(x):
    return round(float(x), 3)


def analyze(tokenizer, model, text, pairs):
    """Run GPT-2 on `text`; return (tokens, highlights) with the best head per (from, to) pair in layers >= MIN_LAYER."""
    enc = tokenizer(text, return_tensors="pt")
    with torch.no_grad():
        out = model(**enc)
    # out.attentions: tuple(layers) of [batch, heads, seq, seq]
    attn = torch.stack([a[0] for a in out.attentions])  # [layers, heads, seq, seq]
    # convert_tokens_to_string undoes GPT-2's byte-level markers (e.g. 'Ġ' → ' ') the same way decode() does.
    tokens = [tokenizer.convert_tokens_to_string([t]) for t in tokenizer.convert_ids_to_tokens(enc["input_ids"][0])]
    spans = word_spans(tokens)
    highlights = []
    for from_word, to_word in pairs:
        to_span = find_word(tokens, spans, to_word)
        from_span = find_word(tokens, spans, from_word, after=to_span[-1])
        frm = from_span[-1]  # the last piece of a split word has seen the whole word
        best = None
        for layer in range(MIN_LAYER, attn.shape[0]):
            for head in range(attn.shape[1]):
                for to in to_span:
                    w = attn[layer, head, frm, to].item()
                    if best is None or w > best[0]:
                        best = (w, layer, head, to)
        weight, layer, head, to = best
        row = attn[layer, head, frm]
        h = {
            "from": frm, "to": to, "layer": layer, "head": head, "weight": r3(weight),
            "argmax": int(row.argmax().item()) == to,
            "row": [r3(x) for x in row.tolist()], "mean_row": [r3(x) for x in attn[layer, :, frm].mean(dim=0).tolist()],
            "_from_word": from_word, "_to_word": to_word,
        }
        if weight < WEAK_BELOW:
            h["weak"] = True
        highlights.append(h)
    return tokens, highlights, attn.shape


def describe(h):
    return (f"{h['_from_word']!r:>12} -> {h['_to_word']!r:<12} layer {h['layer']:2d} head {h['head']:2d} "
            f"weight {h['weight']:.3f}  argmax={'yes' if h['argmax'] else 'no '}{'  (weak)' if h.get('weak') else ''}")


def strip_private(h):
    return {k: v for k, v in h.items() if not k.startswith("_")}


def parse_candidate(spec):
    """'<sentence>::from>to[,from>to]' → (sentence, [(from, to), ...])."""
    text, _, pairs = spec.partition("::")
    if not pairs:
        raise SystemExit(f"candidate {spec!r} needs '::from>to'")
    return text.strip(), [tuple(p.strip().split(">", 1)) for p in pairs.split(",")]


def run_candidates(extra_specs):
    tokenizer, model = load()
    candidates = CANDIDATES + [parse_candidate(s) for s in extra_specs]
    print(f"{MODEL}: best head per highlight in layers >= {MIN_LAYER} (weak below {WEAK_BELOW})\n")
    for text, pairs in candidates:
        _, highlights, _ = analyze(tokenizer, model, text, pairs)
        print(text)
        for h in highlights:
            print("   " + describe(h))
        print()


def build():
    tokenizer, model = load()
    out_sentences = []
    shape = None
    for text, pairs in SENTENCES:
        tokens, highlights, shape = analyze(tokenizer, model, text, pairs)
        for h in highlights:
            print(describe(h), file=sys.stderr)
        out_sentences.append({"text": text, "tokens": tokens, "highlights": [strip_private(h) for h in highlights]})
    data = {"model": MODEL, "layers": int(shape[0]), "heads": int(shape[1]), "sentences": out_sentences}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--candidates":
        run_candidates(args[1:])
    else:
        build()
