/** top: [{text, logprob}] as returned by the API (natural-log probabilities).
 *  A non-numeric logprob yields p = NaN; only finite p values count toward the shown total. */
export function withProbs(top) {
  const items = top.map(t => ({ ...t, p: typeof t.logprob === 'number' ? Math.exp(t.logprob) : NaN }));
  const shown = items.reduce((s, x) => s + (Number.isFinite(x.p) ? x.p : 0), 0);
  return { items, other: Math.max(0, 1 - shown) };
}

/** Softmax over the shown candidates at a given temperature. T<=0 (or non-finite T) → argmax.
 *  Each output keeps the input fields (text, logprob) and adds p. */
export function rescale(top, temperature) {
  if (!top.length) return [];
  if (!Number.isFinite(temperature) || temperature <= 0) {
    const maxI = top.reduce((bi, x, i, a) => (x.logprob > a[bi].logprob ? i : bi), 0);
    return top.map((t, i) => ({ ...t, p: i === maxI ? 1 : 0 }));
  }
  const scaled = top.map(t => t.logprob / temperature);
  const m = Math.max(...scaled);
  const exps = scaled.map(s => Math.exp(s - m));
  const z = exps.reduce((a, b) => a + b, 0);
  return top.map((t, i) => ({ ...t, p: exps[i] / z }));
}

/** dist: [{text, p}] summing to ~1. random: () => [0,1). Returns null for an empty distribution. */
export function sample(dist, random = Math.random) {
  if (!dist.length) return null;
  const r = random();
  let acc = 0;
  for (const d of dist) { acc += d.p; if (r < acc) return d; }
  return dist[dist.length - 1];
}

export function band(p) {
  if (p == null || Number.isNaN(p)) return 'unknown';
  if (p >= 0.6) return 'high';
  if (p >= 0.25) return 'mid';
  return 'low';
}
