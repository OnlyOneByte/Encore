import type { WorkerRegistry } from './registry';

/** Deregister a worker on its socket's close, but only if that socket is still the worker's CURRENT one. */
export function releaseWorkerSocket<S>(
	sockets: Map<string, S>,
	registry: Pick<WorkerRegistry, 'remove'>,
	workerId: string,
	ws: S
): void {
	if (sockets.get(workerId) !== ws) return;
	registry.remove(workerId);
	sockets.delete(workerId);
}
