// Fake align worker: connects, advertises `align`, prints the first job:assign params, exits. Proves the
// model and sync mode chosen on the settings page reach the wire. Params are computed at ASSIGN time, so
// this also shows a settings change taking effect on work that was already queued.
//
//   EPORT=5199 bun tests/e2e/fake-align-worker.mjs
const port = process.env.EPORT ?? '3000';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=worker`);
const timer = setTimeout(() => {
	console.log('NO ASSIGN within 15s');
	process.exit(1);
}, 15000);

ws.onopen = () => {
	ws.send(
		JSON.stringify({
			type: 'worker:hello',
			workerId: 'fake-align-1',
			capabilities: ['align'],
			concurrency: 1,
			version: 'test'
		})
	);
};

ws.onmessage = (/** @type {MessageEvent} */ ev) => {
	const msg = JSON.parse(String(ev.data));
	if (msg.type === 'job:assign') {
		clearTimeout(timer);
		console.log('job:assign  jobType =', msg.jobType);
		console.log('  params    =', JSON.stringify(msg.params));
		console.log('  asrModel  =', msg.params?.asrModel);
		console.log('  syncMode  =', msg.params?.syncMode);
		process.exit(0);
	}
};
ws.onerror = (/** @type {Event} */ e) => {
	console.log('ws error', e instanceof ErrorEvent ? e.message : e.type);
	process.exit(1);
};
