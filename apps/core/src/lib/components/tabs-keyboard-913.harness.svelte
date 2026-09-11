<script lang="ts">
	/*
	 * The settings tablist's SHAPE, mountable. settings/+page.svelte imports `$app`, so it cannot be
	 * mounted; this carries the same three scopes through the same primitive so the keyboard contract is
	 * checked against a real render. Not shipped: nothing in the app imports it.
	 */
	import * as Tabs from '$lib/components/ui/tabs';
	const TABS = [
		{ id: 'you', label: 'You' },
		{ id: 'party', label: 'Party' },
		{ id: 'server', label: 'Server' }
	] as const;
	let tab = $state<string>('you');
</script>

<Tabs.Root value={tab} onValueChange={(v) => (tab = v)}>
	<Tabs.List aria-label="Settings scope">
		{#each TABS as t (t.id)}
			<Tabs.Trigger id="tab-{t.id}" value={t.id}>{t.label}</Tabs.Trigger>
		{/each}
	</Tabs.List>
	{#each TABS as t (t.id)}
		<Tabs.Content value={t.id}>{t.label} panel</Tabs.Content>
	{/each}
</Tabs.Root>
