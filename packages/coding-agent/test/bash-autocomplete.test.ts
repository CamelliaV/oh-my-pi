import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui";
import {
	BashAutocompleteProvider,
	type BashCommandItem,
	type BashFileItem,
	parseAliasList,
} from "../src/modes/bash-autocomplete";
import type { ShellCommandRecord } from "../src/session/shell-history";

/** Recording stand-in for the wrapped provider. */
function fakeInner(): AutocompleteProvider & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		getSuggestions: async () => {
			calls.push("getSuggestions");
			return null;
		},
		applyCompletion: (lines, cursorLine, cursorCol) => {
			calls.push("applyCompletion");
			return { lines, cursorLine, cursorCol };
		},
		getForceFileSuggestions: async () => {
			calls.push("getForceFileSuggestions");
			return null;
		},
		shouldTriggerFileCompletion: () => {
			calls.push("shouldTriggerFileCompletion");
			return false;
		},
		getInlineHint: () => {
			calls.push("getInlineHint");
			return "inner-hint";
		},
	};
}

const NO_SESSION: ShellCommandRecord[] = [];

describe("parseAliasList", () => {
	test("parses single-quoted, double-quoted, and bare alias definitions", () => {
		const aliases = parseAliasList("mls='eza --icons -h'\nla=\"mls -la\"\nbare=cmd arg\nnot an alias\n");
		expect(aliases.get("mls")).toBe("eza --icons -h");
		expect(aliases.get("la")).toBe("mls -la");
		expect(aliases.get("bare")).toBe("cmd arg");
		expect(aliases.size).toBe(3);
	});

	test("parses zsh `alias -L` lines and skips global aliases", () => {
		const aliases = parseAliasList("alias mls='eza --icons -h'\nalias -- -='cd -'\nalias -g ...=../..\n");
		expect(aliases.get("mls")).toBe("eza --icons -h");
		expect(aliases.get("-")).toBe("cd -");
		expect(aliases.size).toBe(2);
	});
});

describe("BashAutocompleteProvider dispatch", () => {
	async function makeProvider(options?: {
		shellHistoryRecords?: ShellCommandRecord[];
		session?: ShellCommandRecord[];
	}) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-ac-"));
		const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-"));
		await Promise.all([
			fs.writeFile(path.join(dir, "systemd-analyze"), "#!/bin/sh\n", { mode: 0o755 }),
			fs.writeFile(path.join(dir, "git-tool"), "#!/bin/sh\n", { mode: 0o755 }),
			fs.mkdir(path.join(workdir, "packages", "tui"), { recursive: true }),
			fs.writeFile(path.join(workdir, "readme.md"), "# test\n"),
		]);
		const inner = fakeInner();
		const provider = new BashAutocompleteProvider(inner, {
			sessionBashCommands: () => options?.session ?? NO_SESSION,
			shellHistoryRecords: options?.shellHistoryRecords ?? [],
			aliases: new Map([["mls", "eza --icons -h"]]),
			pathEnv: dir,
			cwd: () => workdir,
		});
		return { provider, inner, workdir };
	}

	test("non-bash buffers delegate every call to the wrapped provider", async () => {
		const { provider, inner } = await makeProvider();
		await provider.getSuggestions(["hello"], 0, 5);
		expect(provider.shouldTriggerFileCompletion(["hello"], 0, 5)).toBe(false);
		expect(provider.getInlineHint(["hello"], 0, 5)).toBe("inner-hint");
		await provider.getForceFileSuggestions(["hello wo"], 0, 8);
		expect(inner.calls).toEqual([
			"getSuggestions",
			"shouldTriggerFileCompletion",
			"getInlineHint",
			"getForceFileSuggestions",
		]);
	});

	test("Tab on the first token completes PATH executables and aliases", async () => {
		const { provider } = await makeProvider();
		const result = await provider.getForceFileSuggestions(["!syste"], 0, 6);
		expect(result?.prefix).toBe("syste");
		expect(result?.items.map(item => item.value)).toEqual(["systemd-analyze"]);
		const aliasResult = await provider.getForceFileSuggestions(["!ml"], 0, 3);
		const expectedAliasItems: BashCommandItem[] = [
			{ value: "mls", label: "mls", description: "eza --icons -h", bashCommandCompletion: true },
		];
		expect(aliasResult?.items).toEqual(expectedAliasItems);
	});

	test("`! cmd` with a space after the prefix still completes the command name", async () => {
		const { provider } = await makeProvider();
		const result = await provider.getForceFileSuggestions(["!ml"], 0, 4);
		expect(result?.prefix).toBe("ml");
		expect(result?.items.map(item => item.value)).toEqual(["mls"]);
		const excluded = await provider.getForceFileSuggestions(["!! ml"], 0, 5);
		expect(excluded?.items.map(item => item.value)).toEqual(["mls"]);
	});

	test("an empty command token lists commands without exploding", async () => {
		const { provider } = await makeProvider();
		const result = await provider.getForceFileSuggestions(["!"], 0, 1);
		expect(result?.items.length).toBe(3);
		expect(result?.items.map(item => item.value).sort()).toEqual(["git-tool", "mls", "systemd-analyze"]);
	});

	test("later tokens and path-like first tokens complete paths from the cwd", async () => {
		const { provider } = await makeProvider();
		const nested = await provider.getForceFileSuggestions(["!cat packages/tu"], 0, 16);
		expect(nested?.prefix).toBe("packages/tu");
		expect(nested?.items.map(item => item.value)).toEqual(["packages/tui/"]);
		const topLevel = await provider.getForceFileSuggestions(["!cat packa"], 0, 10);
		expect(topLevel?.items.map(item => item.value)).toEqual(["packages/"]);
		const dotSlash = await provider.getForceFileSuggestions(["!ls ./pack"], 0, 11);
		expect(dotSlash?.items.map(item => item.value)).toEqual(["./packages/"]);
	});

	test("an empty path token lists the cwd, directories first", async () => {
		const { provider } = await makeProvider();
		const result = await provider.getForceFileSuggestions(["!ls "], 0, 4);
		expect(result?.prefix).toBe("");
		expect(result?.items.map(item => item.value)).toEqual(["packages/", "readme.md"]);
	});

	test("applying a file completion appends a space only for files", async () => {
		const { provider } = await makeProvider();
		const dirItem: BashFileItem = { value: "packages/", label: "packages/", bashFileCompletion: true };
		const dirResult = provider.applyCompletion(["!cat packa"], 0, 10, dirItem, "packa");
		expect(dirResult.lines).toEqual(["!cat packages/"]);
		expect(dirResult.cursorCol).toBe(14);
		const fileItem: BashFileItem = { value: "readme.md", label: "readme.md", bashFileCompletion: true };
		const fileResult = provider.applyCompletion(["!vim rea"], 0, 8, fileItem, "rea");
		expect(fileResult.lines).toEqual(["!vim readme.md "]);
		expect(fileResult.cursorCol).toBe(15);
	});
	test("bash buffers report Tab as eligible and suppress regular popups", async () => {
		const { provider } = await makeProvider();
		expect(provider.shouldTriggerFileCompletion(["!git"], 0, 4)).toBe(true);
		expect(await provider.getSuggestions(["!git"], 0, 4)).toBeNull();
	});

	test("applyCompletion replaces the command token and appends a space", async () => {
		const { provider } = await makeProvider();
		const item: BashCommandItem = {
			value: "systemd-analyze",
			label: "systemd-analyze",
			bashCommandCompletion: true,
		};
		const result = provider.applyCompletion(["!syste"], 0, 6, item, "syste");
		expect(result.lines).toEqual(["!systemd-analyze "]);
		expect(result.cursorCol).toBe(17);
	});

	test("applyCompletion delegates non-bash items to the wrapped provider", async () => {
		const { provider, inner } = await makeProvider();
		const item: AutocompleteItem = { value: "src/x", label: "src/x" };
		provider.applyCompletion(["@src/"], 0, 5, item, "src/");
		expect(inner.calls).toEqual(["applyCompletion"]);
	});
});

