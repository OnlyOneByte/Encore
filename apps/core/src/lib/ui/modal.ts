/*
 * What "modal" actually costs, in one place.
 *
 * THE BUG THIS EXISTS FOR. ProfileSheet carried `role="dialog" aria-modal="true"` and delivered none
 * of what that promises: focus never entered the sheet on open, never returned to the trigger on
 * close, Tab walked straight out into the queue behind, and Escape did nothing -- a comment on the
 * scrim claimed Escape worked *because* the scrim was a <button>, which is simply false (Escape on a
 * button is not a click). Nothing locked the page either, so on iOS a drag on the scrim scrolled the
 * room underneath the modal.
 *
 * Each of those is a separate omission and each is easy to forget again, which is the argument for a
 * module rather than a fixed copy per sheet: a future dialog gets all four by calling one function,
 * and the reasoning below is written once.
 *
 * Deliberately NOT a <Sheet> component. The two sheets in this app are not variants -- the queue
 * sheet is a persistent dock whose peek is always visible and whose page stays interactive, and
 * trapping focus inside it would break the surface it docks to. Sharing behaviour as a function lets
 * the modal sheet opt in and the dock stay out, instead of a `modal` flag that silently decides
 * whether a11y applies.
 */

/** Everything focusable a keyboard can reach, in DOM order. */
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalOptions {
	/** Called for Escape, and for anything else that should dismiss. */
	onclose: () => void;
	/**
	 * Where focus goes on open. Defaults to the first focusable in the container.
	 *
	 * Worth passing deliberately: on a phone, focusing a TEXT input also raises the keyboard, which
	 * covers the lower half of the sheet the moment it opens. A sheet whose primary action is editing
	 * text wants that; one that merely contains a text field does not.
	 */
	initial?: () => HTMLElement | null | undefined;
}

/**
 * Make `container` behave as a modal for as long as the returned disposer is uncalled.
 *
 * Returns a teardown, so the caller is an `$effect` that returns it -- the same shape every other
 * effect in this codebase uses, so cleanup cannot be forgotten separately from setup.
 */
export function modal(container: HTMLElement, opts: ModalOptions): () => void {
	const returnTo = document.activeElement as HTMLElement | null;

	const focusables = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
	(opts.initial?.() ?? focusables()[0])?.focus();

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			opts.onclose();
			return;
		}
		if (e.key !== 'Tab') return;
		const items = focusables();
		if (items.length === 0) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		// Only the two ends need handling; everything between them is the browser's own Tab order.
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
	document.addEventListener('keydown', onKeydown);

	/*
	 * Scroll lock via `position: fixed` on <body>, not `overflow: hidden` -- iOS Safari ignores the
	 * latter, which is why the room still scrolled under the sheet. The cost of the fixed approach is
	 * that the page jumps to the top unless the offset is held and restored, so it is held here.
	 */
	const body = document.body;
	const scrollY = window.scrollY;
	const prev = {
		position: body.style.position,
		top: body.style.top,
		left: body.style.left,
		right: body.style.right,
		width: body.style.width
	};
	body.style.position = 'fixed';
	body.style.top = `-${scrollY}px`;
	body.style.left = '0';
	body.style.right = '0';
	body.style.width = '100%';

	return () => {
		document.removeEventListener('keydown', onKeydown);
		body.style.position = prev.position;
		body.style.top = prev.top;
		body.style.left = prev.left;
		body.style.right = prev.right;
		body.style.width = prev.width;
		window.scrollTo(0, scrollY);
		// Restore focus AFTER the page is back, so focusing the trigger cannot scroll to a stale offset.
		returnTo?.focus?.();
	};
}
