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
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { dur, stepLabel, stageLabel, rate } from '$lib/metrics-format';
	import * as Card from '$lib/components/ui/card';

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
		slowestCooks: {
			cookId: string;
			mediaId: string;
			title?: string | null;
			totalMs: number;
			workMs: number;
			steps: number;
		}[];
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

	/**
	 * The useful worker `host` keys as labelled pairs, replacing a raw JSON.stringify dump on the
	 * operator dashboard. Resilient by design: `host` is typed as an open bag here, so an unexpected
	 * or missing key is skipped rather than throwing, and only keys that carry a value are shown.
	 */
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
			.map(([k, label]): [string, string] => [label, host[k] === undefined || host[k] === null ? '' : String(host[k])])
			.filter(([, v]) => v !== '');
	}
</script>

<svelte:head><title>Encore — metrics</title></svelte:head>

<section class="metrics">
	<PageHeader title="Processing metrics" back={{ href: '/settings', label: 'Back to settings' }} />

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
			<p class="banner" role="status">No worker connected — songs can't be processed right now.</p>
		{/if}

		<p class="note">
			{m.sample.attempts} runs across {m.sample.cooks} songs.
			{#if m.sample.provisional}<strong>Too few to trust the averages yet.</strong>{/if}
			Songs processed before this page existed have no timings.
		</p>

		<Card.Root>
	<Card.Header>
		<Card.Title>Start to finish</Card.Title>
	</Card.Header>
	<Card.Content>
			
			<div class="kv">
				<div><span class="k">typical</span><span class="v">{dur(m.e2e.p50Ms)}</span></div>
				<div><span class="k">average</span><span class="v">{dur(m.e2e.meanMs)}</span></div>
				<div><span class="k">worst</span><span class="v">{dur(m.e2e.p95Ms)}</span></div>
				<div><span class="k">songs</span><span class="v">{m.e2e.n}</span></div>
			</div>
			<p class="note">From asking for a song to it being ready to sing, waiting included.</p>
	</Card.Content>
</Card.Root>

		<Card.Root>
	<Card.Header>
		<Card.Title>Each step</Card.Title>
	</Card.Header>
	<Card.Content>
			
			{#if m.steps.length === 0}
				<p class="note">Nothing processed yet.</p>
			{:else}
				<div class="scroller">
					<table>
						<thead>
							<tr>
								<th scope="col">step</th>
								<th scope="col">runs</th>
								<th scope="col">average</th>
								<th scope="col">typical</th>
								<th scope="col">worst</th>
								<th scope="col">waited</th>
								<th scope="col">speed</th>
								<th scope="col">failed</th>
							</tr>
						</thead>
						<tbody>
							{#each m.steps as s (s.jobType)}
								<tr>
									<td class="name"
										>{stepLabel(s.jobType)}{#if s.provisional}<span class="flag">few runs</span>{/if}</td
									>
									<td>{s.n}</td>
									<td class:lead={s.jobType === slowestStep}>{dur(s.meanMs)}</td>
									<td>{dur(s.p50Ms)}</td>
									<td>{dur(s.p95Ms)}</td>
									<td>{dur(s.meanQueueWaitMs)}</td>
									<td>{rate(s.meanRtFactor)}</td>
									<td>{s.failed + s.abandoned}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">
					Times are work only — <strong>waited</strong> is time sitting in the queue.
					<strong>speed</strong> is computer time per second of song, so 0.5× means twice as fast as the music.
					<strong>failed</strong> runs are left out of the averages.
				</p>
			{/if}
	</Card.Content>
</Card.Root>

		<Card.Root>
	<Card.Header>
		<Card.Title>Vocal removal — this machine vs the benchmark</Card.Title>
	</Card.Header>
	<Card.Content>
			
			{#if m.models.length === 0}
				<p class="note">No vocals removed yet.</p>
			{:else}
				<div class="scroller">
					<table>
						<thead>
							<tr>
								<th scope="col">model</th>
								<th scope="col">runs</th>
								<th scope="col">here</th>
								<th scope="col">benchmark</th>
								<th scope="col">vs</th>
							</tr>
						</thead>
						<tbody>
							{#each m.models as r (String(r.engine) + String(r.model))}
								<tr>
									<td class="name"
										>{r.engine ?? '—'} / {r.model ?? '—'}{#if r.provisional}<span class="flag">few runs</span>{/if}</td
									>
									<td>{r.n}</td>
									<td>{rate(r.meanRtFactor)}</td>
									<td>{rate(r.declared?.rtFactor ?? null)}</td>
									<td
										class:slower={(r.ratioToDeclared ?? 1) > 1.5}
										class:faster={r.ratioToDeclared !== null && r.ratioToDeclared < 0.67}>{rate(r.ratioToDeclared)}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">
					<strong>benchmark</strong> is the speed this model was timed at once, on a different machine.
					<strong>vs</strong> compares it to here: 1.0× matches, <span class="slower">over 1.5×</span> is slower here,
					<span class="faster">under 0.67×</span> means the benchmark was too pessimistic. Use it to plan, not to pass or
					fail.
				</p>
			{/if}
	</Card.Content>
</Card.Root>

		<Card.Root>
	<Card.Header>
		<Card.Title>Lyrics transcription</Card.Title>
	</Card.Header>
	<Card.Content>
			
			{#if m.asr.length === 0}
				<p class="note">No lyrics timed yet.</p>
			{:else}
				<div class="scroller">
					<table>
						<thead>
							<tr>
								<th scope="col">model</th>
								<th scope="col">timing</th>
								<th scope="col">runs</th>
								<th scope="col">average</th>
								<th scope="col">speed</th>
							</tr>
						</thead>
						<tbody>
							{#each m.asr as r (String(r.asrModel) + String(r.syncMode))}
								<tr>
									<td class="name"
										>{r.asrModel ?? '—'}{#if r.provisional}<span class="flag">few runs</span>{/if}</td
									>
									<td class="name">{r.syncMode ?? '—'}</td>
									<td>{r.n}</td>
									<td>{dur(r.meanMs)}</td>
									<td>{rate(r.meanRtFactor)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">
					These models have never been timed anywhere, so there is no benchmark to compare against. This is the first
					measurement.
				</p>
			{/if}
	</Card.Content>
</Card.Root>

		{#if m.stages.length}
			<Card.Root>
	<Card.Header>
		<Card.Title>Where the time goes</Card.Title>
	</Card.Header>
	<Card.Content>
				
				<Bars
					rows={m.stages.map((s) => ({
						label: stageLabel(s.stage),
						value: Math.round((s.meanMs ?? 0) / 1000),
						hint: `${s.n} runs`
					}))}
					unit="s avg"
				/>
				<p class="note">Measured by the worker inside each step.</p>
	</Card.Content>
</Card.Root>
		{/if}

		{#if m.slowestCooks.length}
			<Card.Root>
	<Card.Header>
		<Card.Title>Slowest songs</Card.Title>
	</Card.Header>
	<Card.Content>
				
				<ol class="cooks">
					{#each m.slowestCooks as c (c.cookId)}
						<li>
							<a href="/metrics/{c.mediaId}">{c.title ?? c.mediaId}</a>
							<span class="v">{dur(c.totalMs)}</span>
							<span class="note">{dur(c.workMs)} working, {c.steps} steps</span>
						</li>
					{/each}
				</ol>
				<p class="note">The gap between the two numbers was spent waiting for a free worker.</p>
	</Card.Content>
</Card.Root>
		{/if}

		<Card.Root>
	<Card.Header>
		<Card.Title>Workers</Card.Title>
	</Card.Header>
	<Card.Content>
			
			{#if m.workers.length === 0}
				<p class="note">Nothing is connected, so no song can be processed.</p>
			{:else}
				{#each m.workers as w (w.workerId)}
					<div class="worker">
						<strong>{w.workerId}</strong>
						<span class="note">{w.capabilities.join(', ')} · {w.slotsFree} free</span>
						{#if w.host}
							{@const facts = hostFacts(w.host)}
							{#if facts.length}
								<dl class="facts">
									{#each facts as [k, v] (k)}
										<div>
											<dt>{k}</dt>
											<dd>{v}</dd>
										</div>
									{/each}
								</dl>
							{/if}
						{/if}
					</div>
				{/each}
			{/if}
	</Card.Content>
</Card.Root>
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
		/* The cap takes width off the right only on a flex child (.app-shell is a
		   centered flex column); width:100% keeps the stretch so margin-inline:auto
		   re-centres the full capped block instead of collapsing it to content width. */
		width: 100%;
		margin-inline: auto;
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
	/*
	 * #913 S4: `.card`'s local padding left this file — shadcn's Card owns its spacing through
	 * `--card-spacing`. The visual change is accepted deliberately (a ring rather than a border, its
	 * own scale). Layout classes that must apply to the GRID ITEM stay on a wrapper element, because a
	 * scoped rule cannot reach an element a child component renders.
	 */
	/* Full-strength ink and a rule beneath, so a section title out-ranks the dim column headers
	   directly below it. Both were --ink-dim uppercase, which made them compete. */
	/*
	 * #913 S4: the card heading rule left this file. Card.Title owns it now — a normal-weight base-size
	 * title where this was hand-styled, which is part of the visual change accepted for S4.
	 */
	/* Stopped, not merely slow — the one state that invalidates every number below it. --warn-bg gives
	   it a fill (it painted transparent while the token was undefined, hiding the page's most important
	   state); --warn-line is the matching border. */
	.banner {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
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
		font-size: var(--ph-text-2xs);
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
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: 0.8rem 0 0;
		line-height: var(--lh-loose);
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
	 * --ink with an underline, NOT an accent colour. --accent measures 3.38:1 on --card — it is built
	 * to CARRY --on-accent, not to be text — so it fails AA for normal-size link text. (The old
	 * --accent-strong was worse at 3.52:1 and is retired; #840, XR-COL-11.) The underline also stops
	 * the link being signalled by colour alone. min-height gives the stacked links a real tap target.
	 */
	.cooks a {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		display: inline-flex;
		align-items: center;
		/* 44px tap target — this is the only route into the per-song audit and was 32px, under the
		   ratified floor (issue #140). No literal-string pin like settings/.back, so the token is fine. */
		min-height: var(--tap);
		/* A title-less song shows its raw media id; an unbroken id would push the 320px layout wide. */
		overflow-wrap: anywhere;
	}
	.cooks .note {
		margin: 0;
	}
	/* Aligned key/value pairs for the worker's host — the same pattern the per-song audit uses for its
	   model facts. Replaces a raw JSON dump: keys stay dim, values take ink. */
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, max-content));
		gap: 0.2rem 1.2rem;
		margin: 0.45rem 0 0;
		font-size: var(--ph-text-xs);
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
