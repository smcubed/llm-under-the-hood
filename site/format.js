/** Small number formatters for the pane footers. Pure; tested in tests/format.test.mjs. */

/** USD → "$0.0004", "< $0.0001" for tiny positive amounts, "$0" for zero; null/NaN → "". */
export function formatCost(usd) {
  if (usd === null || usd === undefined || usd === '') return '';
  const n = Number(usd);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  if (n < 0.0001) return '< $0.0001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** Milliseconds → "850 ms" under a second, "1.2 s" from a second up; null/NaN → "". */
export function formatLatency(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/** Usage → "12 in · 80 out" (missing counts are skipped); null → "". */
export function formatTokens(usage) {
  if (!usage) return '';
  const parts = [];
  if (Number.isFinite(usage.prompt)) parts.push(`${usage.prompt} in`);
  if (Number.isFinite(usage.completion)) parts.push(`${usage.completion} out`);
  return parts.join(' · ');
}
