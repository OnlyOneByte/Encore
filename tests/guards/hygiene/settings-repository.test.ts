import { describe, it, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import {
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_ROOM_SETTINGS,
	QUEUE_ORDERS,
	type GlobalSettings,
	type RoomSettings
} from '$lib/contract';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';

function freshRepo() {
	const db = migratedDb();
	return new SettingsRepository(db);
}

describe('SettingsRepository', () => {
	it('a room-scoped write addresses the given room, not the literal "main"', () => {
		// roomId is REQUIRED because every room-scoped method used to DEFAULT it to the literal 'main', so an
		// omitting caller silently addressed 'main' with the compiler saying nothing. What makes the requirement
		// meaningful: a write keyed to some OTHER room lands in THAT room and is invisible to 'main'.
		const repo = freshRepo();
		const other = 'room-728';
		expect(other).not.toBe('main');

		repo.setRoom({ songIntroMs: 4321 }, other);

		expect(repo.getRoom(other).songIntroMs).toBe(4321);
		expect(repo.hasRoom(other)).toBe(true);
		expect(repo.getEffective(other).room.songIntroMs).toBe(4321);

		//... and did NOT bleed into 'main', which never had a row and still reads the default.
		expect(repo.hasRoom('main')).toBe(false);
		expect(repo.getRoom('main').songIntroMs).toBe(DEFAULT_ROOM_SETTINGS.songIntroMs);
		expect(repo.getEffective('main').room.songIntroMs).toBe(DEFAULT_ROOM_SETTINGS.songIntroMs);
	});

	it('returns defaults before anything is written', () => {
		expect(freshRepo().getGlobal()).toEqual(DEFAULT_GLOBAL_SETTINGS);
	});

	it('persists a valid update and reads it back', () => {
		const repo = freshRepo();
		const saved = repo.setGlobal({ defaultModel: 'htdemucs_ft', enqueueUpgrade: true });
		expect(saved.defaultModel).toBe('htdemucs_ft');
		expect(saved.enqueueUpgrade).toBe(true);
		expect(repo.getGlobal().defaultModel).toBe('htdemucs_ft');
	});

	it('the chosen FETCHER survives a write and a re-read', () => {
		// A field can be on GlobalSettings and in the normalizer while having NO column and never being selected, so
		// every read falls back to the shared default and a written choice vanishes. Invisible while yt-dlp is the
		// only implemented fetcher, and a silently wrong answer the moment a second one lands.
		const repo = freshRepo();
		expect(repo.getGlobal().defaultFetcher).toBe(DEFAULT_GLOBAL_SETTINGS.defaultFetcher);
		const saved = repo.setGlobal({ defaultFetcher: 'ytdlp' });
		expect(saved.defaultFetcher).toBe('ytdlp');
		expect(repo.getGlobal().defaultFetcher).toBe('ytdlp');
	});

	it('the chosen LYRICS ENGINES survive a write and a re-read', () => {
		// Same trap as `defaultFetcher` above, and worse than invisible here: the settings page would show `medium`
		// while every process kept using `base`, so the one lever on wrong words would look like it did nothing.
		const repo = freshRepo();
		expect(repo.getGlobal().asrModel).toBe(DEFAULT_GLOBAL_SETTINGS.asrModel);
		const saved = repo.setGlobal({ asrModel: 'medium', syncMode: 'lines' });
		expect(saved.asrModel).toBe('medium');
		expect(saved.syncMode).toBe('lines');
		expect(repo.getGlobal().asrModel).toBe('medium');
		expect(repo.getGlobal().syncMode).toBe('lines');
	});

	it('a de-whitelisted stored model degrades on READ rather than being served to a worker', () => {
		// A checkpoint removed between releases leaves a row naming it, and serving that value would send a worker a token
		// it fails to load. Re-normalizing on READ is what makes the stale row harmless.
		const repo = freshRepo();
		repo.setGlobal({ asrModel: 'small' });
		repo.setGlobal({ asrModel: 'no-longer-shipped' as never });
		expect(repo.getGlobal().asrModel).toBe('small'); // fell back to the current value, not garbage
	});

	it('`local` is refused as a deployment default, on write AND on a stale read', () => {
		// `local` describes one media's bytes, so storing it as the default would mean "never download anything".
		// Re-normalising on READ matters too: a value written by an older build must degrade rather than be served.
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
		expect(freshRepo().getRoom('main')).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('persists room settings independently of global', () => {
		const repo = freshRepo();
		repo.setGlobal({ defaultModel: 'htdemucs_ft' });
		repo.setRoom({ songIntroEnabled: false }, 'main');
		expect(repo.getRoom('main').songIntroEnabled).toBe(false);
		expect(repo.getGlobal().defaultModel).toBe('htdemucs_ft');
	});

	it('keys rooms separately, so two rooms do not share policy', () => {
		const repo = freshRepo();
		repo.setRoom({ songIntroMs: 1000 }, 'room-a');
		repo.setRoom({ songIntroMs: 4000 }, 'room-b');
		expect(repo.getRoom('room-a').songIntroMs).toBe(1000);
		expect(repo.getRoom('room-b').songIntroMs).toBe(4000);
		expect(repo.getRoom('room-c')).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('getEffective returns both layers', () => {
		const repo = freshRepo();
		repo.setGlobal({ enqueueUpgrade: true });
		repo.setRoom({ maxQualityRank: 20 }, 'main');
		const eff = repo.getEffective('main');
		expect(eff.global.enqueueUpgrade).toBe(true);
		expect(eff.room.maxQualityRank).toBe(20);
	});
});

describe('SettingsRepository — invalid writes preserve prior choices', () => {
	it('THE BUG: rejecting an invalid engine must not wipe a previously-saved model', () => {
		const repo = freshRepo();
		repo.setGlobal({ defaultModel: 'htdemucs_ft' });
		const after = repo.setGlobal({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		expect(after.defaultEngine).toBe('demucs');
		//...but the model chosen earlier must survive rather than resetting to the hardcoded default
		expect(after.defaultModel).toBe('htdemucs_ft');
	});
});

describe('SettingsRepository room scope: tv progress style', () => {
	it('defaults to the bottom-edge hairline and round-trips a choice', () => {
		const repo = freshRepo();
		// `edge`, not `card`: the now-singing block is plain text on the backdrop, so there is no card for the
		// in-card treatment to live in. `card` is still a legal choice and still renders its clock row inline.
		expect(repo.getRoom('main').tvProgressStyle).toBe('edge');
		expect(repo.setRoom({ tvProgressStyle: 'card' }, 'main').tvProgressStyle).toBe('card');
		expect(repo.getRoom('main').tvProgressStyle).toBe('card');
	});

	it('falls back to the CURRENT style, not the default, when a write is invalid', () => {
		// setRoom normalized against hardcoded defaults, so one bad field discarded an unrelated room choice.
		const repo = freshRepo();
		repo.setRoom({ tvProgressStyle: 'corner', songIntroMs: 7000 }, 'main');
		const after = repo.setRoom({ tvProgressStyle: 'nonsense' as never }, 'main');
		expect(after.tvProgressStyle).toBe('corner');
		expect(after.songIntroMs).toBe(7000);
	});

	it('an invalid song intro duration keeps the room value rather than resetting to 2500', () => {
		const repo = freshRepo();
		repo.setRoom({ songIntroMs: 7000 }, 'main');
		expect(repo.setRoom({ songIntroMs: NaN }, 'main').songIntroMs).toBe(7000);
	});

	it('an unconfigured room reads as black — an existing box looks identical after the migration', () => {
		expect(freshRepo().getRoom('main').tvBackgroundStyle).toBe('off');
	});

	it('a background choice survives the round trip through SQLite', () => {
		// getRoom builds its normalizer input field-by-field, so a column it forgets to pass reads back as the default no
		// matter what was written. Only a real round trip catches that.
		const repo = freshRepo();
		expect(repo.setRoom({ tvBackgroundStyle: 'singer' }, 'main').tvBackgroundStyle).toBe('singer');
		expect(repo.getRoom('main').tvBackgroundStyle).toBe('singer');
		expect(repo.setRoom({ tvBackgroundStyle: 'solid', tvBackgroundColor: '#002215' }, 'main').tvBackgroundColor).toBe(
			'#002215'
		);
		expect(repo.getRoom('main').tvBackgroundColor).toBe('#002215');
		expect(repo.getRoom('main').tvBackgroundStyle).toBe('solid');
	});

	it('a bad background write keeps every unrelated choice the room already made', () => {
		const repo = freshRepo();
		repo.setRoom(
			{ tvBackgroundStyle: 'solid', tvBackgroundColor: '#281600', songIntroMs: 7000, tvProgressStyle: 'edge' },
			'main'
		);
		const after = repo.setRoom({ tvBackgroundStyle: 'nonsense' as never }, 'main');
		expect(after.tvBackgroundStyle).toBe('solid');
		expect(after.tvBackgroundColor).toBe('#281600');
		expect(after.songIntroMs).toBe(7000);
		expect(after.tvProgressStyle).toBe('edge');
	});

	// The column is TEXT, so what a round trip has to prove is that an arbitrary colour reaches SQLite and comes
	// back byte-identical — a column that silently truncated, or a getRoom that forgot the field, would both read
	// back as the default — and that a junk write cannot poison it.
	it('an arbitrary stage colour survives SQLite verbatim, and junk cannot poison it', () => {
		const repo = freshRepo();
		expect(repo.setRoom({ tvBackgroundColor: '#ffffff' }, 'main').tvBackgroundColor).toBe('#ffffff');
		expect(repo.getRoom('main').tvBackgroundColor).toBe('#ffffff');
		expect(repo.setRoom({ tvBackgroundColor: '#ABC' }, 'main').tvBackgroundColor).toBe('#aabbcc');
		expect(repo.getRoom('main').tvBackgroundColor).toBe('#aabbcc');
		expect(repo.setRoom({ tvBackgroundColor: 'rebeccapurple' as never }, 'main').tvBackgroundColor).toBe('#aabbcc');
		expect(repo.getRoom('main').tvBackgroundColor).toBe('#aabbcc');
	});

	// The stage dimmer, same hazard as the colour above: a column dropped from the SELECT reads back as the
	// default (0) no matter what was written, and a junk write must keep the room's current dim.
	it('the stage dim survives SQLite verbatim, clamps, and junk cannot poison it', () => {
		const repo = freshRepo();
		expect(repo.getRoom('main').tvBackgroundDim).toBe(0); // default: no dim
		expect(repo.setRoom({ tvBackgroundDim: 0.5 }, 'main').tvBackgroundDim).toBe(0.5);
		expect(repo.getRoom('main').tvBackgroundDim).toBe(0.5);
		expect(repo.setRoom({ tvBackgroundDim: 0.126 }, 'main').tvBackgroundDim).toBe(0.13);
		expect(repo.getRoom('main').tvBackgroundDim).toBe(0.13);
		expect(repo.setRoom({ tvBackgroundDim: 9 }, 'main').tvBackgroundDim).toBe(1);
		expect(repo.setRoom({ tvBackgroundDim: 'lots' as never }, 'main').tvBackgroundDim).toBe(1);
		expect(repo.getRoom('main').tvBackgroundDim).toBe(1);
	});

	it('a visualizer choice survives the round trip through SQLite', () => {
		const repo = freshRepo();
		expect(repo.getRoom('main').tvVisualizer).toBe('plasma');
		expect(repo.setRoom({ tvBackgroundStyle: 'visualizer', tvVisualizer: 'starfield' }, 'main').tvVisualizer).toBe(
			'starfield'
		);
		expect(repo.getRoom('main').tvVisualizer).toBe('starfield');
		expect(repo.getRoom('main').tvBackgroundStyle).toBe('visualizer');
	});

	it('the visualizer choice is kept when the room switches to another background and back', () => {
		const repo = freshRepo();
		repo.setRoom({ tvBackgroundStyle: 'visualizer', tvVisualizer: 'lissajous' }, 'main');
		repo.setRoom({ tvBackgroundStyle: 'gradient' }, 'main');
		expect(repo.getRoom('main').tvVisualizer).toBe('lissajous');
		expect(repo.setRoom({ tvBackgroundStyle: 'visualizer' }, 'main').tvVisualizer).toBe('lissajous');
	});

	it('a quality ceiling can be cleared and the clear survives the round trip through SQLite', () => {
		// The "No limit" option sends maxQualityRank: null — the real clear payload. The visualizer sibling above gets this
		// set→change→re-read shape; the ceiling never did, which let a bad normalizer keep the old cap forever with the UI
		// insisting it is off.
		const repo = freshRepo();
		expect(repo.getRoom('main').maxQualityRank).toBeNull();
		expect(repo.setRoom({ maxQualityRank: 20 }, 'main').maxQualityRank).toBe(20);
		expect(repo.getRoom('main').maxQualityRank).toBe(20);
		expect(repo.setRoom({ maxQualityRank: null }, 'main').maxQualityRank).toBeNull();
		expect(repo.getRoom('main').maxQualityRank).toBeNull();
		repo.setRoom({ songIntroMs: 1200 }, 'main');
		expect(repo.getRoom('main').maxQualityRank).toBeNull();
	});

	it('the room default set is complete — every field has a value with no writes at all', () => {
		// A field added to RoomSettings but forgotten in DEFAULT_ROOM_SETTINGS reads as undefined here and would reach
		// a NOT NULL column on the first write. The getRoom SELECT-list omission is the persisted-path guard below.
		const room = freshRepo().getRoom('main');
		for (const [k, v] of Object.entries(room)) {
			if (k === 'maxQualityRank') continue; // legitimately nullable
			expect(v, `${k} has no default`).not.toBeUndefined();
			expect(v, `${k} has no default`).not.toBeNull();
		}
	});

	// A non-default, normalizer-valid value for EVERY RoomSettings key, each differing from its default so a value
	// that reverts on read is a caught failure rather than a coincidental match. The completeness check below makes
	// forgetting one impossible to do SILENTLY.
	const NON_DEFAULT_ROOM: RoomSettings = {
		queueOrder: 'fcfs',
		tvProgressStyle: 'card',
		tvBackgroundStyle: 'solid',
		tvBackgroundColor: '#241900',
		tvBackgroundDim: 0.4,
		tvVisualizer: 'starfield',
		songIntroEnabled: false,
		songIntroMs: 5000,
		maxQualityRank: 3,
		lyricsBall: 'steady',
		lyricsHighlight: 'line',
		lyricsLeadMs: 700,
		lyricsScalePct: 120,
		lyricsFont: 'serif',
		lyricsCase: 'upper',
		lyricsLinesBefore: 1,
		lyricsLinesAfter: 3,
		guideLevelDefault: 0.5,
		loudnessNormalization: true,
		presenceGraceMinutes: 120
	};

	it('every persisted room field survives a write and a re-read (guards the getRoom SELECT list)', () => {
		// THE REAL HAZARD: a field on RoomSettings + in the schema + in DEFAULT_ROOM_SETTINGS but dropped from
		// getRoom's SELECT literal reads back as the DEFAULT no matter what was written — invisible to TypeScript
		// (normalizeRoomSettings takes Partial<RoomSettings>) and to any test that does not go through a persisted
		// row. The loop takes its keys from DEFAULT_ROOM_SETTINGS, so a newly-added field is checked automatically.

		// Overrides must cover exactly the default key set, so a room field added without a NON_DEFAULT_ROOM entry
		// fails and NAMES the omission rather than the round trip silently skipping an unwritten key.
		expect(Object.keys(NON_DEFAULT_ROOM).sort()).toEqual(Object.keys(DEFAULT_ROOM_SETTINGS).sort());

		const repo = freshRepo();
		const written = repo.setRoom(NON_DEFAULT_ROOM, 'main');
		const readBack = repo.getRoom('main');
		for (const k of Object.keys(DEFAULT_ROOM_SETTINGS) as (keyof RoomSettings)[]) {
			// Likeliest cause named first; a normalizer that clamped this override back to its default would red too.
			expect(
				readBack[k],
				`${k} did not survive a persisted round trip — check getRoom's SELECT list (or a normalizer range that clamps this override to its default)`
			).toBe(written[k]);
			expect(
				readBack[k],
				`${k} read back as its default — it is missing from getRoom's SELECT list (or normalized back to the default)`
			).not.toBe(DEFAULT_ROOM_SETTINGS[k]);
		}
	});
});

describe('SettingsRepository global scope: getGlobal SELECT completeness', () => {
	// getGlobal has the same hazard as getRoom: a field dropped from its SELECT literal reads back as its default.
	// This writes a non-default, normalizer-valid value for every GlobalSettings key and re-reads, iterating the
	// key set from DEFAULT_GLOBAL_SETTINGS so a newly-added field is checked automatically.
	//
	// defaultEngine/defaultModel and upgradeEngine/upgradeModel are COUPLED pairings, so the overrides are valid
	// live-selectable / valid-separator pairs rather than independently flipped values.
	//
	// defaultFetcher is deliberately NOT round-trip-checked, and not because another test covers it — it does not.
	// normalizeGlobalSettings refuses the only other FETCHERS member ('local'), and setGlobal is the sole writer,
	// so no value distinct from the default can reach the column through the public API. Its SELECT line is
	// UNOBSERVABLE today, so it is SKIPPED rather than asserted tautologically.
	const GLOBAL_UNOBSERVABLE_FIELDS: (keyof GlobalSettings)[] = ['defaultFetcher'];
	const NON_DEFAULT_GLOBAL: GlobalSettings = {
		defaultFetcher: 'ytdlp', // == DEFAULT; unobservable through the public API, see note above
		defaultEngine: 'roformer',
		defaultModel: 'bs-roformer-1297',
		enqueueUpgrade: true,
		upgradeEngine: 'demucs',
		upgradeModel: 'htdemucs',
		asrModel: 'medium',
		syncMode: 'lines',
		joinOrigin: 'http://host.test:3000',
		// 7, not 0: a non-default that is also not the "uncapped" sentinel, so a dropped SELECT line reds — where 0
		// would be indistinguishable from a normalizer rejecting the write.
		maxProcessesPerSinger: 7
	};

	it('every persisted global field survives a write and a re-read (guards the getGlobal SELECT list)', () => {
		// Overrides must cover exactly the default key set, so a newly-added global field forces a matching entry.
		expect(Object.keys(NON_DEFAULT_GLOBAL).sort()).toEqual(Object.keys(DEFAULT_GLOBAL_SETTINGS).sort());

		const repo = freshRepo();
		const written = repo.setGlobal(NON_DEFAULT_GLOBAL);
		const readBack = repo.getGlobal();
		for (const k of Object.keys(DEFAULT_GLOBAL_SETTINGS) as (keyof GlobalSettings)[]) {
			// defaultFetcher's override equals its default, so a round-trip assertion on it would be tautological.
			if (GLOBAL_UNOBSERVABLE_FIELDS.includes(k)) continue;
			// A coupled pairing degrades to a partner (dropping defaultModel reds as defaultEngine).
			expect(
				readBack[k],
				`${k} did not survive a persisted round trip — check getGlobal's SELECT list (a coupled pairing may name its partner; or a normalizer that rejects this override)`
			).toBe(written[k]);
			expect(
				readBack[k],
				`${k} read back as its default — it is missing from getGlobal's SELECT list (or was normalized back)`
			).not.toBe(DEFAULT_GLOBAL_SETTINGS[k]);
		}
	});
});

describe('SettingsRepository global scope: join origin', () => {
	it('defaults to empty and round-trips a declared address', () => {
		const repo = freshRepo();
		expect(repo.getGlobal().joinOrigin).toBe('');
		expect(repo.setGlobal({ joinOrigin: 'http://10.69.1.169:3000/tv' }).joinOrigin).toBe('http://10.69.1.169:3000');
		expect(repo.getGlobal().joinOrigin).toBe('http://10.69.1.169:3000');
		expect(repo.setGlobal({ joinOrigin: '' }).joinOrigin).toBe('');
	});

	it('a patch to another field leaves the declared address alone', () => {
		// The whole reason setGlobal normalizes over CURRENT values: a slider move elsewhere must not silently put
		// `localhost` back in the TV's QR.
		const repo = freshRepo();
		repo.setGlobal({ joinOrigin: 'http://10.69.1.169:3000' });
		expect(repo.setGlobal({ defaultModel: 'htdemucs_ft' }).joinOrigin).toBe('http://10.69.1.169:3000');
	});
});

describe('SettingsRepository room scope: lyrics presentation', () => {
	it('fresh-room defaults: no marker, word highlight, 0.3s lead', () => {
		// A brand-new room (no stored row) reads the schema column defaults; a room that existed before the ball default
		// flipped keeps its own stored 'lyrics_ball' value via the shipped baseline migration.
		const room = freshRepo().getRoom('main');
		expect(room.lyricsBall).toBe('off');
		expect(room.lyricsHighlight).toBe('word');
		expect(room.lyricsLeadMs).toBe(0);
	});

	it('round-trips all three through a write and a re-read', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'line', lyricsLeadMs: 550 }, 'main');
		const room = repo.getRoom('main');
		expect(room.lyricsBall).toBe('underline');
		expect(room.lyricsHighlight).toBe('line');
		expect(room.lyricsLeadMs).toBe(550);
	});

	it('a patch touching only the ball leaves the highlight and lead alone', () => {
		// A per-field patch over CURRENT values, so a stale Settings page cannot clobber a choice it never showed.
		const repo = freshRepo();
		repo.setRoom({ lyricsHighlight: 'off', lyricsLeadMs: 900 }, 'main');
		repo.setRoom({ lyricsBall: 'steady' }, 'main');
		const room = repo.getRoom('main');
		expect(room.lyricsBall).toBe('steady');
		expect(room.lyricsHighlight).toBe('off');
		expect(room.lyricsLeadMs).toBe(900);
	});

	it('an invalid style keeps the room CURRENT value rather than resetting to the default', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline' }, 'main');
		repo.setRoom({ lyricsBall: 'disco' as never }, 'main');
		expect(repo.getRoom('main').lyricsBall).toBe('underline');
	});

	it('an out-of-range lead is clamped on write, not persisted raw', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsLeadMs: 99_999 }, 'main');
		expect(repo.getRoom('main').lyricsLeadMs).toBe(1500);
		repo.setRoom({ lyricsLeadMs: -400 }, 'main');
		expect(repo.getRoom('main').lyricsLeadMs).toBe(0);
	});

	it('two rooms hold different presentation, since this is per-party', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsHighlight: 'line' }, 'loud-room');
		repo.setRoom({ lyricsHighlight: 'word' }, 'quiet-room');
		expect(repo.getRoom('loud-room').lyricsHighlight).toBe('line');
		expect(repo.getRoom('quiet-room').lyricsHighlight).toBe('word');
	});

	it('presentation is untouched by a global lyrics-engine write', () => {
		// The two layers answer different questions: a syncMode change must not rewrite the room's rendering choice.
		const repo = freshRepo();
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'word' }, 'main');
		repo.setGlobal({ syncMode: 'lines' });
		const room = repo.getRoom('main');
		expect(room.lyricsBall).toBe('underline');
		expect(room.lyricsHighlight).toBe('word');
	});
});

