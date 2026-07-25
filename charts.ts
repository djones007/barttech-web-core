/**
 * Shared chart presentation constants for the estate's INTERNAL dashboards
 * (command-center, bartmail, checkout-engine, barton-lms).
 *
 * Deliberately React-free, like every other module here — this file holds the
 * parts that actually drift between dashboards (series colours, axis/tooltip
 * formatting), not the JSX. The card shell itself is ~15 lines of markup and
 * stays per-repo, for the same reason the cookie banner does: it depends on
 * that app's Card primitive and spacing.
 *
 * NOT for brand marketing sites. Those follow the per-brand palettes in
 * reference_website_design_standard; this is the neutral internal-tool set.
 *
 * Charting library: recharts 3, used DIRECTLY. Do not adopt shadcn's `chart`
 * component — its registry entry still pins recharts@2.15.4, so adopting it
 * pins the consuming repo to recharts 2 (this is why cloud-plus-v2's vendored
 * copy was deleted on 2026-07-25).
 */

/**
 * Categorical series colours, ordered for sequential assignment.
 * Index with `SERIES_COLORS[i % SERIES_COLORS.length]` so any series count works.
 *
 * Slate → blue ramp: the first entry is deliberately muted so that in a
 * year-over-year chart the oldest series recedes and the current one leads.
 * Taken from command-center's `YEAR_FILLS`, which is the estate's only
 * real-world chart palette in production use.
 */
export const SERIES_COLORS = ["#cbd5e1", "#60a5fa", "#2563eb", "#1e3a8a"] as const;

/** Positive / negative / neutral accents for deltas, targets and thresholds. */
export const SIGNAL_COLORS = {
  positive: "#16a34a",
  negative: "#dc2626",
  neutral: "#64748b",
} as const;

/** Grid + axis styling, so every dashboard's chrome matches without copy-paste. */
export const CHART_GRID = { stroke: "#f1f5f9", strokeDasharray: "3 3" } as const;
export const CHART_AXIS = { fontSize: 11, stroke: "#94a3b8" } as const;

/**
 * recharts widened its Tooltip/axis formatter value to `ValueType`
 * (`string | number | array | undefined`) in v3, so a `(v: number) => …`
 * callback no longer satisfies the signature and fails `tsc`. Narrow with this
 * instead of casting — a cast would hide a genuinely non-numeric series.
 * Returns `null` rather than `NaN` for anything non-numeric, so formatters can
 * render an em dash rather than "NaN".
 */
export function asChartNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Compact axis labels: 1500 → "1.5k", 2_400_000 → "2.4M". */
export function compactNumber(v: unknown): string {
  const n = asChartNumber(v);
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Whole-unit currency for axis ticks and tooltips. Symbol is passed in rather
 * than derived — this repo is brand-agnostic and several dashboards mix
 * currencies on one chart.
 */
export function chartCurrency(v: unknown, symbol = ""): string {
  const n = asChartNumber(v);
  if (n === null) return "—";
  return `${symbol}${Math.round(n).toLocaleString("en-GB")}`;
}

/** One-decimal percentage. Expects an already-scaled value (12.3 → "12.3%"). */
export function chartPercent(v: unknown): string {
  const n = asChartNumber(v);
  if (n === null) return "—";
  return `${n.toFixed(1)}%`;
}
