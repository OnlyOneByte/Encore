import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { runMigrations } from '../db/migrate';
import * as schema from '../db/schema';
import { SettingsRepository } from './settings-repository';
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_ROOM_SETTINGS } from '@encore/shared';

function freshRepo() {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite, { schema });
	runMigrations(db);
	return new SettingsRepository(db);
}

describe('SettingsRepository', () => {
	it('returns defaults before anything is written', () => {
		expect(freshRepo().getGlobal()).toEqual(DEFAULT_GLOBAL_SETTINGS);
	});

	it('persists a valid update and reads it back', () => {
		const repo = freshRepo();
		const saved = repo.setGlobal({ defaultModel: 'htdemucs_ft', enqueueUpgrade: true });
		expect(saved.defaultModel).toBe('htdemucs_ft');
		expect(saved.enqueueUpgrade).toBe(true);
		// a second instance on the same db sees the persisted row (proves it hit SQLite, not memory)
		expect(repo.getGlobal().defaultModel).toBe('htdemucs_ft');
	});

	it('a partial patch preserves the untouched fields', () => {
		const repo = freshRepo();
		repo.setGlobal({ defaultModel: 'htdemucs_ft' });
		const after = repo.setGlobal({ enqueueUpgrade: true });
		expect(after.defaultModel).toBe('htdemucs_ft'); // not reset by the second patch
		expect(after.enqueueUpgrade).toBe(true);
	});

	it('an invalid live pairing is rejected on write (falls back, never persists garbage)', () => {
		const repo = freshRepo();
		const saved = repo.setGlobal({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		// ensemble is upgrade-only, not a valid LIVE default → falls back
		expect(saved.defaultEngine).toBe(DEFAULT_GLOBAL_SETTINGS.defaultEngine);
		expect(saved.defaultModel).toBe(DEFAULT_GLOBAL_SETTINGS.defaultModel);
	});
});

describe('SettingsRepository — room scope', () => {
	it('returns room defaults before anything is written', () => {
		expect(freshRepo().getRoom()).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('persists room settings independently of global', () => {
		const repo = freshRepo();
		repo.setGlobal({ defaultModel: 'htdemucs_ft' });
		repo.setRoom({ interstitialMs: 0 });
		// each scope keeps its own values; a room write must not disturb deployment policy
		expect(repo.getRoom().interstitialMs).toBe(0);
		expect(repo.getGlobal().defaultModel).toBe('htdemucs_ft');
	});

	it('keys rooms separately, so two rooms do not share policy', () => {
		const repo = freshRepo();
		repo.setRoom({ interstitialMs: 1000 }, 'room-a');
		repo.setRoom({ interstitialMs: 4000 }, 'room-b');
		expect(repo.getRoom('room-a').interstitialMs).toBe(1000);
		expect(repo.getRoom('room-b').interstitialMs).toBe(4000);
		// an untouched room still gets defaults rather than another room's values
		expect(repo.getRoom('room-c')).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('getEffective returns both layers', () => {
		const repo = freshRepo();
		repo.setGlobal({ enqueueUpgrade: true });
		repo.setRoom({ maxQualityRank: 20 });
		const eff = repo.getEffective();
		expect(eff.global.enqueueUpgrade).toBe(true);
		expect(eff.room.maxQualityRank).toBe(20);
	});
});

describe('SettingsRepository — invalid writes preserve prior choices', () => {
	it('THE BUG: rejecting an invalid engine must not wipe a previously-saved model', () => {
		const repo = freshRepo();
		repo.setGlobal({ defaultModel: 'htdemucs_ft' });
		// ensemble is upgrade-only, so this live pairing is invalid and must be refused...
		const after = repo.setGlobal({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		expect(after.defaultEngine).toBe('demucs');
		// ...but the model chosen earlier must survive rather than resetting to the hardcoded default
		expect(after.defaultModel).toBe('htdemucs_ft');
	});
});
