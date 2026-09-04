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

	it('the chosen FETCHER survives a write and a re-read', () => {
		// REGRESSION: `defaultFetcher` existed on GlobalSettings and in the normalizer, but there was no
		// column and `getGlobal` never selected it — so every read fell back to the shared default and a
		// written choice vanished. Invisible while yt-dlp is the only implemented fetcher, and a silently
		// wrong answer the moment a second one lands.
		const repo = freshRepo();
		expect(repo.getGlobal().defaultFetcher).toBe(DEFAULT_GLOBAL_SETTINGS.defaultFetcher);
		const saved = repo.setGlobal({ defaultFetcher: 'ytdlp' });
		expect(saved.defaultFetcher).toBe('ytdlp');
		expect(repo.getGlobal().defaultFetcher).toBe('ytdlp');
	});

	it('the chosen LYRICS ENGINES survive a write and a re-read', () => {
		// Same trap as `defaultFetcher` above, and the reason that regression test exists: a field can be
		// on GlobalSettings and in the normalizer while having no column and never being selected, so
		// every read falls back to the default and the operator's choice silently vanishes. Here it would
		// be worse than invisible — the settings page would show `medium` while every cook kept using
		// `base`, so the one lever on wrong words would look like it did nothing.
		const repo = freshRepo();
		expect(repo.getGlobal().asrModel).toBe(DEFAULT_GLOBAL_SETTINGS.asrModel);
		const saved = repo.setGlobal({ asrModel: 'medium', syncMode: 'lines' });
		expect(saved.asrModel).toBe('medium');
		expect(saved.syncMode).toBe('lines');
		expect(repo.getGlobal().asrModel).toBe('medium');
		expect(repo.getGlobal().syncMode).toBe('lines');
	});

	it('a de-whitelisted stored model degrades on READ rather than being served to a worker', () => {
		// A checkpoint removed between releases leaves a row naming it. Serving that value would send a
		// worker a token it fails to load; re-normalizing on read is what makes the stale row harmless.
		const repo = freshRepo();
		repo.setGlobal({ asrModel: 'small' });
		// simulate the row surviving a release that dropped the checkpoint
		repo.setGlobal({ asrModel: 'no-longer-shipped' as never });
		expect(repo.getGlobal().asrModel).toBe('small'); // fell back to the current value, not garbage
	});

	it('`local` is refused as a deployment default, on write AND on a stale read', () => {
		// `local` describes one media's bytes, so storing it as the default would mean "never download
		// anything". Re-normalising on READ matters too: a value written by an older build, or a fetcher
		// de-whitelisted between releases, must degrade rather than be served.
		const repo = freshRepo();
		expect(repo.setGlobal({ defaultFetcher: 'local' as never }).defaultFetcher).toBe(
			DEFAULT_GLOBAL_SETTINGS.defaultFetcher
		);
		expect(repo.setGlobal({ defaultFetcher: 'librespot' as never }).defaultFetcher).toBe(
			DEFAULT_GLOBAL_SETTINGS.defaultFetcher
		);
		expect(repo.getGlobal().defaultFetcher).toBe(DEFAULT_GLOBAL_SETTINGS.defaultFetcher);
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
		repo.setRoom({ songIntroEnabled: false });
		// each scope keeps its own values; a room write must not disturb deployment policy
		expect(repo.getRoom().songIntroEnabled).toBe(false);
		expect(repo.getGlobal().defaultModel).toBe('htdemucs_ft');
	});

	it('keys rooms separately, so two rooms do not share policy', () => {
		const repo = freshRepo();
		repo.setRoom({ songIntroMs: 1000 }, 'room-a');
		repo.setRoom({ songIntroMs: 4000 }, 'room-b');
		expect(repo.getRoom('room-a').songIntroMs).toBe(1000);
		expect(repo.getRoom('room-b').songIntroMs).toBe(4000);
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

describe('SettingsRepository room scope: tv progress style', () => {
	it('defaults to the in-card treatment and round-trips a choice', () => {
		const repo = freshRepo();
		expect(repo.getRoom().tvProgressStyle).toBe('card');
		expect(repo.setRoom({ tvProgressStyle: 'edge' }).tvProgressStyle).toBe('edge');
		expect(repo.getRoom().tvProgressStyle).toBe('edge');
	});

	it('falls back to the CURRENT style, not the default, when a write is invalid', () => {
		// The bug this pins: setRoom normalized against hardcoded defaults, so one bad field discarded an
		// unrelated choice the room had already made. Same defect previously fixed on the global scope.
		const repo = freshRepo();
		repo.setRoom({ tvProgressStyle: 'corner', songIntroMs: 7000 });
		const after = repo.setRoom({ tvProgressStyle: 'nonsense' as never });
		expect(after.tvProgressStyle).toBe('corner');
		expect(after.songIntroMs).toBe(7000);
	});

	it('an invalid song intro duration keeps the room value rather than resetting to 2500', () => {
		const repo = freshRepo();
		repo.setRoom({ songIntroMs: 7000 });
		expect(repo.setRoom({ songIntroMs: NaN }).songIntroMs).toBe(7000);
	});

	it('an unconfigured room reads as black — an existing box looks identical after the migration', () => {
		expect(freshRepo().getRoom().tvBackgroundStyle).toBe('off');
	});

	it('a background choice survives the round trip through SQLite', () => {
		// getRoom builds the normalizer input field-by-field, so a column it forgets to pass silently
		// reads back as the default no matter what was written. Only a real round trip catches that.
		const repo = freshRepo();
		expect(repo.setRoom({ tvBackgroundStyle: 'singer' }).tvBackgroundStyle).toBe('singer');
		expect(repo.getRoom().tvBackgroundStyle).toBe('singer');
		expect(repo.setRoom({ tvBackgroundStyle: 'solid', tvBackgroundHue: 165 }).tvBackgroundHue).toBe(165);
		expect(repo.getRoom().tvBackgroundHue).toBe(165);
		expect(repo.getRoom().tvBackgroundStyle).toBe('solid');
	});

	it('a bad background write keeps every unrelated choice the room already made', () => {
		const repo = freshRepo();
		repo.setRoom({ tvBackgroundStyle: 'solid', tvBackgroundHue: 75, songIntroMs: 7000, tvProgressStyle: 'edge' });
		const after = repo.setRoom({ tvBackgroundStyle: 'nonsense' as never });
		expect(after.tvBackgroundStyle).toBe('solid');
		expect(after.tvBackgroundHue).toBe(75);
		expect(after.songIntroMs).toBe(7000);
		expect(after.tvProgressStyle).toBe('edge');
	});

	it('the stored hue is always one the wheel can render', () => {
		const repo = freshRepo();
		expect(repo.setRoom({ tvBackgroundHue: 200 }).tvBackgroundHue).toBe(195); // snapped to the step
		expect(repo.getRoom().tvBackgroundHue).toBe(195);
		expect(repo.setRoom({ tvBackgroundHue: -30 }).tvBackgroundHue).toBe(330); // wrapped, not rejected
	});

	it('a visualizer choice survives the round trip through SQLite', () => {
		const repo = freshRepo();
		expect(repo.getRoom().tvVisualizer).toBe('plasma');
		expect(repo.setRoom({ tvBackgroundStyle: 'visualizer', tvVisualizer: 'starfield' }).tvVisualizer).toBe('starfield');
		expect(repo.getRoom().tvVisualizer).toBe('starfield');
		expect(repo.getRoom().tvBackgroundStyle).toBe('visualizer');
	});

	it('the visualizer choice is kept when the room switches to another background and back', () => {
		const repo = freshRepo();
		repo.setRoom({ tvBackgroundStyle: 'visualizer', tvVisualizer: 'lissajous' });
		repo.setRoom({ tvBackgroundStyle: 'gradient' });
		expect(repo.getRoom().tvVisualizer).toBe('lissajous');
		expect(repo.setRoom({ tvBackgroundStyle: 'visualizer' }).tvVisualizer).toBe('lissajous');
	});

	it('the room default set is complete — every field has a value with no writes at all', () => {
		// A field added to RoomSettings but forgotten in DEFAULT_ROOM_SETTINGS reads as undefined here and
		// would reach a NOT NULL column on the first write.
		const room = freshRepo().getRoom();
		for (const [k, v] of Object.entries(room)) {
			if (k === 'maxQualityRank') continue; // legitimately nullable
			expect(v, `${k} has no default`).not.toBeUndefined();
			expect(v, `${k} has no default`).not.toBeNull();
		}
		expect(Object.keys(room).sort()).toEqual(Object.keys(DEFAULT_ROOM_SETTINGS).sort());
	});
});

describe('SettingsRepository global scope: join origin', () => {
	it('defaults to empty and round-trips a declared address', () => {
		const repo = freshRepo();
		expect(repo.getGlobal().joinOrigin).toBe('');
		expect(repo.setGlobal({ joinOrigin: 'http://10.69.1.169:3000/tv' }).joinOrigin).toBe('http://10.69.1.169:3000');
		expect(repo.getGlobal().joinOrigin).toBe('http://10.69.1.169:3000');
		// Explicit empty clears it, back to env/request auto-detection.
		expect(repo.setGlobal({ joinOrigin: '' }).joinOrigin).toBe('');
	});

	it('a patch to another field leaves the declared address alone', () => {
		// The whole reason setGlobal normalizes over CURRENT values: a slider move elsewhere must not
		// silently put `localhost` back in the TV's QR.
		const repo = freshRepo();
		repo.setGlobal({ joinOrigin: 'http://10.69.1.169:3000' });
		expect(repo.setGlobal({ defaultModel: 'htdemucs_ft' }).joinOrigin).toBe('http://10.69.1.169:3000');
	});
});

describe('SettingsRepository room scope: lyrics presentation', () => {
	it('defaults reproduce the previously-hardcoded TV', () => {
		// The migration is additive with these as column defaults, so a room that existed before this
		// feature must read back identical to how it rendered.
		const room = freshRepo().getRoom();
		expect(room.lyricsBall).toBe('bounce');
		expect(room.lyricsHighlight).toBe('word');
		expect(room.lyricsLeadMs).toBe(300);
	});

	it('round-trips all three through a write and a re-read', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'line', lyricsLeadMs: 550 });
		const room = repo.getRoom();
		expect(room.lyricsBall).toBe('underline');
		expect(room.lyricsHighlight).toBe('line');
		expect(room.lyricsLeadMs).toBe(550);
	});

	it('a patch touching only the ball leaves the highlight and lead alone', () => {
		// Same contract as every other room field: a per-field patch over CURRENT values, so a stale
		// Settings page cannot clobber a choice it never showed.
		const repo = freshRepo();
		repo.setRoom({ lyricsHighlight: 'off', lyricsLeadMs: 900 });
		repo.setRoom({ lyricsBall: 'steady' });
		const room = repo.getRoom();
		expect(room.lyricsBall).toBe('steady');
		expect(room.lyricsHighlight).toBe('off');
		expect(room.lyricsLeadMs).toBe(900);
	});

	it('an invalid style keeps the room CURRENT value rather than resetting to the default', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline' });
		repo.setRoom({ lyricsBall: 'disco' as never });
		expect(repo.getRoom().lyricsBall).toBe('underline');
	});

	it('an out-of-range lead is clamped on write, not persisted raw', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsLeadMs: 99_999 });
		expect(repo.getRoom().lyricsLeadMs).toBe(1500);
		repo.setRoom({ lyricsLeadMs: -400 });
		expect(repo.getRoom().lyricsLeadMs).toBe(0);
	});

	it('two rooms hold different presentation, since this is per-party', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsHighlight: 'line' }, 'loud-room');
		repo.setRoom({ lyricsHighlight: 'word' }, 'quiet-room');
		expect(repo.getRoom('loud-room').lyricsHighlight).toBe('line');
		expect(repo.getRoom('quiet-room').lyricsHighlight).toBe('word');
	});

	it('presentation is untouched by a global lyrics-engine write', () => {
		// The two layers answer different questions; a syncMode change must not rewrite the room's
		// rendering choice, only what the resolver can honour.
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'word' });
		repo.setGlobal({ syncMode: 'lines' });
		const room = repo.getRoom();
		expect(room.lyricsBall).toBe('underline');
		expect(room.lyricsHighlight).toBe('word');
	});
});

