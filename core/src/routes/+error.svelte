<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	// SvelteKit's own error page, plus the styles the root layout no longer imports. Lazy, because the client loads
	// this page on every route, so a static import would add `screens.css` to every phone's download.
	void import('../screens.css');
</script>

<!-- No dock here, so the page carries its own way back: the TV to its stage, anyone else to the Sing tab. -->
<div class="app-shell">
	<h1>{page.status}</h1>
	<p>{page.error?.message}</p>
	<a href={page.url.pathname.startsWith('/tv') ? resolve('/tv') : resolve('/')}>Back to the room</a>
</div>
