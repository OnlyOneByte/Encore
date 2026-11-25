/** Pause, restart and skip, sent by the root layout (which owns the dropped-command notice and the tap target) and
 *  drawn on the Queue tab's Now card, under the context key `'transport'`. Types only: a runtime helper here was its
 *  own chunk, and /queue's JS budget (CLAIM 13) could not carry it. */
export interface TransportControls {
	restart(): void;
	togglePlay(): void;
	skip(): void;
}
