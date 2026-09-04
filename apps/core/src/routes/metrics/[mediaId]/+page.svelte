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
		<p class="note">{error}</p>
	{:else if !audit}
		<p class="note">Loading…</p>
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
							<div class="row note">
								<span>ran {dur(a.processingMs)}</span>
								<span>queued {dur(a.queueWaitMs)}</span>
								{#if a.rtFactor !== null}<span>{a.rtFactor.toFixed(2)}× realtime</span>{/if}
								{#if a.workerId}<span>{a.workerId}</span>{/if}
							</div>
							{#if usedModels(a.models).length}
								<div class="row note">
									{#each usedModels(a.models) as [k, v] (k)}<span>{k}: {v}</span>{/each}
								</div>
							{/if}
							{#if a.stages.length}
								<div class="row note">
									{#each a.stages as s (s.stage)}<span>{s.stage} {dur(s.ms)}</span>{/each}
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
	.audit {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 3rem;
	}
	.back a {
		color: var(--ink-dim);
		font-size: 0.82rem;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	h1 {
		font-size: 1.25rem;
		margin: 0;
	}
	h2 {
		font-size: 0.95rem;
		margin: 0;
		color: var(--ink-dim);
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
		margin: 0.8rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.steps li {
		border-left: 2px solid var(--line-strong);
		padding-left: 0.7rem;
	}
	.steps li.failed {
		border-left-color: var(--danger);
	}
	.steps li.abandoned {
		border-left-color: var(--warn);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		align-items: baseline;
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
