/*
 * The context plumbing and the ChartConfig type, which is all Encore uses `ui/chart` for — see
 * chart-container.svelte. The registry's tooltip chain is deliberately absent: it had no call sites and
 * was the only thing pulling layerchart and its d3 tree into the bundle. A tooltip belongs on Encore's own
 * accessible marks, so re-adding the registry's would reintroduce that dependency for nothing.
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
