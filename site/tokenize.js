const cache = new Map();
/** Lazily import a vendored encoder; works in browsers and Node. */
export async function loadTokenizer(name) {
  if (!['o200k', 'cl100k'].includes(name)) throw new Error(`Unknown tokenizer ${name}`);
  if (!cache.has(name)) cache.set(name, import(`./vendor/${name}.js`));
  return cache.get(name);
}
/** → [{id, text}] */
export function tokenize(enc, text) {
  return enc.encode(text).map(id => ({ id, text: enc.decode([id]) }));
}
