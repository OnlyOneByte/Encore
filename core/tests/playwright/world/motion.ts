// MOTION CAPTURE for UI review: one real animation in, three artifacts out.
//
//   clip.gif        for the human — real-time pacing, held before/after frames so the loop reads
//   filmstrip.png   for an agent that sees images but not video — every frame labelled with its ms
//   metrics.json    the numbers the strip cannot show: declared timing, rAF cadence, long frames, CLS,
//                   and whether `prefers-reduced-motion: reduce` actually removed the motion
//
// TWO RUNS PER ANIMATION, because one run cannot be both deterministic and honest:
//   SEEK run  — every animation that starts after `arm()` is caught on its first event and PAUSED, then
//               stepped through `currentTime` in fixed increments with a screenshot at each. The frames are
//               exact (frame N is the animation at N×step ms) whatever the box's load, which is what makes a
//               strip comparable across runs and reviewable by an agent.
//   LIVE run  — the same trigger, unpaused, with rAF timestamps, Long Animation Frame entries and layout-shift
//               entries collected over the animation's window. This is the jank/CLS evidence; the seek run
//               has none, because it does not run in real time.
// Headless Chromium runs with --disable-gpu (playwright.config.ts), so LIVE numbers are a floor on what software
// rasterisation can do on this box — not a TV's GPU and not a phone's. See docs/UI-CHECKLIST.md#limits.
//
// Run it with `bun run ui:review` (docs/UI-CHECKLIST.md says what a reviewer reads off the output).
//
// Zero system deps: PNG decode is pngjs, GIF encode is gifenc (pure JS), the contact sheet is laid out as HTML
// and photographed by the same Chromium. No ffmpeg, no gifski, no sharp.
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
// gifenc ships CJS + ESM without types, and its package.json has no `exports`, so Playwright's loader resolves the
// CJS build: take the default and destructure.
// @ts-expect-error untyped
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

