<!-- Internal processing dashboard, ungated on the LAN. Rates, not raw seconds. docs/FRONTEND.md#metrics -->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { dur, stepLabel, stageLabel, pct, vsClaimed, separatorLabel, count } from '$lib/metrics-format';
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
		sample: { attempts: number; processes: number; provisional: boolean };
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

	/** Marked in the table, because comparing mixed units down a column is arithmetic, not a glance. */
	const slowestStep = $derived.by(() => {
		if (!metrics || metrics.steps.length === 0) return null;
		return metrics.steps.reduce((best, s) => ((s.meanMs ?? 0) > (best.meanMs ?? 0) ? s : best)).jobType;
	});

	onMount(async () => {
		try {
			const res = await fetch('/api/metrics');
			if (!res.ok) throw new Error(String(res.status));
			metrics = await res.json();
		} catch {
			failed = true;
		}
	});

	/** `host` is an open bag, so an unexpected or absent key is skipped rather than thrown on. */
	const HOST_LABELS: Record<string, string> = {
		accelerator: 'accelerator',
		deviceName: 'device',
		cpuCount: 'cpus',
		platform: 'platform',
		python: 'python',
		torch: 'torch',
		contained: 'contained'
	};
	function hostFacts(host: Record<string, unknown>): [string, string][] {
		return Object.entries(HOST_LABELS)
			.map(([key, label]): [string, string] => [label, host[key] == null ? '' : String(host[key])])
			.filter(([, value]) => value !== '');
	}
</script>

<svelte:head><title>Encore — metrics</title></svelte:head>

<section class="metrics">
	<!-- Keep `title="Processing metrics"` a literal here and on <main>: tests/playwright/world/selectors.ts anchors it. -->
	<PageHeader title="Processing metrics" back={{ href: '/settings', label: 'Back to settings' }} />

	<main aria-label="Processing metrics">
		{#if failed}
			<Alert.Root variant="destructive"><Alert.Title>Could not load metrics.</Alert.Title></Alert.Root>
		{:else}
			<!-- Worker state leads: with none connected, every timing below is history, not live state. -->
			{#if metrics && metrics.workers.length === 0}
				<!-- `role="status"`, not `alert`: phone-inventory.test.ts requires these live regions to be polite. -->
				<Alert.Root variant="warn" role="status">
					<Alert.Title>No worker connected — songs can't be processed right now.</Alert.Title>
				</Alert.Root>
			{/if}

			<!-- This live region must OUTLIVE the load: one created by it arrives already holding its message. -->
			<p class="note" role="status">
				{#if !metrics}
					Loading…
				{:else}
					{count(metrics.sample.attempts, 'run')} across {count(metrics.sample.processes, 'song')}.
					{#if metrics.sample.provisional}<strong>Too few to trust the averages yet.</strong>{/if}
				{/if}
			</p>

			{#if metrics}
				<Card.Root>
					<Card.Header>
						<Card.Title>From request to ready to sing</Card.Title>
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
						<Card.Title>Each step</Card.Title>
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
											<Table.Head scope="col">runs</Table.Head>
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
												<Table.Cell><span class:lead={s.jobType === slowestStep}>{dur(s.meanMs)}</span></Table.Cell>
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
						<Card.Title>Vocal removal speed</Card.Title>
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
														class:slower={(r.ratioToDeclared ?? 1) > 1.5}
														class:faster={r.ratioToDeclared !== null && r.ratioToDeclared < 0.67}
														>{vsClaimed(r.ratioToDeclared)}</span
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
						<Card.Title>Lyrics transcription</Card.Title>
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
							<Card.Title>Where the time goes</Card.Title>
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
							<Card.Title>Slowest songs</Card.Title>
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
						<Card.Title>Workers</Card.Title>
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
