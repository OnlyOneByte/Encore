<!-- Per-song audit log, grouped by processingId — one id, several runs. docs/FRONTEND.md#metrics -->
<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { dur, stepLabel, stageLabel, localStamp, pct } from '$lib/metrics-format';
	import { formatClock } from '$lib/clock';
	import type { SelectionRecord } from '$lib/contract';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import * as Item from '$lib/components/ui/item';
	import FactList from '$lib/components/FactList.svelte';
	import { Badge } from '$lib/components/ui/badge';

	interface AuditAttempt {
		id: string;
		jobType: string;
		attempt: number;
		outcome: string | null;
		error: string | null;
		workerId: string | null;
		enqueuedAt: number;
		startedAt: number | null;
		finishedAt: number | null;
		queueWaitMs: number | null;
		processingMs: number | null;
		rtFactor: number | null;
		models: Record<string, string | null>;
		stages: { stage: string; ms: number }[];
		/** Why the published lyric won. Recorded by align attempts only; null elsewhere. */
		selection: SelectionRecord | null;
	}
	interface Process {
		processingId: string;
		startedAt: number;
		endedAt: number | null;
		totalMs: number | null;
		outcome: string;
		attempts: AuditAttempt[];
	}
	interface Audit {
		media: {
			id: string;
			title: string;
			titleCanonical?: string | null;
			artistCanonical?: string | null;
			durationSec: number;
			/** A vocals stem exists to align against. */
			vocalsRef?: string;
			/** The 4-channel mix was built, which is the only path a guiding track plays through. */
			guideMixRef?: string;
		} | null;
		processes: Process[];
		plays: { at: number; entryId: string }[];
		hasHistory: boolean;
	}

	let audit = $state<Audit | null>(null);
	let error = $state<string | null>(null);
	const mediaId = page.params.mediaId;

	onMount(async () => {
		try {
			const res = await fetch(`/api/audit/${mediaId}`);
			if (res.status === 404) {
				error = 'No such song.';
				return;
			}
			if (!res.ok) throw new Error(String(res.status));
			audit = await res.json();
		} catch {
			error = 'Could not load the audit log.';
		}
	});

	/** Drops nulls: a null model field is "not applicable", and FactList prints whatever it is handed. */
	const modelFacts = (models: Record<string, string | null>): [string, string][] =>
		Object.entries(models)
			.filter((entry): entry is [string, string] => Boolean(entry[1]))
			.map(([key, value]): [string, string] => [factLabel(key), value]);

	const OUTCOME_LABELS: Record<string, string> = {
		ready: 'done',
		failed: 'failed',
		abandoned: 'gave up, retried',
		canceled: 'canceled',
		running: 'running'
	};
	const outcomeLabel = (outcome: string | null) => OUTCOME_LABELS[outcome ?? 'running'] ?? outcome ?? 'running';
	/** One tone table for a run and for an attempt, which carry the same outcome vocabulary. Anything else — running,
	 * canceled, not yet reported — is in-flight, so it reads as a caution rather than a verdict. */
	const OUTCOME_TONES: Record<string, 'ok' | 'bad' | 'warn'> = { ready: 'ok', failed: 'bad', abandoned: 'bad' };
	const outcomeTone = (outcome: string | null) => OUTCOME_TONES[outcome ?? ''] ?? 'warn';

	/** The model/hardware keys, in words. `asrModel` and `syncMode` are field names, not English. */
	const FACT_LABELS: Record<string, string> = {
		engine: 'separator',
		model: 'model',
		backend: 'runtime',
		device: 'hardware',
		asrModel: 'speech model',
		syncMode: 'timing'
	};
	const factLabel = (k: string) => FACT_LABELS[k] ?? k;

	// The distinction worth keeping: 'agreement' means a baseline voted, so a wrong pick there is a metric problem;
	// 'metadata' means none could and cheap ordering stood, which a better metric does not fix.
	const DECIDED_LABELS: Record<string, string> = {
		agreement: 'a baseline judged it',
		metadata: 'no baseline could judge — chosen on metadata'
	};
	const decidedLabel = (d: string) => DECIDED_LABELS[d] ?? d;
	const score = (n: number | null) => (n === null ? '—' : n.toFixed(2));

	/** One string for the h1 and the <main> landmark's accessible name, so they cannot drift apart. */
	const pageTitle = $derived(audit?.media?.titleCanonical ?? audit?.media?.title ?? mediaId ?? '');
