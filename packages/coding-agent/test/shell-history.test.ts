import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CommandHistorySource,
	loadShellCommandHistory,
	mergeCommandHistories,
	parseBashHistory,
	parseZshHistory,
	resolveShellHistoryFile,
} from "../src/session/shell-history";

describe("parseZshHistory", () => {
	test("extended-history header yields command and timestamp", () => {
		const records = parseZshHistory(": 1787929832:0;z oh\n: 1787929833:0;omp\n", 0);
		expect(records).toEqual([
			{ command: "z oh", timestamp: 1787929832 },
			{ command: "omp", timestamp: 1787929833 },
		]);
	});

	test("backslash-continued lines join into one multi-line command", () => {
		const records = parseZshHistory(": 1764993548:0;mkdir karing-build\\\ncd karing-build\n", 0);
		expect(records).toEqual([{ command: "mkdir karing-build\ncd karing-build", timestamp: 1764993548 }]);
	});

	test("plain lines fall back to the fallback timestamp", () => {
		const records = parseZshHistory("git status\nls -la\n", 12345);
		expect(records).toEqual([
			{ command: "git status", timestamp: 12345 },
			{ command: "ls -la", timestamp: 12345 },
		]);
	});

	test("a no-colon 0:0; line stays a literal command, matching zsh's own reader", () => {
		const records = parseZshHistory("0:0;omp -r mini\n: 1787929832:0;z oh\n", 0);
		expect(records).toEqual([
			{ command: "0:0;omp -r mini", timestamp: 0 },
			{ command: "z oh", timestamp: 1787929832 },
		]);
	});
});

describe("parseBashHistory", () => {
	test("timestamp markers split entries and consecutive lines join", () => {
		const records = parseBashHistory("#1234567890\ngit status\n#1234567891\necho hello\nworld\n", 0);
		expect(records).toEqual([
			{ command: "git status", timestamp: 1234567890 },
			{ command: "echo hello\nworld", timestamp: 1234567891 },
		]);
	});

	test("without markers every non-empty line is one command with the fallback timestamp", () => {
		const records = parseBashHistory("git status\n\ngit push\n", 99);
		expect(records).toEqual([
			{ command: "git status", timestamp: 99 },
			{ command: "git push", timestamp: 99 },
		]);
	});
});

describe("resolveShellHistoryFile", () => {
	afterEach(() => {
		delete process.env.HISTFILE;
		delete process.env.SHELL;
	});

	test("exported HISTFILE wins and format follows $SHELL", () => {
		expect(resolveShellHistoryFile({ HISTFILE: "/tmp/custom_hist", SHELL: "/usr/bin/bash" })).toEqual({
			path: "/tmp/custom_hist",
			format: "bash",
		});
		expect(resolveShellHistoryFile({ HISTFILE: "/tmp/custom_hist", SHELL: "/usr/bin/zsh" })).toEqual({
			path: "/tmp/custom_hist",
			format: "zsh",
		});
	});

	test("zsh and bash default to their conventional history paths", () => {
		expect(resolveShellHistoryFile({ SHELL: "/usr/bin/zsh" })).toEqual({
			path: path.join(os.homedir(), ".zsh_history"),
			format: "zsh",
		});
		expect(resolveShellHistoryFile({ SHELL: "/bin/bash" })).toEqual({
			path: path.join(os.homedir(), ".bash_history"),
			format: "bash",
		});
	});

	test("unknown or missing shell yields no history file", () => {
		expect(resolveShellHistoryFile({ SHELL: "/usr/bin/fish" })).toBeUndefined();
		expect(resolveShellHistoryFile({})).toBeUndefined();
	});
});

describe("mergeCommandHistories", () => {
	test("deduplicates by command text keeping the newest occurrence and its origin", () => {
		const merged = mergeCommandHistories(
			[
				{ command: "git status", timestamp: 100 },
				{ command: "git status", timestamp: 300 },
				{ command: "ls", timestamp: 200 },
			],
			[{ command: "git status", timestamp: 400 }],
		);
		expect(merged).toEqual([
			{ id: 0, prompt: "git status", created_at: 400, origin: "omp" },
			{ id: 0, prompt: "ls", created_at: 200, origin: "shell" },
		]);
	});

	test("orders newest first and ignores whitespace-only commands", () => {
		const merged = mergeCommandHistories(
			[
				{ command: "old", timestamp: 1 },
				{ command: "   ", timestamp: 5 },
			],
			[{ command: "new", timestamp: 9 }],
		);
		expect(merged.map(entry => entry.prompt)).toEqual(["new", "old"]);
	});
});

describe("CommandHistorySource", () => {
	const source = new CommandHistorySource(
		mergeCommandHistories(
			[
				{ command: "git status", timestamp: 100 },
				{ command: "systemd-analyze blame", timestamp: 200 },
			],
			[{ command: "omp stats", timestamp: 300 }],
		),
	);

	test("empty query returns recents newest-first", () => {
		expect(source.getRecent(10).map(entry => entry.prompt)).toEqual([
			"omp stats",
			"systemd-analyze blame",
			"git status",
		]);
	});

	test("every query token must match, case-insensitively", () => {
		expect(source.search("systemd blame", 10).map(entry => entry.prompt)).toEqual(["systemd-analyze blame"]);
		expect(source.search("OMP", 10).map(entry => entry.prompt)).toEqual(["omp stats"]);
		expect(source.search("git blame", 10)).toEqual([]);
	});

	test("limit bounds the result count", () => {
		expect(source.search("", 2)).toHaveLength(2);
	});
});

describe("loadShellCommandHistory", () => {
	test("missing file yields an empty list instead of throwing", async () => {
		const records = await loadShellCommandHistory({ file: { path: "/nonexistent/omp-test-history", format: "zsh" } });
		expect(records).toEqual([]);
	});

	test("reads and parses an explicit zsh history file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-history-"));
		const file = path.join(dir, "zsh_history");
		await fs.writeFile(file, ": 1787900000:0;git status\n: 1787900100:0;systemd-analyze blame\n");
		const records = await loadShellCommandHistory({ file: { path: file, format: "zsh" } });
		expect(records).toEqual([
			{ command: "git status", timestamp: 1787900000 },
			{ command: "systemd-analyze blame", timestamp: 1787900100 },
		]);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
