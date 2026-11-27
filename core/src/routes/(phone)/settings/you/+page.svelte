<!-- THE YOU SCOPE: one person's name and colour, and the way out of the room. Its one door is the identity chip in the
	Sing tab's topbar, which is also where `close` lands. No settings write happens here — the two controls patch
	`/api/me` — so this route loads no settings object at all. docs/FRONTEND.md#settings -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import '$lib/ui/settings-cards.css';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { safeNextPath } from '$lib/next-path';
	import ColourRing from '$lib/components/ColourRing.svelte';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { leaveCostSentence, type LeaveCost } from '$lib/phrasing/leave-cost-sentence';
	import { room } from '$lib/stores/room';
	import type { PublicSinger } from '$lib/contract';
	import Spotlight from '$lib/ui/Spotlight.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import Icon from '$lib/ui/Icon.svelte';
	import { resolve } from '$app/paths';

	interface KeepState {
		kept: boolean;
		canKeep: boolean;
		otherPhones: number;
	}
	interface YearState {
		year: number;
		nights: number;
		songs: number;
		mostSung: { title: string | null; times: number } | null;
	}
	interface NightsState {
		recording: boolean;
		list: { id: string; when: string; songs: number }[];
		year: YearState;
		/** The core's zone, which `year` was counted in. */
		zone: string;
	}
	interface Props {
		data: {
			/** You, without the session token — the load strips it before the page is serialised. */
			me: PublicSinger;
			keep: KeepState;
			nights: NightsState;
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
	/** What a leave would cost, fetched when the confirm opens so it can state the price in numbers. `null` is NOT
	 * ZERO — see leave-cost-sentence.ts, which owns that distinction. */
	let leaveCost = $state<LeaveCost | null>(null);
	/* A BARE STRING, not draft-keyed the way `profileRefusal` is: a leave has no draft for a reason to be about, its
	   whole subject is the dialog that is open, and `askLeave` clears it on every open — so it cannot outlive the
	   attempt that produced it the way a bare profile refusal once outlived its name. */
	let leaveRefusal = $state('');
	/** One wording for both failure modes: a guest does not need to know whether the server refused or the wifi did. */
	const LEAVE_REFUSAL = 'Could not leave the room — try again.';

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

	/* Fetched on OPEN so the number is current when read out, and best-effort so a failure cannot block.
	   BOTH STATEMENTS ARE CLEARED BEFORE THE DIALOG OPENS, because both belong to one attempt: a reopen that kept the
	   last open's `leaveCost` would state a price this open has not asked about, and a refusal left standing would
	   explain a leave the guest is no longer making. With the cost nulled, the second open reads the number-free
	   sentence until its own fetch lands instead of the carried-over count. */
	async function askLeave() {
		leaveCost = null;
		leaveRefusal = '';
		confirmingLeave = true;
		try {
			const res = await fetch('/api/leave');
			leaveCost = res.ok ? await res.json() : null;
		} catch {
			leaveCost = null;
		}
	}

	/* GUARDED LIKE EVERY OTHER WRITE IN THIS FILE: this was the one unwrapped fetch in it, and both ways it could fail
	   produced a lie. A REJECTION (dead wifi) escaped as an unhandled error, so execution never reached the `goto` and
	   `leaving` stayed true forever — the one action a guest cannot undo sat at "Leaving…", disabled, claiming to be in
	   progress, and closing and reopening the dialog showed the same dead label because `leaving` belongs to a
	   component that stays mounted. A 500 RESOLVED, so a catch alone would not have fired: the navigation ran anyway
	   and dropped a guest who was still a member on the Sing tab with their own name in the topbar and nothing saying
	   the leave had failed. That is why this tests `res.ok` and does not merely catch.
	   THE RESETS ARE ON THE TWO FAILURE PATHS RATHER THAN IN A `finally`: on success this component is still mounted
	   while the navigation runs, and clearing the flag there would flip the label back to "Yes, leave" mid-leave — a
	   leave that IS happening must keep saying so until the component is gone. `goto` stays OUTSIDE the try for the
	   same reason: a rejection from it arrives after the POST has already landed, so reporting it as "Could not leave
	   the room" would be a brand-new false statement. No message is read from the body either — /api/leave's only
	   non-ok answer is a 401 `join first`, which is nonsense to show somebody trying to leave. */
	async function leaveRoom() {
		leaving = true;
		leaveRefusal = '';
		// The server closes this tab's socket as part of the leave; the link must read that as this leave, not a lost session.
		const undoLeave = room.beginLeave();
		try {
			const res = await fetch('/api/leave', { method: 'POST' });
			if (!res.ok) {
				undoLeave();
				leaveRefusal = LEAVE_REFUSAL;
				leaving = false;
				return;
			}
		} catch {
			undoLeave();
			leaveRefusal = LEAVE_REFUSAL;
			leaving = false;
			return;
		}
		// The plain join screen here, and the cookie was this browser's, so its other tabs are told they left too.
		room.left();
		/* `/` AND NEVER `closeTo`: the cookie is gone, so the landing page is the only honest destination — a reload, or
		   a `?next=` pointing at any other surface, would 401 into the same place after a flash of an empty page. */
		await goto('/');
	}

	/* KEEP ME, SIGN OUT OTHER PHONES, DELETE ME. Each tap shows its outcome at once and rolls back with one line on a
	   refusal (tenet 1). Only delete asks first, since it cannot be undone. docs/FRONTEND.md#settings */
	let keep = $state<KeepState>(untrack(() => data.keep));
	let keepRefusal = $state('');
	let confirmingDelete = $state(false);

	async function keepWrite(method: 'POST' | 'DELETE', path: string, optimistic: KeepState, refusal: string) {
		const before = keep;
		keep = optimistic;
		keepRefusal = '';
		try {
			const res = await fetch(path, { method });
			if (!res.ok) throw new Error(String(res.status));
			keep = await res.json();
		} catch {
			keep = before;
			keepRefusal = refusal;
		}
	}
	const keepMe = () =>
		keepWrite(
			'POST',
			'/api/me/person',
			{ kept: true, canKeep: false, otherPhones: 0 },
			'Could not keep you — try again.'
		);
	const signOutOthers = () =>
		keepWrite('DELETE', '/api/me/person/others', { ...keep, otherPhones: 0 }, 'Could not sign them out — try again.');
	function deleteMe() {
		confirmingDelete = false;
		void keepWrite(
			'DELETE',
			'/api/me/person',
			{ kept: false, canKeep: false, otherPhones: 0 },
			'Could not delete you — try again.'
		);
	}

	/* YOUR NIGHTS: the list, keeping them, and Delete my history. Same shape as Keep me: the outcome shows at once and
	   a refusal rolls it back with one line. */
	let nights = $state<NightsState>(untrack(() => data.nights));
	let nightsRefusal = $state('');
	let confirmingForget = $state(false);
	/* ONE PATCH IN FLIGHT: a second tap while one is out is remembered, not sent alongside it, so two writes can never
	   land out of order; the last tap is what gets sent once the first answers. */
	let recordingInFlight = false;
	let recordingWanted: boolean | null = null;
	async function setRecording(recording: boolean) {
		nights = { ...nights, recording };
		nightsRefusal = '';
		if (recordingInFlight) {
			recordingWanted = recording;
			return;
		}
		recordingInFlight = true;
		let saved = !recording;
		try {
			for (let want: boolean | null = recording; want !== null;) {
				const res: Response = await fetch('/api/me/nights', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ recording: want })
				});
				if (!res.ok) throw new Error(String(res.status));
				saved = (await res.json()).recording;
				want = recordingWanted !== null && recordingWanted !== saved ? recordingWanted : null;
				recordingWanted = null;
			}
			nights = { ...nights, recording: saved };
		} catch {
			nights = { ...nights, recording: saved };
			nightsRefusal = 'Could not change that — try again.';
		} finally {
			recordingInFlight = false;
			recordingWanted = null;
		}
	}
	async function forgetNights() {
		confirmingForget = false;
		const before = nights;
		nights = { ...nights, list: [], year: { ...nights.year, nights: 0, songs: 0, mostSung: null } };
		nightsRefusal = '';
		// The trigger went with the list, so focus goes to the switch, not the page.
		await tick();
		document.getElementById('keep-nights')?.focus();
		try {
			const res = await fetch('/api/me/nights', { method: 'DELETE' });
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			// Back to the phone's year, which may have answered while the delete was out.
			nights = { ...before, year: phoneYear ?? before.year };
			nightsRefusal = 'Could not delete your history — try again.';
		}
	}
	const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

	/* YOUR YEAR is "this year" on this phone's calendar. The load counted it in the zone the phone last told core
	   (else core's own); when the phone's differs, ask once more with `?tz=` and take that answer. Best-effort: a
	   failure keeps the load's numbers. */
	let phoneYear: YearState | null = null;
	onMount(() => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!tz || tz === nights.zone) return;
		void fetch(`/api/me/nights?tz=${encodeURIComponent(tz)}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { year?: YearState } | null) => {
				if (!body?.year) return;
				phoneYear = body.year;
				// A Delete my history since the load wins: its zeros are the truth now, unless it is refused.
				if (nights.list.length) nights = { ...nights, year: body.year };
			})
			.catch(() => {});
	});

	/* Counts, not adjectives — and a cost that has not answered is UNKNOWN, never zero. The sentence itself lives in
	   $lib/phrasing so that unknown arm can be asserted without mounting anything; leave-cost-sentence.ts carries the
	   reasoning for why the `?? 0` that used to be here was the defect. */
	const leaveWarning = $derived(leaveCostSentence(leaveCost));
</script>

<SettingsScope scope={SETTINGS_SCOPES.you} back={{ href: closeTo, label: 'Back to the remote' }}>
	<!-- First, so the offer sits above the fold at 320x568 and its answer lands where the tap was. Offered only after a
			first song, never as a modal. -->
	{#if keep.canKeep}
		<Spotlight title="Keep {savedName} for next time" colour={savedColour}>
			<p class="keep-copy">Your name and colour come back on this phone. No email, no password.</p>
			<Button size="block" onclick={keepMe}>Keep me</Button>
		</Spotlight>
	{:else if keep.kept}
		<Card.Root id="kept">
			<!-- No scope mark: the You card right below carries it. -->
			<Card.Header>
				<Card.Title role="heading" aria-level={2}>{savedName} is kept on this phone</Card.Title>
			</Card.Header>
			<Card.Content>
				<p class="keep-copy">Next time, one tap and you're in.</p>
				{#if keep.otherPhones > 0}
					<Button variant="secondary" size="block" onclick={signOutOthers}>
						Sign out {keep.otherPhones === 1 ? 'the other phone' : `${keep.otherPhones} other phones`}
					</Button>
				{/if}
				<AlertDialog.Root bind:open={confirmingDelete}>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="block">Delete me</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Delete {savedName}?</AlertDialog.Title>
							<AlertDialog.Description>
								Your name, colour and past nights are removed from every phone. You stay in the room tonight as a guest.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel variant="ghost">Don't delete</AlertDialog.Cancel>
							<AlertDialog.Action variant="destructive" onclick={deleteMe}>Yes, delete me</AlertDialog.Action>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			</Card.Content>
		</Card.Root>
	{/if}
	{#if keepRefusal}<p class="err" role="alert">{keepRefusal}</p>{/if}
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

	<!-- YOUR NIGHTS: only ever yours (the load reads this phone's cookies), and no one else's numbers beside them. -->
	<Card.Root id="nights">
		<Card.Header>
			<Card.Title role="heading" aria-level={2}>Your nights</Card.Title>
		</Card.Header>
		<Card.Content>
			<!-- YOUR YEAR: your own counts, never beside anyone else's. Shown once there is a night in it. -->
			{#if nights.year.nights > 0}
				<div class="year" id="your-year">
					<p class="year-head">Your {nights.year.year}</p>
					<p class="year-count">
						{nights.year.nights}
						{nights.year.nights === 1 ? 'night' : 'nights'} · {songs(nights.year.songs)}
					</p>
					{#if nights.year.mostSung?.title}
						<p class="hint">Most sung: {nights.year.mostSung.title}, {nights.year.mostSung.times} times</p>
					{/if}
				</div>
			{/if}
			{#if nights.list.length}
				<ul class="nights">
					{#each nights.list as n (n.id)}
						<li>
							<a href={resolve('/(phone)/settings/you/nights/[id]', { id: n.id })}>
								<span>{n.when}</span><span class="n">{songs(n.songs)}<Icon name="chevron-right" /></span>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="keep-copy">
					{nights.recording ? 'Sing a song and your night shows up here.' : 'Your nights are not being kept.'}
				</p>
			{/if}
			<label class="keep-toggle" for="keep-nights">
				<Switch id="keep-nights" checked={nights.recording} onCheckedChange={setRecording} />
				Keep my nights
			</label>
			<p class="hint">Only you can see them. Off, and no new songs are kept.</p>
			{#if nights.list.length}
				<AlertDialog.Root bind:open={confirmingForget}>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="block">Delete my history</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Delete your history?</AlertDialog.Title>
							<AlertDialog.Description>
								Every night you sang is removed, here and on any phone that keeps you. Your name stays.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel variant="ghost">Don't delete</AlertDialog.Cancel>
							<AlertDialog.Action variant="destructive" onclick={forgetNights}>Yes, delete it</AlertDialog.Action>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			{/if}
			{#if nightsRefusal}<p class="err" role="alert">{nightsRefusal}</p>{/if}
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
					dismissal, which a destructive confirm must not have.
					`size="block"` because the trigger already fills this column: it is what lets the label wrap at 200% text
					instead of spilling out of both sides of its box. -->
			<AlertDialog.Root bind:open={confirmingLeave}>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="destructive" size="block" onclick={askLeave}>Leave the room</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Leave the room?</AlertDialog.Title>
						<!-- The DESCRIPTION, never a second role="alert" COPY OF ITSELF: alertdialog already announces this on
								open, so mirroring it into a live region would say it twice. -->
						<AlertDialog.Description>{leaveWarning}</AlertDialog.Description>
						<!-- A DIFFERENT STATEMENT, and the one case that does need announcing: a refusal can only arrive
								AFTER the open announcement, so it duplicates nothing, and without it a failed destructive action
								would be silent on the non-visual channel while the button quietly went back to reading "Yes, leave".
								The file's own precedent is the profile save's `<p class="err" role="alert">`. Last child of the
								HEADER, not of Content: the header's `gap-1.5` is 6px at the default root, so with .err's own 6px
								margin the measured separation from the description is 12px — Content's --space-2xl gap would have
								made it 16 + 6 = 22px, which is not a rung on the ladder. (The Tailwind gap is rem-based and the
								margin is not, so at 200% text zoom it measures 18px; the reflow is clean either way — at 320px
								with a 32px root the paragraph lays out 238px inside a 280px dialog with nothing overflowing.) -->
						{#if leaveRefusal}<p class="err" role="alert">{leaveRefusal}</p>{/if}
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
	   advisories' to the pixel, so the class carries only the ink.
	   TWO USERS NOW: the refused profile save in the card, and the refused leave inside the alertdialog. The dialog's
	   content is portalled out of this subtree, which does not matter here — the paragraph is authored in THIS file, so
	   Svelte's scoping hash travels on the element and this rule still reaches it wherever the portal puts it. */
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
	.keep-copy {
		margin: 0;
		font-size: var(--type-body);
	}
	.save-slot {
		margin-top: var(--space-lg);
	}
	.year {
		padding-bottom: var(--space-sm);
		margin-bottom: var(--space-xs);
		border-bottom: 1px solid var(--role-rule);
	}
	.year p {
		margin: 0;
	}
	.year-head {
		font-size: var(--ph-text-xs);
		font-weight: 600;
		color: var(--role-ink-dim);
	}
	.year-count {
		font-size: var(--type-title);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.nights {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.nights a {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-sm);
		min-height: 44px;
		color: inherit;
		font-size: var(--type-body);
		font-weight: 600;
		text-decoration: none;
	}
	.nights li + li {
		border-top: 1px solid var(--role-rule);
	}
	.nights .n {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2xs);
		color: var(--role-ink-dim);
		font-weight: 400;
	}
	.keep-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-height: 44px;
		margin-top: var(--space-sm);
		font-size: var(--type-body);
	}
	.hint {
		margin: 0;
		font-size: var(--ph-text-xs);
		color: var(--role-ink-dim);
	}
</style>
