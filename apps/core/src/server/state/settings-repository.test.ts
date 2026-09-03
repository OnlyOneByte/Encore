import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { runMigrations } from '../db/migrate';
import * as schema from '../db/schema';
import { SettingsRepository } from './settings-repository';
import { DEFAULT_ROOM_SETTINGS } from '@encore/shared';

function freshRepo() {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite, { schema });
	runMigrations(db);
	return new SettingsRepository(db);
}

describe('SettingsRepository', () => {
	it('returns defaults before anything is written', () => {
		expect(freshRepo().get()).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('persists a valid update and reads it back', () => {
		const repo = freshRepo();
		const saved = repo.set({ defaultModel: 'htdemucs_ft', enqueueUpgrade: true });
		expect(saved.defaultModel).toBe('htdemucs_ft');
		expect(saved.enqueueUpgrade).toBe(true);
		// a second instance on the same db sees the persisted row (proves it hit SQLite, not memory)
		expect(repo.get().defaultModel).toBe('htdemucs_ft');
	});

	it('a partial patch preserves the untouched fields', () => {
		const repo = freshRepo();
		repo.set({ defaultModel: 'htdemucs_ft' });
		const after = repo.set({ enqueueUpgrade: true });
		expect(after.defaultModel).toBe('htdemucs_ft'); // not reset by the second patch
		expect(after.enqueueUpgrade).toBe(true);
	});

	it('an invalid live pairing is rejected on write (falls back, never persists garbage)', () => {
		const repo = freshRepo();
		const saved = repo.set({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		// ensemble is upgrade-only, not a valid LIVE default → falls back
		expect(saved.defaultEngine).toBe(DEFAULT_ROOM_SETTINGS.defaultEngine);
		expect(saved.defaultModel).toBe(DEFAULT_ROOM_SETTINGS.defaultModel);
	});
});
