<!-- FactList — labelled key/value pairs for the operator dashboards, in place of a raw JSON dump. A COMPONENT rather
  than a rule in app.css: this is one small widget's layout, not a palette or a scale, and a global class would be
  reachable by any page that happened to spell it. The emptiness check lives HERE, not in each caller. -->
<script lang="ts">
	interface Props {
		/** Label/value pairs in display order. The caller owns the wording of every label. */
		facts: [label: string, value: string][];
	}
	let { facts }: Props = $props();
</script>

{#if facts.length}
	<dl class="facts">
		{#each facts as [label, value] (label)}
			<div>
				<dt>{label}</dt>
				<dd>{value}</dd>
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
