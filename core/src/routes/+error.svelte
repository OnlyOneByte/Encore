<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	// The server inlines this page's styles (hooks.server.ts, `data-error-page`). This lazy import covers an error
	// rendered on the client; it is not static because the client loads this page on every route.
	void import('../screens.css');
</script>

<!-- No dock here, so the page carries its own way back: the TV to its stage, anyone else to the Sing tab. -->
<div class="app-shell" data-error-page>
	<h1>{page.status}</h1>
	<p>{page.error?.message}</p>
	<a href={page.url.pathname.startsWith('/tv') ? resolve('/tv') : resolve('/')}>Back to the room</a>
</div>
