<!--
  FactList — labelled key/value pairs for the two operator dashboards, replacing a raw JSON dump on
  each (the worker's `host` bag on /metrics, a step's model/hardware fields on /metrics/[mediaId]).

  WHY A COMPONENT RATHER THAN A SHARED RULE. The `.facts` <dl> was duplicated VERBATIM — four rules and
  seven lines of markup in each of routes/metrics/+page.svelte and routes/metrics/[mediaId]/+page.svelte,
  differing only in a single `overflow-wrap` on the value. Two copies of a rule is the shape that drifts:
  the value column already had one divergence, and the pattern's own comment in each file described it as
  "the same pattern the per-song audit uses", which is a note asking to be a component. app.css is not
  the place for it either — this is one small widget's layout, not a palette or a scale, and a global
  `.facts` would be reachable by any page that happened to spell the class.

  `overflow-wrap: anywhere` is applied to BOTH callers, which is the superset of what the two carried. It
  only ever participates when a value would otherwise push the 320px layout wide (a device name, a raw
  model id), so the audit page — which lacked it — gains the guard rather than changing at any width its
  values already fit.

  The emptiness check lives HERE, not at the call sites: both spelled it, and a <dl> with no pairs is
  this component's own empty case rather than each page's.
-->
<script lang="ts">
	let {
		/** Already-labelled pairs, in display order. The caller owns the wording of each key. */
		facts
	}: { facts: [string, string][] } = $props();
</script>

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

<style>
	/* Aligned key/value pairs: keys stay dim, values take ink. */
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
		/* A device name or a raw model id is one unbroken token; without this it pushes 320px wide. */
		overflow-wrap: anywhere;
	}
</style>