describe("BashAutocompleteProvider ghost hints", () => {
	function providerWith(shell: ShellCommandRecord[], session: ShellCommandRecord[] = []) {
		const inner = fakeInner();
		const provider = new BashAutocompleteProvider(inner, {
			sessionBashCommands: () => session,
			shellHistoryRecords: shell,
			aliases: new Map(),
		});
		return { provider, inner };
	}

	test("suggests the remainder of the newest matching history command", () => {
		const { provider } = providerWith([
			{ command: "git status", timestamp: 100 },
			{ command: "git stash pop", timestamp: 300 },
		]);
		expect(provider.getInlineHint(["!git sta"], 0, 8)).toBe("sh pop");
	});

	test("an empty fragment suggests the newest command outright", () => {
		const { provider } = providerWith([{ command: "z oh", timestamp: 100 }]);
		expect(provider.getInlineHint(["!"], 0, 1)).toBe("z oh");
	});

	test("session commands outrank older shell history and vice versa", () => {
		const { provider } = providerWith(
			[{ command: "git status", timestamp: 100 }],
			[{ command: "git stash", timestamp: 500 }],
		);
		expect(provider.getInlineHint(["!git sta"], 0, 8)).toBe("sh");
		const older = providerWith(
			[{ command: "git status --short", timestamp: 900 }],
			[{ command: "git stash", timestamp: 500 }],
		);
		expect(older.provider.getInlineHint(["!git sta"], 0, 8)).toBe("tus --short");
	});

	test("the !! prefix and a space after ! both match", () => {
		const { provider } = providerWith([{ command: "git status", timestamp: 100 }]);
		expect(provider.getInlineHint(["!!git sta"], 0, 9)).toBe("tus");
		expect(provider.getInlineHint(["! git sta"], 0, 9)).toBe("tus");
	});

	test("no hint mid-line, multi-line, or without a history prefix match", () => {
		const { provider } = providerWith([{ command: "git status", timestamp: 100 }]);
		expect(provider.getInlineHint(["!git sta"], 0, 4)).toBeNull();
		expect(provider.getInlineHint(["!git sta", "more"], 1, 4)).toBeNull();
		expect(provider.getInlineHint(["!zsh"], 0, 4)).toBeNull();
	});

	test("the hint is insertable (→ accept) and non-bash buffers delegate", () => {
		const { provider, inner } = providerWith([{ command: "git status", timestamp: 100 }]);
		expect(provider.getInsertableHint(["!git sta"], 0, 8)).toBe("tus");
		expect(provider.getInlineHint(["plain text"], 0, 10)).toBe("inner-hint");
		expect(provider.getInsertableHint(["plain text"], 0, 10)).toBeNull();
		expect(inner.calls).toEqual(["getInlineHint"]);
	});
});
