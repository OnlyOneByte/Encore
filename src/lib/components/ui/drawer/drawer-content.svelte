<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '$lib/utils.js';
	import type { WithoutChildrenOrChild } from '$lib/utils.js';
	import DrawerHandle from './drawer-handle.svelte';
	import DrawerOverlay from './drawer-overlay.svelte';
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
	<DrawerOverlay />
	<!--
		`border-border` IS A DEFECT FIX, the third this file has needed from the copy-in. `border-t` and
		its left/right/top siblings below set only `border-*-WIDTH`. Nothing in shadcn's class list sets a
		border COLOUR, so it resolved to `currentColor` — and this element carries
		`text-popover-foreground`, which is `--ink`. Every bottom sheet therefore drew a 1px WHITE
		hairline across its top edge, measured on the render at `rgb(243, 243, 251)`. `border-border` is
		the token that was always meant (`--border` is `#2a2a3e`, the same value as Encore's `--line`); it
		was simply never referenced.

		Same family as `sm:max-w-sm` collapsing to 8px earlier in this file: a shadcn utility that assumes
		Preflight's base styles, which this app switches off.
	-->
	<DrawerPrimitive.Content
		bind:ref={ref}
		data-slot="drawer-content"
		class={cn(
			'bg-popover text-popover-foreground border-border flex h-auto flex-col text-sm data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:rounded-r-xl data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:rounded-l-xl data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b group/drawer-content fixed z-50 data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[82dvh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:start-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:end-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[82dvh] data-[vaul-drawer-direction=left]:sm:max-w-[24rem] data-[vaul-drawer-direction=right]:sm:max-w-[24rem]',
			className
		)}
		{...restProps}
	>
		<!--
			DEFECT IN THE COPY-IN, fixed here. shadcn renders a DECORATIVE div at this position — the right
			size, the right place, and dragging nothing at all. `vaul-svelte` exports a real
			`Drawer.Handle` (the element that carries `data-vaul-handle`), and without it `handleOnly` on
			the Root has no handle to restrict dragging TO, so the drawer silently becomes undraggable.
			Encore needs `handleOnly` because this drawer's body is sliders — see drawer-handle.svelte.

			The visibility condition is unchanged: only a bottom drawer draws a grab bar.
		-->
		<DrawerHandle class="hidden group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
		{@render children?.()}
	</DrawerPrimitive.Content>
</DrawerPortal>