describe('SettingsRepository room scope: lyrics text', () => {
	it('defaults reproduce the reel that shipped before these columns existed', () => {
		const room = freshRepo().getRoom();
		expect(room.lyricsScalePct).toBe(100);
		expect(room.lyricsFont).toBe('system');
		expect(room.lyricsCase).toBe('natural');
		expect(room.lyricsLinesBefore).toBe(2);
		expect(room.lyricsLinesAfter).toBe(2);
	});

	it('round-trips all five through a write and a re-read', () => {
		const repo = freshRepo();
		repo.setRoom({
			lyricsScalePct: 130,
			lyricsFont: 'serif',
			lyricsCase: 'upper',
			lyricsLinesBefore: 1,
			lyricsLinesAfter: 3
		});
		const room = repo.getRoom();
		expect(room.lyricsScalePct).toBe(130);
		expect(room.lyricsFont).toBe('serif');
		expect(room.lyricsCase).toBe('upper');
		expect(room.lyricsLinesBefore).toBe(1);
		expect(room.lyricsLinesAfter).toBe(3);
	});

	it('persists ZERO lines, rather than treating it as unset and falling back to 2', () => {
		// The bug this guards: 0 is falsy, so a `|| default` anywhere in the read path would silently
		// restore the history a room explicitly turned off.
		const repo = freshRepo();
		repo.setRoom({ lyricsLinesBefore: 0, lyricsLinesAfter: 0 });
		const room = repo.getRoom();
		expect(room.lyricsLinesBefore).toBe(0);
		expect(room.lyricsLinesAfter).toBe(0);
	});

	it('a patch touching only the font leaves the other four alone', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 145, lyricsCase: 'lower', lyricsLinesAfter: 4 });
		repo.setRoom({ lyricsFont: 'mono' });
		const room = repo.getRoom();
		expect(room.lyricsFont).toBe('mono');
		expect(room.lyricsScalePct).toBe(145);
		expect(room.lyricsCase).toBe('lower');
		expect(room.lyricsLinesAfter).toBe(4);
	});

	it('an out-of-band scale is clamped on write, not persisted raw', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 5 });
		expect(repo.getRoom().lyricsScalePct).toBe(80);
		repo.setRoom({ lyricsScalePct: 400 });
		expect(repo.getRoom().lyricsScalePct).toBe(160);
	});

	it('an invalid font keeps the room CURRENT value rather than resetting to the default', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsFont: 'serif' });
		repo.setRoom({ lyricsFont: 'papyrus' as never });
		expect(repo.getRoom().lyricsFont).toBe('serif');
	});

	it('two rooms hold different type, since this is per-party', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 160, lyricsCase: 'upper' }, 'far-tv');
		repo.setRoom({ lyricsScalePct: 90, lyricsCase: 'natural' }, 'close-tv');
		expect(repo.getRoom('far-tv').lyricsScalePct).toBe(160);
		expect(repo.getRoom('close-tv').lyricsScalePct).toBe(90);
		expect(repo.getRoom('far-tv').lyricsCase).toBe('upper');
	});

	it('text settings are untouched by a marker/highlight write', () => {
		// The two groups are independent: one is the type, the other the marks drawn on it.
		const repo = freshRepo();
		repo.setRoom({ lyricsFont: 'mono', lyricsLinesBefore: 0 });
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'line' });
		const room = repo.getRoom();
		expect(room.lyricsFont).toBe('mono');
		expect(room.lyricsLinesBefore).toBe(0);
	});
});
