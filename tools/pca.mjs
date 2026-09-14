// Two-component PCA for the embedding map. Mean-centre, form the d×d covariance, pull the top two
// eigenvectors by power iteration with deflation, project. Deterministic (fixed start vector), no dependencies.
const ITERATIONS = 200;

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function topEigenvector(C, d) {
  // A start vector with unequal entries so it is not accidentally orthogonal to the leading eigenvector.
  let v = Float64Array.from({ length: d }, (_, j) => 1 + j / d);
  let lambda = 0;
  for (let it = 0; it < ITERATIONS; it++) {
    const w = new Float64Array(d);
    for (let i = 0; i < d; i++) w[i] = dot(C[i], v);
    lambda = Math.sqrt(dot(w, w));
    if (lambda === 0) break;
    for (let i = 0; i < d; i++) w[i] /= lambda;
    v = w;
  }
  return { v, lambda };
}

/** vectors: n arrays of length d → n arrays [x, y] (projections onto the first two principal components). */
export function pca2d(vectors) {
  const n = vectors.length;
  if (n === 0) return [];
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (const row of vectors) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = vectors.map(row => Float64Array.from(row, (x, j) => x - mean[j]));

  const C = Array.from({ length: d }, () => new Float64Array(d));
  for (const row of X) {
    for (let i = 0; i < d; i++) {
      const xi = row[i];
      if (xi === 0) continue;
      const Ci = C[i];
      for (let j = 0; j < d; j++) Ci[j] += xi * row[j];
    }
  }
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= denom;

  const components = [];
  for (let k = 0; k < 2; k++) {
    const { v, lambda } = topEigenvector(C, d);
    components.push(v);
    // Deflate: remove the found component so the next power iteration converges to the runner-up.
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] -= lambda * v[i] * v[j];
  }
  return X.map(row => [dot(row, components[0]), dot(row, components[1])]);
}
