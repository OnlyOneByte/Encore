// Relative imports only: server.ts loads this outside SvelteKit.
import { existsSync } from 'node:fs';

/** Docker writes /.dockerenv and Podman /run/.containerenv. Kubernetes and LXC are not detected. */
export const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
