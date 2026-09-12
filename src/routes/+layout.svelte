<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<!-- Encore's app mark, from static/. The PNG sizes the manifest points at are its siblings, so
	     the icon family has one home; the favicon used to be a Vite-processed import from
	     src/lib/assets/ instead, which is how it drifted to the stock SvelteKit Svelte logo without
	     anyone noticing. -->
	<link rel="icon" href="/icon.svg" type="image/svg+xml" />
</svelte:head>

<div class="app-shell">
	{@render children()}
</div>
