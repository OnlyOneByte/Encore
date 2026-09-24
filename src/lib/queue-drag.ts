// The DOM half of the queue reorder gesture: measuring the list once, listening for the release somewhere the
// release can actually arrive, and putting focus back on a grip whose element no longer exists. The ARITHMETIC half
// is `$lib/reorder-mode` — nothing here decides a position. The route keeps the reactive state, because that is the
// only place it can live; what moves here is the browser wiring, which is where all three recorded defects were.
// See docs/FRONTEND.md#the-home-column.

/** Every queued row carries `.qrow`, both kinds of it — a queued row and a processing card, in DOM order. */
const QUEUE_ROW = '.qrow';

/** A row's box in viewport coordinates, which is the space `liveSortTarget` compares a drag offset in. */
export interface RowBox {
	top: number;
	height: number;
}

/**
 * The whole list's geometry, read ONCE at press time. It must be one read: rows change height while a drag is in
 * flight (a byline gains an `away` badge, another guest queues a card), and a table re-measured mid-gesture points
 * at the wrong position. Both row kinds are included because they share one list and differ in height, which is why
 * `liveSortTarget` compares centres rather than dividing by a single row height.
 */
export function measureRowBoxes(): RowBox[] {
	return [...document.querySelectorAll(QUEUE_ROW)].map((el) => {
		const box = el.getBoundingClientRect();
		return { top: box.top, height: box.height };
	});
}

/**
 * The height of the row the grip belongs to — how far its neighbours slide. Found with `closest` rather than by
 * index because the gap belongs to the row being CARRIED, and 0 when there is nothing to measure.
 */
export function measureCarriedRowHeight(grip: Element): number {
	return grip.closest(QUEUE_ROW)?.getBoundingClientRect().height ?? 0;
}

export interface DragPointerHandlers {
	/** Called with the signed vertical distance from the press, in px. */
	onMove: (offsetY: number) => void;
	onEnd: () => void;
	onCancel: () => void;
}

/**
 * Follows the pointer for the life of one gesture and returns the teardown.
 *
 * THE LISTENERS GO ON `window`, never on the grip and never behind `setPointerCapture`: the row's DOM is recreated
 * as the list reorders under the finger, so the pressed grip becomes a DETACHED node — a listener bound to it
 * delivers nothing, the release never arrives, and the drag neither moves a row nor ends.
 */
export function trackDragPointer(press: PointerEvent, handlers: DragPointerHandlers): () => void {
	const startY = press.clientY;
	const move = (ev: PointerEvent) => handlers.onMove(ev.clientY - startY);
	const end = () => handlers.onEnd();
	const cancel = () => handlers.onCancel();
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', end);
	window.addEventListener('pointercancel', cancel);
	return () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', end);
		window.removeEventListener('pointercancel', cancel);
	};
}

/**
 * Puts focus back on the grip of entry `entryId`, RE-FOUND BY ATTRIBUTE. A move recreates the row's DOM at its new
 * position, so the element the gesture began on is detached and focusing the captured reference puts focus nowhere
 * (`activeElement` was `<body>` after an Escape). `fallback` covers a row that has left the queue entirely.
 *
 * Call it after the DOM has been patched — `tick()` on the caller's side — or it searches the pre-move list.
 */
export function focusGrip(entryId: string | null, fallback?: HTMLElement | null): void {
	const moved = entryId ? (document.querySelector(`[data-grip="${CSS.escape(entryId)}"]`) as HTMLElement | null) : null;
	(moved ?? fallback)?.focus?.();
}
