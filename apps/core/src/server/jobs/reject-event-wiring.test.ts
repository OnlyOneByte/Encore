// guard: #471's reject/lease-expiry DISTINCTION is only real once worker-hub actually fires the
// distinguishing event. `requeue(id, attempts, now, cause)` defaults `cause` to 'LEASE_EXPIRED' so
// existing 3-arg callers keep compiling — which means the #onReject path silently reverts to
// LEASE_EXPIRED if its explicit 'REJECT' argument is dropped, and every behavioural test stays
// green because both events land on `queued`. There is no observable field that separates them at
// the worker-hub boundary (that is deferred to the ledger-hook step, which collides with #520), so
// this decidable property is pinned by source scan, the same way reaper-onfailed-wiring.test.ts
// pins app.ts's reaper seam. Comments are blanked so a commented-out call cannot satisfy the match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const HUB = stripComments(readFileSync(join(import.meta.dir, 'worker-hub.ts'), 'utf8'));

/** The brace-balanced body of `#<name>(...)`, skipping past the parameter list's own braces. */
function methodBody(src: string, name: string): string {
	// The DEFINITION, not a call site: `this.#onReject(msg)` also contains `#onReject(`, so require
	// the occurrence NOT preceded by a `.` (a method declaration follows whitespace, never a dot).
	const re = new RegExp('(?<![.\\w])#' + name + '\\(');
	const m = re.exec(src);
	expect(m).not.toBeNull();
	const sig = m!.index;
	// Walk the parameter list to its matching close-paren (parameter TYPES contain braces —
	// `Extract<WorkerMessage, { type: 'job:reject' }>` — so we cannot just take the next `{`).
	// sig points at '#'; the '(' opening the parameter list is at sig + name.length + 1. Start the
	// walk INSIDE the list with depth 1 and close on the matching ')'.
	const paramOpen = sig + name.length + 1;
	let paren = 1;
	let afterParams = -1;
	for (let i = paramOpen + 1; i < src.length; i++) {
		if (src[i] === '(') paren++;
		else if (src[i] === ')') {
			paren--;
			if (paren === 0) {
				afterParams = i + 1;
				break;
			}
		}
	}
	expect(afterParams).toBeGreaterThan(sig);
	const open = src.indexOf('{', afterParams);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0,
		end = -1;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end).toBeGreaterThan(open);
	return src.slice(open, end + 1);
}

test('#onReject requeues with the REJECT event, not the LEASE_EXPIRED default (#471)', () => {
	const body = methodBody(HUB, 'onReject');
	// The requeue in the reject handler MUST pass 'REJECT' as the causing event. Dropping it (back to
	// the LEASE_EXPIRED default) reds here — the collapse #471 fixes.
	expect(body).toMatch(/\.requeue\(msg\.jobId,\s*job\.attempts,\s*this\.#d\.now\(\),\s*'REJECT'\)/);
	// And it must NOT smuggle a LEASE_EXPIRED into the reject path.
	expect(body).not.toMatch(/'LEASE_EXPIRED'/);
});

test('#onReject really targets the requeue call (fixture sanity — the body was located)', () => {
	const body = methodBody(HUB, 'onReject');
	expect(body).toMatch(/\.requeue\(\s*msg\.jobId/);
});