</script>

<svelte:head><title>Encore — audit {mediaId}</title></svelte:head>

<section class="audit">
	<PageHeader title={pageTitle} back={{ href: '/metrics', label: 'Back to metrics' }} />

	<main aria-label={pageTitle}>
		{#if error}
			<Alert.Root variant="destructive"><Alert.Title>{error}</Alert.Title></Alert.Root>
		{:else}
			<!-- This live region must OUTLIVE the load: one created by it arrives already holding its message. -->
			<p class="note" role="status">
				{#if !audit}
					Loading…
				{:else}
					{#if audit.media}{formatClock(audit.media.durationSec)} long ·
					{/if}sung {audit.plays.length} times
				{/if}
			</p>

			{#if audit}
				{#if audit.media?.artistCanonical}<p class="sub">{audit.media.artistCanonical}</p>{/if}

				{#if audit.media?.vocalsRef}
					<!-- The guide rides in channels 2/3 of the 4-channel mix, so no mix means no guiding track. -->
					<p class="note">
						Guiding track:
						{#if audit.media.guideMixRef}
							<strong>yes</strong>
						{:else}
							<strong>none</strong> — no mix was built for this song
						{/if}
					</p>
				{/if}

				{#if !audit.hasHistory}
					<Card.Root>
						<Card.Content>
							<p class="note">No timings were recorded for this song.</p>
						</Card.Content>
					</Card.Root>
				{:else}
					<p class="note">Each run below is one attempt at making the karaoke track.</p>
				{/if}

				{#each audit.processes as process, i (process.processingId)}
					<Card.Root>
						<Card.Header>
							<Card.Title>Run {i + 1}</Card.Title>
						</Card.Header>
						<Card.Content>
							<Card.Action>
								<Badge variant={outcomeTone(process.outcome)}>{outcomeLabel(process.outcome)}</Badge>
							</Card.Action>
							<p class="note">
								{localStamp(process.startedAt)}{#if process.totalMs !== null}{' · took '}{dur(
										process.totalMs
									)}{:else}{' · still going'}{/if}
							</p>

							<!-- The <li> stays via Item's `child`: `class:` is invalid on a component and .failed must land here. One
									Item.Content only — Item's base is a flex row, so a second child sits beside the first. -->
							<ol class="steps">
								{#each process.attempts as a (a.id)}
									<Item.Root variant="bare" size="bare">
										{#snippet child({ props })}
											<li {...props} class:failed={a.outcome === 'failed'} class:abandoned={a.outcome === 'abandoned'}>
												<Item.Content>
													<div class="row">
														<strong>{stepLabel(a.jobType)}</strong>
														{#if a.attempt > 1}<Badge variant="warn">try {a.attempt}</Badge>{/if}
														<Badge variant={outcomeTone(a.outcome)}>{outcomeLabel(a.outcome)}</Badge>
													</div>
													<div class="metrics-row">
														<span class="ran">{dur(a.processingMs)}</span>
														<span class="secondary">waited {dur(a.queueWaitMs)}</span>
														{#if a.rtFactor !== null}<span class="secondary">{pct(a.rtFactor)} of song length</span
															>{/if}
														{#if a.workerId}<span class="secondary">on {a.workerId}</span>{/if}
													</div>
													<FactList facts={modelFacts(a.models)} />
													{#if a.stages.length}
														<div class="metrics-row">
															{#each a.stages as s (s.stage)}<span class="secondary"
																	>{stageLabel(s.stage)} {dur(s.ms)}</span
																>{/each}
														</div>
													{/if}
													{#if a.selection}
														<div class="selection">
															{#each a.selection.choices as c (c.textSource)}
																<div class="pick">
																	<span class="kept"
																		>kept <strong>{c.chosen ?? '?'}</strong>{#if c.chosenScore !== null}
																			({score(c.chosenScore)} from {c.votes} baseline{c.votes === 1
																				? ''
																				: 's'}){/if}</span
																	>
																	<span class="secondary">{decidedLabel(c.decidedBy)}</span>
																	{#if c.rejected.length}
																		<span class="secondary"
																			>over {#each c.rejected as r, i (r.label ?? i)}{r.label ?? '?'}
																				{score(r.score)}{#if i < c.rejected.length - 1},
																				{/if}{/each}</span
																		>
																	{/if}
																</div>
															{/each}
															{#if a.selection.winnerSuspect}<span class="secondary suspect"
																	>winner disagreed with every baseline — probably the wrong song</span
																>{/if}
														</div>
													{/if}
													{#if a.error}<p class="err">{a.error}</p>{/if}
												</Item.Content>
											</li>
										{/snippet}
									</Item.Root>
								{/each}
							</ol>
						</Card.Content>
					</Card.Root>
				{/each}

				{#if audit.plays.length}
					<Card.Root>
						<Card.Header>
							<Card.Title>Sung</Card.Title>
						</Card.Header>
						<Card.Content>
							<ul class="plays">
								{#each audit.plays as p (p.entryId)}<li>{localStamp(p.at)}</li>{/each}
							</ul>
						</Card.Content>
					</Card.Root>
				{/if}
			{/if}
		{/if}
	</main>
</section>

<style>
	/* Capped below the shell: this is a timeline of short rows, and at full desktop width a row's two ends stop reading
	   as a pair. */
	.audit {
		display: grid;
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
		gap: 1rem;
	}
	.sub {
		margin: 0;
		color: var(--ink-dim);
	}
	.note {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: 0.5rem 0 0;
		line-height: var(--lh-loose);
	}
	.steps {
		list-style: none;
		margin: 0.9rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	/* An attempt is a nested panel on its run's card, so it needs its own surface as well as the rule — a border alone
	   reads as the same depth as the run above it. */
	.steps li {
		background: var(--bg2);
		border-left: 2px solid var(--line-strong);
		border-radius: var(--radius-sm);
		padding: 0.6rem 0.75rem;
	}
	/* Tint the whole block, so the eye finds the bad attempt instead of reading for it. */
	.steps li.failed {
		border-left-color: var(--danger);
		background: var(--danger-bg);
	}
	.steps li.abandoned {
		border-left-color: var(--warn);
		background: var(--card2);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		align-items: baseline;
	}
	.metrics-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.9rem;
		align-items: baseline;
		margin-top: 0.35rem;
		font-variant-numeric: tabular-nums;
	}
	.ran {
		font-size: var(--ph-text-md);
		font-weight: 600;
		color: var(--ink);
	}
	.secondary {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
	}
	/* Ink on top of .secondary rather than a Badge: this is a sentence, and a pill wrapping a sentence reads as broken. */
	.suspect {
		color: var(--warn);
	}
	.selection {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-top: 0.4rem;
		font-variant-numeric: tabular-nums;
	}
	.pick {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.7rem;
		align-items: baseline;
	}
	.kept {
		font-size: var(--ph-text-sm);
		color: var(--ink);
	}
	.err {
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
		background: var(--danger-bg);
		border: 1px solid var(--danger-line);
		border-radius: var(--radius-sm);
		padding: 0.4rem 0.55rem;
		margin: 0.5rem 0 0;
		word-break: break-word;
	}
	.plays {
		list-style: none;
		margin: 0.6rem 0 0;
		padding: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		display: grid;
		gap: 0.25rem;
	}
</style>
