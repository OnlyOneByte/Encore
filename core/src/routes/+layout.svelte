<script lang="ts">
	let { children } = $props();
</script>

<!-- Every surface loads this layout, the TV included, so it holds nothing else: the phone tabs' styles, dock and
	toaster are in `(phone)/+layout.svelte`, and each other surface's layout imports `screens.css`. -->
<svelte:head>
	<!-- The fallback title: a route's own `<title>` wins, since the last one in the head order does (SC 2.4.2). -->
	<title>Encore</title>
	<!-- Served from static/, alongside the PNG sizes the manifest names, so the icon family has one home. -->
	<link rel="icon" href="/icon.svg" type="image/svg+xml" />
</svelte:head>

{@render children()}
