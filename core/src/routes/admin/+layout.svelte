<script lang="ts">
	import '../../screens.css';

	let { children } = $props();
</script>

<div class="app-shell">
	{@render children()}
</div>
