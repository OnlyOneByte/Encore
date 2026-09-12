// — apps/core/src/shared/src is grouped into domain subdirectories (core/, queue/, lyrics/, cook/,
// presentation/), and `index.ts` re-exports each so `$shared` import paths never move. THIS TEST
// IS THE CONTRACT that the move preserved: the barrel's exported-name set is frozen here. A future move
// that drops a re-export line, points it at the wrong subdir, or renames a symbol changes this set and
// reds — the barrel is the package's only public surface, so this is where "the surface did not move"
// is proven, independent of the 156 consumer files that import through it.
//
// When the surface INTENTIONALLY changes (a new exported symbol, a deliberate removal), update EXPECTED
// in the same commit — the diff on this list is then the human-readable record of the API change.
import { test, expect } from 'bun:test';
import * as barrel from '$shared';

// The complete set of names `$shared` exports. Sorted; regenerate with:
//   bun -e "import * as b from './src/index.ts'; console.log(Object.keys(b).sort().join('\n'))"
const EXPECTED = [
	'ACCENT2', 'ASR_MODELS', 'ATTEMPT_OUTCOMES', 'AXIS_HIGH_MIDI', 'AXIS_LOW_MIDI', 'CODE_ALPHABET',
	'CODE_EXCLUDED_NOTE', 'CODE_LENGTH', 'DEFAULT_ASR_MODEL',
	'DEFAULT_EFFECTIVE_SETTINGS', 'DEFAULT_ENGINE', 'DEFAULT_FETCHER', 'DEFAULT_GLOBAL_SETTINGS',
	'DEFAULT_LYRICS_BALL', 'DEFAULT_LYRICS_CASE', 'DEFAULT_LYRICS_FONT', 'DEFAULT_LYRICS_HIGHLIGHT',
	'DEFAULT_LYRICS_LEAD_MS', 'DEFAULT_LYRICS_LINES_AFTER', 'DEFAULT_LYRICS_LINES_BEFORE',
	'DEFAULT_LYRICS_SCALE_PCT', 'DEFAULT_MODEL', 'DEFAULT_PRESENCE_GRACE_MINUTES', 'DEFAULT_QUEUE_ORDER',
	'DEFAULT_ROOM_SETTINGS', 'DEFAULT_STAGE_COLOR', 'DEFAULT_STAGE_DIM', 'DEFAULT_SYNC_MODE',
	'EMPTY_SONG_PROFILE', 'FETCHERS', 'GATES', 'JOB_EVENTS', 'LOUDNESS_CLAMP_N_DB',
	'LOUDNESS_MEASURED_FLOOR', 'LYRICS_BALL_STYLES', 'LYRICS_CASES', 'LYRICS_FONTS', 'LYRICS_HIGHLIGHTS',
	'LYRICS_SCALE_BASE', 'MAX_KEY_SHIFT', 'MAX_LYRICS_LEAD_MS', 'MAX_LYRICS_LINES_AFTER',
	'MAX_LYRICS_LINES_BEFORE', 'MAX_LYRICS_SCALE_PCT', 'MAX_MEASURABLE_LUFS', 'MAX_PRESENCE_GRACE_MINUTES',
	'MAX_SONG_INTRO_MS', 'MAX_STAGE_DIM', 'MEDIA_STAGES', 'METADATA_ONLY_SOURCES', 'MIDI_C4',
	'MIN_KEY_CONFIDENCE', 'MIN_LYRICS_SCALE_PCT', 'MIN_MEASURABLE_LUFS', 'MIN_PRESENCE_GRACE_MINUTES',
	'MIN_SONG_INTRO_MS', 'MIN_STAGE_DIM', 'MIN_TOKENS_TO_COMPARE', 'QUEUE_ORDERS', 'SEPARATOR_ENGINES',
	'SEQUENCE_WEIGHT', 'SINGER_C', 'SINGER_COLORS', 'SINGER_HUES', 'SINGER_HUE_STEP', 'SINGER_L',
	'SONG_INTRO_STEP_MS', 'STAGE_BG_C', 'STAGE_BG_L', 'SURFACES', 'SUSPECT_COVERAGE', 'SYNC_MODES',
	'TERMINAL_JOB_STATUSES', 'TV_BACKGROUND_STYLES', 'TV_PROGRESS_STYLES', 'TV_VISUALIZERS', 'VOICE_BANDS',
	'agreement', 'agreementScore', 'applyAndReseq', 'applyOp', 'assignSeqs', 'attemptSelection',
	'attemptStages', 'chosenCandidate', 'clampDays', 'clampGuideLevel', 'clampKeyShift', 'contrastRatio',
	'dimTowardBlack', 'duetPartColors', 'effectiveGuideLevel', 'effectiveSongIntroMs', 'fetcherFor',
	'getAsrModel', 'getEngine', 'getFetcher', 'getLyricsBallStyle', 'getLyricsCase', 'getLyricsFont',
	'getLyricsHighlight', 'getQueueOrder', 'getSyncMode', 'getTvBackgroundStyle', 'getTvProgressStyle',
	'getTvVisualizer', 'graceMsOf', 'guideOffsetSec', 'hasGuidingTrack', 'hasKey', 'hasNewerCandidateThanOverride', 'hasUsableTiming',
	'hasVocalRange', 'hueOfColor', 'hueToHex', 'insertEntry', 'insertIndexFor', 'isAuthoritativeText',
	'isCookableSource', 'isCooking', 'isLegibleSingerColor', 'isLikelyWrongSong', 'isLiveSelectable',
	'isPlayable', 'isQualityUpgrade', 'isQueueOrder', 'isRoomCodeChar', 'isTerminal', 'isTerminalJob', 'isTvBackgroundStyle',
	'isTvProgressStyle', 'isTvVisualizer', 'isValidAsrModel', 'isValidFetcher', 'isValidLyricsBall',
	'isValidLyricsCase', 'isValidLyricsFont', 'isValidLyricsHighlight', 'isValidSeparator',
	'isValidSyncMode', 'isVoiceBandId', 'keyLabel', 'libraryLoudnessMedian', 'loudnessNormalizationGain',
	'lyricHighlightColor', 'lyricsRank', 'lyricsTokens', 'makeRegistry', 'mediaStagePosition',
	'memberState', 'mergeLyricsCandidate', 'midiToNoteName', 'moveToIndex', 'nearestSingerHue', 'needsFetch',
	'nextSwatchIndex', 'normalizeGlobalSettings', 'normalizeJoinOrigin', 'normalizeRoomCodeInput', 'normalizeRoomSettings',
	'normalizeSingerColor', 'normalizeSongProfile', 'normalizeStageColor', 'normalizeStageDim',
	'oklchToRgb', 'originalKeyLabel', 'overallCookPct', 'parseHex', 'pendingGates', 'pickBestLyrics',
	'playbackRef', 'presetTabStopIndex', 'qualityRank', 'queueOrderLabel', 'rangeBarFractions',
	'rangeLabel', 'rangeOctaves', 'readyToSing', 'realtimeFactor', 'reorderWithinSinger',
	'resolveCookSeparator', 'resolveLyricsPresentation', 'resolveLyricsRef', 'roomTopic', 'separatorCost', 'shouldClearClock',
	'shouldStartClock', 'singHistoryFrom', 'songDisplay', 'soundingKeyLabel', 'sourceUriFor',
	'stageHueToHex', 'stageLightnessForHue', 'storedOrder', 'transposePitchClass', 'ulid', 'voiceBandFor',
	'voiceBandSentence', 'voiceBandZones'
].sort();

test('the $shared barrel exports exactly the frozen public surface', () => {
	const actual = Object.keys(barrel).sort();
	// non-vacuity: the barrel resolves to a real, populated module (not an empty namespace from a
	// broken re-export path).
	expect(actual.length, 'barrel exported nothing — a re-export path is broken').toBeGreaterThan(150);

	const missing = EXPECTED.filter((n) => !actual.includes(n));
	const added = actual.filter((n) => !EXPECTED.includes(n));
	expect(missing, `missing from barrel (a re-export was dropped or mis-pathed): ${missing.join(', ')}`).toEqual([]);
	expect(added, `unexpected new barrel export (update EXPECTED if intended): ${added.join(', ')}`).toEqual([]);
});
