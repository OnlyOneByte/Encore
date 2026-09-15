<!--
	CodeEntry — the typed join path (XR-PH-14). Six single-character boxes, not a free text field: the
	segment count teaches the format without an instruction line, and the boxes reflect the SERVER's
	restricted alphabet (`$lib/contract/room-code`, the one copy) so a character the server would reject
	is refused at the keystroke rather than accepted and failed at the join.

	ACCESSIBILITY IS THE POINT, not a nicety. A typed code alone is a cognitive-function test under WCAG
	SC 3.3.8, which is why the scan path sits ALONGSIDE this (the parent renders both). Here the duties
	are SC 3.3.1 (a rejected character states WHY, in words) and SC 3.3.2 (Continue's disabled state has
	a text reason, never disabled-alone). The group is ONE accessible name and the six boxes are ONE tab
	stop with arrow/backspace movement between them, so a keyboard or switch user tabs into the code once,
	not six times.

	KNOWN HAZARD (encoded in the driven-browser check, restated here for the reader): Svelte 5 `bind:value`
	on a rune does not pick up synthetic CDP input, so a probe must dispatch REAL key/paste events or the
	field reads as empty and Continue as correctly-disabled. Nothing to fix in this file — a note so a
	future probe author does not chase a phantom.
-->
<script lang="ts">
	import { CODE_LENGTH, isRoomCodeChar, normalizeRoomCodeInput, CODE_EXCLUDED_NOTE } from '$lib/contract';

	interface Props {
		/** The assembled code so far, upper-cased, 0..CODE_LENGTH characters. Bindable. */
		value: string;
		/** Accessible name for the whole six-box group. */
		label?: string;
		/** Fired when all six are present (e.g. to submit on the last keystroke). */
		oncomplete?: () => void;
	}
	let { value = $bindable(''), label = 'Room code', oncomplete }: Props = $props();

	// The boxes are the source of truth; `value` is derived from them so a parent binding always equals
	// what is on screen. Seeded from the incoming `value` so a parent that starts with a known code
	// (e.g. a prefill) shows it in the boxes; a per-box array rather than slicing `value` keeps the
	// caret and the DOM element list stable across re-renders.
	const seed = normalizeRoomCodeInput(value);
	let chars = $state<string[]>(Array.from({ length: CODE_LENGTH }, (_, i) => seed[i] ?? ''));
	let inputs: HTMLInputElement[] = $state([]);
	/** Set when a keystroke was refused, cleared on the next accepted one. Announced politely. */
	let rejection = $state('');

	// Keep `value` in lock-step with the boxes. Assigning the array element reassigns `chars` (rune), so
	// this recomputes; the parent sees the same string the user sees.
	$effect(() => {
		value = chars.join('');
	});

	const filled = $derived(chars.filter((c) => c !== '').length);
	const complete = $derived(filled === CODE_LENGTH);

	function focusBox(i: number) {
		const el = inputs[Math.max(0, Math.min(CODE_LENGTH - 1, i))];
		el?.focus();
		el?.select();
	}

	// beforeinput is where a bad character is stopped: preventDefault here means the box never shows it,
	// so `value` never carries a character the server would reject (SC 3.3.1 — with a stated reason).
	function onBeforeInput(e: InputEvent, i: number) {
		// Deletions and non-insert intents fall through to the native handler / onkeydown.
		if (!e.data) return;
		if (e.inputType === 'insertFromPaste') return; // handled by onPaste for the multi-box fill
		const up = e.data.toUpperCase();
		if (e.data.length === 1 && isRoomCodeChar(e.data)) {
			e.preventDefault();
			rejection = '';
			setChar(i, up);
			if (i < CODE_LENGTH - 1) focusBox(i + 1);
			else if (complete) oncomplete?.();
			return;
		}
		// Anything else — an excluded letter, a digit we bar, a symbol, or a multi-char composition — is
		// refused, and we SAY which characters are allowed rather than silently swallowing it.
		e.preventDefault();
		rejection = CODE_EXCLUDED_NOTE;
	}

	function setChar(i: number, ch: string) {
		const next = [...chars];
		next[i] = ch;
		chars = next;
	}

	function onKeyDown(e: KeyboardEvent, i: number) {
		switch (e.key) {
			case 'Backspace':
				e.preventDefault();
				if (chars[i]) {
					setChar(i, ''); // clear this box, stay put
				} else if (i > 0) {
					setChar(i - 1, ''); // empty box: step back and clear the previous one
					focusBox(i - 1);
				}
				rejection = '';
				break;
			case 'ArrowLeft':
				e.preventDefault();
				focusBox(i - 1);
				break;
			case 'ArrowRight':
				e.preventDefault();
				focusBox(i + 1);
				break;
			case 'Enter':
				if (complete) oncomplete?.();
				break;
		}
	}

	// A 6-char paste into ANY box fills all six (XR-PH-14): the code is copied off a TV as one string,
	// so making the guest place each character defeats the paste. Normalised through the same shared
	// filter, so `ABCD-23` or lower case still lands as `ABCD23`.
	function onPaste(e: ClipboardEvent, i: number) {
		const raw = e.clipboardData?.getData('text') ?? '';
		const cleaned = normalizeRoomCodeInput(raw);
		if (!cleaned) return; // nothing usable — let the native paste no-op
		e.preventDefault();
		const next = [...chars];
		// A single character pastes into the focused box; a multi-character paste fills from the start,
		// which is what a whole-code paste means regardless of which box was focused.
		if (cleaned.length === 1) {
			next[i] = cleaned;
			chars = next;
			focusBox(i + 1);
		} else {
			for (let k = 0; k < CODE_LENGTH; k++) next[k] = cleaned[k] ?? '';
			chars = next;
			focusBox(cleaned.length >= CODE_LENGTH ? CODE_LENGTH - 1 : cleaned.length);
		}
		rejection = '';
		if (next.every((c) => c !== '')) oncomplete?.();
	}
