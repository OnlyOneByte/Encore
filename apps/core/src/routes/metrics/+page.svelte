<!--
  /metrics — the INTERNAL processing dashboard. Ungated for now (see /api/metrics for why), so it is
  readable by anything on the LAN.

  The organising choice: every duration is reported as a RATE (seconds of compute per second of audio)
  wherever a rate is meaningful, because raw seconds cannot be compared across songs of different
  lengths. Sample sizes are printed next to every average and small ones are labelled, because on a box
  with a handful of cooks a mean over two renders exactly like a mean over two hundred.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';

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
		sample: { attempts: number; cooks: number; provisional: boolean };
		steps: StepRow[];
		e2e: { n: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null };
		models: ModelRow[];
		asr: AsrRow[];
		stages: { stage: string; n: number; meanMs: number | null }[];
		slowestCooks: { cookId: string; mediaId: string; totalMs: number; workMs: number; steps: number }[];
		workers: { workerId: string; capabilities: string[]; slotsFree: number; host: Record<string, unknown> | null }[];
	}

	let m = $state<Metrics | null>(null);
	let failed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/metrics');
			if (!res.ok) throw new Error(String(res.status));
			m = await res.json();
		} catch {
			failed = true;
		}
	});

	/** ms → a human duration. Null renders as an em dash, never as 0. */
	function dur(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const min = Math.floor(ms / 60_000);
		return `${min}m ${Math.round((ms % 60_000) / 1000)}s`;
	}
	function rt(v: number | null): string {
		return v === null ? '—' : `${v.toFixed(2)}×`;
	}
</script>

<svelte:head><title>Encore — metrics</title></svelte:head>

