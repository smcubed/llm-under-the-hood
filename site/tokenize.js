const NAMES = ['o200k', 'cl100k'];
const cache = new Map();
const defaultImporter = (name) => import(`./vendor/${name}.js`);

/** Lazily import a vendored encoder; works in browsers and Node. A failed import is not cached, so a retry can succeed. */
export async function loadTokenizer(name, { importer = defaultImporter } = {}) {
  if (!NAMES.includes(name)) throw new Error(`Unknown tokenizer ${name}`);
  if (!cache.has(name)) {
    cache.set(name, importer(name).catch((err) => { cache.delete(name); throw err; }));
  }
  return cache.get(name);
}

// Special-token markup such as "<|endoftext|>" is just text a student typed; encode it as ordinary bytes.
const ENCODE_OPTIONS = { disallowedSpecial: new Set() };

/**
 * Text for one token id, decoded on its own. The vendored bundle's `decode` keeps a streaming TextDecoder across
 * calls, so decoding ids one at a time would leak bytes from one token into the next. Instead, read the token's own
 * bytes from the core processor and decode them with a fresh decoder: a piece of a multi-byte character becomes U+FFFD.
 * If the byte accessor is missing (a different bundle build), fall back to `decode([id])`.
 */
function tokenText(enc, id) {
  const raw = enc.default?.bytePairEncodingCoreProcessor?.tryDecodeToken?.(id);
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder('utf-8').decode(raw);
  return enc.decode([id]);
}

/** → [{id, text}] */
export function tokenize(enc, text) {
  return enc.encode(text, ENCODE_OPTIONS).map(id => ({ id, text: tokenText(enc, id) }));
}
