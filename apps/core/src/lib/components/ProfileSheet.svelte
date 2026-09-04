<!--
	ProfileSheet — your own name and colour, and the way out.

	A sheet rather than a page because it is reached mid-party from the header: a guest fixing a typo in
	their name should not lose the queue they were looking at.

	"Leave the room" lives at the bottom, apart from the fields and styled as destructive, because it is
	the one control here that cannot be undone. Its confirm NAMES the cost — how many songs go with you —
	since the remove-undo everywhere else in the app is a five-second toast, and after a leave the cookie
	is cleared and the singer forgotten, so there is nothing left to undo with.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import ColourPicker from './ColourPicker.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { PublicSinger } from '@encore/shared';

	interface Props {
		me: PublicSinger;
		open: boolean;
		onclose: () => void;
		/** Save name + colour. Resolves to an error string, or null on success. */
		onsave: (patch: { displayName: string; color: string }) => Promise<string | null>;
		/** Confirmed leave. The caller navigates away. */
		onleave: () => Promise<void>;
		/** How many of your songs a leave would un-queue, and whether one of yours is on screen now. */
		leaveCost?: { queuedCount: number; hasPlaying: boolean } | null;
	}
	let { me, open, onclose, onsave, onleave, leaveCost = null }: Props = $props();

	// `untrack` because the capture is deliberate: these are an EDITABLE DRAFT seeded from `me`, not a
	// view of it. Without it, a `singer:updated` echo of your own save would rewrite the field under the
	// cursor mid-typing. The effect below re-seeds on each open, which is the only moment a refresh is
	// wanted. Same shape the TV and settings pages use for their own drafts.
	let name = $state(untrack(() => me.displayName));
	let color = $state(untrack(() => me.color));
	let saving = $state(false);
	let error = $state('');
	let confirmingLeave = $state(false);
	let leaving = $state(false);

	// Re-seed whenever the sheet opens, so a cancelled edit does not persist as a stale draft into the
	// next open — and so a rename that landed on another device shows up rather than being overwritten.
	$effect(() => {
		if (open) {
			name = me.displayName;
			color = me.color;
			error = '';
			confirmingLeave = false;
		}
	});

	const dirty = $derived(name.trim() !== me.displayName || color !== me.color);
	const canSave = $derived(dirty && name.trim().length > 0 && !saving);

	async function save() {
		if (!canSave) return;
		saving = true;
		error = '';
		const err = await onsave({ displayName: name.trim(), color });
		saving = false;
		if (err) error = err;
		else onclose();
	}

	async function leave() {
		leaving = true;
		await onleave();
	}

	/** What the confirm says out loud. Counts, not adjectives. */
	const leaveWarning = $derived.by(() => {
		const n = leaveCost?.queuedCount ?? 0;
		const songs = n === 0 ? 'You have no songs queued' : n === 1 ? 'Your 1 queued song will be removed' : `Your ${n} queued songs will be removed`;
		const playing = leaveCost?.hasPlaying ? ' The song on screen now will finish.' : '';
		return `${songs}, and you'll need to rejoin to sing again.${playing}`;
	});
</script>

{#if open}
	<!-- The scrim is a button so a tap outside closes, and Escape works, without a keydown handler on a div. -->
	<button class="scrim" aria-label="Close profile" onclick={onclose}></button>
	<div class="sheet" role="dialog" aria-modal="true" aria-label="Your profile">
		<div class="head">
			<h2>You</h2>
			<button class="x" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
		</div>

		<label class="field" for="profile-name">Your name</label>
		<input
			id="profile-name"
			type="text"
			maxlength="32"
			bind:value={name}
			placeholder="e.g. Dana"
			autocomplete="off"
		/>

		<ColourPicker bind:value={color} label="Your color" hint="How you'll spot yourself in the queue and on the TV." />

		{#if error}<p class="err" role="alert">{error}</p>{/if}

		<button class="btn-accent save" disabled={!canSave} onclick={save}>
			{#if saving}Saving…{:else}Save{/if}
		</button>

		<div class="danger">
			{#if !confirmingLeave}
				<button class="leave" onclick={() => (confirmingLeave = true)}>Leave the room</button>
			{:else}
				<p class="warn" role="alert">{leaveWarning}</p>
				<div class="row">
					<button class="cancel" onclick={() => (confirmingLeave = false)}>Stay</button>
					<button class="leave confirm" disabled={leaving} onclick={leave}>
						{#if leaving}Leaving…{:else}Yes, leave{/if}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed; inset: 0; z-index: 40; border: 0; padding: 0;
		background: rgba(6, 6, 12, 0.62); backdrop-filter: blur(2px);
	}
	.sheet {
		position: fixed; left: 0; right: 0; bottom: 0; z-index: 41;
		max-width: var(--max-w); margin: 0 auto;
		display: flex; flex-direction: column; gap: 12px;
		padding: 18px 18px calc(18px + env(safe-area-inset-bottom));
		background: var(--card); border: 1px solid var(--line);
		border-radius: 20px 20px 0 0; box-shadow: var(--shadow);
		max-height: 88vh; overflow-y: auto;
		animation: rise 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1);
	}
	@keyframes rise { from { transform: translateY(14px); opacity: 0.6; } to { transform: none; opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }

	.head { display: flex; align-items: center; justify-content: space-between; }
	h2 { margin: 0; font-size: 1.15rem; }
	/* 44px: the same tap standard the rest of the phone holds itself to. */
	.x {
		width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--line);
		background: var(--card2); color: var(--ink-dim); cursor: pointer;
		display: grid; place-items: center;
	}
	.field { display: block; font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-dim); }
	input[type='text'] {
		padding: 14px 16px; font-size: 1.05rem; border-radius: 14px;
		border: 1px solid var(--line); background: var(--bg); color: var(--ink);
	}
	.save { padding: 15px; font-size: 1.05rem; border-radius: 15px; }
	.save:disabled { opacity: 0.45; }
	.err { margin: 0; color: var(--danger-ink); font-size: 0.88rem; }

	/*
	 * Separated by a rule and a gap, not just placed last: the fields above are reversible and this is
	 * not, so the boundary is drawn rather than implied by order.
	 */
	.danger { margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--line); }
	.leave {
		width: 100%; padding: 14px; border-radius: 14px; cursor: pointer;
		background: transparent; color: var(--danger-ink); border: 1px solid var(--danger-line);
		font-size: 0.95rem;
	}
	.leave.confirm { background: var(--danger-bg); }
	.leave:disabled { opacity: 0.5; }
	.warn { margin: 0 0 10px; font-size: 0.88rem; color: var(--danger-ink); }
	.row { display: flex; gap: 10px; }
	.row .cancel {
		flex: 1; padding: 14px; border-radius: 14px; cursor: pointer;
		background: var(--card2); color: var(--ink); border: 1px solid var(--line); font-size: 0.95rem;
	}
	.row .leave { flex: 1; }
</style>
