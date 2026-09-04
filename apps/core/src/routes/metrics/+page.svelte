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
		slowestCooks: { cookId: string; mediaId: string; title?: string | null; totalMs: number; workMs: number; steps: number }[];
		workers: { workerId: string; capabilities: string[]; slotsFree: number; host: Record<string, unknown> | null }[];
	}

	let m = $state<Metrics | null>(null);
	let failed = $state(false);

	/**
	 * Which step dominates a cook. The page's whole reason for existing is "what is slow", and reading
	 * that off three columns of mixed units (9.0s vs 2m 34s vs 43.6s) is arithmetic, not a glance — so
	 * the winning row is marked instead.
	 */
	const slowestStep = $derived.by(() => {
		if (!m || m.steps.length === 0) return null;
		return m.steps.reduce((best, s) => ((s.meanMs ?? 0) > (best.meanMs ?? 0) ? s : best)).jobType;
	});

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
		<p class="note" role="alert">Could not load metrics.</p>
	{:else if !m}
		<p class="note" role="status">Loading…</p>
	{:else}
		<!--
			Worker state leads. It was last on the page, but it is the difference between "processing is
			slow" and "processing is STOPPED" — with no worker connected every timing below is history
			rather than live state, and that is the first thing an operator needs to know.
		-->
		{#if m.workers.length === 0}
			<p class="banner" role="status">No worker connected — nothing can cook right now.</p>
		{/if}

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
			{#if m.steps.length === 0}
				<p class="note">No steps recorded yet.</p>
			{:else}
				<div class="scroller">
				<table>
					<thead>
						<tr>
							<th scope="col">step</th>
							<th scope="col">n</th>
							<th scope="col">mean</th>
							<th scope="col">p50</th>
							<th scope="col">p95</th>
							<th scope="col">queue</th>
							<th scope="col">rate</th>
							<th scope="col">fail</th>
						</tr>
					</thead>
					<tbody>
						{#each m.steps as s (s.jobType)}
							<tr>
								<td class="name">{s.jobType}{#if s.provisional}<span class="flag">n&lt;10</span>{/if}</td>
								<td>{s.n}</td>
								<!-- The slowest step is the page's headline answer, so it is bolded rather than
								     left for the reader to compare three different unit scales by eye. -->
								<td class:lead={s.jobType === slowestStep}>{dur(s.meanMs)}</td>
								<td>{dur(s.p50Ms)}</td>
								<td>{dur(s.p95Ms)}</td>
								<td>{dur(s.meanQueueWaitMs)}</td>
								<td>{rt(s.meanRtFactor)}</td>
								<td>{s.failed + s.abandoned}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</div>
				<p class="note">
					<strong>mean/p50/p95</strong> are processing time only — queue wait is the separate column, which is
					the distinction the job table could never express. <strong>rate</strong> is compute seconds per second
					of audio. <strong>fail</strong> counts failed plus abandoned attempts; neither is averaged into the
					timings. <strong>n&lt;10</strong> marks a sample too small to average with confidence.
				</p>
			{/if}
		</div>

		<div class="card">
			<h2>Separator cost — this box vs the benchmark</h2>
			{#if m.models.length === 0}
				<p class="note">No separation has been recorded yet.</p>
			{:else}
				<div class="scroller">
				<table>
					<thead>
						<tr>
							<th scope="col">engine / model</th>
							<th scope="col">n</th>
							<th scope="col">measured</th>
							<th scope="col">declared</th>
							<th scope="col">ratio</th>
						</tr>
					</thead>
					<tbody>
						{#each m.models as r (String(r.engine) + String(r.model))}
							<tr>
								<td class="name">{r.engine ?? '—'} / {r.model ?? '—'}{#if r.provisional}<span class="flag">n&lt;10</span>{/if}</td>
								<td>{r.n}</td>
								<td>{rt(r.meanRtFactor)}</td>
								<td>{r.declared ? `${r.declared.rtFactor.toFixed(2)}× (${r.declared.provenance})` : '—'}</td>
								<!--
									Marked in BOTH directions. Only >1.5 was flagged, so a box running 14x FASTER than
									its declared cost rendered as ordinary ink — yet a benchmark that pessimistic is as
									wrong for sizing a party as an optimistic one, just in the safe direction.
								-->
								<td
									class:slower={(r.ratioToDeclared ?? 1) > 1.5}
									class:faster={r.ratioToDeclared !== null && r.ratioToDeclared < 0.67}
								>{r.ratioToDeclared === null ? '—' : `${r.ratioToDeclared.toFixed(2)}×`}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</div>
				<p class="note">
					<strong>declared</strong> is the whitelist's own <code>SeparatorCost.rtFactor</code>, benchmarked once on a
					32-core Graviton 3 — several entries say <code>estimated</code> outright. <strong>ratio</strong> is measured ÷
					declared: 1.0 means the benchmark holds on this box, <span class="slower">above 1.5</span> means meaningfully
					slower here, <span class="faster">below 0.67</span> means the benchmark is pessimistic. It is for sizing a
					party, not a pass/fail.
				</p>
			{/if}
		</div>

		<div class="card">
			<h2>Lyrics models</h2>
			{#if m.asr.length === 0}
				<p class="note">No alignment has been recorded yet.</p>
			{:else}
				<div class="scroller">
				<table>
					<thead>
						<tr>
							<th scope="col">ASR model</th>
							<th scope="col">sync</th>
							<th scope="col">n</th>
							<th scope="col">mean</th>
							<th scope="col">rate</th>
						</tr>
					</thead>
					<tbody>
						{#each m.asr as r (String(r.asrModel) + String(r.syncMode))}
							<tr>
								<td class="name">{r.asrModel ?? '—'}{#if r.provisional}<span class="flag">n&lt;10</span>{/if}</td>
								<td class="name">{r.syncMode ?? '—'}</td>
								<td>{r.n}</td>
								<td>{dur(r.meanMs)}</td>
								<td>{rt(r.meanRtFactor)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</div>
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
							<a href="/metrics/{c.mediaId}">{c.title ?? c.mediaId}</a>
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
	/*
	 * Capped below the 1080px shell, but wider than the other two pages because this one carries
	 * 8-column tables. Uncapped, a left-aligned step name and its right-aligned numbers ended up ~450px
	 * apart with nothing between them, which breaks row tracking as surely as squashing would.
	 */
	.metrics {
		display: grid;
		/*
		 * minmax(0, 1fr), not the implicit `auto`. A grid track sizes to its widest child, so an
		 * 8-column table wider than the phone viewport stretched the whole column and dragged every
		 * sibling paragraph off-screen with it — the prose was clipped by the table, not by its own width.
		 */
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		padding: 1rem 0 3rem;
		max-width: 900px;
	}
	/*
	 * Wide numeric tables SCROLL on a phone rather than squashing or reflowing into cards.
	 *
	 * Both alternatives are worse for this data: squashing is what clipped the `fail` column to "fai",
	 * and a card-per-row transform destroys the one property that makes a numeric table readable —
	 * a shared right edge you can run your eye down. Scrolling keeps the grid intact and costs one
	 * gesture. The first column stays put so a scrolled row is still identifiable.
	 */
	.scroller {
		overflow-x: auto;
		/* Room for the sticky column's own background to cover what slides under it. */
		margin: 0 -0.1rem;
	}
	.scroller table {
		min-width: 34rem;
	}
	.scroller th:first-child,
	.scroller td:first-child {
		position: sticky;
		left: 0;
		background: var(--card);
	}
	/* .card in app.css has no padding — see the note in routes/stats/+page.svelte. */
	.card {
		padding: 1rem 1.1rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
	}
	/* Full-strength ink and a rule beneath, so a section title out-ranks the dim column headers
	   directly below it. Both were --ink-dim uppercase, which made them compete. */
	h2 {
		font-size: 1rem;
		margin: 0 0 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--line);
		color: var(--ink);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	/* Stopped, not merely slow — the one state that invalidates every number below it. */
	.banner {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: var(--warn-bg, transparent);
		border: 1px solid var(--warn);
		color: var(--warn);
		font-size: 0.85rem;
		font-weight: 600;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
	}
	/*
	 * NUMERIC COLUMNS ARE RIGHT-ALIGNED. tabular-nums was already on, which does half the job by making
	 * every digit the same width — but left-aligned cells still put "9.0s" and "2m 34s" on different
	 * right edges, so a reader cannot run an eye down a column and compare. Alignment is what makes a
	 * numeric table scannable; the first column stays left because it is a name, not a quantity.
	 */
	th,
	td {
		text-align: right;
		padding: 0.4rem 0 0.4rem 0.5rem;
	}
	th:first-child,
	td:first-child,
	td.name {
		text-align: left;
		padding-left: 0;
	}
	th {
		font-weight: 600;
		color: var(--ink-dim);
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
	}
	td {
		border-bottom: 1px solid var(--line-tint);
	}
	/* The dominant step, so "what is slow" is a glance rather than a comparison. */
	.lead {
		color: var(--ink);
		font-weight: 700;
	}
	.slower {
		color: var(--warn);
	}
	/* Faster than the benchmark claims. Previously unmarked, which hid a 14x-pessimistic declared
	   cost — as wrong for sizing as an optimistic one, just in the safe direction. */
	.faster {
		color: var(--ok);
	}
	/*
	 * Reads as its own meaning. This was a bare "?" whose sole explanation was a title attribute —
	 * invisible on touch, hover-only on desktop, and undiscoverable to a keyboard or screen reader.
	 */
	.flag {
		margin-left: 0.4rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius-sm);
		color: var(--warn);
		font-size: 0.68rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(90px, 140px));
		justify-content: start;
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
		line-height: 1.6;
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
	/*
	 * --ink with an underline, NOT an accent colour. --accent measures 3.95:1 on --card and
	 * --accent-strong is worse at 3.52:1 (it is built to CARRY --on-accent, not to be text), so both
	 * fail AA for normal-size link text. The underline also stops the link being signalled by colour
	 * alone. min-height gives the stacked links a real tap target.
	 */
	.cooks a {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		display: inline-flex;
		align-items: center;
		min-height: 32px;
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
