// guard: the worker's two dependency inputs may not disagree.
//
// `requirements.txt` declares 16 DIRECT pins; `constraints.txt` pins the ~124-package transitive closure
// they resolved to. dev.sh installs with both (`-c constraints.txt`), while worker/Dockerfile installs
// from requirements.txt alone — so a direct pin bumped in one file and not the other means the dev box
// and the image get different versions of a named dependency, silently. That is the drift this closes.
//
// It does NOT check the transitive half: those versions are whatever a verified venv resolved, and
// constraints.txt documents how to regenerate them deliberately.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** PEP 503: a run of `-`, `_` or `.` is one separator, so `pyannote.audio` and `pyannote-audio` are the
 *  same project. A freeze writes the hyphenated form while requirements.txt writes the dotted one. */
const canon = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/** `name==version` per line, plus whether the line carries an environment marker. */
function pins(source: string): Map<string, { version: string; marked: boolean }> {
	const out = new Map<string, { version: string; marked: boolean }>();
	for (const raw of source.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^([A-Za-z0-9_.-]+)\s*==\s*([^\s;]+)/.exec(line);
		if (m) out.set(canon(m[1]!), { version: m[2]!, marked: line.includes(';') });
	}
	return out;
}

const direct = pins(read('worker/requirements.txt'));
const constrained = pins(read('worker/constraints.txt'));

test('every direct pin appears in the constraints at the same version', () => {
	// Non-vacuity: a parse that returned nothing would make the comparison below trivially clean, which is
	// exactly how a version-agreement check rots into an empty loop.
	expect(
		direct.size,
		'requirements.txt parsed to no pins — the format changed or the read broke'
	).toBeGreaterThanOrEqual(14);
	expect(constrained.size, 'constraints.txt parsed to no pins').toBeGreaterThanOrEqual(100);
	// The closure must be substantially larger than the direct set, or constraints.txt is not the closure.
	expect(constrained.size).toBeGreaterThan(direct.size * 4);

	const offenders: string[] = [];
	let checked = 0;
	for (const [name, { version, marked }] of direct) {
		// Installed --no-deps at its call sites, deliberately absent from the closure (see constraints.txt).
		if (name === 'karaoke-lyrics-processor') continue;
		const pinned = constrained.get(name);
		if (pinned === undefined) {
			// A pin carrying an environment marker may be absent on the platform the closure was frozen on —
			// `audio-separator` is excluded on darwin-arm64 because upstream requires torch>=2.13 there. An
			// UNMARKED pin has no such excuse.
			if (!marked) offenders.push(`${name}==${version} is pinned in requirements.txt but missing from constraints.txt`);
			continue;
		}
		checked += 1;
		if (pinned.version !== version) {
			offenders.push(`${name}: requirements.txt says ${version}, constraints.txt says ${pinned.version}`);
		}
	}
	// The comparison really compared something: if canonicalisation broke, every name would miss and the
	// loop above would report nothing for the marked ones and everything for the rest.
	expect(checked, 'no direct pin was matched against the closure — name canonicalisation broke').toBeGreaterThanOrEqual(
		12
	);
	expect(
		offenders,
		'the two worker dependency inputs disagree. dev.sh installs with `-c constraints.txt` and ' +
			'worker/Dockerfile installs from requirements.txt alone, so a version only one of them carries is a ' +
			'dev box and an image running different code. Regenerate constraints.txt from a venv you have run ' +
			'the suite against — the recipe is in its header.'
	).toEqual([]);
});

test('the --no-deps package is kept out of the closure', () => {
	// Its own dependency list is ~30 packages of .doc/.rtf readers the worker never calls, which is why it
	// is installed --no-deps. Letting it into constraints.txt would invite a resolver to pull all of them.
	expect(constrained.has('karaoke-lyrics-processor')).toBe(false);
	// …and it really is a direct pin, so the exemption above is not covering an absence.
	expect(read('worker/requirements.txt')).not.toContain('karaoke-lyrics-processor==');
	expect(read('dev.sh')).toContain('KLP_PIN="karaoke-lyrics-processor==');
});
