/**
 * Pins are user intent that outlives the folder a session was recorded in: the
 * resume picker exposes a Pinned scope listing every pinned session from every
 * project, while the session keeps its place in its own project's list (a pin
 * is a shortcut, not a move).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hideSession } from "@oh-my-pi/pi-coding-agent/session/session-hides";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setSessionPinned } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { getAgentDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

describe("resume picker — pinned scope", () => {
	const originalAgentDir = getAgentDir();
	let root: string;
	let projA: string;
	let projB: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-picker-pins-")));
		setAgentDir(path.join(root, "agent"));
		projA = path.join(root, "proj-a");
		projB = path.join(root, "proj-b");
		fs.mkdirSync(projA, { recursive: true });
		fs.mkdirSync(projB, { recursive: true });
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		removeSyncWithRetries(root);
	});

	async function answeredSession(cwd: string): Promise<{ id: string; path: string }> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: `work in ${cwd}`, timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		const info = { id: session.getSessionId(), path: file };
		await session.close();
		return info;
	}

	it("lists a pinned session from another project without moving it out of its own", async () => {
		const a = await answeredSession(projA);
		const b = await answeredSession(projB);
		await setSessionPinned(b.id, true);

		// The pinned shelf spans projects, newest first.
		const pinned = await SessionManager.listPinnedForPicker();
		expect(pinned.map(session => session.id)).toEqual([b.id]);
		expect(pinned[0]?.path).toBe(path.resolve(b.path));

		// The project list stays local: the pin is a shortcut, not a move.
		expect((await SessionManager.listForPicker(projA)).sessions.map(session => session.id)).toEqual([a.id]);
		expect((await SessionManager.listForPicker(projB)).sessions.map(session => session.id)).toEqual([b.id]);
	}, 20_000);

	it("keeps only pinned sessions, and drops a pin whose file is gone", async () => {
		await answeredSession(projA);
		const b = await answeredSession(projB);
		expect(await SessionManager.listPinnedForPicker()).toEqual([]);

		await setSessionPinned(b.id, true);
		fs.rmSync(b.path);
		expect(await SessionManager.listPinnedForPicker()).toEqual([]);
	}, 20_000);

	it("keeps a pinned session out of the shelf while it is hidden", async () => {
		const b = await answeredSession(projB);
		await setSessionPinned(b.id, true);
		await hideSession(b.id);

		expect(await SessionManager.listPinnedForPicker()).toEqual([]);
	}, 20_000);
});
