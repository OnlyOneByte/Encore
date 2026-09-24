// `requeue(id, attempts, now, cause)` DEFAULTS `cause` to 'LEASE_EXPIRED' so existing 3-arg callers keep
// compiling, which means dropping `#onReject`'s explicit 'REJECT' silently collapses the distinction while
// every behavioural test stays green — both events land on `queued`, and nothing observable separates them
// at the worker-hub boundary.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const HUB = stripComments(read('src/lib/server/jobs/worker-hub.ts'));

/** The brace-balanced body of `#<name>(...)`, skipping past the parameter list's own braces. */
function methodBody(src: string, name: string): string {
	// The DEFINITION, not a call site: `this.#onReject(msg)` also contains `#onReject(`, so the match must
	// NOT be preceded by a dot — a declaration follows whitespace.
	const re = new RegExp('(?<![.\\w])#' + name + '\\(');
	const m = re.exec(src);
	expect(m).not.toBeNull();
	const sig = m!.index;
	// The parameter list is walked to its matching close-paren because parameter TYPES contain braces
	// (`Extract<WorkerMessage, { type: 'job:reject' }>`), so the next `{` is not the body's.
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

test('#onReject requeues with the REJECT event, not the LEASE_EXPIRED default', () => {
	const body = methodBody(HUB, 'onReject');
	expect(body).toMatch(/\.requeue\(msg\.jobId,\s*job\.attempts,\s*this\.#d\.now\(\),\s*'REJECT'\)/);
	// …and must not smuggle a LEASE_EXPIRED into the reject path.
	expect(body).not.toMatch(/'LEASE_EXPIRED'/);
});

test('#onReject really targets the requeue call (fixture sanity — the body was located)', () => {
	const body = methodBody(HUB, 'onReject');
	expect(body).toMatch(/\.requeue\(\s*msg\.jobId/);
});