export interface Clip {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface MotionScenario {
	/** Output directory name under the samples root. */
	name: string;
	/** What the reviewer should look for. Written into metrics.json and onto the strip. */
	what: string;
	/** CSS selector for the element the row is ABOUT. Every frame after the trigger, in the seek and the reduced
	 *  runs, must show it: not `visibility: hidden`, with a non-zero area of its box left after the ancestors that
	 *  clip it (`overflow`, `contain: paint`, an `inset()` `clip-path`) and the frame's crop (the strip's, when it
	 *  has one) cut it. Opacity is not checked per frame, so a fade-in's first frame counts, but the LAST frame of each
	 *  run (the seek's settled end, the reduced burst's last shot) must also show it at an effective opacity (the
	 *  product up its ancestors) above 0: a subject that never becomes visible is missing. A frame without it
	 *  shows something else, so `metrics.subject.missingMs` lists it and the row fails.
	 *  What it can't see: z-order (a subject painted under another element still counts as shown); a `clip-path`
	 *  shape other than `inset()`, or an `inset()` it can't read (`calc()`, a box keyword), counts as the whole box; and transformed clipping ancestors, whose padding
	 *  box is approximate (`scale` > 1 can falsely fail, `scale` < 1 can hide a sliver clip). */
	subject: string;
	/** Seek run only: once the trigger resolves, drop every page `setTimeout` callback, pending or new, until the
	 *  page closes. For rows whose subject has a wall-clock dismiss (the "You're up" sheet, the TV card) that would
	 *  otherwise fire between seeked frames and take the subject away under a frozen animation. Off by default,
	 *  because it also hides timer-sequenced motion (a staggered reveal); each dropped callback is listed in
	 *  `metrics.heldTimers` and counted on the strip. */
	holdTimers?: boolean;
	/** Bring a page to the state just BEFORE the motion. Gets a fresh page per run. */
	open(contextOptions: BrowserContextOptions): Promise<Page>;
	/** Fire the motion. Must resolve once the trigger has been delivered (not once motion ends). */
	trigger(page: Page): Promise<void>;
	/** Region of interest for the strip; the GIF uses `gifClip` or the full viewport. */
	stripClip?: (page: Page) => Promise<Clip | undefined>;
	gifClip?: (page: Page) => Promise<Clip | undefined>;
	/** Seek step in ms. ~33 for a 0.5 s+ motion, ~12-16 for a 120 ms one. */
	stepMs?: number;
	/** Render scale for frames (deviceScaleFactor). 0.5 keeps a 1080p TV GIF under 2 MB. */
	scale?: number;
	/** How long to wait for the trigger's first animation before calling it "no motion". */
	startTimeoutMs?: number;
	/** Thumbnails per row on the strip. */
	columns?: number;
	/** CSS selector the animation's target must match to be CAUGHT (seeked, timed). Anything else that starts
	 *  in the window is still listed under `others`, which is how an unrelated fade gets noticed rather than
	 *  silently becoming the subject. */
	only?: string;
	/** Scenario-specific facts read after each run (e.g. "did the phrase change"), kept in metrics.json. */
	observe?(page: Page): Promise<unknown>;
	/** ONE literal that is a deliberate exception: `match` is the exact `tokens.problems` line it waives (e.g.
	 *  `phrase-fade on div.phrase-line: literal timing 0.6s`), `reason` says why. Any other literal still fails. */
	literalsAllowed?: { match: string; reason: string };
}

export interface AnimationRecord {
	kind: string;
	name: string;
	target: string;
	durationMs: number;
	delayMs: number;
	endTimeMs: number;
	easing: string;
	iterations: number;
	fill: string;
	/** What it animates. `vestibular` = moves or resizes something (transform, position, size), which is what
	 *  `prefers-reduced-motion` exists to stop; opacity and colour fades are not. */
	properties: string[];
	vestibular: boolean;
	/** Where the timing and the colours were AUTHORED, read from the built CSS (the CSSOM rules that match the
	 *  target), because `durationMs` is the same 400 for `var(--motion-slow)` and a literal `0.4s`. */
	source: TokenSource;
}

export interface TokenSource {
	/** The authored `transition`/`animation` text that sets this duration, or null when no CSS rule does (an
	 *  `element.animate()` call: script-timed, so only the diff can tell). */
	duration: string | null;
	/** True when that text uses a `var(--motion-*)` token and no literal timing (a duration or a delay). */
	durationIsToken: boolean;
	/** Literal times left once the `var()` calls are taken out: a hard-coded duration or delay (`0s` is fine). */
	literalTimings: string[];
	/** Authored values of the animated colour properties: the matching rules for a transition's end state, the
	 *  keyframes for an animation. */
	colours: string[];
	/** The subset of `colours` that is a literal (`#ff2d95`, `rgb(…)`, `oklch(…)`, …) rather than a variable. */
	literalColours: string[];
}

export interface LiveReport {
	animations: AnimationRecord[];
	others: AnimationRecord[];
	windowMs: number;
	rafFrames: number;
	frameIntervalsMs: { p50: number; p95: number; max: number };
	/** Intervals over 1.5× the median vsync — a frame the compositor did not get to in time. */
	droppedFrames: number;
	longAnimationFrames: { count: number; worstMs: number; supported: boolean };
	cls: { total: number; excludingRecentInput: number; entries: number };
}

// ── in-page instrumentation ──────────────────────────────────────────────────────────────────────────────

/**
 * Installed as an init script, so it is in place before the app's first animation. Inert until `arm()`.
 * Catches CSS animations and transitions through their start events (capture phase, so a component's own
 * listener cannot hide them) and WAAPI animations — Svelte 5 transitions included — by wrapping
 * `Element.prototype.animate`.
 */
function instrument() {
	type M = {
		armed: boolean;
		freeze: boolean;
		/** Seek runs of a `holdTimers` row only: set once the trigger resolves; see the `setTimeout` wrapper below. */
		hold: boolean;
		/** The callbacks `hold` dropped: the timer's delay and when it came due, in ms after `arm()`. */
		held: { delayMs: number; atMs: number }[];
		t0: number;
		caught: Animation[];
		others: Animation[];
		only: string | null;
		raf: number[];
		loaf: number[];
		loafSupported: boolean;
		shifts: { value: number; hadRecentInput: boolean }[];
		arm(freeze: boolean, only: string | null): void;
		catch(a: Animation): void;
	};
	const m: M = {
		armed: false,
		freeze: false,
		hold: false,
		held: [],
		t0: 0,
		caught: [],
		others: [],
		only: null,
		raf: [],
		loaf: [],
		loafSupported: false,
		shifts: [],
		arm(freeze, only) {
			m.armed = true;
			m.freeze = freeze;
			m.hold = false;
			m.held = [];
			m.only = only;
			m.others = [];
			m.t0 = performance.now();
			m.caught = [];
			m.raf = [];
			m.loaf = [];
			m.shifts = [];
			const tick = (t: number) => {
				if (!m.armed) return;
				m.raf.push(t);
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		catch(a) {
			if (!m.armed || m.caught.includes(a) || m.others.includes(a)) return;
			const target = (a.effect as KeyframeEffect | null)?.target;
			if (m.only && !target?.matches(m.only)) {
				m.others.push(a);
				return;
			}
			m.caught.push(a);
			if (m.freeze) {
				// Freeze EVERYTHING so frames are stable (an infinite pulse elsewhere would otherwise move between
				// shots), then rewind only what we caught.
				for (const other of document.getAnimations()) other.pause();
				a.pause();
				a.currentTime = 0;
			}
		}
	};
	(window as unknown as { __motion: M }).__motion = m;

	const fromEvent = (e: Event) => {
		const el = e.target as Element;
		const key = e instanceof AnimationEvent ? e.animationName : e instanceof TransitionEvent ? e.propertyName : null;
		for (const a of el.getAnimations?.() ?? []) {
			const n = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? undefined;
			if (key === null || n === key) m.catch(a);
		}
	};
	document.addEventListener('animationstart', fromEvent, true);
	document.addEventListener('transitionrun', fromEvent, true);

	// Pause-and-seek stops the page's animation clock, so it stops its timers too: a wall-clock timer firing while
	// frames are seeked (the "You're up" sheet's or the TV card's dismiss) would change the page under a frozen
	// animation, or take a CUT's after frame away. Once a `holdTimers` row's seek trigger has resolved (`hold`), no
	// timeout fires, pending or new, and each one dropped is recorded in `held`; the page is closed after that run.
	// Deliberately NOT held: `setInterval` and `requestAnimationFrame` loops (VisualizerStage, LyricsOverlay) run on
	// wall-clock in every run. String handlers pass through untouched.
	const setTimeoutReal = window.setTimeout;
	window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
		typeof handler !== 'function'
			? setTimeoutReal(handler, ms, ...args)
			: setTimeoutReal(() => {
					if (!m.hold) handler(...args);
					else m.held.push({ delayMs: Number(ms) || 0, atMs: Math.round(performance.now() - m.t0) });
				}, ms)) as typeof window.setTimeout;

	const animate = Element.prototype.animate;
	Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
		const a = animate.apply(this, args);
		m.catch(a);
		return a;
	};

	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) if (m.armed) m.loaf.push(e.duration);
		}).observe({ type: 'long-animation-frame', buffered: false });
		m.loafSupported = true;
	} catch {
		// Chromium < 123
	}
	new PerformanceObserver((list) => {
		for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
			if (m.armed) m.shifts.push({ value: e.value, hadRecentInput: e.hadRecentInput });
	}).observe({ type: 'layout-shift', buffered: false });
}

