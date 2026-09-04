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
	import Icon from '$lib/ui/Icon.svelte';

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
		media: { id: string; title: string; titleCanonical?: string | null; artistCanonical?: string | null; durationSec: number } | null;
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

	function dur(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}
	const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
	/** Only the model fields this step actually carries — a null is "not applicable", not "unknown". */
	const usedModels = (m: Record<string, string | null>) => Object.entries(m).filter(([, v]) => v);
</script>

<svelte:head><title>Encore — audit {mediaId}</title></svelte:head>

<section class="audit">
	<p class="back"><a href="/metrics"><Icon name="arrow-left" size="0.9em" /> metrics</a></p>

	{#if error}
		<p class="note" role="alert">{error}</p>
	{:else if !audit}
		<p class="note" role="status">Loading…</p>
	{:else}
		<h1>{audit.media?.titleCanonical ?? audit.media?.title ?? mediaId}</h1>
		{#if audit.media?.artistCanonical}<p class="sub">{audit.media.artistCanonical}</p>{/if}
		<p class="note">
			{mediaId}{#if audit.media}{' · '}{audit.media.durationSec}s{/if} · {audit.plays.length} recorded plays
		</p>

		{#if !audit.hasHistory}
			<!-- Distinguishing "never processed" from "processed before we started recording" matters: the
			     second is the normal state for every song already in an existing library. -->
			<div class="card">
				<p class="note">
					No processing history. This song was cooked before the attempt ledger existed, so its timings
					were never recorded — they are not recoverable.
				</p>
			</div>
		{/if}

		{#each audit.cooks as cook, i (cook.cookId)}
			<div class="card">
				<header>
					<h2>Cook {i + 1}</h2>
					<span class="pill {cook.outcome}">{cook.outcome}</span>
				</header>
				<p class="note">
					{stamp(cook.startedAt)} · total {dur(cook.totalMs)}
					{#if cook.totalMs === null}(still running){/if}
				</p>

				<ol class="steps">
					{#each cook.attempts as a (a.id)}
						<li class:failed={a.outcome === 'failed'} class:abandoned={a.outcome === 'abandoned'}>
							<div class="row">
								<strong>{a.jobType}</strong>
								{#if a.attempt > 1}<span class="retry">attempt {a.attempt}</span>{/if}
								<span class="pill {a.outcome ?? 'running'}">{a.outcome ?? 'running'}</span>
							</div>
							<!-- The duration is why the page exists, so it is the one bright figure. It used to sit
							     in the same muted grey and weight as the worker id beside it. -->
							<div class="metrics-row">
								<span class="ran">{dur(a.processingMs)}</span>
								<span class="secondary">queued {dur(a.queueWaitMs)}</span>
								{#if a.rtFactor !== null}<span class="secondary">{a.rtFactor.toFixed(2)}× realtime</span>{/if}
								{#if a.workerId}<span class="secondary">{a.workerId}</span>{/if}
							</div>
							{#if usedModels(a.models).length}
								<!-- A key:value grid rather than a run-on space-separated line, which became
								     untrackable once the card widened to the 1080px desktop shell. -->
								<dl class="facts">
									{#each usedModels(a.models) as [k, v] (k)}
										<div><dt>{k}</dt><dd>{v}</dd></div>
									{/each}
								</dl>
							{/if}
							{#if a.stages.length}
								<div class="metrics-row">
									{#each a.stages as s (s.stage)}<span class="secondary">{s.stage} {dur(s.ms)}</span>{/each}
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
	}
	/* .card in app.css has no padding — see routes/stats/+page.svelte. */
	.card {
		padding: 1rem 1.1rem;
	}
	.back a {
		color: var(--ink-dim);
		font-size: 0.82rem;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 32px;
	}
	h1 {
		font-size: 1.25rem;
		margin: 0;
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