</script>

<!-- role=group + aria-labelledby gives the six boxes ONE accessible name, so a screen reader announces
     "Room code" once, not six unlabelled text fields. -->
<div class="code-entry" role="group" aria-labelledby="code-entry-label">
	<span id="code-entry-label" class="code-label">{label}</span>
	<div class="segments">
		{#each chars as ch, i (i)}
			<input
				bind:this={inputs[i]}
				class="segment card"
				value={ch}
				inputmode="text"
				autocapitalize="characters"
				autocomplete="off"
				spellcheck="false"
				maxlength="1"
				aria-label={`Character ${i + 1} of ${CODE_LENGTH}`}
				onbeforeinput={(e) => onBeforeInput(e as InputEvent, i)}
				onkeydown={(e) => onKeyDown(e, i)}
				onpaste={(e) => onPaste(e, i)}
			/>
		{/each}
	</div>

	<!--
		THE REJECTION REASON ONLY (SC 3.3.1). One polite live region so a rejected keystroke is announced
		without interrupting typing.

		The progress line that used to live here — "Enter all 6 characters to continue. N of 6 so far." —
		is GONE. It restated what six visibly empty boxes already say, and the screen was saying the same
		thing three times: this line, the "or type the six-character code" divider above the field, and the
		disabled-CTA reason below it. Six boxes ARE the progress indicator; a count of them is narration.
		The SC 3.3.2 duty it shared is still discharged, by the CTA's own reason (see JoinLanding's
		`.cta-reason`), so nothing that was required left with it.

		The region stays mounted rather than becoming conditional markup, so a rejection announces on a
		live region the AT is already watching instead of one that appears at the moment it speaks.
	-->
	<p class="code-note" role="status" aria-live="polite">
		{#if rejection}
			{rejection}
		{/if}
	</p>
</div>

<style>
	.code-entry {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	/* Eyebrow label, matching the /settings + ColourPicker field idiom (0.78rem / 0.12em / uppercase). */
	.code-label {
		font-size: var(--ph-text-sm);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.segments {
		display: flex;
		gap: var(--space-sm);
		/* The boxes size to the row rather than to a fixed width, so six of them fit a narrow phone and
		   grow on a wider one without wrapping mid-code. */
	}
	.segment {
		flex: 1 1 0;
		min-width: 0;
		aspect-ratio: 3 / 4;
		text-align: center;
		font-size: var(--ph-text-xl);
		font-weight: 700;
		text-transform: uppercase;
		color: var(--ink);
		background: var(--card);
		padding: 0;
	}
	.code-note {
		margin: 0;
		min-height: 1.2em; /* reserve the line so accepting/clearing a keystroke does not reflow the boxes */
		color: var(--ink-dim);
		font-size: var(--ph-text-md);
	}
</style>
