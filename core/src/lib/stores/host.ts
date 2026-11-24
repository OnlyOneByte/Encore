// Whether this phone holds the host session, asked once per page load so a tab switch costs no request.
// /host forgets the answer when it unlocks or signs out.
let asked: Promise<boolean> | null = null;

export function isHostPhone(): Promise<boolean> {
	asked ??= fetch('/api/host')
		.then((r) => (r.ok ? (r.json() as Promise<{ host?: boolean }>) : null))
		.then((b) => b?.host === true)
		.catch(() => {
			asked = null;
			return false;
		});
	return asked;
}

export function forgetHost(): void {
	asked = null;
}