/** Serialisable description of what was caught. Run in-page. */
function describeCaught(which: string): AnimationRecord[] {
	const m = (window as unknown as { __motion: Record<'caught' | 'others', Animation[]> }).__motion;
	const MOVES = /^(transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|margin|offset)/;
	const label = (el: Element | null | undefined) => {
		if (!el) return '?';
		const cls = [...el.classList].filter((c) => !c.startsWith('s-') && !c.startsWith('svelte-')).slice(0, 3);
		const slot = el.getAttribute('data-slot');
		return el.tagName.toLowerCase() + (slot ? `[data-slot=${slot}]` : '') + cls.map((c) => '.' + c).join('');
	};
	return m[which as 'caught' | 'others'].map((a) => {
		const effect = a.effect as KeyframeEffect | null;
		const timing = effect?.getComputedTiming();
		const kind = a.constructor.name;
		const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
		const properties =
			kind === 'CSSTransition'
				? [(a as CSSTransition).transitionProperty]
				: [...new Set((effect?.getKeyframes() ?? []).flatMap((k) => Object.keys(k).filter((p) => !skip.has(p))))];
		// A CSS animation's timing function lives on its keyframes, so the effect itself reports `linear`.
		const easing =
			kind === 'CSSAnimation' && effect?.target
				? getComputedStyle(effect.target).animationTimingFunction
				: String(effect?.getTiming().easing ?? '');
		const name =
			(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? (a.id || 'element.animate');
		return {
			kind,
			name,
			target: label(effect?.target),
			durationMs: Number(timing?.duration ?? 0),
			delayMs: Number(timing?.delay ?? 0),
			endTimeMs: Number(timing?.endTime ?? 0),
			easing,
			iterations: Number(timing?.iterations ?? 1),
			fill: String(timing?.fill ?? ''),
			properties,
			vestibular: properties.some((p) => MOVES.test(p)),
			source: authored(kind, name, effect?.target ?? null, properties)
		};
	});

	/** Read the authored values off the page's own stylesheets. Cross-origin sheets are skipped (there are none:
	 *  the app's CSS is same-origin). shortcut: matching ignores the cascade, so a literal in ANY matching rule
	 *  that sets the property counts, even one a later rule overrides; tighten if that ever flags a real token. */
	function authored(kind: string, animName: string, target: Element | null, props: string[]): TokenSource {
		const COLOURISH = /colou?r|background|border|outline|fill|stroke|shadow/;
		const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
		const rules: CSSRule[] = [];
		// Only rules the browser applies now: a block under a media query or @supports that doesn't hold is skipped,
		// so a `reduce` override or a wide-screen variant is not read as this capture's timing.
		const walk = (list: CSSRuleList) => {
			for (const r of list) {
				if (r instanceof CSSMediaRule && !matchMedia(r.media.mediaText).matches) continue;
				if (r instanceof CSSSupportsRule && !CSS.supports(r.conditionText)) continue;
				rules.push(r);
				if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
			}
		};
		for (const sheet of document.styleSheets) {
			try {
				walk(sheet.cssRules);
			} catch {
				// cross-origin
			}
		}
		const styleRules = rules.filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
		const matching = target
			? styleRules.filter((r) => {
					try {
						return target.matches(r.selectorText);
					} catch {
						return false;
					}
				})
			: [];
		const valueOf = (names: string[]) =>
			matching.flatMap((r) => names.map((n) => r.style.getPropertyValue(n)).filter(Boolean));
		// Every matching rule that times this kind of motion, so a literal anywhere among them shows. The longhand
		// reads empty when its shorthand holds a var() (pending substitution), so both are read.
		const durations =
			kind === 'CSSTransition'
				? valueOf(['transition', 'transition-duration', 'transition-delay'])
				: kind === 'CSSAnimation'
					? valueOf(['animation', 'animation-duration', 'animation-delay']).filter(
							(v) => v.includes(animName) || !v.includes(' ')
						)
					: [];
		const duration = durations.length ? durations.join(' | ') : null;
		let colours: string[] = [];
		if (kind === 'CSSTransition') {
			// `border-top-color` is also set by `border-color`, `border-top` and `border`; `background-color` by `background`.
			const names = props
				.filter((p) => COLOURISH.test(p))
				.flatMap((p) => {
					const parts = p.split('-');
					const out = [p];
					if (parts[0] === 'border' && parts.length === 3) out.push('border-color', `border-${parts[1]}`, 'border');
					else if (parts.length > 1) out.push(parts[0]);
					return out;
				});
			colours = names.length ? valueOf(names) : [];
		} else if (kind === 'CSSAnimation') {
			const kf = rules.find((r): r is CSSKeyframesRule => r instanceof CSSKeyframesRule && r.name === animName);
			colours = kf
				? [...kf.cssRules].flatMap((k) => {
						const st = (k as CSSKeyframeRule).style;
						return [...st].filter((p) => COLOURISH.test(p)).map((p) => st.getPropertyValue(p));
					})
				: [];
		}
		let bare = durations.join(' , ');
		for (let prev = ''; prev !== bare;) [prev, bare] = [bare, bare.replace(/var\([^()]*\)/g, '')];
		const literalTimings = [...new Set(bare.match(/(?<![\w.-])\d*\.?\d+m?s\b/g) ?? [])].filter(
			(t) => parseFloat(t) !== 0
		);
		return {
			duration,
			durationIsToken:
				durations.length > 0 && !literalTimings.length && durations.every((d) => d.includes('var(--motion-')),
			literalTimings,
			colours,
			literalColours: colours.filter((c) => LITERAL.test(c.replace(/var\([^)]*\)/g, '')))
		};
	}
}