describe('SettingsRepository room scope: lyrics text', () => {
	it('defaults reproduce the reel that shipped before these columns existed', () => {
		const room = freshRepo().getRoom('main');
		expect(room.lyricsScalePct).toBe(100);
		expect(room.lyricsFont).toBe('system');
		expect(room.lyricsCase).toBe('natural');
		expect(room.lyricsLinesBefore).toBe(2);
		expect(room.lyricsLinesAfter).toBe(2);
	});

	it('round-trips all five through a write and a re-read', () => {
		const repo = freshRepo();
		repo.setRoom(
			{
				lyricsScalePct: 130,
				lyricsFont: 'serif',
				lyricsCase: 'upper',
				lyricsLinesBefore: 1,
				lyricsLinesAfter: 3
			},
			'main'
		);
		const room = repo.getRoom('main');
		expect(room.lyricsScalePct).toBe(130);
		expect(room.lyricsFont).toBe('serif');
		expect(room.lyricsCase).toBe('upper');
		expect(room.lyricsLinesBefore).toBe(1);
		expect(room.lyricsLinesAfter).toBe(3);
	});

	it('persists ZERO lines, rather than treating it as unset and falling back to 2', () => {
		// 0 is falsy, so a `|| default` anywhere in the read path would silently restore the history a room turned off.
		const repo = freshRepo();
		repo.setRoom({ lyricsLinesBefore: 0, lyricsLinesAfter: 0 }, 'main');
		const room = repo.getRoom('main');
		expect(room.lyricsLinesBefore).toBe(0);
		expect(room.lyricsLinesAfter).toBe(0);
	});

	it('a patch touching only the font leaves the other four alone', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 145, lyricsCase: 'lower', lyricsLinesAfter: 4 }, 'main');
		repo.setRoom({ lyricsFont: 'mono' }, 'main');
		const room = repo.getRoom('main');
		expect(room.lyricsFont).toBe('mono');
		expect(room.lyricsScalePct).toBe(145);
		expect(room.lyricsCase).toBe('lower');
		expect(room.lyricsLinesAfter).toBe(4);
	});

	it('an out-of-band scale is clamped on write, not persisted raw', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 5 }, 'main');
		expect(repo.getRoom('main').lyricsScalePct).toBe(100); // clamps up to the rebased legibility-floor MIN
		repo.setRoom({ lyricsScalePct: 400 }, 'main');
		expect(repo.getRoom('main').lyricsScalePct).toBe(300); // clamps down to the widened MAX
	});

	it('an invalid font keeps the room CURRENT value rather than resetting to the default', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsFont: 'serif' }, 'main');
		repo.setRoom({ lyricsFont: 'papyrus' as never }, 'main');
		expect(repo.getRoom('main').lyricsFont).toBe('serif');
	});

	it('two rooms hold different type, since this is per-party', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsScalePct: 160, lyricsCase: 'upper' }, 'far-tv');
		repo.setRoom({ lyricsScalePct: 110, lyricsCase: 'natural' }, 'close-tv');
		expect(repo.getRoom('far-tv').lyricsScalePct).toBe(160);
		expect(repo.getRoom('close-tv').lyricsScalePct).toBe(110);
		expect(repo.getRoom('far-tv').lyricsCase).toBe('upper');
	});

	it('text settings are untouched by a marker/highlight write', () => {
		const repo = freshRepo();
		repo.setRoom({ lyricsFont: 'mono', lyricsLinesBefore: 0 }, 'main');
		repo.setRoom({ lyricsBall: 'underline', lyricsHighlight: 'line' }, 'main');
		const room = repo.getRoom('main');
		expect(room.lyricsFont).toBe('mono');
		expect(room.lyricsLinesBefore).toBe(0);
	});
});

