/*
 * Diff two preflight-reset-audit runs.
 *
 *   bun run e2e/probes/preflight-diff.mjs <before.json> <after.json>
 *
 * WHAT THIS REFUSES TO DO. Elements are paired BY INDEX in document order, which is only sound while
 * the two runs rendered the same DOM. Some surfaces in this app are DATA-DEPENDENT — /stats and
 * /metrics grow rows as songs get played, and the home screen's roster reflects who is in the room —
 * so two runs against two rooms legitimately disagree on element COUNT. Pairing by index across that
 * disagreement would compare unrelated elements and invent differences.
 *
 * So a surface is compared only when its full TAG SEQUENCE is identical between runs, and one whose
 * sequence differs is reported as NOT-COMPARABLE with its counts, never quietly skipped and never
 * quietly compared. That distinction is the whole reason to write a differ rather than eyeball two
 * JSON blobs: the failure mode of this measurement is a false difference, not a missed one.
 *
 * Exit codes: 0 = no style or geometry difference on any comparable surface, 1 = differences found
 * (printed), 2 = the inputs could not be compared at all.
 */
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
	console.error('usage: preflight-diff.mjs <before.json> <after.json>');
	process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

/** Geometry differences below this many px are reported separately — see the note at the summary. */
const PX_EPSILON = 0.01;

/*
 * Tags that render nothing. Preflight's universal and `html`-level rules apply to these too, so an
 * unfiltered tally counts `tab-size` and `font-family` on every `<meta>` in `<head>` and reads as a
 * far larger change than the screen actually sustains. They are counted SEPARATELY rather than
 * dropped, because "the reset reached them and it did not matter" is a different statement from "the
 * reset did not reach them", and only the first is true.
 */
const INERT_TAGS = new Set(['html', 'head', 'meta', 'link', 'title', 'script', 'style', 'base']);

let comparable = 0;
let styleDiffs = 0;
let styleDiffsRendered = 0;
let rectDiffs = 0;
/** @type {string[]} */
const notComparable = [];
/** @type {Map<string, number>} */
const propTally = new Map();
/** @type {string[]} */
const samples = [];

for (const name of Object.keys(before.surfaces)) {
	const b = before.surfaces[name];
	const a = after.surfaces[name];
	if (!a) {
		notComparable.push(`${name}: absent from the after run`);
		continue;
	}
	if (b.error || a.error) {
		notComparable.push(`${name}: probe error (before=${b.error ?? '-'} after=${a.error ?? '-'})`);
		continue;
	}
	if (b.count !== a.count) {
		notComparable.push(`${name}: element count ${b.count} -> ${a.count} (data-dependent surface)`);
		continue;
	}
	const tagsB = b.els.map((/** @type {any} */ e) => e.tag).join(',');
	const tagsA = a.els.map((/** @type {any} */ e) => e.tag).join(',');
	if (tagsB !== tagsA) {
		notComparable.push(`${name}: same count (${b.count}) but the tag sequence differs`);
		continue;
	}

	comparable++;
	let sDiff = 0;
	let sDiffRendered = 0;
	let rDiff = 0;
	for (let i = 0; i < b.els.length; i++) {
		const eb = b.els[i];
		const ea = a.els[i];
		const rendered = !INERT_TAGS.has(eb.tag);
		for (const p of Object.keys(eb.s)) {
			if (eb.s[p] !== ea.s[p]) {
				sDiff++;
				if (rendered) {
					sDiffRendered++;
					propTally.set(p, (propTally.get(p) ?? 0) + 1);
					if (samples.length < 40) {
						samples.push(
							`${name} [${i}] <${eb.tag}${eb.cls ? ` class="${eb.cls}"` : ''}> ${p}: ${eb.s[p]} -> ${ea.s[p]}`
						);
					}
				}
			}
		}
		for (let k = 0; k < 4; k++) {
			if (Math.abs(eb.rect[k] - ea.rect[k]) > PX_EPSILON) {
				rDiff++;
				break;
			}
		}
	}
	styleDiffs += sDiff;
	styleDiffsRendered += sDiffRendered;
	rectDiffs += rDiff;
	console.log(
		`${sDiff === 0 && rDiff === 0 ? '  ✓' : '  ✗'} ${name} — ${b.count} elements, ${sDiffRendered} rendered-element computed-value differences (${sDiff} incl. <head>), ${rDiff} moved boxes`
	);
}

console.log(`\ncomparable surfaces: ${comparable}`);
if (notComparable.length) {
	console.log('NOT comparable (reported, not skipped):');
	for (const n of notComparable) console.log(`  - ${n}`);
}
console.log(`computed-value differences on RENDERED elements: ${styleDiffsRendered}`);
console.log(`computed-value differences including inert <head> nodes: ${styleDiffs}`);
console.log(`moved boxes (>${PX_EPSILON}px on any of x/y/w/h): ${rectDiffs}`);
if (propTally.size) {
	console.log('by property (rendered elements only):');
	for (const [p, n] of [...propTally.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${p}: ${n}`);
}
if (samples.length) {
	console.log(`\nfirst ${samples.length} differences (rendered elements):`);
	for (const s of samples) console.log(`  ${s}`);
}

process.exit(styleDiffs + rectDiffs === 0 ? 0 : 1);
