<!-- THE YOU SCOPE: one person's name and colour, and the way out of the room. Its one door is the identity chip in the
	Sing tab's topbar, which is also where `close` lands. No settings write happens here — the two controls patch
	`/api/me` — so this route loads no settings object at all. docs/FRONTEND.md#settings -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { safeNextPath } from '$lib/next-path';
	import ColourRing from '$lib/components/ColourRing.svelte';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import type { PublicSinger } from '$lib/contract';

	interface Props {
		data: {
			/** You, without the session token — the load strips it before the page is serialised. */
			me: PublicSinger;
		};
	}
	let { data }: Props = $props();

	/* ONE DESTINATION FOR BOTH HALVES OF "CLOSE", resolved through the existing open-redirect allowlist rather than
	   hardcoded: the back arrow and the commit button cannot disagree about where done is, which is the same class of
	   defect as the dual commit this pane was already fixed for. `/` is the fallback and today's only answer — the
	   identity chip in the Sing tab's topbar is this route's one door — so a caller that wants to send a guest back
	   somewhere else (a You link from the room scope, say) passes `?next=` instead of growing a second exit. */
	const closeTo = $derived(safeNextPath(page.url.searchParams.get('next'), '/'));

	/* A DRAFT seeded from `data.me`, not a view of it: `untrack` keeps an echo of your own save from rewriting the field
	   under the cursor. `savedName`/`savedColour` are what the server last confirmed, and `dirty` has to compare against
	   those — the load never re-runs, so `data.me` would leave Save enabled forever. */
	let name = $state(untrack(() => data.me.displayName));
	let colour = $state(untrack(() => data.me.color));
	let savedName = $state(untrack(() => data.me.displayName));
	let savedColour = $state(untrack(() => data.me.color));
	let saving = $state(false);
	/* A REFUSAL IS A STATEMENT ABOUT A DRAFT, so it is stored WITH the draft it was about and read back through a
	   $derived that drops it the moment either field is edited. As a bare string it outlived its subject: refuse an
	   empty name, retype the old one, and "A name is needed" sat under a button that had gone back to reading `Done`
	   — a live reason contradicting the control it was about. Keying it also makes the exit path clean without a
	   clear of its own: a refusal is only ever recorded while `profileDirty`, which means its draft differs from the
	   saved pair, so the not-dirty branch (draft === saved pair) can never match one. The key is the RAW `name`, not
	   the trimmed one the patch sends, because the guest corrects what is in the field. */
	let profileRefusal = $state<{ name: string; colour: string; message: string } | null>(null);
	let confirmingLeave = $state(false);
	let leaving = $state(false);
	/** What a leave would cost, fetched when the confirm opens so it can state the price in numbers. */
	let leaveCost = $state<{ queuedCount: number; hasPlaying: boolean } | null>(null);

	const profileDirty = $derived(name.trim() !== savedName || colour !== savedColour);
	const canSaveProfile = $derived(profileDirty && name.trim().length > 0 && !saving);
	const profileError = $derived(
		profileRefusal && profileRefusal.name === name && profileRefusal.colour === colour ? profileRefusal.message : ''
	);

	async function saveProfile() {
		if (!canSaveProfile) return;
		saving = true;
		/* The draft AS SUBMITTED, snapshotted before the await: the field stays editable while the patch is in flight,
		   and a refusal that comes back about a name the guest has already replaced is not about what they can see. */
		const submitted = { name, colour };
		profileRefusal = null;
		const patchBody = { displayName: name.trim(), color: colour };
		try {
			const res = await fetch('/api/me', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patchBody)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				profileRefusal = { ...submitted, message: body.error ?? 'Could not save that' };
				return;
			}
			savedName = patchBody.displayName;
			savedColour = patchBody.color;
			await goto(closeTo);
		} catch {
			profileRefusal = { ...submitted, message: 'Could not save that' };
		} finally {
			saving = false;
		}
	}

	/* THIS SCOPE'S ONE COMMIT, so it has to cover both jobs — commit-and-close while an edit is pending, and the
	   plain exit when none is. An empty name is refused LOCALLY, the way the machine scope refuses an address a phone
	   cannot open, rather than sent for the server to bounce with the same words or left to a disabled button that
	   states no reason. `saveProfile` owns the navigation on success and stays put with the reason on a refusal, so
	   there is no second `goto` on the save path.
	   IT IS ALSO THE ONLY COMMIT CONTROL IN ALL OF SETTINGS, and the only button on any scope that closes the page:
	   the two panel-level `Done` buttons the room and machine scopes used to end on are deleted, because under a
	   persistent tab bar a button whose whole job is `goto('/')` is a worse copy of a control already on screen. */
	async function finishYou() {
		/* DEFENSIVE NOW, not a live path: the button that calls this renders only while `profileDirty || saving`, and
		   it is `disabled` whenever `saving`, so a clean draft cannot reach here through the UI. Kept rather than
		   deleted because it is the correct answer for any future caller — committing nothing and leaving is what a
		   clean draft means — and because deleting it would make a clean-draft call navigate through the write path. */
		if (!profileDirty) {
			await goto(closeTo);
			return;
		}
		if (name.trim().length === 0) {
			profileRefusal = { name, colour, message: 'A name is needed — type one, or put your old name back.' };
			return;
		}
		await saveProfile();
	}

	/** Fetched on OPEN so the number is current when read out, and best-effort so a failure cannot block. */
	async function askLeave() {
		confirmingLeave = true;
		try {
			const res = await fetch('/api/leave');
			leaveCost = res.ok ? await res.json() : null;
		} catch {
			leaveCost = null;
		}
	}

	async function leaveRoom() {
		leaving = true;
		await fetch('/api/leave', { method: 'POST' });
		/* `/` AND NEVER `closeTo`: the cookie is gone, so the landing page is the only honest destination — a reload, or
		   a `?next=` pointing at any other surface, would 401 into the same place after a flash of an empty page. */
		await goto('/');
	}

	/** Counts, not adjectives: a leave clears the cookie and forgets the singer, so there is no undo. */
	const leaveWarning = $derived.by(() => {
		const n = leaveCost?.queuedCount ?? 0;
		const songs =
			n === 0
				? 'You have no songs queued'
				: n === 1
					? 'Your 1 queued song will be removed'
					: `Your ${n} queued songs will be removed`;
		const playing = leaveCost?.hasPlaying ? ' The song on screen now will finish.' : '';
		return `${songs}, and you'll need to rejoin to sing again.${playing}`;
	});
