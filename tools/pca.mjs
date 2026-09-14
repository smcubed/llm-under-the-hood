// Two-component PCA for the embedding map. Mean-centre, form the d×d covariance, pull the top two eigenvectors
// by orthogonal power iteration (each iterate is re-orthogonalized against the components already found), project.
// Deterministic (fixed start vector), no dependencies. Sign is canonical: the entry with the largest magnitude is
// positive, so the map does not flip when the vocabulary is reordered.
const ITERATIONS = 200;

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Remove from v its projection onto each vector in `basis` (all unit length). Mutates v. */
function orthogonalize(v, basis) {
  for (const u of basis) {
    const c = dot(v, u);
    for (let i = 0; i < v.length; i++) v[i] -= c * u[i];
  }
}

function normalize(v) {
  const n = Math.sqrt(dot(v, v));
  if (n === 0) return 0;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return n;
}

/** Flip v so that its largest-|entry| coordinate is positive. Mutates v. */
function canonicalSign(v) {
  let bi = 0;
  for (let i = 1; i < v.length; i++) if (Math.abs(v[i]) > Math.abs(v[bi])) bi = i;
  if (v[bi] < 0) for (let i = 0; i < v.length; i++) v[i] = -v[i];
}

/** Next eigenvector of C orthogonal to `previous`; returns zeros when the remaining variance is ~0. */
function nextEigenvector(C, d, previous, scale) {
  // A start vector with unequal entries so it is not accidentally orthogonal to the leading eigenvector.
  let v = Float64Array.from({ length: d }, (_, j) => 1 + j / d);
  orthogonalize(v, previous);
  if (normalize(v) === 0) return new Float64Array(d);
  const rayleigh = (u) => { let s = 0; for (let i = 0; i < d; i++) s += u[i] * dot(C[i], u); return s; };
  const zero = new Float64Array(d);
  for (let it = 0; it < ITERATIONS; it++) {
    // v is unit length and orthogonal to `previous`, so v·Cv is the variance left along v. When that is ~0 the
    // remaining directions carry no signal (rank-deficient input): stop and report an exact zero axis rather than
    // renormalizing roundoff into a spurious component.
    if (!(rayleigh(v) > 1e-12 * scale)) return zero;
    const w = new Float64Array(d);
    for (let i = 0; i < d; i++) w[i] = dot(C[i], v);
    orthogonalize(w, previous);
    if (normalize(w) === 0) return zero;
    orthogonalize(w, previous); // second pass: a tiny w leaves O(1) relative leakage after one pass
    if (normalize(w) === 0) return zero;
    v = w;
  }
  if (!(rayleigh(v) > 1e-12 * scale)) return zero;
  canonicalSign(v);
  return v;
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
  let trace = 0;
  for (let i = 0; i < d; i++) trace += C[i][i];
  const scale = Math.max(1, trace);

  const components = [];
  for (let k = 0; k < 2; k++) {
    const v = nextEigenvector(C, d, components.filter(c => dot(c, c) > 0), scale);
    components.push(v);
  }
  return X.map(row => [dot(row, components[0]), dot(row, components[1])]);
}
