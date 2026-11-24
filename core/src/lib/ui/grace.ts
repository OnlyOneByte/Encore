import { PENDING_GRACE_MS } from '$lib/stores/room';

type TimerHandle = unknown;

export interface GraceOptions {
	/** Called with whether the indicator should be painted now. */
	onShow: (shown: boolean) => void;
	now?: () => number;
	setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
	clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface Grace {
	set(busy: boolean): void;
	dispose(): void;
}

/** Tenet 2's flash rule: an indicator is never painted for a wait under PENDING_GRACE_MS, and once painted it stays
 *  at least that long. Timers are injectable so a bun test can drive them. */
export function createGrace(opt: GraceOptions): Grace {
	const now = opt.now ?? (() => Date.now());
	const setTimer = opt.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = opt.clearTimeoutFn ?? ((handle: TimerHandle) => clearTimeout(handle as never));
	let shownAt: number | null = null;
	let timer: TimerHandle | null = null;
	let busy = false;
	const cancel = () => {
		if (timer !== null) clearTimer(timer);
		timer = null;
	};
	return {
		set(next) {
			if (next === busy) return;
			busy = next;
			cancel();
			if (busy) {
				if (shownAt !== null) return;
				timer = setTimer(() => {
					timer = null;
					shownAt = now();
					opt.onShow(true);
				}, PENDING_GRACE_MS);
				return;
			}
			if (shownAt === null) return;
			const hide = () => {
				timer = null;
				shownAt = null;
				opt.onShow(false);
			};
			const left = PENDING_GRACE_MS - (now() - shownAt);
			if (left <= 0) hide();
			else timer = setTimer(hide, left);
		},
		dispose: cancel
	};
}
