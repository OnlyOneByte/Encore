// The range parser's contract. These are the shapes real media elements actually send — including the
// two-byte WebKit probe whose mishandling was the whole bug.
import { test, expect } from 'bun:test';
import { parseRangeHeader, contentRange, unsatisfiedContentRange, type RangeDecision } from '$server/media/http-range';

const SIZE = 26_218_241; // a real cooked instrumental FLAC, for realism

function partial(d: RangeDecision): { start: number; end: number } {
	if (d.kind !== 'partial') throw new Error(`expected partial, got ${d.kind}`);
	return { start: d.start, end: d.end };
}

test('no range asked for: a null header is a full response', () => {
	expect(parseRangeHeader(null, SIZE)).toEqual({ kind: 'full', size: SIZE });
});

test('no range asked for: an empty header is a full response', () => {
	expect(parseRangeHeader('', SIZE).kind).toBe('full');
});

test('the WebKit probe: bytes=0-1 yields exactly two bytes — the request this route used to answer with the whole file', () => {
	expect(partial(parseRangeHeader('bytes=0-1', SIZE))).toEqual({ start: 0, end: 1 });
});

test('the WebKit probe: and its Content-Range names the real total, not the slice length — the request this route used to answer with the whole file', () => {
	expect(contentRange(0, 1, SIZE)).toBe(`bytes 0-1/${SIZE}`);
});

test('the forms a player uses to stream and to seek: open-ended bytes=0- runs to EOF', () => {
	expect(partial(parseRangeHeader('bytes=0-', SIZE))).toEqual({ start: 0, end: SIZE - 1 });
});

test('the forms a player uses to stream and to seek: an open-ended seek starts where asked and runs to EOF', () => {
	expect(partial(parseRangeHeader('bytes=1048576-', SIZE))).toEqual({
		start: 1_048_576,
		end: SIZE - 1
	});
});

test('the forms a player uses to stream and to seek: a closed range is honoured exactly', () => {
	expect(partial(parseRangeHeader('bytes=100-199', SIZE))).toEqual({ start: 100, end: 199 });
});

test('the forms a player uses to stream and to seek: the suffix form returns the LAST n bytes', () => {
	expect(partial(parseRangeHeader('bytes=-500', SIZE))).toEqual({
		start: SIZE - 500,
		end: SIZE - 1
	});
});

test('the forms a player uses to stream and to seek: a suffix longer than the file clamps to the whole file rather than going negative', () => {
	expect(partial(parseRangeHeader('bytes=-999', 100))).toEqual({ start: 0, end: 99 });
});

test('the forms a player uses to stream and to seek: an end past EOF clamps — every element does this on the last chunk', () => {
	expect(partial(parseRangeHeader('bytes=90-500', 100))).toEqual({ start: 90, end: 99 });
});

test('the forms a player uses to stream and to seek: the header is matched case-insensitively and tolerates surrounding space', () => {
	expect(partial(parseRangeHeader('  BYTES=0-1  ', SIZE))).toEqual({ start: 0, end: 1 });
});

test('ranges that must be refused with 416, not answered with an empty 206: a start at EOF is unsatisfiable', () => {
	expect(parseRangeHeader('bytes=100-200', 100).kind).toBe('unsatisfiable');
});

test('ranges that must be refused with 416, not answered with an empty 206: a start past EOF is unsatisfiable', () => {
	expect(parseRangeHeader('bytes=5000-', 100).kind).toBe('unsatisfiable');
});

test('ranges that must be refused with 416, not answered with an empty 206: end before start is unsatisfiable', () => {
	expect(parseRangeHeader('bytes=200-100', SIZE).kind).toBe('unsatisfiable');
});

test('ranges that must be refused with 416, not answered with an empty 206: bytes=-0 asks for the last zero bytes and is unsatisfiable', () => {
	expect(parseRangeHeader('bytes=-0', SIZE).kind).toBe('unsatisfiable');
});

test('ranges that must be refused with 416, not answered with an empty 206: an empty file can satisfy no range', () => {
	expect(parseRangeHeader('bytes=0-', 0).kind).toBe('unsatisfiable');
});

test('ranges that must be refused with 416, not answered with an empty 206: a 416 reports the real size so one retry can succeed', () => {
	expect(unsatisfiedContentRange(SIZE)).toBe(`bytes */${SIZE}`);
});

test('anything we do not understand degrades to a full 200, never to an error: a non-bytes unit is ignored', () => {
	expect(parseRangeHeader('items=0-1', SIZE).kind).toBe('full');
});

test('anything we do not understand degrades to a full 200, never to an error: a multi-range request is served whole rather than as multipart/byteranges', () => {
	expect(parseRangeHeader('bytes=0-99,200-299', SIZE).kind).toBe('full');
});

test('anything we do not understand degrades to a full 200, never to an error: a spec with no dash is malformed and ignored', () => {
	expect(parseRangeHeader('bytes=100', SIZE).kind).toBe('full');
});

test('anything we do not understand degrades to a full 200, never to an error: non-digits are ignored rather than coerced', () => {
	expect(parseRangeHeader('bytes=abc-def', SIZE).kind).toBe('full');
	expect(parseRangeHeader('bytes=-1e3', SIZE).kind).toBe('full');
	expect(parseRangeHeader('bytes=+5-', SIZE).kind).toBe('full');
});

test('anything we do not understand degrades to a full 200, never to an error: a negative size cannot produce a range', () => {
	expect(parseRangeHeader('bytes=0-1', -1).kind).toBe('full');
});
