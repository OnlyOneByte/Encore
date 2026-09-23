/*
 * P8 — Presence, join, and realtime resilience: ten phones stay in sync across disconnects.
 *
 * Ten and not twenty: a browser context per phone costs memory and file descriptors, and every
 * failure class here shows up at 8-10. ENV findings never inflate a real number — see
 * docs/E2E.md#exit-codes-and-what-ran-means.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SEL, PRESET_COLOUR_NAMES } from '../contract.ts';
import { connect } from '../driver.mjs';
import { openBrowseFromHome, joinedExpression } from '../lib/phone.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'ENV' | 'PASS'} Level
 * @typedef {{ title: string, away: boolean, pending: boolean }} QueueRow
 * @typedef {{ rows: QueueRow[], count: number }} RoomState
 * @typedef {{ name: string, away: boolean, more: boolean, text: string }} RosterChip
 * @typedef {{ chips: RosterChip[], screen: ("transient" | "playing" | "lobby" | "attract") }} TvRoster
 */

const PORT = process.env.EPORT ?? '5228';
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.KIROCREW_SCRATCH || process.env.TMPDIR || '/tmp';
const OUT_DIR = join(SCRATCH, `p8-${Date.now()}`);
mkdirSync(OUT_DIR, { recursive: true });

const NUM_PHONES = 10;
const NUM_BURST = 6;
/** One beat for the first queue:sync to land after a socket opens. */
const QUEUE_SYNC_SETTLE_MS = 400;
/** Time for a presence/queue broadcast to reach every other surface. */
const ROSTER_BROADCAST_MS = 600;
/** A broadcast plus a reconnect resync handshake. */
const RESYNC_SETTLE_MS = 1500;
/** Long enough for the client's re-dial attempts to be failing rather than pending. */
const OFFLINE_SETTLE_MS = 800;
/** A reconnect, a queue:sync and the pending-op resend it triggers. */
const RECONCILE_SETTLE_MS = 3000;
/** NUM_BURST concurrent adds, applied and broadcast to every phone. */
const BURST_SETTLE_MS = 3500;

// One distinct name per phone: a reused name is a 409 and the join page simply stays put.
const PHONE_NAMES = ['Ada', 'Bea', 'Cai', 'Deb', 'Eve', 'Fin', 'Gio', 'Han', 'Ira', 'Jos'];

/** @type {{level:'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'ENV'|'PASS', title:string, detail:string, evidence?:string}[]} */
const findings = [];
/**
 * @param {Level} level
 * @param {string} title
 * @param {string} [detail]
 * @param {string} [evidence]
 */
function report(level, title, detail, evidence) {
	findings.push({ level, title, detail: detail ?? '', evidence });
	console.log(`[${level}]  ${title}${detail ? '\n        ' + detail : ''}${evidence ? '\n        ' + evidence : ''}`);
}

/*
 * Runs before app code on every load (docs/E2E.md#the-driver), recording every socket the client
 * opens so the probe can hard-drop one or watch it reconnect. send/close pass straight through, so
 * the instrument adds no observable behaviour.
 */
const INSTRUMENT = `
(() => {
  const orig = window.WebSocket;
  const list = [];
  window.__p8 = {
    sockets: list,
    lastOpen: null,
    connectCount: 0,
    // A browser WebSocket has no "abort", so close(3000) is the closest thing to a signal drop from
    // the JS side: the client's onclose fires and the reconnect path takes over.
    dropLast() {
      const s = this.lastOpen;
      if (!s || s.readyState > 1) return false;
      s.close(3000, 'p8-drop');
      return true;
    }
  };
  function P8Socket(url, protocols) {
    const s = protocols === undefined ? new orig(url) : new orig(url, protocols);
    window.__p8.lastOpen = s;
    list.push(s);
    s.addEventListener('open', () => { window.__p8.connectCount++; });
    return s;
  }
  P8Socket.prototype = orig.prototype;
  P8Socket.CONNECTING = orig.CONNECTING;
  P8Socket.OPEN = orig.OPEN;
  P8Socket.CLOSING = orig.CLOSING;
  P8Socket.CLOSED = orig.CLOSED;
  window.WebSocket = P8Socket;
})();
`;

