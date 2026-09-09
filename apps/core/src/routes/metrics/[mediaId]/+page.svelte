<!--
  /metrics/[mediaId] — the per-song audit log. The thing the feature was actually asked for: click into
  a song and read how it came to be.

  Organised by COOK, not as a flat attempt list, because "the first time we made this, then the
  upgrade" is how a reader thinks about it — and because a flat list on one media id blends distinct
  runs together, which is exactly the confusion cookId exists to remove.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { dur, stepLabel, stageLabel, localStamp, rate } from '$lib/metrics-format';
	import { formatClock } from '$lib/clock';
	import type { SelectionRecord } from '@encore/shared';

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
		// WHY the published lyric won, when the align attempt recorded it (#669). Null otherwise.
		selection: SelectionRecord | null;
	}
	interface Cook {
		cookId: string;
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
			// The guiding-track fields (#766): whether this song has a vocals stem to align, and the
			// measured guide/instrumental offset in signed ms (undefined = never measured).
			vocalsRef?: string;
			guideOffsetMs?: number;
		} | null;
		cooks: Cook[];
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

	// dur() moved to $lib/metrics-format — it had drifted from /metrics's copy, so a new job type
	// taught to one page silently showed its raw DB name on the other.
	// localStamp renders each instant in the VIEWER'S local zone (#141): the old toISOString() form
	// printed UTC with the Z sliced off, dating an evening US run to the next day.
	const stamp = (ms: number) => localStamp(ms);
	/** Only the model fields this step actually carries — a null is "not applicable", not "unknown". */
	const usedModels = (m: Record<string, string | null>) => Object.entries(m).filter(([, v]) => v);

	// STEP_LABELS/stepLabel moved to $lib/metrics-format (shared with /metrics).

	const OUTCOME_LABELS: Record<string, string> = {
		ready: 'done',
		failed: 'failed',
		abandoned: 'gave up, retried',
		canceled: 'canceled',
		running: 'running'
	};
	const outcomeLabel = (outcome: string | null) => OUTCOME_LABELS[outcome ?? 'running'] ?? outcome ?? 'running';

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

	// STAGE_LABELS/stageLabel moved to $lib/metrics-format (shared with /metrics).

	// WHY THE LYRIC WAS PICKED, in words (#669). 'agreement' means a baseline actually voted, so a
	// wrong pick there is a metric problem; 'metadata' means none could and cheap ordering stood, which
	// is the arm a new similarity metric does NOT fix — that distinction is the whole point of persisting it.
	const DECIDED_LABELS: Record<string, string> = {
		agreement: 'a baseline judged it',
		metadata: 'no baseline could judge — chosen on metadata'
	};
	const decidedLabel = (d: string) => DECIDED_LABELS[d] ?? d;
	const score = (n: number | null) => (n === null ? '—' : n.toFixed(2));
</script>

<svelte:head><title>Encore — audit {mediaId}</title></svelte:head>

