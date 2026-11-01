/**
 * Fork patch #6 regression: `--resume <term>` must fall back to matching
 * session titles (and first messages) when the exact id/filename prefix misses.
 * The v18.14.0 upstream merge moved resume resolution into `resolveResumeTarget`
 * and dropped the call site while keeping the exported matcher, so every
 * non-prefix term failed with `Session "…" not found.`
 *
 * The history-index pass is a separate contract: stored prompts rank after
 * title/first-message hits, and one literal title hit still resumes directly
 * even while weaker subsequence candidates exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { fuzzyMatchResumableSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const originalAgentDir = getAgentDir();
let sandbox: TempDir;

beforeAll(() => {
	sandbox = TempDir.createSync("@omp-resume-fuzzy-agent-");
	// The fuzzy pass always scans the global session catalogue; point it at a
	// sandboxed agent dir so the fixtures are the only candidates, including
	// the history.db lookup the content pass opens.
	setAgentDir(sandbox.path());
});

afterAll(() => {
	setAgentDir(originalAgentDir);
	sandbox.removeSync();
});

interface FixtureSpec {
	id: string;
	title: string;
	firstMessage: string;
}

async function writeSession(dir: string, spec: FixtureSpec): Promise<string> {
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${spec.id}.jsonl`);
	await Bun.write(
		file,
		[
			serializeTitleSlot({ title: spec.title, source: "auto", updatedAt: TIMESTAMP }).trimEnd(),
			JSON.stringify({ type: "session", version: 3, id: spec.id, cwd: dir, timestamp: TIMESTAMP }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: TIMESTAMP,
				message: { role: "user", content: spec.firstMessage },
			}),
			"",
		].join("\n"),
	);
	return file;
}

function fixtureDir(name: string): string {
	return path.join(sandbox.path(), "sessions", name);
}

function resumeArgs(resume: string, sessionDir: string) {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

const isolatedSettings = () => Settings.isolated({ "marketplace.autoUpdate": "off" });

async function openResumed(term: string, dir: string) {
	return createSessionManager(resumeArgs(term, dir), dir, isolatedSettings());
}

describe("--resume <term> — fuzzy title fallback", () => {
	it("resumes the single session whose title matches a non-prefix term", async () => {
		const dir = fixtureDir("title");
		const target = await writeSession(dir, {
			id: "019ea530-1111-7000-0000-000000000001",
			title: "zqxunique release notes",
			firstMessage: "hello",
		});
		await writeSession(dir, {
			id: "019ea530-1111-7000-0000-000000000002",
			title: "an unrelated session",
			firstMessage: "goodbye",
		});

		const manager = await openResumed("zqxunique", dir);
		if (!manager) throw new Error("expected a resumed session manager");
		try {
			expect(manager.getSessionFile()).toBe(path.resolve(target));
		} finally {
			await manager.close();
		}
	}, 20_000);

	it("keeps exact id prefixes ahead of a title that also matches", async () => {
		const dir = fixtureDir("prefix");
		const prefixHit = await writeSession(dir, {
			id: "abc12345-1111-7000-0000-000000000001",
			title: "nothing to see",
			firstMessage: "hello",
		});
		await writeSession(dir, {
			id: "ffee9988-1111-7000-0000-000000000002",
			title: "abc in the title",
			firstMessage: "goodbye",
		});

		const manager = await openResumed("abc", dir);
		if (!manager) throw new Error("expected a resumed session manager");
		try {
			expect(manager.getSessionFile()).toBe(path.resolve(prefixHit));
		} finally {
			await manager.close();
		}
	}, 20_000);

	it("reports the candidates instead of a bare not-found when no picker can run", async () => {
		const dir = fixtureDir("ambiguous");
		await writeSession(dir, {
			id: "019ea530-2222-7000-0000-000000000001",
			title: "qwxambig first",
			firstMessage: "hello",
		});
		const secondId = "019ea530-2222-7000-0000-000000000002";
		await writeSession(dir, { id: secondId, title: "qwxambig second", firstMessage: "goodbye" });

		// Bun tests have no TTY, which is exactly the non-interactive launch path.
		let thrown: unknown;
		try {
			await openResumed("qwxambig", dir);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionResolutionError);
		const error = thrown as SessionResolutionError;
		expect(error.message).toContain("matches 2 sessions");
		expect(error.hint).toContain(secondId);
	}, 20_000);

	it("still fails closed when nothing matches", async () => {
		const dir = fixtureDir("none");
		await writeSession(dir, {
			id: "019ea530-3333-7000-0000-000000000001",
			title: "available session",
			firstMessage: "hello",
		});

		let thrown: unknown;
		try {
			await openResumed("qqqqzzzz", dir);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionResolutionError);
		expect((thrown as SessionResolutionError).message).toContain("not found");
	}, 20_000);
});

describe("fuzzy resume ranking — stored prompts", () => {
	it("ranks a title hit above a stored-prompt hit and marks each origin", async () => {
		const dir = fixtureDir("content");
		const titleHit = await writeSession(dir, {
			id: "019ea530-4444-7000-0000-000000000001",
			title: "zzcontent tool output",
			firstMessage: "hello",
		});
		const promptHit = await writeSession(dir, {
			id: "019ea530-4444-7000-0000-000000000002",
			title: "unrelated work",
			firstMessage: "goodbye",
		});

		const matches = await fuzzyMatchResumableSessions("zzcontent", dir, dir, undefined, {
			contentMatch: () => ["019ea530-4444-7000-0000-000000000002"],
		});
		expect(matches.map(match => [path.basename(match.session.path), match.via])).toEqual([
			[path.basename(titleHit), "title"],
			[path.basename(promptHit), "content"],
		]);

		// The content pass maps ids back to listing rows; an unknown id is a no-op.
		const unknown = await fuzzyMatchResumableSessions("zzcontent", dir, dir, undefined, {
			contentMatch: () => ["019ea530-4444-7000-0000-0000000000ff"],
		});
		expect(unknown.map(match => match.via)).toEqual(["title"]);
	}, 20_000);
});
