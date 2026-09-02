// Job status → the phone-facing media:status (§5: a worker's reported stage maps 1:1). Pure, and
// shared by the two places that need it: the worker hub broadcasting live lifecycle changes, and
// /api/library answering "what is cooking right now?" for a client that just loaded and has not
// received any broadcast yet.
import type { Job, JobStatus, MediaStatus } from '@encore/shared';

export function mediaStatusFor(job: Job, stage?: MediaStatus): MediaStatus {
	if (stage) return stage;
	const map: Record<JobStatus, MediaStatus> = {
		queued: 'queued',
		assigned: 'queued',
		running: 'separating', // generic "working"; refined by the worker's reported stage
		ready: 'ready',
		failed: 'failed',
		canceled: 'failed'
	};
	return map[job.status];
}
