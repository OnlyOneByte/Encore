<script lang="ts">
	// Docked now-playing control strip. Ported from docs/mocks. Key-shift greyed until stems (M7).
	interface Props {
		title: string;
		sub: string;
		isPlaying?: boolean;
		progress?: number; // 0..1
		keyShiftEnabled?: boolean;
		keyShift?: number; // current transpose in semitones (M7-C9)
		maxKeyShift?: number;
		onplaypause?: () => void;
		onprev?: () => void;
		onnext?: () => void;
		onkey?: (semitones: number) => void; // request an absolute key (server clamps)
	}
	let {
		title, sub, isPlaying = true, progress = 0.34,
		keyShiftEnabled = false, keyShift = 0, maxKeyShift = 7,
		onplaypause, onprev, onnext, onkey
	}: Props = $props();

	// label like "Key · +2" / "Key · −3" / "Key" at 0
	const keyLabel = $derived(keyShift === 0 ? 'Key' : `Key · ${keyShift > 0 ? '+' : '−'}${Math.abs(keyShift)}`);
	const canDown = $derived(keyShiftEnabled && keyShift > -maxKeyShift);
	const canUp = $derived(keyShiftEnabled && keyShift < maxKeyShift);
</script>

<div class="now">
	<div class="inner">
		<div class="line">
			<div style="min-width:0">
				<div class="t">{title}</div>
				<div class="s">{sub}</div>
			</div>
			<div class="ctrls">
				<button class="ic" aria-label="previous" onclick={() => onprev?.()}>⏮</button>
				<button class="ic play" aria-label="play/pause" onclick={() => onplaypause?.()}>{isPlaying ? '⏸' : '▶'}</button>
				<button class="ic" aria-label="next" onclick={() => onnext?.()}>⏭</button>
			</div>
		</div>
		<div class="seek"><i style="width:{progress * 100}%"></i></div>
		<div class="key" class:disabled={!keyShiftEnabled} class:shifted={keyShift !== 0}>
			<span class="lab">{keyLabel}</span>
			<button disabled={!canDown} onclick={() => onkey?.(keyShift - 1)}>− semitone</button>
			<button disabled={!canUp} onclick={() => onkey?.(keyShift + 1)}>＋ semitone</button>
		</div>
	</div>
</div>

<style>
	.now { position: fixed; left: 0; right: 0; bottom: 0; max-width: var(--max-w); margin: 0 auto; z-index: 10; background: linear-gradient(transparent, var(--bg2) 22%); padding: 14px 14px 18px; }
	.inner { background: var(--card2); border: 1px solid var(--line); border-radius: 18px; padding: 12px 14px; box-shadow: var(--shadow); }
	.line { display: flex; align-items: center; gap: 12px; }
	.t { font-weight: 700; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.s { font-size: 0.78rem; color: var(--ink-dim); }
	.ctrls { display: flex; align-items: center; gap: 10px; margin-left: auto; }
	.ic { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-size: 1rem; cursor: pointer; }
	.ic.play { background: var(--grad); border-color: transparent; width: 46px; height: 46px; }
	.ic:active { transform: scale(0.92); }
	.seek { height: 4px; background: var(--line); border-radius: 4px; margin: 11px 0 2px; }
	.seek > i { display: block; height: 100%; background: var(--grad); border-radius: 4px; }
	.key { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
	.key.disabled { opacity: 0.5; }
	.key .lab { font-size: 0.7rem; color: #5b5b78; letter-spacing: 0.1em; text-transform: uppercase; }
	/* the label brightens to the accent once the song is actually transposed */
	.key.shifted .lab { color: var(--warn); }
	.key button { flex: 1; border: 1px dashed #3a3a55; background: transparent; color: #6b6b8c; border-radius: 10px; padding: 6px; font-size: 0.8rem; cursor: pointer; }
	/* enabled (stems-ready file song): solid, tappable */
	.key:not(.disabled) button:not(:disabled) { border-style: solid; border-color: var(--line); color: var(--ink); }
	.key:not(.disabled) button:not(:disabled):active { transform: scale(0.95); }
	.key button:disabled { cursor: default; }
</style>
