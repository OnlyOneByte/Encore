// RoomRepository — the rooms table's first production writer + reader (#652, Rooms 1/7).
// On base origin/main NO writer or reader exists (only two fixtures touch the table), so the
// round-trip pin below cannot even be authored against base: RoomRepository does not exist there.
import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { rooms } from '../db/schema';
import { RoomRepository, mintRoomCode } from './repository';

function freshRepo() {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return { db, repo: new RoomRepository(db) };
}

// THE PIN: a created room is readable back by its code. Red on base — no writer/reader exists.
test('create then byCode round-trips the room', () => {
	const { repo } = freshRepo();
	const now = 1_700_000_000_000;
	const created = repo.create(now);

	expect(created.id).toBeTruthy();
	expect(created.code).toBeTruthy();
	expect(created.createdAt).toBe(now);

	const found = repo.byCode(created.code);
	expect(found).not.toBeNull();
	expect(found!.id).toBe(created.id);
	expect(found!.code).toBe(created.code);
	expect(found!.createdAt).toBe(now);
});

test('byId round-trips the created room', () => {
	const { repo } = freshRepo();
	const created = repo.create(1_700_000_000_000);
	expect(repo.byId(created.id)!.code).toBe(created.code);
});

test('two created rooms get distinct ids and distinct codes', () => {
	const { repo } = freshRepo();
	const a = repo.create(1_700_000_000_000);
	const b = repo.create(1_700_000_000_001);
	expect(a.id).not.toBe(b.id);
	expect(a.code).not.toBe(b.code);
});

test('byCode / byId return null on a miss (and on empty input)', () => {
	const { repo } = freshRepo();
	repo.create(1_700_000_000_000);
	expect(repo.byCode('NOSUCH')).toBeNull();
	expect(repo.byId('nosuch')).toBeNull();
	expect(repo.byCode('')).toBeNull();
	expect(repo.byId('')).toBeNull();
});

// The rooms_code_idx unique index is what makes lookup-by-code sound. A raw duplicate insert must
// be rejected by the DB, not silently create a second room a joiner could not tell apart.
test('the code is unique at the DB layer', () => {
	const { db, repo } = freshRepo();
	const first = repo.create(1_700_000_000_000);
	expect(() => db.insert(rooms).values({ id: 'dupe', code: first.code, createdAt: 1 }).run()).toThrow(
		/UNIQUE constraint failed/i
	);
	// still exactly one room with that code
	expect(db.select().from(rooms).where(eq(rooms.code, first.code)).all()).toHaveLength(1);
});

// create() retries past a drawn-but-taken code rather than throwing the UNIQUE violation up.
test('create retries past a code collision and returns a free code', () => {
	const { db, repo } = freshRepo();
	// Occupy a code, then hand create() a minter that draws that taken code FIRST and a free one
	// SECOND — so the first insert hits the unique index and the retry lands the free code.
	db.insert(rooms).values({ id: 'seed', code: 'TAKEN1', createdAt: 1 }).run();
	const draws = ['TAKEN1', 'FREE22'];
	let i = 0;
	const made = repo.create(1_700_000_000_000, { mintCode: () => draws[i++]! });
	expect(i).toBe(2); // proves the first draw collided and it drew again
	expect(made.code).toBe('FREE22');
	expect(repo.byCode('FREE22')!.id).toBe(made.id);
});

// After exhausting the retries on a code space that is entirely taken, create() throws rather than
// returning a room with a colliding code.
test('create throws once every attempt collides', () => {
	const { db, repo } = freshRepo();
	db.insert(rooms).values({ id: 'seed', code: 'ONLYCD', createdAt: 1 }).run();
	expect(() => repo.create(1_700_000_000_000, { attempts: 3, mintCode: () => 'ONLYCD' })).toThrow(
		/could not mint a free room code/i
	);
});

test('mintRoomCode yields a code over the unambiguous alphabet only', () => {
	for (let i = 0; i < 200; i++) {
		const c = mintRoomCode();
		expect(c).toHaveLength(6);
		// no confusable characters: 0/O/1/I/L are excluded
		expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
	}
});
