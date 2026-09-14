<!--
  /metrics — the INTERNAL processing dashboard. Ungated for now (see /api/metrics for why), so it is
  readable by anything on the LAN.

  The organising choice: every duration is reported as a RATE (seconds of compute per second of audio)
  wherever a rate is meaningful, because raw seconds cannot be compared across songs of different
  lengths. Sample sizes are printed next to every average and small ones are labelled, because on a box
  with a handful of processes a mean over two renders exactly like a mean over two hundred.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { dur, stepLabel, stageLabel, rate } from '$lib/metrics-format';
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

	let m = $state<Metrics | null>(null);
	let failed = $state(false);

	/**
	 * Which step dominates a process. The page's whole reason for existing is "what is slow", and reading
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
	<!--
		`title="Processing metrics"` is spelled as a LITERAL, and the same string is repeated on <main> below
		rather than hoisted into a const both read. That is deliberate: SEL.metricsPage's anchor in
		apps/core/e2e/contract.ts is the exact text `title="Processing metrics"`, so interpolating the
		attribute deletes the anchor the e2e flow uses to know it landed on this page — the guard reds,
		correctly. Two occurrences of a two-word string is the cheaper of the two costs.
	-->
	<PageHeader title="Processing metrics" back={{ href: '/settings', label: 'Back to settings' }} />

	<!--
		The shadcn migration: the content is a <main> landmark, the shape /admin and /settings already use. The cap,
		--page-measure and the auto inline margin stay on .metrics so the PageHeader inside it still shares
		the content's 900px measure; <main> only carries the grid the cards lay out in.
	-->
	<main aria-label="Processing metrics">
		{#if failed}
			<Alert.Root variant="destructive"><Alert.Title>Could not load metrics.</Alert.Title></Alert.Root>
		{:else}
			<!--
				Worker state leads. It was last on the page, but it is the difference between "processing is
				slow" and "processing is STOPPED" — with no worker connected every timing below is history
				rather than live state, and that is the first thing an operator needs to know.
			-->
			{#if m && m.workers.length === 0}
				<!--
					`role="status"`, not the registry's hardcoded `alert`: this reports a STANDING condition,
					so it must not interrupt a screen reader mid-sentence. phone-inventory.test.ts requires
					every live region on these surfaces to be polite.
				-->
				<Alert.Root variant="warn" role="status">
					<Alert.Title>No worker connected — songs can't be processed right now.</Alert.Title>
				</Alert.Root>
			{/if}

			<!--
				ONE live region that EXISTS BEFORE ITS CONTENT CHANGES (the shadcn migration). This was
				`{:else if !m}<p role="status">Loading…</p>`, a region CREATED by the load rather than updated
				by it — a live region is announced when its contents change, so a region that arrives already
				holding its message announces nothing, and the operator heard silence both while waiting and
				on arrival. Persisting the element and swapping only its text makes the transition the change.
				The loaded copy is the sample summary this paragraph already carried, so the announcement is
				the page's own first fact rather than a second sentence added to be announced.
			-->
			<p class="note" role="status">
				{#if !m}
					Loading…
				{:else}
					{m.sample.attempts} runs across {m.sample.processes} songs.
					{#if m.sample.provisional}<strong>Too few to trust the averages yet.</strong>{/if}
					Songs processed before this page existed have no timings.
				{/if}
			</p>

			{#if m}
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
											<Table.Head scope="col">waited</Table.Head>
											<Table.Head scope="col">speed</Table.Head>
											<Table.Head scope="col">failed</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each m.steps as s (s.jobType)}
											<Table.Row>
												<Table.Cell
													>{stepLabel(s.jobType)}{#if s.provisional}<Badge variant="warn">few runs</Badge
														>{/if}</Table.Cell
												>
												<Table.Cell>{s.n}</Table.Cell>
												<Table.Cell><span class:lead={s.jobType === slowestStep}>{dur(s.meanMs)}</span></Table.Cell>
												<Table.Cell>{dur(s.p50Ms)}</Table.Cell>
												<Table.Cell>{dur(s.p95Ms)}</Table.Cell>
												<Table.Cell>{dur(s.meanQueueWaitMs)}</Table.Cell>
												<Table.Cell>{rate(s.meanRtFactor)}</Table.Cell>
												<Table.Cell>{s.failed + s.abandoned}</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
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
											<Table.Head scope="col">here</Table.Head>
											<Table.Head scope="col">benchmark</Table.Head>
											<Table.Head scope="col">vs</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each m.models as r (String(r.engine) + String(r.model))}
											<Table.Row>
												<Table.Cell
													>{r.engine ?? '—'} / {r.model ?? '—'}{#if r.provisional}<Badge variant="warn">few runs</Badge
														>{/if}</Table.Cell
												>
												<Table.Cell>{r.n}</Table.Cell>
												<Table.Cell>{rate(r.meanRtFactor)}</Table.Cell>
												<Table.Cell>{rate(r.declared?.rtFactor ?? null)}</Table.Cell>
												<Table.Cell
													><span
														class:slower={(r.ratioToDeclared ?? 1) > 1.5}
														class:faster={r.ratioToDeclared !== null && r.ratioToDeclared < 0.67}
														>{rate(r.ratioToDeclared)}</span
													></Table.Cell
												>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
							<p class="note">
								<strong>benchmark</strong> is the speed this model was timed at once, on a different machine.
								<strong>vs</strong> compares it to here: 1.0× matches, <span class="slower">over 1.5×</span> is slower
								here,
								<span class="faster">under 0.67×</span> means the benchmark was too pessimistic. Use it to plan, not to pass
								or fail.
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
											<Table.Head scope="col">speed</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each m.asr as r (String(r.asrModel) + String(r.syncMode))}
											<Table.Row>
												<Table.Cell
													>{r.asrModel ?? '—'}{#if r.provisional}<Badge variant="warn">few runs</Badge>{/if}</Table.Cell
												>
												<Table.Cell class="name">{r.syncMode ?? '—'}</Table.Cell>
												<Table.Cell>{r.n}</Table.Cell>
												<Table.Cell>{dur(r.meanMs)}</Table.Cell>
												<Table.Cell>{rate(r.meanRtFactor)}</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
							<p class="note">
								These models have never been timed anywhere, so there is no benchmark to compare against. This is the
								first measurement.
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

				{#if m.slowestProcesses.length}
					<Card.Root>
						<Card.Header>
							<Card.Title>Slowest songs</Card.Title>
						</Card.Header>
						<Card.Content>
							<!--
						The shadcn migration: each row is <Item.Root> for the shared row GRAMMAR, with the <li> kept through Item's own
						`child` snippet — the same shape QueueRow uses. The list element matters here: these are ranked
						entries, so the <ol>/<li> pair is the meaning, and a component-rendered <div> would drop it.
						`bare`/`bare` because `.processes` already lays the list out and the row needs no second surface.

						The duration moves into <Item.Actions>, which is the visual change this buys: the three lines
						were a stacked grid, so the number a reader is ranking by sat mid-cell under the name. It is now
						the row's trailing value on a shared right edge — the same argument the tables make for
						right-aligning a numeric column. Item.Title is deliberately NOT used: its `line-clamp-1` would
						truncate the raw media id a title-less song falls back to, which `.processes a` deliberately
						wraps with `overflow-wrap: anywhere` instead.
					-->
							<ol class="processes">
								{#each m.slowestProcesses as c (c.processingId)}
									<Item.Root variant="bare" size="bare">
										{#snippet child({ props })}
											<li {...props}>
												<Item.Content>
													<a href="/metrics/{c.mediaId}">{c.title ?? c.mediaId}</a>
													<Item.Description>{dur(c.workMs)} working, {c.steps} steps</Item.Description>
												</Item.Content>
												<Item.Actions><span class="v">{dur(c.totalMs)}</span></Item.Actions>
											</li>
										{/snippet}
									</Item.Root>
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
							<Empty.Root>
								<Empty.Header>
									<Empty.Description>Nothing is connected, so no song can be processed.</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							{#each m.workers as w (w.workerId)}
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
		/* 3rem (48px) is off-scale — the scale stops at --space-4xl (20px) — so it stays a literal. */
		padding: 1rem 0 3rem;
		max-width: 900px;
		/* Match the PageHeader's --page-measure cap to this block's width so header and content share one
		   measure and the header does not cap below 900 when --max-w steps to 760 in the 768–1200 band. */
		--page-measure: 900px;
		/* The cap takes width off the right only on a flex child (.app-shell is a
		   centered flex column); width:100% keeps the stretch so margin-inline:auto
		   re-centres the full capped block instead of collapsing it to content width. */
		width: 100%;
		margin-inline: auto;
	}
	/*
	 * The <main> landmark (the shadcn migration). It carries the CARD grid and nothing else: the cap, --page-measure and
	 * the auto inline margin stay on .metrics so the PageHeader sitting inside that block keeps sharing
	 * the content's measure. Same track sizing as its parent, and for the same reason — main is now the
	 * grid the 8-column tables are items of, so it needs the minmax(0, …) floor too or a wide table
	 * stretches this column instead of scrolling inside its own.
	 */
	main {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	/*
	 * Wide numeric tables SCROLL on a phone rather than squashing or reflowing into cards.
	 *
	 * Both alternatives are worse for this data: squashing is what clipped the `fail` column to "fai",
	 * and a card-per-row transform destroys the one property that makes a numeric table readable —
	 * a shared right edge you can run your eye down. Scrolling keeps the grid intact and costs one
	 * gesture. The first column stays put so a scrolled row is still identifiable.
	 */
	/*
	 * S8: the table's own rules moved to ui/table — including the two that are behaviour rather
	 * than decoration: the 34rem minimum that makes eight numeric columns scroll instead of crushing,
	 * and the sticky first column that keeps the step name beside its numbers while they do. `.scroller`
	 * stays HERE because it is this page's layout, and the component's rules key off it as an ancestor.
	 */
	.scroller {
		overflow-x: auto;
		/* Room for the sticky column's own background to cover what slides under it. */
		margin: 0 -0.1rem;
	}
	/* .card in app.css has no padding — see the note in routes/stats/+page.svelte. */
	/*
	 * S4: `.card`'s local padding left this file — shadcn's Card owns its spacing through
	 * `--card-spacing`. The visual change is accepted deliberately (a ring rather than a border, its
	 * own scale). Layout classes that must apply to the GRID ITEM stay on a wrapper element, because a
	 * scoped rule cannot reach an element a child component renders.
	 */
	/* Full-strength ink and a rule beneath, so a section title out-ranks the dim column headers
	   directly below it. Both were --ink-dim uppercase, which made them compete. */
	/*
	 * S4: the card heading rule left this file. Card.Title owns it now — a normal-weight base-size
	 * title where this was hand-styled, which is part of the visual change accepted for S4.
	 */
	/*
	 * `.banner` is GONE — the no-worker state is `Alert variant="warn" role="status"` with its sentence
	 * in `Alert.Title`. The reasoning the old rule carried is preserved where it now lives: the warn
	 * fill/line pair became the component's `warn` variant (added precisely because the registry's
	 * `destructive` paints the flat card surface and would have made this banner LESS legible than the
	 * hand-rolled one), `--ph-text-base` became the component's base type size for the same
	 * "bold is not a substitute for size" reason, and the 600 weight is `Alert.Title`'s `font-medium`.
	 * Deleted rather than kept because a Svelte rule matching nothing is an unused selector, which this
	 * repo treats as a typecheck failure.
	 */
	/*
	 * NUMERIC COLUMNS ARE RIGHT-ALIGNED, and the first column stays left because it is a name rather
	 * than a quantity. tabular-nums does half that job by making every digit the same width, but
	 * left-aligned cells still put "9.0s" and "2m 34s" on different right edges, so a reader cannot run
	 * an eye down a column and compare.
	 *
	 * S8: both halves moved to ui/table, keyed on shadcn's data-slot attributes — a table's
	 * appearance is inherently descendant, and the cells are rendered by sibling components that a
	 * scoped rule here cannot reach. What stays below is this page's own MEANING, not table styling.
	 */
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
	/*
	 * The shadcn migration: considered for <Item.Group> and REJECTED. Item.Group is `flex w-full flex-col` — a vertical
	 * stack of rows — and this is a horizontal strip of four small stat cells in an auto-fit grid, so the
	 * primitive would have stacked typical/average/worst/songs into four full-width rows and lost the
	 * side-by-side comparison that is the whole point of the strip. Overriding it back to a grid is not
	 * available either: a `class` handed to Item.Group is scoped to THIS file and cannot reach the
	 * element the component renders (ui-scoped-style-reach-913.test.ts), and Tailwind mints no utilities
	 * for app source (`source(none)`), so there is no spelling of the override that would apply.
	 */
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
	/*
	 * The shadcn migration: `.processes li { display: grid; gap: 0.15rem }` is GONE — <Item.Root> lays the row out now
	 * (its base is the flex row, `[data-slot='item-content']` the stacked left column), and this rule
	 * would have overridden the display it sets. `.processes .note { margin: 0 }` went with it: the
	 * subtitle is <Item.Description>, which carries its own type and spacing.
	 */
	/*
	 * --ink with an underline, NOT an accent colour. --accent measures 3.38:1 on --card — it is built
	 * to CARRY --on-accent, not to be text — so it fails AA for normal-size link text. (The old
	 * --accent-strong was worse at 3.52:1 and is retired; XR-COL-11.) The underline also stops
	 * the link being signalled by colour alone. min-height gives the stacked links a real tap target.
	 *
	 * The <a> is still rendered BY THIS PAGE (inside Item.Content's slot), so it carries this file's
	 * scope hash and a descendant selector from `.processes` — a plain <ol> this page renders — reaches
	 * it. That is why the class did not have to move anywhere when the row became a component.
	 */
	.processes a {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		display: inline-flex;
		align-items: center;
		/* 44px tap target — this is the only route into the per-song audit and was 32px, under the
		   ratified floor. No literal-string pin like settings/.back, so the token is fine. */
		min-height: var(--tap);
		/* A title-less song shows its raw media id; an unbroken id would push the 320px layout wide. */
		overflow-wrap: anywhere;
	}
	/*
	 * The shadcn migration: `.facts` and its three descendant rules are GONE from this file. They were duplicated
	 * VERBATIM in routes/metrics/[mediaId]/+page.svelte — four rules and seven lines of markup in each,
	 * already diverging by one `overflow-wrap` — and are now lib/components/FactList.svelte, which both
	 * pages import. A scoped rule here could not reach that component's <dl> anyway.
	 */
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
