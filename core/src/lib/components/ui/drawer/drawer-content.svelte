<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '$lib/utils.js';
	import type { WithoutChildrenOrChild } from '$lib/utils.js';
	import DrawerPortal from './drawer-portal.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		...restProps
	}: DrawerPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DrawerPortal>>;
	} = $props();
</script>

<DrawerPortal {...portalProps}>
	<!-- NO OVERLAY IS RENDERED HERE, and it is not a simplification — it could never render: vaul-svelte gates the
		overlay on modality, and the app's only drawer is non-modal by necessity. Re-add the render only together with
		modality; `drawer-overlay-modality.test.ts` pins the pair. `border-border` IS A DEFECT FIX, not decoration: `border-t`
		and its siblings set only border-WIDTH and nothing in the registry's list sets a COLOUR, so it falls through to
		currentColor — here --ink, a white hairline across every sheet's top edge. Any width must stay an arbitrary value. -->
	<DrawerPrimitive.Content
		bind:ref={ref}
		data-slot="drawer-content"
		class={cn(
			'bg-popover text-popover-foreground border-border flex h-auto flex-col text-sm data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:rounded-r-xl data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:rounded-l-xl data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b group/drawer-content fixed z-50 data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[82dvh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:start-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:end-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[82dvh] data-[vaul-drawer-direction=left]:sm:max-w-[24rem] data-[vaul-drawer-direction=right]:sm:max-w-[24rem]',
			className
		)}
		{...restProps}
	>
		<!-- NO HANDLE IS RENDERED HERE, deliberately. A real handle is still REQUIRED somewhere in the tree — with no element
			carrying vaul's handle attribute, `handleOnly` on the Root has nothing to restrict dragging to and the sheet silently
			becomes undraggable. It belongs at the COMPOSITION site: this position is the top of the content box, not the row a
			thumb pulls, and a consumer cannot move a child this component renders for it. -->
		{@render children?.()}
	</DrawerPrimitive.Content>
</DrawerPortal>
