"""Precompute GPT-2 attention for the two canned sentences in the attention chapter.

Run with `npm run data:attention` (needs the venv: `python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`).
Writes site/data/attention.json:

  { "model": "gpt2", "layers": 12, "heads": 12,
    "sentences": [ { "text": "...", "tokens": ["The", " patient", ...],
                     "highlights": [ { "from": 7, "to": 5, "layer": 7, "head": 8, "weight": 0.703,
                                       "row": [...], "mean_row": [...] } ] } ] }

For each highlight (a pronoun or verb and the earlier word it should point back to) we search every layer and head
for the one where the `from` token puts the most attention on the `to` token. `row` is that head's full attention row
for `from` (so the UI can draw an arc to every earlier token); `mean_row` is the same row averaged over the layer's
heads. A highlight whose best weight is under 0.15 is kept but flagged `"weak": true`. Indices are 0-based.
"""
import json
import sys
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "gpt2"
WEAK_BELOW = 0.15
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "attention.json"

# (sentence, [(from_word, to_word), ...]). Fictional, PHI-free.
SENTENCES = [
    ("The patient stopped taking her medication because it made her dizzy.",
     [("it", "medication"), ("her", "patient")]),
    ("The nurse gave the child an inhaler, and she began breathing more easily.",
     [("she", "child"), ("breathing", "inhaler")]),
]


def clean(token: str) -> str:
    """GPT-2 marks a leading space with 'Ġ' and a newline with 'Ċ'."""
    return token.replace("Ġ", " ").replace("Ċ", "\n")


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
        text = "".join(tokens[i] for i in span).strip().strip(".,;:!?")
        if text == word:
            return span
    raise SystemExit(f"could not find the word {word!r} in {tokens}")


def r3(x):
    return round(float(x), 3)


def main():
    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL, attn_implementation="eager", output_attentions=True)
    model.eval()
    out_sentences = []
    for text, pairs in SENTENCES:
        enc = tokenizer(text, return_tensors="pt")
        with torch.no_grad():
            out = model(**enc)
        # out.attentions: tuple(layers) of [batch, heads, seq, seq]
        attn = torch.stack([a[0] for a in out.attentions])  # [layers, heads, seq, seq]
        tokens = [clean(t) for t in tokenizer.convert_ids_to_tokens(enc["input_ids"][0])]
        spans = word_spans(tokens)
        highlights = []
        for from_word, to_word in pairs:
            to_span = find_word(tokens, spans, to_word)
            from_span = find_word(tokens, spans, from_word, after=to_span[-1])
            frm = from_span[-1]  # the last piece of a split word has seen the whole word
            best = None
            for layer in range(attn.shape[0]):
                for head in range(attn.shape[1]):
                    for to in to_span:
                        w = attn[layer, head, frm, to].item()
                        if best is None or w > best[0]:
                            best = (w, layer, head, to)
            weight, layer, head, to = best
            row = attn[layer, head, frm].tolist()
            mean_row = attn[layer, :, frm].mean(dim=0).tolist()
            h = {
                "from": frm, "to": to, "layer": layer, "head": head, "weight": r3(weight),
                "row": [r3(x) for x in row], "mean_row": [r3(x) for x in mean_row],
            }
            if weight < WEAK_BELOW:
                h["weak"] = True
            highlights.append(h)
            print(f"{from_word!r:>12} -> {to_word!r:<12} layer {layer:2d} head {head:2d} weight {weight:.3f}"
                  f"{'  (weak)' if weight < WEAK_BELOW else ''}", file=sys.stderr)
        out_sentences.append({"text": text, "tokens": tokens, "highlights": highlights})
    data = {"model": MODEL, "layers": int(attn.shape[0]), "heads": int(attn.shape[1]), "sentences": out_sentences}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
