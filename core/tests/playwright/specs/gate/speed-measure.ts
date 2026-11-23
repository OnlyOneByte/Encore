// The in-page measurer behind CLAIM 9-14. How it measures, and why: docs/E2E.md#speed-gate.
import { test, type Page } from '@playwright/test';

/** Times in ms, epoch-anchored high-res, so two pages on one machine share a clock. */
export interface Interval {
	what: string;
	start: number;
	end: number | null;
}

export interface Shift {
	v: number;
	src: string[];
	/** Within 500 ms of input. Counted anyway: a tap doesn't license a jump. */
	input: boolean;
}

export interface Anim {
	what: string;
	name: string;
	duration: number;
	delay: number;
	iterations: number;
}

const INDICATOR_SEL = '[data-slot="spinner"], [aria-busy="true"], .skels';
const INDICATOR_TEXT = /^(Loading|Searching|Finding the room|Joining)…$/;

/** Installed on every document of a context (addInitScript) and once on a page already loaded (evaluate). */
function install(cfg: { indicatorSel: string; indicatorText: string }) {
	const w = window as unknown as { __sg?: unknown };
	if (w.__sg) return;
	const now = () => performance.timeOrigin + performance.now();
	const re = new RegExp(cfg.indicatorText);
	const S = {
		tap: null as number | null,
		watches: {} as Record<string, { root: string; dom: number | null; paint: number | null }>,
		cls: 0,
		shifts: [] as Shift[],
		fcp: null as number | null,
		indicators: [] as { what: string; start: number; end: number | null }[],
		anims: new Map<Animation, { what: string; name: string; duration: number; delay: number; iterations: number }>()
	};
	w.__sg = S;
	document.addEventListener('pointerdown', (e) => void (S.tap = performance.timeOrigin + e.timeStamp), true);
	const po = (type: string, fn: (e: PerformanceEntry & Record<string, unknown>) => void) => {
		try {
			new PerformanceObserver((l) => l.getEntries().forEach((e) => fn(e as never))).observe({ type, buffered: true });
		} catch {
			/* not supported */
		}
	};
	po('paint', (e) => void (e.name === 'first-contentful-paint' && (S.fcp = e.startTime)));
	po('layout-shift', (e) => {
		S.cls += e.value as number;
		const src = ((e.sources as { node?: Element }[]) ?? []).map((s) => {
			const n = s.node;
			return n ? `${n.nodeName}.${String(n.className ?? '').slice(0, 40)}` : '?';
		});
		S.shifts.push({ v: e.value as number, src, input: !!e.hadRecentInput });
	});
	const visible = (el: Element) => {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
		return true;
	};
	const label = (el: Element) =>
		`${el.nodeName}.${String(el.className ?? '').slice(0, 30)} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
	const indicatorsNow = () => {
		const out = new Set<string>();
		for (const el of document.querySelectorAll(cfg.indicatorSel)) if (visible(el)) out.add(label(el));
		// Not a whole-tree text walk: that, every 8 ms, would slow the taps this file times.
		for (const el of document.querySelectorAll('button, [role="status"]'))
			if (re.test((el.textContent ?? '').trim()) && visible(el)) out.add(label(el));
		return out;
	};
	const open = new Map<string, { what: string; start: number; end: number | null }>();
	const sweep = () => {
		if (!document.body) return;
		const seen = indicatorsNow();
		for (const k of seen)
			if (!open.has(k)) {
				const rec = { what: k, start: now(), end: null };
				open.set(k, rec);
				S.indicators.push(rec);
			}
		for (const [k, rec] of open)
			if (!seen.has(k)) {
				rec.end = now();
				open.delete(k);
			}
		for (const a of document.getAnimations()) {
			if (S.anims.has(a)) continue;
			const t = a.effect?.getTiming();
			const target = (a.effect as KeyframeEffect | null)?.target;
			const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id ?? '';
			S.anims.set(a, {
				what: target ? label(target) : '?',
				name: String(name),
				duration: Number(t?.duration ?? 0),
				delay: Number(t?.delay ?? 0),
				iterations: Number(t?.iterations ?? 1)
			});
		}
	};
	new MutationObserver((recs) => {
		const t = now();
		for (const [, wt] of Object.entries(S.watches)) {
			if (wt.dom !== null) continue;
			const root = document.querySelector(wt.root);
			if (!root || !recs.some((r) => root.contains(r.target))) continue;
			wt.dom = t;
			requestAnimationFrame(() => {
				const ch = new MessageChannel();
				ch.port1.onmessage = () => void (wt.paint = now());
				ch.port2.postMessage(0);
			});
		}
		sweep();
	}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	// CSS-only changes (an opacity step) fire no mutation.
	setInterval(sweep, 8);
	(S as Record<string, unknown>).watch = (key: string, root: string) => {
		S.watches[key] = { root, dom: null, paint: null };
	};
}

const CFG = { indicatorSel: INDICATOR_SEL, indicatorText: INDICATOR_TEXT.source };

/** Every future document in the page's context, and the one already loaded. */
export async function instrument(page: Page): Promise<void> {
	await page.context().addInitScript(install, CFG);
	await page.evaluate(install, CFG);
}

/** For a context the test builds itself, before its first page. */
export const instrumentScript = { fn: install, arg: CFG };

type State = {
	tap: number | null;
	cls: number;
	shifts: Shift[];
	fcp: number | null;
	indicators: Interval[];
	watches: Record<string, { dom: number | null; paint: number | null }>;
};

export const readState = (page: Page) =>
	page.evaluate(() => {
		const s = (window as unknown as { __sg: State & { anims: Map<Animation, Anim> } }).__sg;
		return {
			tap: s.tap,
			cls: s.cls,
			shifts: s.shifts,
			fcp: s.fcp,
			indicators: s.indicators,
			watches: s.watches,
			anims: [...s.anims.values()]
		};
	});

/** ms from the real `pointerdown` to the frame that shows the first DOM change inside `root`. */
export async function tapToChange(page: Page, root: string, tap: () => Promise<void>): Promise<number> {
	const key = `w${Math.random().toString(36).slice(2, 8)}`;
	await page.evaluate(
		([k, r]) => (window as unknown as { __sg: { watch(k: string, r: string): void } }).__sg.watch(k, r),
		[key, root] as const
	);
	await tap();
	await page.waitForFunction(
		(k) => {
			const s = (window as unknown as { __sg: State }).__sg;
			return s.watches[k]?.paint !== null && s.watches[k]?.paint !== undefined;
		},
		key,
		{ timeout: 10_000, polling: 50 }
	);
	return page.evaluate((k) => {
		const s = (window as unknown as { __sg: State }).__sg;
		return s.watches[k]!.paint! - s.tap!;
	}, key);
}

export async function throttle(page: Page, rate: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/** Host load only adds time, so the fastest rep is the product's cost. */
export const best = (xs: number[]) => Math.min(...xs);

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Indicators on screen for less than the grace. One still open at the end has outlasted the watch. */
export const flashes = (ivs: Interval[], graceMs = 300) =>
	ivs
		.filter((i) => i.end !== null && i.end - i.start < graceMs)
		.map((i) => ({ ...i, ms: Math.round(i.end! - i.start) }));

/** Call after the setup, just before the claim's one assertion, so only the claim can be the expected failure. */
export function knownBreak(why: string): void {
	test.fail(true, `KNOWN BREAK: ${why}`);
}

export function report(claim: string, samples: number[], budget: number): string {
	const s = samples.map(Math.round).join(', ');
	return `${claim}: best ${Math.round(best(samples))} ms, median ${Math.round(median(samples))} ms (${s}), budget ${budget} ms`;
}
