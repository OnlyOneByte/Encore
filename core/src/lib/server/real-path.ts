// Relative imports only: server.ts loads this outside SvelteKit.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** `p` with every symlink followed, or null for a dangling link. A path not written yet (a write target)
 *  resolves through its nearest existing ancestor. */
export function realPath(p: string): string | null {
	const tail: string[] = [];
	let head = p;
	for (;;) {
		try {
			lstatSync(head);
			break;
		} catch {
			const up = dirname(head);
			if (up === head) return p;
			tail.unshift(basename(head));
			head = up;
		}
	}
	try {
		return join(realpathSync(head), ...tail);
	} catch {
		return null;
	}
}