// ── runs ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Frame {
	ms: number;
	png: Buffer;
}

async function waitForCatch(page: Page, timeout: number): Promise<boolean> {
	return page
		.waitForFunction(
			() => (window as unknown as { __motion: { caught: unknown[] } }).__motion.caught.length > 0,
			null,
			{
				timeout,
				polling: 'raf'
			}
		)
		.then(async () => {
			// Siblings started by the same state change (a dialog and its scrim) dispatch in the same or next frame.
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			return true;
		})
		.catch(() => false);
}

/** Is `s.subject` on screen inside `area` (viewport px, as a screenshot `clip` is; the viewport when absent), with a non-zero area of it left
 *  after clipping? Its box is cut by every ancestor that clips it (`overflow` other than `visible`, or `contain:
 *  paint`, on its containing-block chain) and by an `inset()` `clip-path` on it or any ancestor. `shown` ignores
 *  opacity, so a fade-in's first frame counts; `opaque` also needs its effective opacity (the product up the
 *  ancestor chain) above 0, and is what a run's last frame must have. */
function subjectState(
	page: Page,
	selector: string,
	area: Clip | undefined
): Promise<{ shown: boolean; opaque: boolean }> {
	return page.evaluate(
		([sel, a]) => {
			type R = { l: number; t: number; r: number; b: number };
			const cut = (p: R, q: R): R => ({
				l: Math.max(p.l, q.l),
				t: Math.max(p.t, q.t),
				r: Math.min(p.r, q.r),
				b: Math.min(p.b, q.b)
			});
			const rect = (el: Element): R => {
				const r = el.getBoundingClientRect();
				return { l: r.left, t: r.top, r: r.right, b: r.bottom };
			};
			const opacity = (el: Element | null) => {
				let o = 1;
				for (; el; el = el.parentElement) o *= Number(getComputedStyle(el).opacity);
				return o;
			};
			// Does `el` hold fixed (and so also absolute) descendants? The usual triggers; enough for this app.
			const holdsFixed = (cs: CSSStyleDeclaration) =>
				cs.transform !== 'none' ||
				cs.translate !== 'none' ||
				cs.scale !== 'none' ||
				cs.rotate !== 'none' ||
				cs.perspective !== 'none' ||
				cs.filter !== 'none' ||
				cs.backdropFilter !== 'none' ||
				/paint|layout|strict|content/.test(cs.contain) ||
				/transform|translate|scale|rotate|perspective|filter/.test(cs.willChange);
			// The nearest ancestor whose overflow clip applies to `el`: its containing block, not just its parent.
			const containingBlock = (el: Element): Element | null => {
				const pos = getComputedStyle(el).position;
				let p = el.parentElement;
				for (; p && p !== document.body; p = p.parentElement) {
					const cs = getComputedStyle(p);
					if (cs.display === 'contents') continue; // no box, so never a containing block
					if (pos === 'fixed' ? holdsFixed(cs) : pos !== 'absolute' || cs.position !== 'static' || holdsFixed(cs))
						return p;
				}
				return null; // the viewport, which `box` already is; `body`'s overflow goes to the viewport
			};
			// shortcut: only `inset()` is measured; another shape counts as its whole border box. Upgrade if a
			// subject or its ancestors ever use circle()/polygon()/path().
			const clipPath = (el: Element, r: R): R => {
				const m = /^inset\(([^)]*?)(?:\s+round\s[^)]*)?\)$/.exec(getComputedStyle(el).clipPath);
				if (!m) return r;
				const v = m[1].trim().split(/\s+/);
				const [t, rt, b, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
				const len = (s: string, full: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * full : parseFloat(s));
				const w = r.r - r.l;
				const h = r.b - r.t;
				return { l: r.l + len(l, w), t: r.t + len(t, h), r: r.r - len(rt, w), b: r.b - len(b, h) };
			};
			const visibleRect = (el: Element): R => {
				let v = rect(el);
				// clip-path clips every descendant, fixed ones included, so it is read up the whole DOM chain.
				for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
					if (getComputedStyle(p).clipPath !== 'none') v = cut(v, clipPath(p, rect(p)));
				}
				// Overflow and paint containment clip to the padding box, per axis, along the containing-block chain.
				for (let p = containingBlock(el); p; p = containingBlock(p)) {
					const cs = getComputedStyle(p);
					if (cs.display === 'inline' || cs.display === 'contents') continue; // overflow and contain don't apply
					const paint = /paint|strict|content/.test(cs.contain);
					const r = rect(p);
					const pad: R = {
						l: r.l + p.clientLeft,
						t: r.t + p.clientTop,
						r: r.l + p.clientLeft + p.clientWidth,
						b: r.t + p.clientTop + p.clientHeight
					};
					if (paint || cs.overflowX !== 'visible') v = { ...v, l: Math.max(v.l, pad.l), r: Math.min(v.r, pad.r) };
					if (paint || cs.overflowY !== 'visible') v = { ...v, t: Math.max(v.t, pad.t), b: Math.min(v.b, pad.b) };
				}
				return v;
			};
			// A screenshot `clip` (not full-page) is in viewport px, like `getBoundingClientRect`, so no scroll offset.
			const box = a
				? { l: a.x, t: a.y, r: a.x + a.width, b: a.y + a.height }
				: { l: 0, t: 0, r: innerWidth, b: innerHeight };
			const inside = [...document.querySelectorAll(sel)].filter((el) => {
				if (getComputedStyle(el).visibility === 'hidden') return false;
				const v = cut(visibleRect(el), box);
				return v.r > v.l && v.b > v.t;
			});
			return { shown: inside.length > 0, opaque: inside.some((el) => opacity(el) > 0) };
		},
		[selector, area ?? null] as const
	);
}

