<script lang="ts">
	/*
	 * ONE SHAPE FOR A REGISTRY-BACKED SELECT: a label bound by `for`, a native select, and an `{#each}` over a
	 * registry of `{ id, label }`. Fourteen call sites across the room and machine scopes were the same five lines.
	 *
	 * A COMPONENT RATHER THAN A SNIPPET, since the two scope routes became two files: a snippet cannot be shared
	 * between them, and the alternative was two copies of the shape that nothing would notice drifting apart.
	 *
	 * IT RENDERS TWO SIBLINGS AND NO WRAPPER, which is load-bearing: the settings shell's `.pick` row is a flex line
	 * of exactly those two, the name at the start and the select at the end, so a wrapper here would stack them.
	 *
	 * `id` is passed EXPLICITLY and never derived from the label: `p9-settings.spec.ts` and the shot frames drive
	 * these controls by id, so the spelling is a contract rather than an implementation detail.
	 *
	 * Two selects on the settings routes deliberately do NOT come through here — `quality-ceiling` carries an empty
	 * "no cap" option over a registry keyed on `rank`, and `asr-model` composes its option label from two fields.
	 * Parameterising for either would add a knob that exists for one caller.
	 */
	import { NativeSelect } from '$lib/components/ui/native-select';
	import * as Field from '$lib/components/ui/field';

	let {
		id,
		label,
		value,
		options,
		pick
	}: {
		id: string;
		label: string;
		value: string;
		options: readonly { id: string; label: string }[];
		pick: (v: string) => void;
	} = $props();
</script>

<Field.Label for={id}>{label}</Field.Label>
<NativeSelect id={id} value={value} onchange={(e) => pick(e.currentTarget.value)}>
	{#each options as o (o.id)}
		<option value={o.id}>{o.label}</option>
	{/each}
</NativeSelect>
