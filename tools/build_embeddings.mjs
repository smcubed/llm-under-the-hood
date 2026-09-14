// Embed tools/vocabulary.txt with MiniLM and write site/data/embeddings.json: a 2-D PCA map plus
// each word's five nearest neighbours by cosine. `npm run data:embeddings` (first run downloads ~23 MB).
import { pipeline } from '@huggingface/transformers';
import { readFile, writeFile } from 'node:fs/promises';
import { pca2d } from './pca.mjs';

const lines = (await readFile(new URL('./vocabulary.txt', import.meta.url), 'utf8')).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const words = lines.map(l => { const [w, g] = l.split('\t'); return { w, g: g || 'other' }; });
const dupes = words.map(x => x.w).filter((w, i, a) => a.indexOf(w) !== i);
if (dupes.length) throw new Error(`vocabulary.txt has duplicate words: ${[...new Set(dupes)].join(', ')}`);
const emb = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
const out = await emb(words.map(x => x.w), { pooling: 'mean', normalize: true });
const vecs = out.tolist();
const pts = pca2d(vecs);
const norm = (arr, i) => { const v = arr.map(p => p[i]); const lo = Math.min(...v), hi = Math.max(...v); return v.map(x => ((x - lo) / (hi - lo)) * 2 - 1); };
const xs = norm(pts, 0), ys = norm(pts, 1);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const neighbors = {};
words.forEach((x, i) => {
  neighbors[x.w] = words.map((y, j) => [y.w, dot(vecs[i], vecs[j])]).filter(([w]) => w !== x.w).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, s]) => ({ w, s: Number(s.toFixed(3)) }));
});
const data = { model: 'Xenova/all-MiniLM-L6-v2', built: new Date().toISOString().slice(0, 10), words: words.map((x, i) => ({ w: x.w, g: x.g, x: Number(xs[i].toFixed(4)), y: Number(ys[i].toFixed(4)) })), neighbors };
await writeFile(new URL('../site/data/embeddings.json', import.meta.url), JSON.stringify(data));
console.log('wrote', data.words.length, 'words');