/** Pause-and-seek capture. Returns frames at -1 (pre-trigger), 0, step, … endTime, and the settled end, plus the
 *  times of any frame after the trigger that did not show the subject inside `area` (the last frame also needs
 *  it opaque), and the timeouts a `holdTimers` row dropped. The page is frozen, so a frame and its check agree. */
async function seekRun(page: Page, s: MotionScenario, clip: Clip | undefined, area: Clip | undefined, step: number) {
	const shot = (c = clip) => page.screenshot({ clip: c, caret: 'hide', animations: 'allow' });
	const missingMs: number[] = [];
	const check = async (ms: number, last: boolean) => {
		const st = await subjectState(page, s.subject, area);
		if (!st.shown || (last && !st.opaque)) missingMs.push(ms);
	};
	const heldTimers = () =>
		page.evaluate(
			() => (window as unknown as { __motion: { held: { delayMs: number; atMs: number }[] } }).__motion.held
		);
	const pre = await shot();
	await page.evaluate(
		(only) => (window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(true, only),
		s.only ?? null
	);
	await s.trigger(page);
	if (s.holdTimers)
		await page.evaluate(() => ((window as unknown as { __motion: { hold: boolean } }).__motion.hold = true));
	// Nothing animated: a CUT. Keep the after frame too, so the strip shows the jump instead of only the before.
	if (!(await waitForCatch(page, s.startTimeoutMs ?? 3000))) {
		const after = await shot();
		await check(0, true);
		return {
			frames: [
				{ ms: -1, png: pre },
				{ ms: 0, png: after }
			],
			animations: [],
			missingMs,
			heldTimers: await heldTimers()
		};
	}
	const animations = await page.evaluate(describeCaught, 'caught');
	const end = Math.max(...animations.map((a) => (Number.isFinite(a.endTimeMs) ? a.endTimeMs : a.durationMs)));
	const frames: Frame[] = [{ ms: -1, png: pre }];
	const times: number[] = [];
	for (let t = 0; t < end; t += step) times.push(t);
	times.push(end);
	for (const [i, t] of times.entries()) {
		await page.evaluate((ms) => {
			for (const a of (window as unknown as { __motion: { caught: Animation[] } }).__motion.caught) a.currentTime = ms;
		}, t);
		frames.push({ ms: Math.round(t), png: await shot() });
		await check(Math.round(t), i === times.length - 1);
	}
	return { frames, animations, missingMs, heldTimers: await heldTimers() };
}

async function liveRun(page: Page, s: MotionScenario): Promise<LiveReport> {
	await page.evaluate(
		(only) =>
			(window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(false, only),
		s.only ?? null
	);
	const t0 = Date.now();
	await s.trigger(page);
	const caught = await waitForCatch(page, s.startTimeoutMs ?? 3000);
	const animations = caught ? await page.evaluate(describeCaught, 'caught') : [];
	const end = animations.length ? Math.max(...animations.map((a) => a.endTimeMs)) : 0;
	// Run past the end by a vsync-generous margin so the settle frame is counted too.
	await page.waitForTimeout(Math.max(0, end + 150 - (Date.now() - t0)));
	const raw = await page.evaluate(() => {
		const m = (
			window as unknown as {
				__motion: {
					armed: boolean;
					raf: number[];
					loaf: number[];
					loafSupported: boolean;
					shifts: { value: number; hadRecentInput: boolean }[];
				};
			}
		).__motion;
		m.armed = false;
		return { raf: m.raf, loaf: m.loaf, loafSupported: m.loafSupported, shifts: m.shifts };
	});
	const others = await page.evaluate(describeCaught, 'others');
	const iv = raw.raf.slice(1).map((t, i) => t - raw.raf[i]);
	const sorted = [...iv].sort((a, b) => a - b);
	const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
	const median = q(0.5) || 16.7;
	const r1 = (n: number) => Math.round(n * 10) / 10;
	return {
		animations,
		others,
		windowMs: Math.round(raw.raf.length ? raw.raf[raw.raf.length - 1] - raw.raf[0] : 0),
		rafFrames: raw.raf.length,
		frameIntervalsMs: { p50: r1(median), p95: r1(q(0.95)), max: r1(sorted[sorted.length - 1] ?? 0) },
		droppedFrames: iv.filter((d) => d > median * 1.5).length,
		longAnimationFrames: {
			count: raw.loaf.length,
			worstMs: r1(Math.max(0, ...raw.loaf)),
			supported: raw.loafSupported
		},
		cls: {
			total: Number(raw.shifts.reduce((n, e) => n + e.value, 0).toFixed(4)),
			excludingRecentInput: Number(
				raw.shifts
					.filter((e) => !e.hadRecentInput)
					.reduce((n, e) => n + e.value, 0)
					.toFixed(4)
			),
			entries: raw.shifts.length
		}
	};
}

/** Under reduce there is usually nothing to seek, so this is a real-time burst: screenshots as fast as they come.
 *  The page is live here, so the subject is read just before AND just after each shot, and a frame is missing only
 *  when both reads miss it (the last frame: when neither has it opaque). */
async function reducedRun(page: Page, s: MotionScenario, clip: Clip | undefined, windowMs: number) {
	const pre = await page.screenshot({ clip, caret: 'hide' });
	await page.evaluate(
		(only) =>
			(window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(false, only),
		s.only ?? null
	);
	await s.trigger(page);
	// Timed from the trigger RESOLVING: a clock-driven trigger (the TV's) can spend seconds waiting first.
	const t0 = Date.now();
	const frames: Frame[] = [{ ms: -1, png: pre }];
	const missingMs: number[] = [];
	let last = { ms: 0, opaque: false };
	while (Date.now() - t0 < windowMs) {
		const ms = Date.now() - t0;
		const before = await subjectState(page, s.subject, clip);
		frames.push({ ms, png: await page.screenshot({ clip, caret: 'hide' }) });
		const after = await subjectState(page, s.subject, clip);
		if (!before.shown && !after.shown) missingMs.push(ms);
		last = { ms, opaque: before.opaque || after.opaque };
	}
	if (!last.opaque && !missingMs.includes(last.ms)) missingMs.push(last.ms);
	const animations = await page.evaluate(describeCaught, 'caught');
	const others = await page.evaluate(describeCaught, 'others');
	return { frames, animations, others, missingMs };
}

// ── encoders ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * GIF at real-time pacing. GIF delays are in 10 ms units and browsers clamp anything under 20 ms to ~100 ms,
 * so a frame's delay is never below 20 — a 120 ms motion with 12 ms steps plays slightly slow rather than 5×
 * slow. `hold` frames before and after are what make the loop readable.
 */
function encodeGif(frames: Frame[], step: number, { holdMs = 700, slow = 1 } = {}): Buffer {
	const gif = GIFEncoder();
	frames.forEach((f, i) => {
		const img = PNG.sync.read(f.png);
		const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
		const palette = quantize(rgba, 256);
		const index = applyPalette(rgba, palette);
		const last = i === frames.length - 1;
		const delay = f.ms < 0 || last ? holdMs : Math.max(20, Math.round((step * slow) / 10) * 10);
		gif.writeFrame(index, img.width, img.height, { palette, delay });
	});
	gif.finish();
	return Buffer.from(gif.bytes());
}

/** Cut `clip` (page CSS px) out of a frame that was shot at `origin` (or the viewport) and `scale`. */
function crop(png: Buffer, clip: Clip, origin: Clip | undefined, scale: number): Buffer {
	const src = PNG.sync.read(png);
	const x = Math.max(0, Math.round((clip.x - (origin?.x ?? 0)) * scale));
	const y = Math.max(0, Math.round((clip.y - (origin?.y ?? 0)) * scale));
	const w = Math.min(src.width - x, Math.round(clip.width * scale));
	const h = Math.min(src.height - y, Math.round(clip.height * scale));
	const dst = new PNG({ width: w, height: h });
	PNG.bitblt(src, dst, x, y, w, h, 0, 0);
	return PNG.sync.write(dst);
}

/** The contact sheet, laid out as HTML and photographed — labels in a real font with no image library. */
async function filmstrip(
	browser: Browser,
	title: string,
	sub: string,
	frames: Frame[],
	columns: number
): Promise<Buffer> {
	const { width, height } = PNG.sync.read(frames[0].png);
	const thumbW = Math.min(width, Math.floor(1900 / columns) - 12);
	const thumbH = Math.round((height * thumbW) / width);
	const cells = frames
		.map(
			(f, i) =>
				`<figure><img src="data:image/png;base64,${f.png.toString('base64')}" width="${thumbW}" height="${thumbH}"><figcaption><b>${
					f.ms < 0 ? 'before' : `${f.ms} ms`
				}</b><span>#${i}</span></figcaption></figure>`
		)
		.join('');
	const html = `<!doctype html><style>
		body{margin:0;padding:12px;background:#111;color:#eee;font:14px system-ui,sans-serif;width:max-content}
		h1{font-size:16px;margin:0 0 2px}p{margin:0 0 10px;color:#aaa;max-width:${columns * (thumbW + 12)}px}
		main{display:grid;grid-template-columns:repeat(${columns},${thumbW}px);gap:12px}
		figure{margin:0}img{display:block;outline:1px solid #444;image-rendering:auto}
		figcaption{display:flex;justify-content:space-between;padding-top:3px;font-variant-numeric:tabular-nums}
		b{color:#ffd166}span{color:#777}</style><h1>${title}</h1><p>${sub}</p><main>${cells}</main>`;
	const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 400, height: 300 } });
	const page = await ctx.newPage();
	await page.setContent(html);
	const png = await page.locator('body').screenshot();
	await ctx.close();
	return png;
}