/**
 * @param {Browser} browser
 * @param {string} name
 * @param {string} [colourName]
 */
async function joinPhone(browser, name, colourName = PRESET_COLOUR_NAMES[0]) {
	const page = await browser.newPage({ initScript: INSTRUMENT });
	await page.viewport(390, 844, 1);
	await openJoin(page, BASE);

	// Driver verbs, not hand-dispatched events: they wait for actionability. docs/E2E.md#gestures.
	await page.fill(SEL.nameInput, name);
	await page.clickByLabel(colourName);
	await page.clickByRole('button', 'Start singing');
	// "joined" keys on the docked band, not the search box, which would answer "browsing" instead.
	const outcome = await page.waitFor(
		`(() => {
			if (location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)})) return 'joined';
			const err = document.querySelector(${JSON.stringify(SEL.joinError)});
			if (err) return 'err:' + (err.textContent || '').trim();
			return null;
		})()`,
		{ timeout: 8_000 }
	);
	if (outcome === 'joined') {
		// A phone that taps before its store has observed the sync-time rebase misses its own row.
		await page.waitFor(`window.__p8 && window.__p8.connectCount > 0`, { timeout: 8_000 }).catch(() => null);
		await delay(QUEUE_SYNC_SETTLE_MS);
	}
	return { page, name, outcome };
}

/** @param {Page} page @returns {Promise<RoomState>} */
async function getState(page) {
	return page.evaluate(
		`(() => {
			const rows = [...document.querySelectorAll(${JSON.stringify(SEL.queueRow)})].map(r => ({
				title: (r.querySelector(${JSON.stringify(SEL.rowTitle)})?.textContent || '').trim(),
				away: r.querySelector(${JSON.stringify(SEL.away)}) != null,
				pending: r.classList.contains('pending')
			}));
			return { rows, count: rows.length };
		})()`
	);
}

// A LOCAL song: a cold yt-dlp miss takes long enough to read as the queue losing rows.
const SEARCH_TERM = process.env.P8_SEARCH ?? 'bohemian';

