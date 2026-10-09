/*
 * THE SETTINGS WRITE MODEL, in one place because two scope routes perform it and the subtle half of it is a
 * fix that must not be re-broken by a copy that drifted: a refused write rolls back ONLY the fields it sent.
 *
 * There is no socket on a settings route. Every control writes a per-field patch which the server re-normalizes
 * over CURRENT values, so a stale page can only change the field it sends. The patch is applied optimistically —
 * a select that waits for a round trip reads as not having taken — and reconciled against the authoritative
 * response.
 */
import type { EffectiveSettings, GlobalSettings, RoomSettings } from '$lib/contract';

export interface SettingsWrites {
	/** The live settings: the server's last word, plus any optimistic write and any drag frame. */
	readonly settings: EffectiveSettings;
	/** True while the last write stands refused. The scope shell reads it to show one destructive Alert. */
	readonly failed: boolean;
	/** Commit room-scope fields. */
	onroom: (body: Partial<RoomSettings>) => Promise<void>;
	/** Commit global-scope fields. */
	onglobal: (body: Partial<GlobalSettings>) => Promise<void>;
	/** Move one ROOM field on screen without writing, so a readout tracks the thumb. */
	liveRoom: <K extends keyof RoomSettings>(field: K, value: RoomSettings[K]) => void;
	/** The same, for a GLOBAL field. */
	liveGlobal: <K extends keyof GlobalSettings>(field: K, value: GlobalSettings[K]) => void;
}

/**
 * @param read the page's own `() => data.settings`, so a load re-run is re-adopted here rather than ignored.
 */
export function createSettingsWrites(read: () => EffectiveSettings): SettingsWrites {
	/* WRITABLE `$derived`, because a write lands optimistically AND a load re-run must re-adopt `data`. That is
	   exactly what writable `$derived` is; the `$state` + `untrack` + effect form this replaces was emulating it
	   one microtask late. */
	let settings = $derived(read());

	/* The last value the SERVER confirmed. `settings` moves on every drag frame; this does not, so a rejected
	   commit rolls back to what the server holds rather than to the dragged value it refused. Also
	   writable-derived: `patch()` assigns it on a confirmed write, and a load re-run re-adopts. */
	let committed = $derived(read());

	let failed = $state(false);

	async function patch(scope: 'global' | 'room', body: Record<string, unknown>) {
		settings =
			scope === 'global'
				? { ...settings, global: { ...settings.global, ...body } }
				: { ...settings, room: { ...settings.room, ...body } };
		failed = false;
		try {
			const res = await fetch(scope === 'global' ? '/api/settings' : '/api/settings/room', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error('rejected');
			settings = await res.json();
			committed = settings;
		} catch {
			/* Only the fields THIS write sent go back, and to what the server holds NOW — every other field keeps
			   whatever landed while this request was in flight. Restoring a whole pre-request snapshot silently undid
			   a CONCURRENT write: flip two toggles, the second is accepted, the first is refused, and the refusal put
			   the accepted toggle back too, so a setting the server has stored reads as off. */
			const restored = Object.fromEntries(Object.entries(committed[scope]).filter(([field]) => field in body));
			settings =
				scope === 'global'
					? { ...settings, global: { ...settings.global, ...restored } }
					: { ...settings, room: { ...settings.room, ...restored } };
			failed = true;
		}
	}

	return {
		// GETTERS, not values: a plain property would snapshot the deriveds at construction and never move again.
		get settings() {
			return settings;
		},
		get failed() {
			return failed;
		},
		onroom: (body) => patch('room', body),
		onglobal: (body) => patch('global', body),
		liveRoom: (field, value) => {
			settings = { ...settings, room: { ...settings.room, [field]: value } };
		},
		liveGlobal: (field, value) => {
			settings = { ...settings, global: { ...settings.global, [field]: value } };
		}
	};
}