/** Live runs per capture; `MOTION_LIVE_RUNS` overrides. Three is the fewest that has a median. */
const LIVE_RUNS = Math.max(1, Number(process.env.MOTION_LIVE_RUNS ?? 3));

/** Check 3 and the colour half of check 8, from what the CSS authored rather than from the measured numbers. */
function tokenReport(animations: AnimationRecord[], allowed: MotionScenario['literalsAllowed']) {
	const found: string[] = [];
	const unchecked: string[] = [];
	for (const a of animations) {
		const what = `${a.name} on ${a.target}`;
		if (a.kind !== 'CSSTransition' && a.kind !== 'CSSAnimation') {
			unchecked.push(`${what}: timed by script; read the diff`);
			continue;
		}
		if (!a.source.duration) found.push(`${what}: no CSS rule sets its timing`);
		for (const t of a.source.literalTimings) found.push(`${what}: literal timing ${t}`);
		if (a.source.duration && !a.source.literalTimings.length && !a.source.durationIsToken)
			found.push(`${what}: timing ${a.source.duration} is not a var(--motion-*) token`);
		for (const c of new Set(a.source.literalColours)) found.push(`${what}: literal colour ${c}`);
	}
	// The waiver covers the one line it names, exactly; a second literal on the same row is still a problem.
	const waived = allowed ? found.filter((p) => p.endsWith(allowed.match)) : [];
	const problems = found.filter((p) => !waived.includes(p));
	const summary = !animations.length
		? 'tokens: nothing caught to check'
		: problems.length
			? `TOKENS: ${problems.length} literal(s)`
			: waived.length
				? `tokens: var() tokens, plus 1 waived literal (${allowed!.reason})`
				: 'tokens: durations and colours are var() tokens';
	return { problems, waived, waiver: allowed ?? null, unchecked, summary };
}

