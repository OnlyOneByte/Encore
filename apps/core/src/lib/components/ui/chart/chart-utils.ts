/*
 * ── ENCORE DEVIATIONS (#913 S8, trimmed in Phase 2) ───────────────────────────────────────────────
 * What Encore uses `ui/chart` for is the CONFIG CONTRACT — `config` → one `--color-<series>` custom
 * property per series, emitted by ChartStyle onto `[data-chart=<id>]`. It does NOT use layerchart's
 * marks: /stats' Trend is 31 real <button> columns with per-day aria-labels and Bars is a labelled
 * proportional list, both deliberately accessible in a way plotted <rect>/<path> marks are not (see
 * chart-container.svelte's header for the full argument).
 *
 * PHASE 2 REMOVED THE TOOLTIP CHAIN AND THE layerchart DEPENDENCY WITH IT.
 * `chart-tooltip.svelte` had ZERO call sites — nothing in the app rendered Chart.Tooltip — and it was
 * the only consumer of `getPayloadConfigFromPayload` and `TooltipPayload`, which in turn were the only
 * reason this file imported `type { Tooltip } from 'layerchart'`. So the whole chain was carrying a
 * multi-megabyte dependency (layerchart plus its d3 tree) for code no surface reached. Both are gone;
 * what remains is the context plumbing and the ChartConfig type that the two real charts use.
 *
 * If a tooltip is ever wanted, it belongs on Encore's own accessible marks rather than on layerchart's
 * — re-adding the registry's tooltip would reintroduce the dependency for a rendering path this app
 * does not take.
 */
import { getContext, setContext, type Component, type Snippet } from 'svelte';

export const THEMES = { light: '', dark: '.dark' } as const;

export type ChartConfig = {
	[k in string]: {
		label?: string;
		icon?: Component;
	} & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> });
};

export type ExtractSnippetParams<T> = T extends Snippet<[infer P]> ? P : never;

type ChartContextValue = {
	config: ChartConfig;
};

const chartContextKey = Symbol('chart-context');

export function setChartContext(value: ChartContextValue) {
	return setContext(chartContextKey, value);
}

export function useChart() {
	return getContext<ChartContextValue>(chartContextKey);
}
