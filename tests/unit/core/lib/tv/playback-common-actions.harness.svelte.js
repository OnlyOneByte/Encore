// Reactive props for the matrix. A `.svelte.js` rune module because runes ($state) are illegal
// in a plain `.test.ts`; the matrix mutates the returned object and the mounted TvPlayer's effects
// re-run on the change, which is the whole point of the decision-B test (drive the real effects, not
// a source scan). Compiled by the test-setup Svelte loader.
//
// Plain JS (JSDoc, no TS annotations) on purpose: the repo's svelte-eslint-parser is not wired with
// a TS sub-parser for rune modules, so a `.svelte.ts` here trips "Unexpected token" on any type
// syntax. The caller asserts the concrete prop type on the return, so no types are lost.

/**
 * Wrap an object in a `$state` proxy so mutations to it drive a mounted component's effects.
 * @param {object} initial
 * @returns {object}
 */
export function makeReactive(initial) {
	const s = $state(initial);
	return s;
}