<section class="audit">
	<PageHeader
		title={audit?.media?.titleCanonical ?? audit?.media?.title ?? mediaId ?? ''}
		back={{ href: '/metrics', label: 'Back to metrics' }}
	/>

	{#if error}
		<p class="note" role="alert">{error}</p>
	{:else if !audit}
		<p class="note" role="status">Loading…</p>
	{:else}
		{#if audit.media?.artistCanonical}<p class="sub">{audit.media.artistCanonical}</p>{/if}
		<p class="note">
			{#if audit.media}{formatClock(audit.media.durationSec)} long ·
			{/if}sung {audit.plays.length} times
		</p>

		{#if audit.media?.vocalsRef}
			<!--
				The MEASURED guide/instrumental offset (#766), so a wrong alignment is diagnosable here rather
				than only by ear on the party box. Shown only when this song has a guiding track (a vocals
				stem) — the only case an offset means anything. `undefined` ⇔ never measured (an older cook);
				a number, 0 included, ⇔ measured, so the two read differently.
			-->
			<p class="note">
				Guide offset:
				{#if typeof audit.media.guideOffsetMs === 'number'}
					<strong>{audit.media.guideOffsetMs} ms</strong>
					{audit.media.guideOffsetMs === 0 ? '(vocals aligned with instrumental)' : '(vocals vs instrumental)'}
				{:else}
					<strong>not measured</strong> (cooked before this was recorded)
				{/if}
			</p>
		{/if}

		{#if !audit.hasHistory}
			<div class="card">
				<p class="note">
					No history for this song — it was processed before this page existed, so its timings were never recorded.
				</p>
			</div>
		{:else}
			<p class="note">
				Each <strong>run</strong> below is one attempt at making a karaoke track. A run has several steps, and a step can
				be retried.
			</p>
		{/if}

		{#each audit.cooks as cook, i (cook.cookId)}
			<div class="card">
				<header>
					<h2>Run {i + 1}</h2>
					<span class="pill {cook.outcome}">{outcomeLabel(cook.outcome)}</span>
				</header>
				<p class="note">
					{stamp(cook.startedAt)}{#if cook.totalMs !== null}{' · took '}{dur(
							cook.totalMs
						)}{:else}{' · still going'}{/if}
				</p>

				<ol class="steps">
					{#each cook.attempts as a (a.id)}
						<li class:failed={a.outcome === 'failed'} class:abandoned={a.outcome === 'abandoned'}>
							<div class="row">
								<strong>{stepLabel(a.jobType)}</strong>
								{#if a.attempt > 1}<span class="retry">try {a.attempt}</span>{/if}
								<span class="pill {a.outcome ?? 'running'}">{outcomeLabel(a.outcome)}</span>
							</div>
							<div class="metrics-row">
								<span class="ran">{dur(a.processingMs)}</span>
								<span class="secondary">waited {dur(a.queueWaitMs)}</span>
								{#if a.rtFactor !== null}<span class="secondary">{rate(a.rtFactor)} song length</span>{/if}
								{#if a.workerId}<span class="secondary">on {a.workerId}</span>{/if}
							</div>
							{#if usedModels(a.models).length}
								<dl class="facts">
									{#each usedModels(a.models) as [k, v] (k)}
										<div>
											<dt>{factLabel(k)}</dt>
											<dd>{v}</dd>
										</div>
									{/each}
								</dl>
							{/if}
							{#if a.stages.length}
								<div class="metrics-row">
									{#each a.stages as s (s.stage)}<span class="secondary">{stageLabel(s.stage)} {dur(s.ms)}</span>{/each}
								</div>
							{/if}
							{#if a.selection}
								<div class="selection">
									{#each a.selection.choices as c (c.textSource)}
										<div class="pick">
											<span class="kept"
												>kept <strong>{c.chosen ?? '?'}</strong>{#if c.chosenScore !== null}
													({score(c.chosenScore)} from {c.votes} baseline{c.votes === 1 ? '' : 's'}){/if}</span
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
						</li>
					{/each}
				</ol>
			</div>
		{/each}

		{#if audit.plays.length}
			<div class="card">
				<h2>Sung</h2>
				<ul class="plays">
					{#each audit.plays as p (p.entryId)}<li>{stamp(p.at)}</li>{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>

<style>
	/*
	 * Capped narrower than the 1080px shell on purpose. This is a TIMELINE of short rows, and at full
	 * desktop width each row became a very long line whose start and end were hard to associate.
	 */
	.audit {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 3rem;
		max-width: 760px;
		/* The cap takes width off the right only on a flex child (.app-shell is a
		   centered flex column); width:100% keeps the stretch so margin-inline:auto
		   re-centres the full capped block instead of collapsing it to content width. */
		width: 100%;
		margin-inline: auto;
	}
	/* .card in app.css has no padding — see routes/stats/+page.svelte. */
	.card {
		padding: 1rem 1.1rem;
	}
	/* The cook owns the attempts beneath it, so its header takes full ink and a dividing rule. At
	   --ink-dim it was the same grey as the timestamp under it and barely out-ranked a step name. */
	h2 {
		font-size: 1rem;
		margin: 0;
		color: var(--ink);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.3rem;
	}
	.sub {
		margin: 0;
		color: var(--ink-dim);
	}
	.note {
		font-size: 0.75rem;
		color: var(--ink-dim);
		margin: 0.5rem 0 0;
		line-height: 1.6;
	}
	.steps {
		list-style: none;
		margin: 0.9rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	/*
	 * Each attempt is a NESTED PANEL on the cook's card, not a floating stripe. A 2px left border was
	 * the only thing marking one level of nesting, so cook and attempt read as the same depth — which
	 * is precisely the parent/child relationship cookId exists to express.
	 */
	.steps li {
		background: var(--bg2);
		border-left: 2px solid var(--line-strong);
		border-radius: var(--radius-sm);
		padding: 0.6rem 0.75rem;
	}
	/* A whole tinted block, so the eye FINDS the bad attempt instead of reading for it. The border
	   alone left a failure looking like its neighbours. */
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
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--ink);
	}
	.secondary {
		font-size: 0.75rem;
		color: var(--ink-dim);
	}
	/* Aligned pairs instead of a run-on line: keys stay dim, values take ink. */
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, max-content));
		gap: 0.2rem 1.2rem;
		margin: 0.45rem 0 0;
		font-size: 0.75rem;
	}
	.facts div {
		display: flex;
		gap: 0.35rem;
	}
	.facts dt {
		color: var(--ink-dim);
	}
	.facts dd {
		margin: 0;
		color: var(--ink);
	}
	/* WHY the lyric was picked (#669): one small block per source, each line dim so it reads as
	   provenance beside the timings rather than competing with them. */
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
		font-size: 0.78rem;
		color: var(--ink);
	}
	.suspect {
		color: var(--warn);
	}
	.retry {
		font-size: 0.72rem;
		color: var(--warn);
	}
	.pill {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--line-strong);
		color: var(--ink-dim);
		white-space: nowrap;
	}
	.pill.ready {
		color: var(--ok);
		border-color: var(--ok);
	}
	.pill.failed {
		color: var(--danger);
		border-color: var(--danger);
	}
	.pill.abandoned,
	.pill.running {
		color: var(--warn);
		border-color: var(--warn);
	}
	.err {
		font-size: 0.75rem;
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
		font-size: 0.78rem;
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		display: grid;
		gap: 0.25rem;
	}
</style>