<section class="metrics">
	<h1>Processing metrics</h1>

	{#if failed}
		<p class="note">Could not load metrics.</p>
	{:else if !m}
		<p class="note">Loading…</p>
	{:else}
		<p class="note">
			{m.sample.attempts} recorded attempts across {m.sample.cooks} complete cooks.
			{#if m.sample.provisional}<strong>Small sample — treat every average below as provisional.</strong>{/if}
			History starts when the attempt ledger was deployed; anything cooked before that has no timings.
		</p>

		<div class="card">
			<h2>End to end</h2>
			<div class="kv">
				<div><span class="k">mean</span><span class="v">{dur(m.e2e.meanMs)}</span></div>
				<div><span class="k">p50</span><span class="v">{dur(m.e2e.p50Ms)}</span></div>
				<div><span class="k">p95</span><span class="v">{dur(m.e2e.p95Ms)}</span></div>
				<div><span class="k">cooks</span><span class="v">{m.e2e.n}</span></div>
			</div>
			<p class="note">Request to singable song, including time queued. Complete cooks only.</p>
		</div>

		<div class="card">
			<h2>Per step</h2>
			<table>
				<thead>
					<tr><th>step</th><th>n</th><th>mean</th><th>p50</th><th>p95</th><th>queue</th><th>rate</th><th>fail</th></tr>
				</thead>
				<tbody>
					{#each m.steps as s (s.jobType)}
						<tr>
							<td>{s.jobType}{#if s.provisional}<span class="flag" title="fewer than 10 samples">?</span>{/if}</td>
							<td>{s.n}</td>
							<td>{dur(s.meanMs)}</td>
							<td>{dur(s.p50Ms)}</td>
							<td>{dur(s.p95Ms)}</td>
							<td>{dur(s.meanQueueWaitMs)}</td>
							<td>{rt(s.meanRtFactor)}</td>
							<td>{s.failed + s.abandoned}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note">
				<strong>mean/p50/p95</strong> are processing time only — queue wait is the separate column, which is
				the distinction the job table could never express. <strong>rate</strong> is compute seconds per second
				of audio. <strong>fail</strong> counts failed plus abandoned attempts; neither is averaged into the timings.
			</p>
		</div>

		<div class="card">
			<h2>Separator models — measured vs declared</h2>
			{#if m.models.length === 0}
				<p class="note">No separation has been recorded yet.</p>
			{:else}
				<table>
					<thead><tr><th>engine / model</th><th>n</th><th>measured</th><th>declared</th><th>ratio</th></tr></thead>
					<tbody>
						{#each m.models as r (String(r.engine) + String(r.model))}
							<tr>
								<td>{r.engine ?? '—'} / {r.model ?? '—'}{#if r.provisional}<span class="flag" title="fewer than 10 samples">?</span>{/if}</td>
								<td>{r.n}</td>
								<td>{rt(r.meanRtFactor)}</td>
								<td>{r.declared ? `${r.declared.rtFactor.toFixed(2)}× (${r.declared.provenance})` : '—'}</td>
								<td class:slower={(r.ratioToDeclared ?? 0) > 1.5}>{r.ratioToDeclared === null ? '—' : `${r.ratioToDeclared.toFixed(2)}×`}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="note">
					<strong>declared</strong> is the whitelist's own <code>SeparatorCost.rtFactor</code>, benchmarked once on a
					32-core Graviton 3 — several entries say <code>estimated</code> outright. <strong>ratio</strong> is measured ÷
					declared: 1.0 means the benchmark holds on this box, 2.0 means it is twice as slow here. Slower than the
					benchmark is expected; the number is for sizing a party, not a pass/fail.
				</p>
			{/if}
		</div>

		<div class="card">
			<h2>Lyrics models</h2>
			{#if m.asr.length === 0}
				<p class="note">No alignment has been recorded yet.</p>
			{:else}
				<table>
					<thead><tr><th>ASR model</th><th>sync</th><th>n</th><th>mean</th><th>rate</th></tr></thead>
					<tbody>
						{#each m.asr as r (String(r.asrModel) + String(r.syncMode))}
							<tr>
								<td>{r.asrModel ?? '—'}{#if r.provisional}<span class="flag" title="fewer than 10 samples">?</span>{/if}</td>
								<td>{r.syncMode ?? '—'}</td>
								<td>{r.n}</td>
								<td>{dur(r.meanMs)}</td>
								<td>{rt(r.meanRtFactor)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="note">
					There is no declared cost to compare against: <code>AsrModel</code> carries a parameter count but
					deliberately no <code>rtFactor</code>, with a note not to add one until someone times these on real
					hardware. This table is that measurement.
				</p>
			{/if}
		</div>

		{#if m.stages.length}
			<div class="card">
				<h2>Where the time goes</h2>
				<Bars rows={m.stages.map((s) => ({ label: s.stage, value: Math.round((s.meanMs ?? 0) / 1000), hint: `${s.n} samples` }))} unit="s avg" />
				<p class="note">Reported by the worker per sub-step. The core can only see totals on its own.</p>
			</div>
		{/if}

		{#if m.slowestCooks.length}
			<div class="card">
				<h2>Slowest cooks</h2>
				<ol class="cooks">
					{#each m.slowestCooks as c (c.cookId)}
						<li>
							<a href="/metrics/{c.mediaId}">{c.mediaId}</a>
							<span class="v">{dur(c.totalMs)}</span>
							<span class="note">{dur(c.workMs)} of work across {c.steps} steps</span>
						</li>
					{/each}
				</ol>
				<p class="note">Total above work means it spent the difference waiting for a free worker.</p>
			</div>
		{/if}

		<div class="card">
			<h2>Workers</h2>
			{#if m.workers.length === 0}
				<p class="note">No worker connected. Nothing can cook.</p>
			{:else}
				{#each m.workers as w (w.workerId)}
					<div class="worker">
						<strong>{w.workerId}</strong>
						<span class="note">{w.capabilities.join(', ')} · {w.slotsFree} slots free</span>
						{#if w.host}<span class="note">{JSON.stringify(w.host)}</span>{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</section>

<style>
	.metrics {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 3rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
	}
	h2 {
		font-size: 0.95rem;
		margin: 0 0 0.9rem;
		color: var(--ink-dim);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
	}
	th {
		text-align: left;
		font-weight: 600;
		color: var(--ink-dim);
		border-bottom: 1px solid var(--line);
		padding: 0 0.4rem 0.4rem 0;
		white-space: nowrap;
	}
	td {
		padding: 0.4rem 0.4rem 0.4rem 0;
		border-bottom: 1px solid var(--line-tint);
	}
	.slower {
		color: var(--warn);
	}
	.flag {
		color: var(--warn);
		margin-left: 0.25rem;
		font-weight: 700;
	}
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
		gap: 0.6rem;
	}
	.kv .k {
		display: block;
		font-size: 0.72rem;
		color: var(--ink-dim);
		text-transform: uppercase;
	}
	.v {
		font-size: 1.05rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.note {
		font-size: 0.75rem;
		color: var(--ink-dim);
		margin: 0.8rem 0 0;
		line-height: 1.5;
	}
	.cooks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	.cooks li {
		display: grid;
		gap: 0.15rem;
	}
	.cooks a {
		color: var(--accent);
	}
	.cooks .note {
		margin: 0;
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
	code {
		font-size: 0.72rem;
	}
</style>
