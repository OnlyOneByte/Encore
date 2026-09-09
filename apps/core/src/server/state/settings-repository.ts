// Settings persistence across two scopes.
//
// GLOBAL is a singleton: separator and cook policy belong to the deployment and its worker fleet.
// ROOM is keyed by room id: pacing and a downward-only quality ceiling belong to one party, so
// multi-room needs a row per room rather than a schema change.
//
// Both are read whole / written whole, and every write passes through the shared normalizers so an
// untrusted payload degrades to valid values per-field instead of persisting garbage. Reads
// re-normalize too: a checkpoint can be de-whitelisted between releases, and a stale stored pairing
// must degrade rather than be served.

import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { globalSettings, roomSettings } from '../db/schema';
import {
	type GlobalSettings,
	type RoomSettings,
	type EffectiveSettings,
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_ROOM_SETTINGS,
	normalizeGlobalSettings,
	normalizeRoomSettings
} from '@encore/shared';

const SINGLETON = 'singleton';

export class SettingsRepository {
	constructor(private readonly db: DB) {}

	// ── global ────────────────────────────────────────────────────────────────
	getGlobal(): GlobalSettings {
		const row = this.db.select().from(globalSettings).where(eq(globalSettings.id, SINGLETON)).all()[0];
		if (!row) return { ...DEFAULT_GLOBAL_SETTINGS };
		return normalizeGlobalSettings({
			defaultEngine: row.defaultEngine as GlobalSettings['defaultEngine'],
			defaultModel: row.defaultModel,
			enqueueUpgrade: row.enqueueUpgrade,
			upgradeEngine: row.upgradeEngine as GlobalSettings['upgradeEngine'],
			upgradeModel: row.upgradeModel,
			defaultFetcher: row.defaultFetcher as GlobalSettings['defaultFetcher'],
			asrModel: row.asrModel as GlobalSettings['asrModel'],
			syncMode: row.syncMode as GlobalSettings['syncMode'],
			joinOrigin: row.joinOrigin
		});
	}

	setGlobal(input: Partial<GlobalSettings> | null | undefined): GlobalSettings {
		const current = this.getGlobal();
		// Fall back to CURRENT values, not hardcoded defaults: rejecting one invalid field must not
		// discard an unrelated choice the user already made.
		const next = normalizeGlobalSettings({ ...current, ...(input ?? {}) }, current);
		this.db
			.insert(globalSettings)
			.values({ id: SINGLETON, ...next })
			.onConflictDoUpdate({ target: globalSettings.id, set: next })
			.run();
		return next;
	}

	// ── room ──────────────────────────────────────────────────────────────────
	getRoom(roomId: string): RoomSettings {
		const row = this.db.select().from(roomSettings).where(eq(roomSettings.roomId, roomId)).all()[0];
		if (!row) return { ...DEFAULT_ROOM_SETTINGS };
		return normalizeRoomSettings({
			queueOrder: row.queueOrder,
			tvProgressStyle: row.tvProgressStyle,
			tvBackgroundStyle: row.tvBackgroundStyle,
			tvBackgroundColor: row.tvBackgroundColor,
			tvBackgroundDim: row.tvBackgroundDim,
			tvVisualizer: row.tvVisualizer,
			songIntroEnabled: row.songIntroEnabled,
			songIntroMs: row.songIntroMs,
			maxQualityRank: row.maxQualityRank,
			lyricsBall: row.lyricsBall,
			lyricsHighlight: row.lyricsHighlight,
			lyricsLeadMs: row.lyricsLeadMs,
			lyricsScalePct: row.lyricsScalePct,
			lyricsFont: row.lyricsFont,
			lyricsCase: row.lyricsCase,
			lyricsLinesBefore: row.lyricsLinesBefore,
			lyricsLinesAfter: row.lyricsLinesAfter,
			guideLevelDefault: row.guideLevelDefault,
			presenceGraceMinutes: row.presenceGraceMinutes
		});
	}

	setRoom(input: Partial<RoomSettings> | null | undefined, roomId: string): RoomSettings {
		const current = this.getRoom(roomId);
		const next = normalizeRoomSettings({ ...current, ...(input ?? {}) }, current);
		this.db
			.insert(roomSettings)
			.values({ roomId, ...next })
			.onConflictDoUpdate({ target: roomSettings.roomId, set: next })
			.run();
		return next;
	}

	/** Whether this room has ever written settings — lets boot seed a default without stomping a choice. */
	hasRoom(roomId: string): boolean {
		return this.db.select().from(roomSettings).where(eq(roomSettings.roomId, roomId)).all().length > 0;
	}

	/** Both layers — what `queue:sync` carries and what a client renders. */
	getEffective(roomId: string): EffectiveSettings {
		return { global: this.getGlobal(), room: this.getRoom(roomId) };
	}
}
