// guard: `capabilities.ts` is the ONE place that answers "is this actor allowed to do that?". Caught:
// `queue:remove-any` and `queue:reorder-any` had NO asker — remove/move were gated by membership alone and
// never consulted `can()` — so narrowing `can()` would silently leave exactly those two ops open to every
// joined singer. The defect is a MISSING CALL SITE, and it stays decidable only from source: `can()` ignores
// its capability today, so an ungated op behaves identically to a gated one and no behavioural test can tell
// them apart.
//
// WHAT THIS ASSERTS, AND WHY IT IS NOT A PER-ARM GREP ANY MORE. It used to require the literal
// `if (!can({ singerId: deps.actorSingerId }, 'queue:remove-any')) return '` inside `case 'remove':`, once per
// arm. That pinned the SHAPE of the implementation rather than the invariant, with two costs: it blocked
// collapsing three near-identical arms into one gate, and — the real problem — it could only police the three
// arms it names, so a FOURTH entry op added with a copy-pasted capability was both legal and invisible.
//
// The invariant instead: every client op that names an existing entry has a gate, the gate set is derived
// from `QueueOp` rather than listed here, there is exactly one gate site, and its denial returns a refusal
// string rather than `null` (validateCommand's "valid"). See docs/GUARDS.md#wiring
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const hub = stripComments(read('src/lib/server/realtime/hub.ts'), { drop: true });
const ops = stripComments(read('src/lib/contract/core/ops.ts'), { drop: true });
const caps = stripComments(read('src/lib/server/capabilities.ts'), { drop: true });

/**
 * Every `QueueOp` member carrying an `id`, minus the server-owned `status`. DERIVED, so a new
 * `{ op: 'x'; id: string }` member joins this set without anybody editing this file — which is the whole
 * point: the old guard could not have noticed one.
 */
function entryOpsFromContract(): string[] {
	const union = /export type QueueOp =([\s\S]*?);\n/.exec(ops);
	expect(union, 'QueueOp union not found in ops.ts — this guard derives its scope from it').not.toBeNull();
	const members = [...union![1]!.matchAll(/\{\s*op:\s*'([a-z-]+)'([^}]*)\}/g)];
	expect(members.length, 'no QueueOp members parsed — the union shape changed').toBeGreaterThanOrEqual(4);
	return members
		.filter(([, , rest]) => /\bid:\s*string/.test(rest!))
		.map(([, op]) => op!)
		.filter((op) => op !== 'status');
}

/** The `ENTRY_OP_GATE` table's `op -> capability` mapping, read out of hub.ts. */
function gateTable(): Map<string, string> {
	const block = /const ENTRY_OP_GATE = \{([\s\S]*?)\} as const satisfies/.exec(hub);
	expect(block, 'ENTRY_OP_GATE table not found — the one place every entry op gets its capability').not.toBeNull();
	const out = new Map<string, string>();
	for (const m of block![1]!.matchAll(/'?([a-z-]+)'?:\s*\{\s*capability:\s*'([a-z:-]+)'/g)) out.set(m[1]!, m[2]!);
	return out;
}

test('every client op that names an existing entry has a capability gate', () => {
	const expected = entryOpsFromContract();
	const table = gateTable();
	// Non-vacuity both ways: a broken union parse would compare an empty set against an empty set.
	expect(expected.length, 'no entry-naming ops derived from QueueOp').toBeGreaterThanOrEqual(3);
	expect(table.size, 'ENTRY_OP_GATE parsed to no entries').toBeGreaterThanOrEqual(3);
	expect([...table.keys()].sort()).toEqual([...expected].sort());
});

test('the table is exhaustive BY TYPE, so a new entry op cannot compile without a gate', () => {
	// The `satisfies` is what makes a missing gate a compile error rather than something a guard has to
	// notice. Without it this file is the only thing standing between a new op and an ungated mutation.
	expect(hub).toMatch(/\}\s*as const satisfies Record<EntryMutatingOp,\s*\{\s*capability:\s*Capability/);
	expect(hub).toMatch(/type EntryMutatingOp = Exclude<Extract<QueueOp, \{ id: string \}>\['op'\], 'status'>/);
});

test('each gate names a capability the capabilities module actually declares', () => {
	const declared = new Set([...caps.matchAll(/\|?\s*'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]!));
	expect(declared.size, 'no Capability members parsed from capabilities.ts').toBeGreaterThanOrEqual(5);
	for (const [op, capability] of gateTable()) {
		expect(declared.has(capability), `${op} gates on '${capability}', which is not a Capability member`).toBe(true);
	}
});

test('remove asks to remove, reorder asks to reorder — the two are not swapped', () => {
	// The original defect this guard was written for included the two capability strings being swappable
	// between arms without any assertion noticing.
	const table = gateTable();
	expect(table.get('remove')).toBe('queue:remove-any');
	expect(table.get('move')).toBe('queue:reorder-any');
	expect(table.get('move-to-index')).toBe('queue:reorder-any');
});

test('there is exactly ONE can() gate for entry ops, and denial returns a refusal, not null', () => {
	const gates = [
		...hub.matchAll(
			/if\s*\(\s*!can\(\s*\{\s*singerId:\s*deps\.actorSingerId\s*\}\s*,\s*([^)]+)\)\s*\)\s*return\s+([^;]+);/g
		)
	];
	expect(gates.length, 'expected exactly one entry-op capability gate in hub.ts').toBe(1);
	const [, capabilityArg, returned] = gates[0]!;
	// Driven by the table, not a literal — a hardcoded capability here would gate every op the same way.
	expect(capabilityArg!.trim()).toMatch(/gate\.capability|ENTRY_OP_GATE\[/);
	// `return null` is validateCommand's "this command is valid", so a gate that returns it APPROVES on denial.
	expect(returned!.trim()).not.toBe('null');
	expect(returned!.trim()).toMatch(/gate\.refusal|'[^']+'/);
});

test('every entry op routes to that one gate rather than re-implementing it', () => {
	const body = /export function validateCommand[\s\S]*?\n\}/.exec(hub);
	expect(body, 'validateCommand not found').not.toBeNull();
	for (const op of entryOpsFromContract()) {
		expect(body![0]).toMatch(new RegExp(`case '${op}':`));
	}
	// Delegation, asserted without pinning the arms' shape: whether the three ops fall through to one
	// `return` or each call it separately is not a property worth defending — that `validateCommand` does no
	// gating of its OWN is. A `can(` back inside it means an arm grew a private gate, which is how three
	// copies of the ownership check appeared in the first place.
	expect(body![0]).toMatch(/entryOpRefusal\(/);
	expect((body![0].match(/\bcan\(/g) ?? []).length, 'validateCommand gates inline instead of delegating').toBe(0);
});

test('hub imports can from the capabilities module (the ONE decision point)', () => {
	// Widened to admit the `type Capability` the gate table needs: pinning the exact import text made adding
	// a type-only import a guard failure, which is not a property anybody wants defended.
	expect(hub).toMatch(/import\s*\{[^}]*\bcan\b[^}]*\}\s*from\s*'\.\.\/capabilities'/);
});
