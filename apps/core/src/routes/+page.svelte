<script lang="ts">
	// M0-C5 shell — verifies design tokens render. The real phone remote (M3) replaces this.
</script>

<header style="padding:18px 18px 12px;display:flex;align-items:center;gap:10px;">
	<div style="font-weight:800;font-size:1.3rem;letter-spacing:.5px;">
		🎤 <span
			style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;"
			>Encore</span
		>
	</div>
</header>

<main style="flex:1;padding:6px 18px 24px;">
	<p style="color:var(--ink-dim);margin:0 4px 18px;">
		Self-hosted karaoke. Wicked fast. Mobile-first.
	</p>

	<div class="card pop-in" style="padding:14px;margin-bottom:10px;">
		<div style="font-weight:700;">Design tokens online</div>
		<div style="color:var(--ink-dim);font-size:.85rem;margin-top:2px;">
			Surfaces, ink, accents, radii — ported from the mock.
		</div>
	</div>

	<div style="display:flex;gap:8px;margin-bottom:18px;">
		<button class="btn-accent" style="padding:10px 14px;">＋ Accent button</button>
		<span class="card" style="padding:10px 14px;color:var(--ok);">● ok</span>
		<span class="card" style="padding:10px 14px;color:var(--warn);">● warn</span>
	</div>

	<div style="display:flex;gap:6px;">
		{#each ['--bg', '--card', '--card2', '--accent', '--accent2', '--ok', '--warn'] as token}
			<div
				title={token}
				style="width:36px;height:36px;border-radius:8px;border:1px solid var(--line);background:var({token});"
			></div>
		{/each}
	</div>
</main>