// ── the entry point ──────────────────────────────────────────────────────────────────────────────────────

export interface CaptureResult {
	dir: string;
	files: Record<string, { path: string; bytes: number }>;
	metrics: Record<string, unknown>;
}

export async function captureMotion(browser: Browser, s: MotionScenario, outRoot: string): Promise<CaptureResult> {
	const dir = join(outRoot, s.name);
	mkdirSync(dir, { recursive: true });
	const step = s.stepMs ?? 33;
	const scale = s.scale ?? 1;
	const cols = s.columns ?? 6;
	const timing: Record<string, number> = {};
	const clock = async <T>(label: string, fn: () => Promise<T>) => {
		const t = Date.now();
		const r = await fn();
		timing[label] = Date.now() - t;
		return r;
	};
	const files: CaptureResult['files'] = {};
	const write = (name: string, buf: Buffer | string) => {
		const path = join(dir, name);
		writeFileSync(path, buf);
		files[name] = { path, bytes: Buffer.byteLength(buf) };
	};
	const withPage = async <T>(opts: BrowserContextOptions, fn: (p: Page) => Promise<T>) => {
		const page = await s.open({ deviceScaleFactor: scale, ...opts });
		await page.addInitScript(instrument);
		// `addInitScript` reaches only documents loaded AFTER it, and `open` has already loaded this one, so the
		// instrument is also installed into the current document in place. No reload: the open state stays as is.
		await page.evaluate(instrument);
		try {
			return await fn(page);
		} finally {
			await page.context().close();
		}
	};

	// 1. SEEK — full-motion, paused and stepped.
	const seek = await clock('seekMs', () =>
		withPage({}, async (page) => {
			const gifClip = s.gifClip ? await s.gifClip(page) : undefined;
			const stripClip = s.stripClip ? await s.stripClip(page) : gifClip;
			// The GIF and the strip may want different crops, so frames are shot once at the union (the GIF clip)
			// and the strip is re-shot only when its crop differs.
			const gifRun = await seekRun(page, s, gifClip, stripClip, step);
			return { gifRun, stripClip, gifClip, observed: await s.observe?.(page) };
		})
	);
	// The strip is a crop of the GIF's frames, not a second run: one seek pass per animation.
	const stripFrames =
		seek.stripClip && seek.stripClip !== seek.gifClip
			? seek.gifRun.frames.map((f) => ({ ms: f.ms, png: crop(f.png, seek.stripClip!, seek.gifClip, scale) }))
			: seek.gifRun.frames;
	const motionEnd = Math.max(0, ...seek.gifRun.animations.map((a) => a.endTimeMs));
	const tokens = tokenReport(seek.gifRun.animations, s.literalsAllowed);

	await clock('encodeMs', async () => {
		write('clip.gif', encodeGif(seek.gifRun.frames, step));
		write('clip-slow4x.gif', encodeGif(seek.gifRun.frames, step, { slow: 4 }));
		write(
			'filmstrip.png',
			await filmstrip(
				browser,
				`${s.name} — seek-rendered, ${step} ms steps`,
				`${s.what} · frames are exact animation times (paused + currentTime), not wall-clock samples · ${tokens.summary} · ${
					seek.gifRun.missingMs.length
						? `SUBJECT ${s.subject} MISSING at ${seek.gifRun.missingMs.join(', ')} ms`
						: `subject ${s.subject} in every frame`
				}${s.holdTimers ? ` · ${seek.gifRun.heldTimers.length} ${seek.gifRun.heldTimers.length === 1 ? 'timer' : 'timers'} held` : ''}`,
				stripFrames,
				cols
			)
		);
	});

	// 2. LIVE — real-time cadence, long frames, CLS. One run is noise (the same row gave 5 to 12 dropped frames on
	// identical code), so it runs LIVE_RUNS times and the median is the number to compare.
	const liveRuns: (LiveReport & { observed: unknown })[] = [];
	await clock('liveMs', async () => {
		for (let i = 0; i < LIVE_RUNS; i++)
			liveRuns.push(
				await withPage({}, async (page) => ({ ...(await liveRun(page, s)), observed: await s.observe?.(page) }))
			);
	});
	const median = (pick: (r: LiveReport) => number) => {
		const v = liveRuns.map(pick).sort((a, b) => a - b);
		return { median: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] };
	};
	// Only the median and range of each cadence number: a single run's value is the noise this exists to avoid.
	// What ran in the window (subject and others) is the same every run, so the first run's list stands for all.
	const live = {
		runs: liveRuns.length,
		animations: liveRuns[0].animations,
		others: liveRuns[0].others,
		observed: liveRuns[0].observed,
		droppedFrames: median((r) => r.droppedFrames),
		longAnimationFrames: median((r) => r.longAnimationFrames.count),
		longAnimationFramesSupported: liveRuns[0].longAnimationFrames.supported,
		frameIntervalP95Ms: median((r) => r.frameIntervalsMs.p95),
		clsMax: Math.max(...liveRuns.map((r) => r.cls.total))
	};

	// 3. REDUCED — the same trigger with the OS preference set.
	const reduced = await clock('reducedMs', () =>
		withPage({ reducedMotion: 'reduce' }, async (page) => {
			const clip = s.stripClip ? await s.stripClip(page) : s.gifClip ? await s.gifClip(page) : undefined;
			return {
				...(await reducedRun(page, s, clip, Math.max(300, motionEnd + 200))),
				observed: await s.observe?.(page)
			};
		})
	);
	await clock('reducedEncodeMs', async () =>
		write(
			'filmstrip-reduced.png',
			await filmstrip(
				browser,
				`${s.name} — prefers-reduced-motion: reduce, real-time burst`,
				`${reduced.animations.length} animation(s) started under reduce · labels are wall-clock ms after the trigger`,
				reduced.frames.slice(0, cols * 2),
				cols
			)
		)
	);

	const metrics = {
		scenario: s.name,
		what: s.what,
		capturedAt: new Date().toISOString(),
		stepMs: step,
		scale,
		declared: seek.gifRun.animations,
		tokens,
		motionEndMs: motionEnd,
		seekFrames: seek.gifRun.frames.length,
		seekObserved: seek.observed,
		// Frames after the trigger that do not show the row's subject. Empty, or the row captured something else.
		subject: {
			selector: s.subject,
			missingMs: { seek: seek.gifRun.missingMs, reduced: reduced.missingMs }
		},
		// The seek run's dropped timeouts, so a hold is never invisible. null: this row does not hold timers.
		heldTimers: s.holdTimers ? seek.gifRun.heldTimers : null,
		live,
		reducedMotion: {
			animationsStarted: reduced.animations.length,
			animations: reduced.animations,
			// Strict: the subject did not animate at all. Lenient: nothing that MOVES ran, anywhere on the page —
			// a cross-fade under reduce is acceptable, a slide or scale is not.
			honoured: reduced.animations.length === 0,
			noVestibularMotion: ![...reduced.animations, ...reduced.others].some((a) => a.vestibular),
			others: reduced.others,
			burstFrames: reduced.frames.length,
			observed: reduced.observed
		},
		timingsMs: timing,
		files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.bytes]))
	};
	write('metrics.json', JSON.stringify(metrics, null, 2) + '\n');
	return { dir, files, metrics };
}
