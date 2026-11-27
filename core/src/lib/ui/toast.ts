// svelte-sonner's `toast`, except that every toast shown asks the phone layout to load its <Toaster>, so no phone
// tab ships the toaster until a toast needs it (#1309), and a load that failed is tried again on the next toast.
// Sonner holds a toast pushed before a Toaster mounts and shows it on mount. Import `toast` from here, never from
// 'svelte-sonner' (`toast-lazy.test.ts`).
import { toast as sonner } from 'svelte-sonner';

let needed = false;
let wake: (() => void) | undefined;

/** Runs `load` whenever a toast is wanted: now, if one already was. `load` returns early once it has the toaster. */
export function whenToastNeeded(load: () => void): void {
	wake = load;
	if (needed) load();
}

function need(): void {
	needed = true;
	wake?.();
}

// `dismiss` shows nothing, so it never pulls the toaster in.
export const toast: typeof sonner = new Proxy(sonner, {
	apply: (target, self, args) => (need(), Reflect.apply(target, self, args)),
	get: (target, key, receiver) => {
		const value = Reflect.get(target, key, receiver);
		if (typeof value !== 'function' || key === 'dismiss') return value;
		return (...args: unknown[]) => (need(), Reflect.apply(value, target, args));
	}
});
