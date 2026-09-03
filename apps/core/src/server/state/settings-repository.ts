// Room-level separator settings (B-8). Read whole / written whole against the `room_settings`
// singleton row. The shared `RoomSettings` type is the contract; `normalizeRoomSettings` gates every
// write so an untrusted client payload degrades to defaults per-field rather than persisting garbage.

import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { roomSettings } from '../db/schema';
import {
	type RoomSettings,
	DEFAULT_ROOM_SETTINGS,
	normalizeRoomSettings
} from '@encore/shared';

const SINGLETON = 'singleton';

export class SettingsRepository {
	constructor(private readonly db: DB) {}

	/** Current settings, or the defaults when the row has never been written. */
	get(): RoomSettings {
		const row = this.db.select().from(roomSettings).where(eq(roomSettings.id, SINGLETON)).all()[0];
		if (!row) return { ...DEFAULT_ROOM_SETTINGS };
		// Run stored values back through normalize: a checkpoint can be de-whitelisted between
		// releases, and a stale stored pairing must degrade to a valid one rather than being served.
		return normalizeRoomSettings({
			defaultEngine: row.defaultEngine as RoomSettings['defaultEngine'],
			defaultModel: row.defaultModel,
			enqueueUpgrade: row.enqueueUpgrade,
			upgradeEngine: row.upgradeEngine as RoomSettings['upgradeEngine'],
			upgradeModel: row.upgradeModel
		});
	}

	/** Validate + persist a (possibly partial) update, returning the resulting authoritative settings. */
	set(input: Partial<RoomSettings> | null | undefined): RoomSettings {
		const next = normalizeRoomSettings({ ...this.get(), ...(input ?? {}) });
		this.db
			.insert(roomSettings)
			.values({ id: SINGLETON, ...next })
			.onConflictDoUpdate({ target: roomSettings.id, set: next })
			.run();
		return next;
	}
}