</script>

<SettingsScope scope={SETTINGS_SCOPES.you} back={{ href: closeTo, label: 'Back to the remote' }}>
	<!-- See the room scope for why `role="heading" aria-level={2}` is at the call site, and what `Card.Scope` is. -->
	<Card.Root id="you">
		<Card.Header>
			<Card.Scope>{SETTINGS_SCOPES.you.blastRadius}</Card.Scope>
			<Card.Title role="heading" aria-level={2}>You</Card.Title>
		</Card.Header>
		<Card.Content>
			<Field.Label for="profile-name">Your name</Field.Label>
			<Input
				id="profile-name"
				variant="comfortable"
				type="text"
				maxlength={32}
				autocomplete="off"
				placeholder="e.g. Dana"
				bind:value={name}
			/>

			<!-- `taken` is DELIBERATELY empty: the pips mean "somebody in the room holds this", and this page's load carries
					no occupancy, so an invented list would draw pips at nobody. -->
			<ColourRing
				bind:value={colour}
				label="Your color"
				hint="How you'll spot yourself in the queue and on the TV."
				taken={[]}
			/>

			{#if profileError}<p class="err" role="alert">{profileError}</p>{/if}

			<!-- ONE COMMIT CONTROL FOR THIS SCOPE, and its label says which of its two jobs it is doing. There used to
					be a second: this `Save` plus a panel-level `Done`, both the `default` variant, so from the first
					keystroke they were two identical --accent block buttons — and `Done` was a bare `goto('/')`, which
					DISCARDED the typed name and the picked colour with nothing on screen saying so. It stays INSIDE the
					card because the refusals it produces name this field ("That name is taken — try another."), and a
					reason belongs beside what has to be corrected. The cost, kept deliberately, is that this scope ends on
					the Leaving card instead of on its own exit — see FRONTEND.md's Settings section for why last belongs
					to the destructive card here. -->
			<!-- RENDERED ONLY WHEN THERE IS SOMETHING TO COMMIT, which is what makes the exit model one rule instead of
					three. It used to render unconditionally, reading `Done` with the draft clean — an --accent block button
					whose only action was a navigation, i.e. structurally the same thing as the panel-level `Done` buttons
					this rebuild deleted from the room and machine scopes, and which FRONTEND.md calls "a worse copy of the
					dock". Worse, clean-on-arrival is the state a guest ARRIVES in, so the deleted pattern was the one most
					guests actually saw.
					The rule now holds across all three scopes: the back arrow is the exit everywhere, and a commit control
					appears only where there is a draft to commit. `Saving…` stays, because a commit in flight must say so. -->
			{#if profileDirty || saving}
				<div class="save-slot">
					<Button size="block" disabled={saving} onclick={finishYou}>
						{#if saving}Saving…{:else}Save and close{/if}
					</Button>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Its own card: leaving cannot be undone, so the boundary is drawn rather than implied. -->
	<Card.Root id="leaving">
		<Card.Header>
			<Card.Scope>{SETTINGS_SCOPES.you.blastRadius}</Card.Scope>
			<Card.Title role="heading" aria-level={2}>Leaving</Card.Title>
		</Card.Header>
		<Card.Content>
			<!-- AlertDialog, not Dialog: `role="alertdialog"` announces the description on open, and it has no click-outside
					dismissal, which a destructive confirm must not have. -->
			<AlertDialog.Root bind:open={confirmingLeave}>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="destructive" onclick={askLeave}>Leave the room</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Leave the room?</AlertDialog.Title>
						<!-- The DESCRIPTION, never a second role="alert" paragraph: alertdialog already announces this on open. -->
						<AlertDialog.Description>{leaveWarning}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel variant="ghost">Stay</AlertDialog.Cancel>
						<AlertDialog.Action variant="destructive" disabled={leaving} onclick={leaveRoom}>
							{#if leaving}Leaving…{:else}Yes, leave{/if}
						</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</Card.Content>
	</Card.Root>
</SettingsScope>

<style>
	/* --danger-ink, because --warn is the transient self-healing tone the other two scopes' advisories wear
	   ("~45 minutes per song on CPU"): a rejected profile save was painted that same amber, so a guest could not tell
	   a hint from the one thing they had to act on. This is the ink the rest of the app spends on a failure —
	   `.err[role=alert]` on the join screen, the destructive Alert at the top of a scope — and the box is the
	   advisories' to the pixel, so the class carries only the ink. */
	.err {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
	}

	/* Position only, on a wrapper: Tailwind mints nothing for app source, and scoped CSS cannot reach inside a component.
	   It holds this scope's ONE accent control — commit-and-close while an edit is pending, the plain exit when none is.
	   THE SAME RUNG AS THE TWO INTER-GROUP MARGINS IN THE SHELL, and for the same reason: this is a card-content child
	   too, so what the guest sees is 8 + 12 = 20px, and a commit control is an inter-group boundary, not a section one.
	   It was `xl` until app.css retired that rung, which would now render 22px against those two at 20px. */
	.save-slot {
		margin-top: var(--space-lg);
	}
</style>