describe('SettingsRepository room scope: the ordering algorithm', () => {
	it('defaults to fair rotation — the behaviour that existed before the setting', () => {
		expect(freshRepo().getRoom('main').queueOrder).toBe('fair');
	});

	it('round-trips every registered algorithm', () => {
		const repo = freshRepo();
		for (const p of QUEUE_ORDERS) {
			expect(repo.setRoom({ queueOrder: p.id }, 'main').queueOrder).toBe(p.id);
			expect(repo.getRoom('main').queueOrder).toBe(p.id);
		}
	});

	it('an unregistered algorithm keeps the room on the one it is running', () => {
		// Reject-to-current, not reset-to-default: swapping the house rule mid-party because a retired name was
		// written is worse than ignoring the write.
		const repo = freshRepo();
		repo.setRoom({ queueOrder: 'fcfs' }, 'main');
		expect(repo.setRoom({ queueOrder: 'round-robin' as never }, 'main').queueOrder).toBe('fcfs');
		expect(repo.setRoom({ queueOrder: undefined }, 'main').queueOrder).toBe('fcfs');
	});

	it('a patch touching only pacing leaves the algorithm alone', () => {
		const repo = freshRepo();
		repo.setRoom({ queueOrder: 'shuffle' }, 'main');
		expect(repo.setRoom({ songIntroMs: 1000 }, 'main').queueOrder).toBe('shuffle');
	});

	it('the baseline is never edited in place; a schema addition is an additive follow-on migration', () => {
		// 0000 is the pre-release baseline and must NOT be re-edited: a running box keeps its DB across restarts and
		// boot re-runs runMigrations, so editing 0000 in place makes drizzle replay it and throw on CREATE TABLE of an
		// already-existing table. So 0000 stays as shipped and CARRIES these columns, while any later schema change
		// arrives as a NEW numbered file that only ALTERs. Both halves are asserted.
		const folder = process.env.ENCORE_MIGRATIONS_DIR ?? at('drizzle');
		const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
			entries: { idx: number; tag: string }[];
		};
		expect(journal.entries[0]?.tag).toBe('0000_baseline');
		const sql = readFileSync(join(folder, '0000_baseline.sql'), 'utf8');
		expect(sql).toContain("`queue_order` text DEFAULT 'fair' NOT NULL");
		expect(sql).toContain('`last_sung_at` integer');
		expect(sql).not.toContain('`last_sung_at` integer NOT NULL');
		expect(sql).toContain('SINGLE PRE-RELEASE BASELINE');
		// Any migration AFTER the baseline must never REPLAY a baseline table: a `CREATE TABLE` for a table 0000
		// already created throws on an existing DB. SQLite's only way to change a primary key, though, is the
		// create-copy-drop-rename dance on a `__new_*` TEMP table renamed into place, which is NOT a replay — the temp
		// name never collides with a live table. So: forbid a CREATE TABLE of a baseline table name, allow `__new_*`.
		const baselineSql = readFileSync(join(folder, '0000_baseline.sql'), 'utf8');
		const baselineTables = new Set(
			[...baselineSql.matchAll(/create\s+table\s+`?([a-z_]+)`?/gi)].map((m) => m[1]!.toLowerCase())
		);
		for (const e of journal.entries.slice(1)) {
			const body = readFileSync(join(folder, `${e.tag}.sql`), 'utf8');
			for (const m of body.matchAll(/create\s+table\s+`?([a-z_0-9]+)`?/gi)) {
				const name = m[1]!.toLowerCase();
				// A `__new_*` temp table renamed into place is the SQLite PK-change idiom, not a replay.
				const isRebuildTemp =
					name.startsWith('__new_') && new RegExp(`alter\\s+table\\s+\`?${name}\`?\\s+rename\\s+to`, 'i').test(body);
				expect(isRebuildTemp || !baselineTables.has(name)).toBe(true);
			}
		}
	});
});