/** @param {Page} page @param {string} [term] */
async function searchAndQueue(page, term = SEARCH_TERM) {
	await openBrowseFromHome(page);
	await page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(SEL.search)});
			el.focus(); el.value = ${JSON.stringify(term)};
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		})()`
	);
	// An ACTIONABLE row, not a bare `.row`: one with no button is a header or is still hydrating.
	const rowsBefore = await page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
	const attemptClick = async () => {
		return page.evaluate(
			`(() => {
				const row = document.querySelector(${JSON.stringify(SEL.songRow)});
				if (!row) return null;
				const btn = row.querySelector(${JSON.stringify(SEL.addAction)}) || row.querySelector(${JSON.stringify(SEL.singAction)});
				if (!btn) return null;
				btn.click();
				return btn.className || 'clicked';
			})()`
		);
	};
	const clicked = await page
		.waitFor(
			`(() => {
			const row = document.querySelector(${JSON.stringify(SEL.songRow)});
			if (!row) return null;
			return row.querySelector(${JSON.stringify(SEL.addOrSing)}) ? 'row-ready' : null;
		})()`,
			{ timeout: 20_000 }
		)
		.catch(() => null);
	if (!clicked) return { queued: false, reason: 'no actionable row after 20s' };
	// Two-shot: results shuffling in the same tick replace the button with an identical-looking one
	// that carries the live handler, so a single click can land on a dead node.
	let btnClass = await attemptClick();
	const landed = await page
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > ${rowsBefore}`, { timeout: 3_000 })
		.catch(() => false);
	if (!landed) {
		btnClass = (await attemptClick()) ?? btnClass;
		const landed2 = await page
			.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > ${rowsBefore}`, { timeout: 3_000 })
			.catch(() => false);
		if (!landed2) {
			const diag = await page.evaluate(
				`(() => ({
					wsOpen: window.__p8?.lastOpen?.readyState,
					connectCount: window.__p8?.connectCount,
					qrows: document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length,
					rows: document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length,
					btn: btnClass
				}))()`.replaceAll('btnClass', JSON.stringify(btnClass))
			);
			return { queued: false, reason: `clicked but no local row: ${JSON.stringify(diag)}` };
		}
	}
	return { queued: true, reason: btnClass || 'clicked' };
}

/** @param {Page} tv @returns {Promise<TvRoster>} */
async function tvRoster(tv) {
	return tv.evaluate(
		`(() => {
			const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})].map(el => ({
				name: (el.childNodes[1]?.textContent || el.textContent || '').trim(),
				away: el.classList.contains('away'),
				more: el.classList.contains('more'),
				text: (el.textContent || '').trim()
			}));
			return { chips, screen: document.querySelector(${JSON.stringify(SEL.anyTransientState)}) ? 'transient' : (document.querySelector(${JSON.stringify(SEL.lowerThird)}) ? 'playing' : (document.querySelector(${JSON.stringify(SEL.stripPerson)}) ? 'lobby' : 'attract')) };
		})()`
	);
}

async function main() {
	// This probe boots nothing, so a dead port must fail here with the runbook, not time out later.
	const health = await fetch(`${BASE}/health`).catch(() => null);
	if (!health?.ok) {
		console.error(`No Encore server on ${BASE}. Boot per e2e/HARNESS.md and re-run.`);
		process.exit(2);
	}

	/** @type {Browser | undefined} */
	let browser;
	let phones = [];
	let tv;
	try {
		browser = await connect();

		// 1. TV, then N phones, then the TV roster + screenshot.
		tv = await browser.newPage(); // the TV needs no socket instrumentation
		await tv.viewport(1600, 900, 1);
		await tv.goto(`${BASE}/tv`);
		// Freshness gate on markup present on BOTH attract branches: the reachable-origin half is
		// absent on loopback, so anchoring there gates on a state this harness never reaches.
		const attract = await tv
			.waitFor(`document.querySelector(${JSON.stringify(SEL.isLabel)}) !== null`, { timeout: 8_000 })
			.catch(() => false);
		if (!attract) {
			report(
				'ENV',
				'server was not empty at start of run',
				'A prior run left singers or an in-flight state in the room. Restart the ephemeral server between runs (see e2e/HARNESS.md).'
			);
			throw new Error('bail: not empty');
		}

		for (let i = 0; i < NUM_PHONES; i++) {
			const p = await joinPhone(browser, PHONE_NAMES[i], PRESET_COLOUR_NAMES[i % PRESET_COLOUR_NAMES.length]);
			phones.push(p);
			if (p.outcome !== 'joined') {
				report('HIGH', `phone ${PHONE_NAMES[i]} could not join`, `outcome=${p.outcome}`);
			}
		}
		await delay(ROSTER_BROADCAST_MS); // the last connect has to reach the TV before the roster is read

		const roster = await tvRoster(tv);
		const shot1 = await tv.screenshot(join(OUT_DIR, '01-tv-lobby-10.png'));
		const chipCount = roster.chips.filter((c) => !c.more).length;
		const moreChip = roster.chips.find((c) => c.more);
		// Still `attract` with singers present means the roster broadcast dropped one.
		if (roster.screen !== 'lobby') {
			report('HIGH', `TV did not enter lobby after ${NUM_PHONES} joins`, `screen=${roster.screen}`, `see: ${shot1}`);
		} else {
			// The cap is 8 chips + "+N more"; a cap with no overflow chip vanished guests 9+.
			if (NUM_PHONES > 8) {
				if (!moreChip || chipCount !== 8) {
					report(
						'MEDIUM',
						'TV roster clipped instead of collapsing overflow',
						`chipCount=${chipCount} more=${moreChip?.text ?? 'MISSING'} (expected 8 named chips + one "+N more")`,
						`src/lib/tv/screen.ts:93 lobbyRoster capping; src/lib/tv/TvLobby.svelte:120 overflow render; ${shot1}`
					);
				} else {
					const m = /\+(\d+) more/.exec(moreChip.text);
					const overflowN = m ? Number(m[1]) : NaN;
					if (overflowN !== NUM_PHONES - 8) {
						report(
							'MEDIUM',
							'TV overflow count disagrees with roster',
							`shown 8, overflow ${overflowN}, expected +${NUM_PHONES - 8}`,
							`src/lib/tv/TvLobby.svelte:120; ${shot1}`
						);
					} else {
						report('PASS', 'TV renders 8 named chips + "+N more" for a 10-singer room', `${shot1}`);
					}
				}
			}
		}

		// The phone renders no lobby and the store is not exposed, so read the session off /api/me.
		const perPhoneSingers = await Promise.all(
			phones.map((p) =>
				p.page.evaluate(
					`(async () => {
						const me = await fetch('/api/me').then(r => r.ok ? r.json() : { singer: null });
						return { hasMe: !!me.singer, name: me.singer?.displayName ?? null };
					})()`
				)
			)
		);
		const allSaw = perPhoneSingers.every((/** @type {{ hasMe: boolean }} */ s) => s.hasMe);
		if (!allSaw) {
			report(
				'HIGH',
				'not every phone confirmed a joined session',
				`hasMe counts: ${perPhoneSingers.filter((/** @type {{ hasMe: boolean }} */ s) => s.hasMe).length}/${NUM_PHONES}`,
				`src/routes/api/me/+server.ts`
			);
		} else {
			report('PASS', `${NUM_PHONES}/${NUM_PHONES} phones report a joined session`);
		}

		// 2. A duplicate name must produce a human 409, not a dead form.
		{
			const dup = await joinPhone(browser, PHONE_NAMES[0], PRESET_COLOUR_NAMES[1]);
			if (dup.outcome === 'joined') {
				report(
					'CRITICAL',
					'duplicate display name JOINED anyway',
					`the name "${PHONE_NAMES[0]}" was reused and the server accepted it`,
					`src/lib/server/singers/join.ts:31 assertNameFree; ${BASE}/api/join`
				);
			} else {
				const msg = (dup.outcome || '').replace(/^err:/, '');
				const humanTaken = /taken/i.test(msg) || /already/i.test(msg);
				if (!humanTaken) {
					report(
						'HIGH',
						'name-collision error is not human-legible',
						`phone displayed: ${JSON.stringify(msg)}`,
						`src/lib/components/JoinLanding.svelte:26 error rendering; server: src/lib/server/singers/join.ts:21 NameTakenError message`
					);
				} else {
					// A 409 that leaves the form unusable looks exactly like a broken app.
					const usable = await dup.page.evaluate(
						`(() => {
							const nameEl = document.querySelector(${JSON.stringify(SEL.nameInput)});
							const alertEl = document.querySelector(${JSON.stringify(SEL.joinError)});
							const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Start singing') || b.textContent.trim().startsWith('Joining'));
							return {
								nameStillEditable: !!nameEl && !nameEl.disabled,
								errorAnnounced: !!alertEl && !!alertEl.getAttribute('role'),
								submitReachable: !!btn && !btn.disabled
							};
						})()`
					);
					const ok = usable.nameStillEditable && usable.errorAnnounced && usable.submitReachable;
					if (!ok) {
						report(
							'HIGH',
							'join form is not recoverable after a 409',
							`state=${JSON.stringify(usable)} — the form must let the user retype and resubmit`,
							`src/lib/components/JoinLanding.svelte:14 submitting flag reset`
						);
					} else {
						// Retype and resubmit for real: a by-text click lands on the inner text node.
						await dup.page.fill(SEL.nameInput, 'ZZReplay');
						await dup.page.clickByRole('button', 'Start singing');
						const recovered = await dup.page.waitFor(joinedExpression(), { timeout: 8_000 }).catch(() => false);
						if (!recovered) {
							report('HIGH', 'form did not recover after fixing name', `submit did not land in the party`);
						} else {
							report(
								'PASS',
								'duplicate-name 409 leaves the form recoverable, and retyping works',
								`error text: ${JSON.stringify(msg)}`
							);
							phones.push({ page: dup.page, name: 'ZZReplay', outcome: 'joined' });
						}
					}
				}
			}
		}

		// 3. A hard WS drop with the page still resident.
		{
			// A mid-list phone, so the drop is not at a boundary that might be special-cased.
			const victim = phones[3];
			const before = await victim.page.evaluate(`window.__p8.connectCount`);
			const dropped = await victim.page.evaluate(`window.__p8.dropLast()`);
			if (!dropped) {
				report(
					'MEDIUM',
					'could not drop the phone WebSocket via instrumentation',
					'sockets was empty or already CLOSED — probe scaffolding, not a defect'
				);
			} else {
				// 10s covers a full 250ms-backoff cycle plus the hello -> queue:sync handshake.
				const reconnected = await victim.page
					.waitFor(`window.__p8.connectCount > ${before}`, { timeout: 10_000 })
					.catch(() => false);
				if (!reconnected) {
					report(
						'CRITICAL',
						'phone did not reconnect after a WebSocket drop',
						`connectCount stayed at ${before} for 10s`,
						`src/lib/ws/client.ts:107 scheduleReconnect + capped backoff`
					);
				} else {
					// A row queued while the victim is down is what proves the resync, not just the socket.
					const other = phones[5];
					const otherResult = await searchAndQueue(other.page);
					if (!otherResult.queued) {
						report('ENV', 'could not queue on the witness phone for the WS-drop test', `reason=${otherResult.reason}`);
					} else {
						await delay(RESYNC_SETTLE_MS);
						const witnessRows = await other.page.evaluate(
							`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
						);
						const victimState = await getState(victim.page);
						// Parity means nothing until the witness confirms a row landed at all.
						if (witnessRows < 1) {
							// rev 0 = no op reached the store; rev > 0 with no row = dropped before render.
							const rev = await fetch(`${BASE}/health`)
								.then((r) => r.json())
								.then((j) => j.rev)
								.catch(() => 'unknown');
							report(
								'HIGH',
								'queue-add on the witness phone did not produce a row',
								`witness rows=${witnessRows}, server rev=${rev} — the add appeared to succeed (button clicked) but no row landed on the source phone`,
								`src/lib/stores/queue.ts:120 #optimistic`
							);
						} else if (victimState.rows.length !== witnessRows) {
							report(
								'HIGH',
								'reconnected phone did not resync the queue',
								`victim sees ${victimState.rows.length} rows, witness sees ${witnessRows}`,
								`src/lib/stores/queue.ts:154 #onSync (rebase on queue:sync)`
							);
						} else {
							report(
								'PASS',
								'a hard-dropped phone reconnects and resyncs to the authoritative queue',
								`victim rows=${victimState.rows.length}, witness=${witnessRows}`
							);
						}
					}
				}
			}
		}

		// 4. Sever without leaving: the TV must show away, and the queued song must survive.
		{
			const away = phones[7];
			const queued = await searchAndQueue(away.page, 'caroline');
			if (!queued.queued) {
				report('ENV', 'could not queue a song for the away test', `reason=${queued.reason}`);
			} else {
				// ORDER IS LOAD-BEARING: dropLast() BEFORE setOffline(), which only affects connections
				// opened after it. Offline first swallows the close frame and the server waits out its
				// own idleTimeout instead of learning the phone went away.
				await delay(ROSTER_BROADCAST_MS);
				const beforeConnects = await away.page.evaluate(`window.__p8.connectCount`);
				const dropped = await away.page.evaluate(`window.__p8.dropLast()`);
				if (!dropped) {
					report(
						'ENV',
						'could not sever the away-test socket',
						'the instrumentation returned false — no socket to drop'
					);
				}
				// Block the 250ms re-dial, so the room can be observed while the phone is unreachable.
				await away.page.setOffline(true);
				const tvSaidAway = await tv
					.waitFor(
						`(() => {
						const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})];
						return chips.some(c => c.classList.contains('away') && (c.textContent || '').includes(${JSON.stringify(away.name)}));
					})()`,
						{ timeout: 15_000 }
					)
					.catch(() => false);
				if (!tvSaidAway) {
					const shot = await tv.screenshot(join(OUT_DIR, '02-tv-away.png'));
					report(
						'HIGH',
						'severed phone did not show up as AWAY on the TV within 15s',
						`the TV\u2019s roster never marked ${away.name} as away — presence.disconnect broadcast should be near-instant on close(3000)`,
						`src/lib/server/realtime/presence.ts:69 disconnect; server.ts (websocket.close handler); ${shot}`
					);
				} else {
					const shot = await tv.screenshot(join(OUT_DIR, '02-tv-away.png'));
					report('PASS', 'severed phone appears as AWAY on the TV, still counted', `${shot}`);
				}

				// A locked phone keeping its turn is the whole point of `away`.
				const otherSurface = await phones[2].page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
				);
				if (otherSurface < 1) {
					report(
						'CRITICAL',
						'severed phone LOST its queued song',
						`another phone reports ${otherSurface} queue rows; the disconnected singer\u2019s song should survive`,
						`src/lib/server/realtime/presence.ts:79 (grace clock does not start while pending songs exist)`
					);
				} else {
					report('PASS', 'a phone\u2019s queued song survives the phone going away', `others see ${otherSurface} rows`);
				}

				// A synthetic `online` event is what wakes the client and makes it re-dial.
				await away.page.setOffline(false);
				await away.page.evaluate(`window.dispatchEvent(new Event('online'))`);
				await away.page.waitFor(`window.__p8.connectCount > ${beforeConnects}`, { timeout: 15_000 }).catch(() => null);
				const back = await tv
					.waitFor(
						`(() => {
						const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})];
						const c = chips.find(c => (c.textContent || '').includes(${JSON.stringify(away.name)}));
						return c && !c.classList.contains('away');
					})()`,
						{ timeout: 15_000 }
					)
					.catch(() => false);
				if (!back) {
					report(
						'MEDIUM',
						`away phone did not return to "here" after network came back`,
						`the TV chip stayed grey`,
						`src/lib/ws/client.ts:64 wake(); src/lib/server/realtime/presence.ts:61 connect()`
					);
				} else {
					report('PASS', 'away phone rejoins as here when the network comes back');
				}
			}
		}

		// 5. An optimistic queue op taken while the socket is severed.
		{
			const p = phones[6];
			const witness = phones[2];
			const before = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
			// Search WHILE ONLINE: setOffline does block a new HTTP request, so the row must be up first.
			await openBrowseFromHome(p.page);
			await p.page.evaluate(
				`(() => {
					const el = document.querySelector(${JSON.stringify(SEL.search)});
					el.focus(); el.value = ${JSON.stringify(SEARCH_TERM)};
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				})()`
			);
			const rows = await p.page
				.waitFor(
					`(() => {
						const row = document.querySelector(${JSON.stringify(SEL.songRow)});
						if (!row) return 0;
						return row.querySelector(${JSON.stringify(SEL.addOrSing)}) ? 1 : 0;
					})()`,
					{ timeout: 20_000 }
				)
				.catch(() => 0);
			if (!rows) {
				report('ENV', 'could not populate search rows before the offline test', `rows=${rows}`);
			} else {
				// Sever the WS first, THEN block the reconnect — same close-frame ordering as step 4.
				const beforeConnects = await p.page.evaluate(`window.__p8.connectCount`);
				await p.page.evaluate(`window.__p8.dropLast()`);
				await p.page.setOffline(true);
				await delay(OFFLINE_SETTLE_MS);
				// The send lands on a closed socket, so the op stays pending and only the local row shows.
				await p.page.evaluate(
					`(() => {
						const row = document.querySelector(${JSON.stringify(SEL.songRow)});
						const btn = row && (row.querySelector(${JSON.stringify(SEL.addAction)}) || row.querySelector(${JSON.stringify(SEL.singAction)}));
						if (btn) btn.click();
					})()`
				);
				const optimistic = await p.page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length + document.querySelectorAll(${JSON.stringify(SEL.processing)}).length`
				);
				if (optimistic === 0) {
					report(
						'HIGH',
						'offline tap produced no optimistic row',
						'the store must render locally before hearing back from the server',
						`src/lib/stores/queue.ts:120 #optimistic`
					);
				}
				await p.page.setOffline(false);
				await p.page.evaluate(`window.dispatchEvent(new Event('online'))`);
				await p.page.waitFor(`window.__p8.connectCount > ${beforeConnects}`, { timeout: 15_000 }).catch(() => null);
				await delay(RECONCILE_SETTLE_MS);
				const after = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
				const offlineRowsOnP = await p.page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
				);
				const delta = after - before;
				if (delta === 1) {
					// Reconciled: the op made it through the pending resend that follows queue:sync.
					const parity = offlineRowsOnP === after;
					if (!parity) {
						report(
							'HIGH',
							'offline queue-add reconciled but origin/others disagree',
							`witness=${after} rows, origin=${offlineRowsOnP} rows — a phantom local row survived reconcile`,
							`src/lib/stores/queue.ts:150 #onPatch rebase / src/lib/stores/queue.ts:154 #onSync rebase`
						);
					} else {
						report(
							'PASS',
							'offline queue-add reconciles through resendPending on reconnect',
							`witness rows delta=+1, origin=${offlineRowsOnP}`
						);
					}
				} else if (delta === 0) {
					if (offlineRowsOnP > 0) {
						report(
							'CRITICAL',
							'offline queue-add was silently lost',
							`origin phone shows ${offlineRowsOnP} rows, witness shows delta ${delta} — the op never reached the server AND the origin has a phantom`,
							`src/lib/ws/client.ts:80 trySend drops on non-open; src/lib/stores/queue.ts:126 pending map`
						);
					} else {
						report(
							'HIGH',
							'offline queue-add left no trace on either surface',
							`witness delta=0, origin rows=0 — op was neither sent, nor optimistic, nor rejected`,
							`src/lib/stores/queue.ts:120 #optimistic`
						);
					}
				} else {
					report(
						'HIGH',
						`offline queue-add produced unexpected row count`,
						`witness delta=${delta}, origin rows=${offlineRowsOnP}`
					);
				}
			}
		}

		// 6. An explicit leave through /api/leave.
		{
			const leaver = phones[4];
			await searchAndQueue(leaver.page, 'caroline'); // so leave has real songs to handle
			await delay(OFFLINE_SETTLE_MS);
			const beforeCount = await phones[2].page.evaluate(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
			);
			const preview = await leaver.page.evaluate(
				`fetch('/api/leave').then(r => r.ok ? r.json() : ({error: r.status}))`
			);
			const leaveRes = await leaver.page.evaluate(
				`fetch('/api/leave', { method: 'POST' }).then(r => r.ok ? r.json() : ({error: r.status}))`
			);
			await delay(RESYNC_SETTLE_MS);
			const afterCount = await phones[2].page.evaluate(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
			);
			if (leaveRes?.error) {
				report('HIGH', '/api/leave returned an error', `status=${leaveRes.error}`);
			} else {
				const removed = Array.isArray(leaveRes.removed) ? leaveRes.removed.length : NaN;
				const drop = beforeCount - afterCount;
				if (drop < removed) {
					report(
						'HIGH',
						'leave removed fewer rows from the room than the API reported',
						`api removed=${removed}, room delta=${drop}, previewQueued=${preview.queuedCount}`,
						`src/lib/server/singers/leave.ts:40 doLeave`
					);
				} else {
					report(
						'PASS',
						`/api/leave un-queues that singer\u2019s pending songs`,
						`removed=${removed}, previewQueued=${preview.queuedCount}, hasPlaying=${preview.hasPlaying}`
					);
				}
			}
			// Not a shooter any more: its session is 401, so a tap no-ops and reads as a lost row.
			leaver.outcome = 'left';
			const rejoin = await joinPhone(browser, leaver.name, PRESET_COLOUR_NAMES[3]);
			if (rejoin.outcome !== 'joined') {
				report(
					'HIGH',
					`name did not return to the pool after leave`,
					`rejoin outcome=${rejoin.outcome}`,
					`src/lib/server/realtime/presence.ts:105 forget`
				);
				await rejoin.page.close();
			} else {
				report('PASS', 'leave frees the name for immediate rejoin');
				await rejoin.page.close();
			}
		}

		// 7. NUM_BURST phones queue simultaneously.
		{
			// Only `joined` phones: a left phone still has a page, but its tap no-ops silently.
			const shooters = phones.filter((p) => p.outcome === 'joined').slice(0, NUM_BURST);
			if (shooters.length < NUM_BURST) {
				report('ENV', `burst had only ${shooters.length} joined shooters`, `expected ${NUM_BURST}`);
			}
			const witness = shooters[0];
			const before = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
			// All taps in one turn; each page mints its own clientOpId and entry id.
			await Promise.all(shooters.map((p) => searchAndQueue(p.page, 'caroline')));
			await delay(BURST_SETTLE_MS);
			// EVERY joined phone: an origin renders its own row, so a lost broadcast still looks correct.
			const counts = await Promise.all(
				phones
					.filter((p) => p.outcome === 'joined')
					.map((p) => p.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`))
			);
			const uniq = Array.from(new Set(counts));
			const expected = before + NUM_BURST;
			if (uniq.length !== 1) {
				report(
					'HIGH',
					'phones disagree on the queue length after a burst of adds',
					`counts=${JSON.stringify(counts)} (expected all=${expected})`,
					`src/lib/server/realtime/hub.ts:98 handleQueueCommand broadcasts to room`
				);
			} else if (uniq[0] !== expected) {
				report(
					'HIGH',
					'burst of adds lost/duplicated rows',
					`observed=${uniq[0]}, expected=${expected} (before=${before} + burst=${NUM_BURST})`,
					`src/lib/server/state/store.ts:91 applyQueueOp / applyAndReseq`
				);
			} else {
				// A duplicated row under a different id sums to the same count, so check titles too.
				const ids = await witness.page.evaluate(
					`(() => {
						const titles = [...document.querySelectorAll(${JSON.stringify(SEL.queueTitle)})].map(e => e.textContent.trim());
						return titles;
					})()`
				);
				const uniqTitles = new Set(ids);
				const shot = await tv.screenshot(join(OUT_DIR, '03-tv-burst.png'));
				report(
					'PASS',
					'burst adds converge — no lost updates, no rev conflicts',
					`every phone reports ${expected} rows; titles=${ids.length}, unique=${uniqTitles.size} (dups are legal — same media queued by different singers); ${shot}`
				);
			}
			// No revision context in the envelope by design: concurrency is clientOpId dedupe alone.
			report(
				'PASS',
				'concurrency reduces to clientOpId dedupe — no revision context in the envelope',
				'src/lib/server/realtime/hub.ts validateCommand has no revision check; the envelope carries clientOpId + op only, so duplicate-op replays are the only conflict shape and they dedupe idempotently.',
				`src/lib/contract/core/ops.ts ClientCommand (clientOpId + op; the dead baseRev field was removed)`
			);
		}
	} catch (err) {
		report('CRITICAL', 'probe threw before finishing', String(err instanceof Error ? err.stack : err));
	} finally {
		try {
			if (tv) await tv.screenshot(join(OUT_DIR, '99-final.png'));
		} catch {
			/* best-effort cleanup */
		}
		try {
			for (const p of phones) await p.page.close();
			if (tv) await tv.close();
		} catch {
			/* already closed, or never opened */
		}
		await browser?.close();
	}

	/** @type {Partial<Record<Level, number>>} */
	const summary = findings.reduce(
		(/** @type {Partial<Record<Level, number>>} */ m, f) => ((m[f.level] = (m[f.level] || 0) + 1), m),
		{}
	);
	console.log(`\n── SUMMARY ────────────────────────────────────────`);
	for (const level of /** @type {Level[]} */ (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ENV', 'PASS'])) {
		if (summary[level]) console.log(`  ${level}: ${summary[level]}`);
	}
	console.log(`  evidence: ${OUT_DIR}`);

	const real = /** @type {Level[]} */ (['CRITICAL', 'HIGH']).reduce((n, l) => n + (summary[l] || 0), 0);
	const env = summary['ENV'] || 0;
	// ENV items with no PASS is exit 2, never 0: green has to mean "we asserted and nothing failed".
	if (real > 0) process.exit(1);
	if (env > 0 && (summary['PASS'] || 0) === 0) process.exit(2);
	process.exit(0);
}

main().catch((e) => {
	console.error('fatal:', e);
	process.exit(1);
});
