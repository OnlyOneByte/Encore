import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the now-line heart's saved set is ONE singer's. After a Leave the next singer on the phone must not see the
 * last one's saves filled while their own load is in the air. Source scans, because the component-mount harness is
 * gone (bunfig.toml records why); the probe now-line-heart covers the fill itself.
 */

const layout = readFileSync(at('src/routes/+layout.svelte'), 'utf8');

test('a change of singer empties the saved set before the new one loads', () => {
	expect(layout).toMatch(
		/const singer = isPhoneSurface \? me : null;\s*untrack\(\(\) => \{\s*savedIds\.clear\(\);\s*if \(singer\) void loadSaved\(singer\);/
	);
});

test("an answer that lands after the singer changed is dropped, and so is a refused tap's undo", () => {
	expect(layout).toMatch(
		/async function loadSaved\(singer: string\)[\s\S]{0,300}if \(me !== singer\) return;\s*savedIds\.clear\(\);/
	);
	expect(layout).toContain('if (!res?.ok && me === who) {');
});
