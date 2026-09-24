<!-- CodeEntry — the typed join path. One box per character rather than a free text field: the segment count teaches
	the format without an instruction line, and the boxes enforce the SERVER's restricted alphabet from the one shared
	copy. The duties are SC 3.3.1 (a rejected character states WHY, in words) and SC 3.3.2; the group is ONE accessible
	name and ONE tab stop. KNOWN HAZARD for a probe author, not a defect here: Svelte 5's `bind:value` on a rune does not
	pick up synthetic CDP input, so a probe must dispatch REAL key and paste events or the field reads as empty. -->
<script lang="ts">
	import { CODE_LENGTH, isRoomCodeChar, normalizeRoomCodeInput, CODE_EXCLUDED_NOTE } from '$lib/contract';

	interface Props {
		/** The assembled code so far, upper-cased, 0..CODE_LENGTH characters. Bindable. */
		value: string;
		/** Accessible name for the whole six-box group. */
		label?: string;
		/** Fired when every box is filled, and IT MUST CARRY THE CODE: `value` reaches the parent through the `$effect`
		 * below, on the NEXT tick, while every call to this fires synchronously from inside an input handler. A parent
		 * reading its own binding here sees the code one character short and returns silently. */
		oncomplete?: (code: string) => void;
	}
	let { value = $bindable(''), label = 'Room code', oncomplete }: Props = $props();

	// THE BOXES ARE THE SOURCE OF TRUTH and `value` is derived from them, so a parent binding always equals what is on
	// screen. A per-box array rather than slicing `value` keeps the caret and the DOM element list stable.
	const seed = normalizeRoomCodeInput(value);
	let chars = $state<string[]>(Array.from({ length: CODE_LENGTH }, (_, i) => seed[i] ?? ''));
	let inputs: HTMLInputElement[] = $state([]);
	/** Set when a keystroke was refused, cleared on the next accepted one. Announced politely. */
	let rejection = $state('');

	// Keeps `value` in lock-step with the boxes, so the parent sees the string the guest sees.
	$effect(() => {
		value = chars.join('');
	});

	const filled = $derived(chars.filter((c) => c !== '').length);
	const complete = $derived(filled === CODE_LENGTH);

	/** What the code WILL be once box `i` holds `ch` — PROJECTED, never read back: the insert path has to know whether
	 * this keystroke completes the code in the same synchronous turn that handles it, and reading a `$derived` after a
	 * write in that turn is the assumption that made the last keystroke inert. */
	function withChar(i: number, ch: string): string {
		const next = [...chars];
		next[i] = ch;
		return next.join('');
	}

	function focusBox(i: number) {
		const el = inputs[Math.max(0, Math.min(CODE_LENGTH - 1, i))];
		el?.focus();
		el?.select();
	}

	// `beforeinput` is where a bad character is stopped, because preventDefault here means the box never shows
	// it and `value` never carries a character the server would reject (SC 3.3.1, with a stated reason).
	function onBeforeInput(e: InputEvent, i: number) {
		// Deletions and non-insert intents fall through to the native handler and onkeydown.
		if (!e.data) return;
		if (e.inputType === 'insertFromPaste') return; // handled by onPaste for the multi-box fill
		const up = e.data.toUpperCase();
		if (e.data.length === 1 && isRoomCodeChar(e.data)) {
			e.preventDefault();
			rejection = '';
			const assembled = withChar(i, up);
			setChar(i, up);
			if (i < CODE_LENGTH - 1) focusBox(i + 1);
			else if (assembled.length === CODE_LENGTH) oncomplete?.(assembled);
			return;
		}
		// Anything else is refused WITH the allowed set stated, never silently swallowed (SC 3.3.1).
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
				if (complete) oncomplete?.(chars.join(''));
				break;
		}
	}

	// A whole-code paste into ANY box fills every box: the code is copied off the TV as one string. Same shared filter.
	function onPaste(e: ClipboardEvent, i: number) {
		const raw = e.clipboardData?.getData('text') ?? '';
		const cleaned = normalizeRoomCodeInput(raw);
		if (!cleaned) return; // nothing usable — let the native paste no-op
		e.preventDefault();
		const next = [...chars];
		// A single character lands in the focused box; a longer paste fills from the START, which is what a whole-code paste
		// means regardless of which box was focused.
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
		if (next.every((c) => c !== '')) oncomplete?.(next.join(''));
	}
</script>

<!-- role=group with aria-labelledby gives the boxes ONE accessible name, so a screen reader announces the
     field once rather than once per unlabelled box. -->
<div class="code-entry" role="group" aria-labelledby="code-entry-label">
	<span id="code-entry-label" class="code-label">{label}</span>
	<div class="segments">
		<!-- `name` is purely the identity the platform asks for — without it the browser reports a missing id-or-name once
				per box on the first screen of the app. Autofill is already declined. -->
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
				name={`code-${i + 1}`}
				aria-label={`Character ${i + 1} of ${CODE_LENGTH}`}
				onbeforeinput={(e) => onBeforeInput(e as InputEvent, i)}
				onkeydown={(e) => onKeyDown(e, i)}
				onpaste={(e) => onPaste(e, i)}
			/>
		{/each}
	</div>

	<!-- THE REJECTION REASON ONLY (SC 3.3.1), on one polite live region so a refused keystroke is announced without
			interrupting typing. No progress count: the boxes ARE the progress indicator. The region STAYS MOUNTED rather than
			being conditional markup, so a rejection announces on a region assistive tech is already watching. -->
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
	/* The shared eyebrow idiom, for a group that carries its own accessible name. */
	.code-label {
		font-size: var(--ph-text-sm);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	/* The boxes size to the row rather than to a fixed width, so they fit a narrow phone and grow on a wider one
	   without ever wrapping mid-code. */
	.segments {
		display: flex;
		gap: var(--space-sm);
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
