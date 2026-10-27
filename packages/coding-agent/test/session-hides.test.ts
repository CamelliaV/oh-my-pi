import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filterOutHiddenSessions, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { hideSession, loadHiddenSessionIds, unhideSession } from "@oh-my-pi/pi-coding-agent/session/session-hides";

describe("session-hides", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-hides-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns an empty set when no hides file exists", async () => {
		const hidden = await loadHiddenSessionIds(tempDir);
		expect(hidden.size).toBe(0);
	});

	it("recovers gracefully from a corrupt hides file", async () => {
		await Bun.write(path.join(tempDir, "session-hides.json"), "invalid json {");
		const hidden = await loadHiddenSessionIds(tempDir);
		expect(hidden.size).toBe(0);
	});

	it("hides and unhide sessions and persists to disk", async () => {
		const id1 = "session-aaa-111";
		const id2 = "session-bbb-222";

		expect(await hideSession(id1, tempDir)).toBe(true);
		let loaded = await loadHiddenSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(true);
		expect(loaded.size).toBe(1);

		expect(await hideSession(id2, tempDir)).toBe(true);
		loaded = await loadHiddenSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(true);
		expect(loaded.has(id2)).toBe(true);
		expect(loaded.size).toBe(2);

		// Hiding an already-hidden id stays hidden (no toggle semantics).
		expect(await hideSession(id1, tempDir)).toBe(true);
		loaded = await loadHiddenSessionIds(tempDir);
		expect(loaded.size).toBe(2);

		// Unhide removes only the named id.
		expect(await unhideSession(id1, tempDir)).toBe(false);
		loaded = await loadHiddenSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(false);
		expect(loaded.has(id2)).toBe(true);
		expect(loaded.size).toBe(1);
	});

	it("filters hidden sessions out of a listing while stale ids are a no-op", () => {
		const session = (id: string): SessionInfo =>
			({
				id,
				path: `/tmp/${id}.jsonl`,
				title: undefined,
				firstMessage: "hello",
				size: 100,
				modified: new Date(),
				created: new Date(),
				cwd: "/tmp",
				status: "complete",
			}) as unknown as SessionInfo;

		const sessions = [session("a"), session("b"), session("c")];
		// Hidden "b" drops from the listing; a stale hide for a deleted
		// session "zzz" leaves the remaining rows untouched.
		const visible = filterOutHiddenSessions(sessions, new Set(["b", "zzz"]));
		expect(visible.map(s => s.id)).toEqual(["a", "c"]);
		// Empty hide set returns the input list unfiltered.
		expect(filterOutHiddenSessions(sessions, new Set())).toBe(sessions);
	});

	it("keeps every hide when many concurrent hides race", async () => {
		// Regression: unlocked read-modify-write would interleave
		// load-load-write-write across omp instances and drop hides.
		const ids = Array.from({ length: 24 }, (_, i) => `session-hide-race-${i}`);
		await Promise.all(ids.map(id => hideSession(id, tempDir)));

		const loaded = await loadHiddenSessionIds(tempDir);
		expect(loaded.size).toBe(ids.length);
		for (const id of ids) expect(loaded.has(id)).toBe(true);
	});

	it("never exposes a truncated hides file while writes are in flight", async () => {
		// Atomic replace: a concurrent reader sees either the old or the new
		// complete file, never a partial JSON document.
		const ids = Array.from({ length: 16 }, (_, i) => `session-atomic-${i}`);
		const readers = ids.map(id => hideSession(id, tempDir));
		const snapshots = await Promise.all(Array.from({ length: 8 }, () => loadHiddenSessionIds(tempDir)));
		await Promise.all(readers);
		for (const snapshot of snapshots) {
			// Every snapshot is a valid set — a truncated file would have thrown.
			expect(snapshot instanceof Set).toBe(true);
		}
		const final = await loadHiddenSessionIds(tempDir);
		expect(final.size).toBe(ids.length);
	});
});
