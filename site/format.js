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

/** Below this, a latency is shown as "< 0.1 s" rather than rounding to a misleading "0.0 s". */
const SUB_TENTH_MS = 50;

/** Milliseconds → seconds with one decimal ("0.4 s", "1.3 s"); under SUB_TENTH_MS → "< 0.1 s"; null/NaN/negative → "". */
export function formatLatency(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < SUB_TENTH_MS) return '< 0.1 s';
  return `${(Math.round(n / 100) / 10).toFixed(1)} s`; // round in tenths first: (0.85).toFixed(1) is "0.8" in binary floating point
}

/** Footer timing: "first token 0.4 s · total 1.3 s", or "took 1.3 s" when no token arrived; no total → "". */
export function formatTiming(stats) {
  const total = formatLatency(stats?.latencyMs);
  if (!total) return '';
  const first = formatLatency(stats?.firstTokenMs);
  return first ? `first token ${first} · total ${total}` : `took ${total}`;
}

/** Usage → "12 in · 80 out" (missing counts are skipped); null → "". */
export function formatTokens(usage) {
  if (!usage) return '';
  const parts = [];
  if (Number.isFinite(usage.prompt)) parts.push(`${usage.prompt} in`);
  if (Number.isFinite(usage.completion)) parts.push(`${usage.completion} out`);
  return parts.join(' · ');
}
