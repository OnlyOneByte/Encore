// YouTube Music search parsing: the InnerTube response shape, and the narrowing that makes it useful.
//
// The value of THIS source over `ytsearch` is metadata: a music-catalog row carries the real artist and
// the track duration, where an all-of-YouTube hit carries the UPLOADER as artist and a video length. So
// these tests pin the field extraction against a response captured from the live API, and pin the
// identity decision (`source: 'youtube'`) that keeps one video from becoming two library rows.
import { test, expect } from 'bun:test';
import { parseMusicSearch, parseDuration, parsePlays } from '$lib/server/media/ytmusic';

/** A trimmed capture of a real `music.youtube.com/youtubei/v1/search` response (songs filter). The
 *  nesting is kept — the parser searches by renderer key precisely because InnerTube moves these. */
const RESPONSE = {
	contents: {
		tabbedSearchResultsRenderer: {
			tabs: [
				{
					tabRenderer: {
						content: {
							sectionListRenderer: {
								contents: [
									{
										musicShelfRenderer: {
											contents: [
												{
													musicResponsiveListItemRenderer: {
														playlistItemData: { videoId: 'mE2O5LsrPuA' },
														flexColumns: [
															{
																musicResponsiveListItemFlexColumnRenderer: {
																	text: { runs: [{ text: 'Never Be Alone' }] }
																}
															},
															{
																musicResponsiveListItemFlexColumnRenderer: {
																	text: {
																		runs: [
																			{ text: 'TheFatRat' },
																			{ text: ' • ' },
																			{ text: 'Never Be Alone' },
																			{ text: ' • ' },
																			{ text: '4:20' }
																		]
																	}
																}
															},
															{
																musicResponsiveListItemFlexColumnRenderer: {
																	text: { runs: [{ text: '827K plays' }] }
																}
															}
														]
													}
												},
												{
													musicResponsiveListItemRenderer: {
														playlistItemData: { videoId: 'z8owzOAosig' },
														flexColumns: [
															{
																musicResponsiveListItemFlexColumnRenderer: {
																	text: { runs: [{ text: 'Never Be Alone (Radio Edit)' }] }
																}
															},
															{
																musicResponsiveListItemFlexColumnRenderer: {
																	text: {
																		runs: [
																			{ text: 'Dougal ' },
																			{ text: ', ' },
																			{ text: ' Technikore' },
																			{ text: ' • ' },
																			{ text: 'Never Be Alone' },
																			{ text: ' • ' },
																			{ text: '2:57' }
																		]
																	}
																}
															}
														]
													}
												}
											]
										}
									}
								]
							}
						}
					}
				}
			]
		}
	}
};

test('a music-catalog row yields the ARTIST and track duration, not an uploader and a video length', () => {
	const [first] = parseMusicSearch(RESPONSE, 12);
	expect(first).toBeDefined();
	// The whole point of searching YouTube Music: `artist` is the performer, from the catalog.
	expect(first!.artist).toBe('TheFatRat');
	expect(first!.title).toBe('Never Be Alone');
	expect(first!.durationSec).toBe(260); // 4:20
	expect(first!.viewCount).toBe(827_000);
	expect(first!.thumbnail).toContain('mE2O5LsrPuA');
});

test('a music hit keeps YOUTUBE identity — where it was found is not what it is', () => {
	// A music result IS a YouTube video id. Tagging it anything else would split the same video into
	// two library rows, and break the fetcher/thumbnail/retention paths that speak that identity.
	for (const r of parseMusicSearch(RESPONSE, 12)) {
		expect(r.source).toBe('youtube');
		expect(r.sourceRef).toMatch(/^[\w-]{11}$/);
	}
});

test('multi-run artists join into one name, and a missing plays column is simply absent', () => {
	const second = parseMusicSearch(RESPONSE, 12)[1]!;
	expect(second.artist).toBe('Dougal ,  Technikore');
	expect(second.durationSec).toBe(177); // 2:57
	expect(second.viewCount).toBeUndefined();
});

test('the limit is honoured', () => {
	expect(parseMusicSearch(RESPONSE, 1)).toHaveLength(1);
});

test('a reshaped or empty response yields no results rather than throwing', () => {
	// InnerTube is unofficial: the shape WILL move. A parse failure must degrade to a dead source,
	// which `safeSearch` in the route already tolerates — never a 500 on a keystroke.
	expect(parseMusicSearch({}, 12)).toEqual([]);
	expect(parseMusicSearch({ contents: { somethingNew: [1, 2, 3] } }, 12)).toEqual([]);
	expect(parseMusicSearch(null, 12)).toEqual([]);
});

test('a row with no videoId or no title is dropped, not emitted half-built', () => {
	const doc = {
		musicShelfRenderer: {
			contents: [
				{ musicResponsiveListItemRenderer: { flexColumns: [] } }, // no videoId
				{
					musicResponsiveListItemRenderer: {
						playlistItemData: { videoId: 'aaaaaaaaaaa' },
						flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '  ' }] } } }]
					}
				} // blank title
			]
		}
	};
	expect(parseMusicSearch(doc, 12)).toEqual([]);
});

test('a row with an unparseable duration still lists — duration is probe-verified later', () => {
	const doc = {
		musicResponsiveListItemRenderer: {
			playlistItemData: { videoId: 'bbbbbbbbbbb' },
			flexColumns: [
				{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'A Song' }] } } },
				{
					musicResponsiveListItemFlexColumnRenderer: {
						text: { runs: [{ text: 'An Artist' }, { text: ' • ' }, { text: 'Album' }] }
					}
				}
			]
		}
	};
	const [only] = parseMusicSearch(doc, 12);
	expect(only!.title).toBe('A Song');
	expect(only!.durationSec).toBe(0);
});

test('parseDuration handles mm:ss and h:mm:ss, and refuses anything else', () => {
	expect(parseDuration('4:20')).toBe(260);
	expect(parseDuration('1:02:03')).toBe(3723);
	expect(parseDuration('0:07')).toBe(7);
	expect(parseDuration('Album Name')).toBeUndefined();
	expect(parseDuration('4')).toBeUndefined();
	expect(parseDuration('')).toBeUndefined();
});

test('parsePlays scales K/M/B and refuses non-play text', () => {
	expect(parsePlays('263 plays')).toBe(263);
	expect(parsePlays('827K plays')).toBe(827_000);
	expect(parsePlays('1.2M plays')).toBe(1_200_000);
	expect(parsePlays('3B plays')).toBe(3_000_000_000);
	expect(parsePlays('1 play')).toBe(1);
	// An album row's second column is not a play count; reading it as one would rank on noise.
	expect(parsePlays('Album • 2019')).toBeUndefined();
	expect(parsePlays('4:20')).toBeUndefined();
});
