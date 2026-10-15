<!-- Internal processing dashboard, ungated on the LAN. Rates, not raw seconds. docs/FRONTEND.md#metrics -->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import {
		count,
		dur,
		hostFacts,
		pct,
		separatorLabel,
		slowestStepType,
		stageLabel,
		stepLabel,
		vsClaimed
	} from '$lib/metrics-format';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import * as Table from '$lib/components/ui/table';
	import FactList from '$lib/components/FactList.svelte';

	interface StepRow {
		jobType: string;
		n: number;
		failed: number;
		abandoned: number;
		meanMs: number | null;
		p50Ms: number | null;
		p95Ms: number | null;
		meanQueueWaitMs: number | null;
		meanRtFactor: number | null;
		provisional: boolean;
	}
	interface ModelRow {
		engine: string | null;
		model: string | null;
		n: number;
		meanRtFactor: number | null;
		declared: { rtFactor: number; provenance: string } | undefined;
		ratioToDeclared: number | null;
		provisional: boolean;
	}
	interface AsrRow {
		asrModel: string | null;
		syncMode: string | null;
		n: number;
		meanRtFactor: number | null;
		meanMs: number | null;
		provisional: boolean;
	}
	interface Metrics {
		/** `total`, `windowDays` and `clipped` are what the endpoint sends and this interface used to drop: `attempts`
		    alone is the count INSIDE an unnamed window, and when the server's row backstop bites it is the backstop
		    rendered as a measurement — the exact failure `clipped` is computed to prevent. */
		sample: {
			attempts: number;
			total: number;
			windowDays: number;
			clipped: boolean;
			processes: number;
			provisional: boolean;
		};
		steps: StepRow[];
		e2e: { n: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null };
		models: ModelRow[];
		asr: AsrRow[];
		stages: { stage: string; n: number; meanMs: number | null }[];
		slowestProcesses: {
			processingId: string;
			mediaId: string;
			title?: string | null;
			totalMs: number;
			workMs: number;
			steps: number;
		}[];
		workers: { workerId: string; capabilities: string[]; slotsFree: number; host: Record<string, unknown> | null }[];
	}

	let metrics = $state<Metrics | null>(null);
	let failed = $state(false);
	/** A reading we have, that we could not refresh. Separate from `failed`, which means we have nothing at all. */
	let stale = $state(false);

	/** Marked in the table, because comparing mixed units down a column is arithmetic, not a glance. */
	const slowestStep = $derived(metrics ? slowestStepType(metrics.steps) : null);

	/** The two facts the client used to drop on the floor. Joined HERE rather than in markup because the gap between two
	    sentences is whitespace, and whitespace between `{#if}` blocks is what Svelte trims. */
	const sampleCaveats = $derived.by(() => {
		if (!metrics) return '';
		const parts: string[] = [];
		// `clipped` is true when the row backstop bit OR a process straddled the window's older edge, so the wording
		// must not name one cause — "the most recent N of M" is false under the second.
		if (metrics.sample.clipped) parts.push('Partial sample: not every run in this window is counted.');
		// `total` is the LIFETIME finished-attempt count, not this window's population: said as "N of M" it would claim
		// every one of those attempts fell inside the window above.
		if (metrics.sample.total > metrics.sample.attempts)
			parts.push(`${count(metrics.sample.total, 'attempt')} recorded in all, including before this window.`);
		return parts.join(' ');
	});

	/* THE WORKER CLAIM IS PRESENT TENSE, so the reading behind it has to be live. A single `onMount` fetch froze
	   "No worker connected — songs can't be processed right now." at load, in BOTH directions: it stayed up after a
	   worker connected, and stayed absent after one died. /metrics is in the layout's NOT_PHONE list, which forbids an
	   ungated `room.connect()` (it would register this page as a singer) — it does not forbid polling. The endpoint
	   measures 0.03s and ~3.3kB, so a 5s poll is negligible. */
	const POLL_MS = 5_000;

	async function load() {
		try {
			const res = await fetch('/api/metrics');
			if (!res.ok) throw new Error(String(res.status));
			metrics = await res.json();
			stale = false;
			failed = false;
		} catch {
			// A FAILED POLL MUST NOT DISCARD A GOOD READING. Blanking the whole page for a 5s blip is worse than showing
			// the last reading and saying it could not be refreshed; the hard state is for having nothing to show.
			if (metrics) stale = true;
			else failed = true;
		}
	}

	onMount(() => {
		void load();
		// A backgrounded tab polls nothing, and `visibilitychange` is what makes returning to a parked one correct AT
		// ONCE rather than up to POLL_MS later.
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, POLL_MS);
		const onVisibility = () => {
			if (!document.hidden) void load();
		};
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<svelte:head><title>Encore — metrics</title></svelte:head>

<section class="metrics">
	<!-- Keep `title="Processing metrics"` a literal here and on <main>: tests/playwright/world/selectors.ts anchors it. -->
	<!-- Back to the SCOPE that links here, not to `/settings`: this page's one door is on the machine scope, and a bare
		`/settings` resolved to the room scope — so leaving from the machine settings and tapping back landed somewhere
		else, measured. -->
	<PageHeader title="Processing metrics" back={{ href: '/settings/server', label: 'Back to settings' }} />

	<main aria-label="Processing metrics">
		{#if failed}
			<Alert.Root variant="destructive"><Alert.Title>Could not load metrics.</Alert.Title></Alert.Root>
		{:else}
			<!-- `warn`, not `destructive`: a poll that missed is transient and self-healing — the next one clears this. -->
			{#if stale}
				<Alert.Root variant="warn" role="status">
					<Alert.Title>Couldn't refresh — showing the last reading.</Alert.Title>
				</Alert.Root>
			{/if}

			<!-- Worker state leads: with none connected, every timing below is history, not live state. -->
			{#if metrics && metrics.workers.length === 0}
				<!-- `role="status"`, not `alert`: a standing condition must not interrupt what the operator is reading. -->
				<Alert.Root variant="warn" role="status">
					<Alert.Title>No worker connected — songs can't be processed right now.</Alert.Title>
				</Alert.Root>
			{/if}

			<!-- This live region must OUTLIVE the load: one created by it arrives already holding its message. -->
			<p class="note" role="status">
				{#if !metrics}
					Loading…
				{:else}
					<!-- The WINDOW is named, because "0 runs" over an unnamed span reads as "nothing has ever been processed"
						 while thousands of attempts sit in the ledger. Worded like /stats' own "Party stats for the last N days." so the
						 two operator pages read alike. -->
					{count(metrics.sample.attempts, 'attempt')} in the last {count(metrics.sample.windowDays, 'day')}, across
					{count(metrics.sample.processes, 'finished song')}.
					{#if metrics.sample.provisional}<strong>Too few to trust the averages yet.</strong>{/if}
				{/if}
			</p>

			{#if sampleCaveats}
				<!-- No role: the headline above is the live region, and a 5s poll re-announcing the ledger size would talk
					 over whatever the operator is reading. -->
				<p class="note">{sampleCaveats}</p>
			{/if}

			{#if metrics}
				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>From request to ready to sing</Card.Title>
					</Card.Header>
					<Card.Content>
						<div class="kv">
							<div><span class="k">typical</span><span class="v">{dur(metrics.e2e.p50Ms)}</span></div>
							<div><span class="k">average</span><span class="v">{dur(metrics.e2e.meanMs)}</span></div>
							<div><span class="k">worst</span><span class="v">{dur(metrics.e2e.p95Ms)}</span></div>
							<div><span class="k">songs</span><span class="v">{metrics.e2e.n}</span></div>
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Each step</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if metrics.steps.length === 0}
							<Empty.Root>
								<Empty.Header>
									<Empty.Description>Nothing processed yet.</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							<div class="scroller">
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head scope="col">step</Table.Head>
											<!-- `measured`, not `runs`: this column counts the runs that got AVERAGED, which the caption below
												 says excludes failures, while the headline's "attempts" counts every sealed attempt in the
												 window. One word for two populations is what made the table contradict the line above it. -->
											<Table.Head scope="col">measured</Table.Head>
											<Table.Head scope="col">average</Table.Head>
											<Table.Head scope="col">typical</Table.Head>
											<Table.Head scope="col">worst</Table.Head>
											<Table.Head scope="col">wait</Table.Head>
											<Table.Head scope="col">% of song length</Table.Head>
											<Table.Head scope="col">failed</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each metrics.steps as s (s.jobType)}
											<Table.Row>
												<Table.Cell>
													<span class="named"
														>{stepLabel(s.jobType)}{#if s.provisional}<Badge variant="warn">few runs</Badge>{/if}</span
													>
												</Table.Cell>
												<Table.Cell>{s.n}</Table.Cell>
												<Table.Cell><span class={{ lead: s.jobType === slowestStep }}>{dur(s.meanMs)}</span></Table.Cell
												>
												<Table.Cell>{dur(s.p50Ms)}</Table.Cell>
												<Table.Cell>{dur(s.p95Ms)}</Table.Cell>
												<Table.Cell>{dur(s.meanQueueWaitMs)}</Table.Cell>
												<Table.Cell>{pct(s.meanRtFactor)}</Table.Cell>
												<Table.Cell>{s.failed + s.abandoned}</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
							<p class="note">Failed runs are left out of the averages.</p>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Vocal removal speed</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if metrics.models.length === 0}
							<Empty.Root>
								<Empty.Header>
									<Empty.Description>No vocals removed yet.</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							<div class="scroller">
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head scope="col">model</Table.Head>
											<Table.Head scope="col">runs</Table.Head>
											<Table.Head scope="col">measured here</Table.Head>
											<Table.Head scope="col">claimed</Table.Head>
											<Table.Head scope="col">vs claimed</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each metrics.models as r (String(r.engine) + String(r.model))}
											<Table.Row>
												<Table.Cell>
													<span class="named"
														>{separatorLabel(r.engine, r.model)}{#if r.provisional}<Badge variant="warn">few runs</Badge
															>{/if}</span
													>
												</Table.Cell>
												<Table.Cell>{r.n}</Table.Cell>
												<Table.Cell>{pct(r.meanRtFactor)}</Table.Cell>
												<Table.Cell>{pct(r.declared?.rtFactor ?? null)}</Table.Cell>
												<Table.Cell
													><span
														class={{
															slower: (r.ratioToDeclared ?? 1) > 1.5,
															faster: r.ratioToDeclared !== null && r.ratioToDeclared < 0.67
														}}>{vsClaimed(r.ratioToDeclared)}</span
													></Table.Cell
												>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
							<p class="note">Claimed speeds were measured once, on someone else's machine.</p>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Lyrics transcription</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if metrics.asr.length === 0}
							<Empty.Root>
								<Empty.Header>
									<Empty.Description>No lyrics timed yet.</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							<div class="scroller">
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head scope="col">model</Table.Head>
											<Table.Head scope="col">timing</Table.Head>
											<Table.Head scope="col">runs</Table.Head>
											<Table.Head scope="col">average</Table.Head>
											<Table.Head scope="col">% of song length</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each metrics.asr as r (String(r.asrModel) + String(r.syncMode))}
											<Table.Row>
												<Table.Cell>
													<span class="named"
														>{r.asrModel ?? '—'}{#if r.provisional}<Badge variant="warn">few runs</Badge>{/if}</span
													>
												</Table.Cell>
												<Table.Cell class="name">{r.syncMode ?? '—'}</Table.Cell>
												<Table.Cell>{r.n}</Table.Cell>
												<Table.Cell>{dur(r.meanMs)}</Table.Cell>
												<Table.Cell>{pct(r.meanRtFactor)}</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				{#if metrics.stages.length}
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Where the time goes</Card.Title>
						</Card.Header>
						<Card.Content>
							<Bars
								rows={metrics.stages.map((s) => ({
									label: stageLabel(s.stage),
									value: Math.round((s.meanMs ?? 0) / 1000),
									hint: count(s.n, 'run')
								}))}
								unit="s avg"
							/>
						</Card.Content>
					</Card.Root>
				{/if}

				{#if metrics.slowestProcesses.length}
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Slowest songs</Card.Title>
						</Card.Header>
						<Card.Content>
							<!-- Ranked entries: the <ol>/<li> is meaning; not Item.Title, whose clamp truncates a raw media id. -->
							<ol class="processes">
								{#each metrics.slowestProcesses as c (c.processingId)}
									<Item.Root variant="bare" size="bare">
										{#snippet child({ props })}
											<li {...props}>
												<Item.Content>
													<a href="/metrics/{c.mediaId}">{c.title ?? c.mediaId}</a>
													<Item.Description>{dur(c.workMs)} working, {c.steps} steps</Item.Description>
												</Item.Content>
												<Item.Actions><span class="v">{dur(c.totalMs)} total</span></Item.Actions>
											</li>
										{/snippet}
									</Item.Root>
								{/each}
							</ol>
						</Card.Content>
					</Card.Root>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Workers</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if metrics.workers.length === 0}
							<Empty.Root>
								<Empty.Header>
									<Empty.Description>Nothing is connected, so no song can be processed.</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							{#each metrics.workers as w (w.workerId)}
								<div class="worker">
									<strong>{w.workerId}</strong>
									<span class="note">{w.capabilities.join(', ')} · {w.slotsFree} free</span>
									{#if w.host}<FactList facts={hostFacts(w.host)} />{/if}
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>
			{/if}
		{/if}
	</main>
</section>

<style>
	/* Gaps and pads on this page stay in rem for the same reason /stats' do: the --space-* ladder is flat px, so tokenising
	   them would freeze the spacing while the rem type they separate keeps growing. The one value here with a token twin is
	   the 1rem gap, and sweeping the root font-size the way text-only zoom does is what shows the trap: at 100% `1rem` and
	   `var(--space-2xl)` both compute 16px, so the rem spelling reads as an oversight; at 200% the rem gap tracks
	   --ph-text-base to 32px while the token stays frozen at 16px, so gap-to-type holds at 1.00 in rem and halves to 0.50
	   tokenised. The smaller values (0.6rem, 0.15rem, 0.8rem) are off-scale and have no token at all.
	   See docs/FRONTEND.md#tokens-and-which-may-never-carry-text. */
	.metrics {
		display: grid;
		/* minmax(0, 1fr), never the implicit `auto`: a track sizes to its widest child, so an 8-column table wider than the
			   viewport would stretch this column and drag the prose off-screen. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		padding: 1rem 0 3rem;
		max-width: var(--measure-grid);
		/* PageHeader caps on --page-measure, so match it here or the header and its content disagree. */
		--page-measure: var(--measure-grid);
		/* .app-shell is a centred flex column: a cap alone shrinks from the right, so keep the stretch. */
		width: 100%;
		margin-inline: auto;
	}
	main {
		display: grid;
		/* The tables are items of THIS grid, so it needs the same floor as .metrics or one wide table stretches the column. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	/* Wide numeric tables scroll rather than squash or reflow into cards: a shared right edge is what makes them readable.
	   The vendored container's own overflow is handed to .scroller below. */
	:global(.scroller [data-slot='table-container']) {
		overflow-x: visible;
		width: auto;
	}
	.scroller {
		overflow-x: auto;
		/* Room for the sticky column's own background to cover what slides under it. */
		margin: 0 -0.1rem;
		/* The pair is a `local` cover over a `scroll` shadow: the cover travels with the content and hides the shadow exactly
			   when there is nothing further that way, so a table that fits shows no fade. Keep both, keep them linear, and keep
			   them right-side only. See docs/FRONTEND.md#the-metrics-table-scroller. */
		background:
			linear-gradient(to left, var(--card) 55%, transparent) right center / 1.5rem 100% no-repeat local,
			linear-gradient(to left, var(--bg), transparent) right center / 1.25rem 100% no-repeat scroll;
	}
	/* The badge is a component, so the gap between a name and its qualifier belongs to the pairing here — a class handed
	   to the Badge would be scoped to this file and reach nothing. */
	.named {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2xs);
	}
	.lead {
		color: var(--ink);
		font-weight: 700;
	}
	.slower {
		color: var(--warn);
	}
	/* Marked in both directions: a pessimistic declared cost is as wrong for sizing as an optimistic one. */
	.faster {
		color: var(--ok);
	}
	/* Stays a hand-rolled grid, not Item.Group: that primitive is a vertical stack, and a class handed to it is scoped
	   here and cannot reach what it renders. */
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(90px, 140px));
		justify-content: start;
		gap: 0.6rem;
	}
	.kv .k {
		display: block;
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		text-transform: uppercase;
	}
	.v {
		font-size: var(--ph-text-base);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.note {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: 0.8rem 0 0;
		line-height: var(--lh-loose);
	}
	.processes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	/* --ink plus an underline, never an accent: --accent measures 3.38:1 on --card and fails AA as text, and the underline
	   is what keeps the link from being signalled by colour alone. */
	.processes a {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		display: inline-flex;
		align-items: center;
		/* The only route into the per-song audit, so it has to clear the 44px tap floor. */
		min-height: var(--tap);
		/* A title-less song shows its raw media id, which would otherwise push a 320px layout wide. */
		overflow-wrap: anywhere;
	}
	.worker {
		display: grid;
		gap: 0.15rem;
		padding-bottom: 0.6rem;
	}
	.worker .note {
		margin: 0;
		word-break: break-all;
	}
</style>
