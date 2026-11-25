// #1245 nit 1: the Sing search a tab trip keeps belongs to the singer who typed it. Every join path reloads the page
// today, which clears it anyway; these pin the guard for a join that one day does not.
import { test, expect } from 'bun:test';
import { keepSearch, keptSearch, type KeptSearch } from '$lib/sing-search-keep';

const search = (query: string): KeptSearch => ({
	query,
	widened: false,
	ready: [],
	raw: [],
	processing: [],
	failed: false,
	answeredFor: query,
	pending: false
});

test('the same singer gets their search back, under the same source only', () => {
	keepSearch('alice', '', search('sweet c'));
	expect(keptSearch('alice', '')?.query).toBe('sweet c');
	expect(keptSearch('alice', 'local')).toBeNull();
});

test('Alice -> Leave -> Bob: Bob never sees Alice search', () => {
	keepSearch('alice', '', search('sweet c'));
	expect(keptSearch('bob', ''), 'another singer on the same phone').toBeNull();
	// Leave: Sing mounts unjoined, and its unmount keeps nothing, so Alice's search is gone for good.
	keepSearch(undefined, '', search('sweet c'));
	expect(keptSearch('bob', '')).toBeNull();
	expect(keptSearch('alice', ''), 'not even for Alice, after a leave').toBeNull();
});

test('no one joined: nothing kept, nothing given', () => {
	keepSearch(undefined, '', search('anything'));
	expect(keptSearch(undefined, '')).toBeNull();
});
