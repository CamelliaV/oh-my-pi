import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { loadShellCommandHistory, type ShellCommandRecord } from "../session/shell-history";

/** Maximum command-name candidates offered for one Tab press. */
const MAX_COMMAND_ITEMS = 100;
/** Milliseconds a Tab press waits for the (once-per-process) shell alias load. */
const ALIAS_WAIT_MS = 300;
/** Hard cap on the `alias -L` subprocess so a hanging rc file cannot wedge completion. */
const ALIAS_SPAWN_TIMEOUT_MS = 5000;

/** Bash command-name completion item, marked so the wrapper applies it itself. */
export interface BashCommandItem extends AutocompleteItem {
	bashCommandCompletion: true;
}

/** Bash path-token completion item, marked so the wrapper applies it itself. */
export interface BashFileItem extends AutocompleteItem {
	bashFileCompletion: true;
}

function isBashFileItem(item: AutocompleteItem): item is BashFileItem {
	return (item as BashFileItem).bashFileCompletion === true;
}

function isBashCommandItem(item: AutocompleteItem): item is BashCommandItem {
	return (item as BashCommandItem).bashCommandCompletion === true;
}

/** A `!` / `!!` line split into prefix and the command text after it. */
interface BashLine {
	/** Column where the command text starts (after `!` or `!!`). */
	prefixEnd: number;
	/** Text after the prefix, unmodified. */
	fragment: string;
}

function parseBashLine(line: string): BashLine | null {
	const leading = line.length - line.trimStart().length;
	const rest = line.slice(leading);
	if (rest.startsWith("!!")) return { prefixEnd: leading + 2, fragment: rest.slice(2) };
	if (rest.startsWith("!")) return { prefixEnd: leading + 1, fragment: rest.slice(1) };
	return null;
}

function isBashBuffer(lines: string[]): boolean {
	return (lines[0] ?? "").trimStart().startsWith("!");
}

/** Whether a first token is a path (delegated to file completion) rather than a command name. */
function isPathLikeToken(token: string): boolean {
	return (
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.startsWith("~") ||
		token.includes("/")
	);
}

/**
 * Parse `alias -L` (zsh) or `alias` (bash) output into name → expansion.
 * zsh prints a leading `alias ` plus `--` for odd names; global (`-g`) and
 * suffix (`-s`) aliases expand in argument position, not command position,
 * so they are skipped.
 */
export function parseAliasList(text: string): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^(?:alias\s+)?(?:(-g|-s)\s+)?(?:--\s+)?([A-Za-z0-9_.-]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(
			line.trim(),
		);
		if (!match || match[1]) continue;
		aliases.set(match[2], match[3] ?? match[4] ?? match[5] ?? "");
	}
	return aliases;
}

let pathCommandsCache: { pathKey: string; commands: string[] } | undefined;

/** Executable names found across the PATH directories, cached per PATH value. */
async function loadPathCommands(pathEnv: string): Promise<string[]> {
	if (pathCommandsCache?.pathKey === pathEnv) return pathCommandsCache.commands;
	const names = new Set<string>();
	await Promise.all(
		pathEnv
			.split(path.delimiter)
			.filter(Boolean)
			.map(dir =>
				fs
					.readdir(dir)
					.then(entries => {
						for (const entry of entries) names.add(entry);
					})
					.catch(() => undefined),
			),
	);
	const commands = [...names].sort((a, b) => a.localeCompare(b));
	pathCommandsCache = { pathKey: pathEnv, commands };
	return commands;
}

let aliasLoad: Promise<Map<string, string>> | undefined;

/**
 * Load the user's shell aliases by spawning the login shell once
 * (`$SHELL -ic 'alias -L'`). Sourcing the full rc takes a while, so the
 * promise is shared and never restarted; Tab falls back to PATH-only
 * candidates while it is still running.
 */
function loadShellAliases(): Promise<Map<string, string>> {
	aliasLoad ??= (async () => {
		const shell = process.env.SHELL ?? "";
		const shellName = path.basename(shell).toLowerCase();
		if (!shell || !(shellName.includes("zsh") || shellName.includes("bash"))) return new Map<string, string>();
		try {
			const proc = Bun.spawn([shell, "-ic", shellName.includes("zsh") ? "alias -L" : "alias"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			const timer = setTimeout(() => proc.kill(), ALIAS_SPAWN_TIMEOUT_MS);
			try {
				const text = await new Response(proc.stdout).text();
				await proc.exited;
				return parseAliasList(text);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			logger.warn("Failed to load shell aliases", { error: error instanceof Error ? error.message : String(error) });
			return new Map<string, string>();
		}
	})();
	return aliasLoad;
}

/** Aliases if the background load finished within the Tab budget, else null (PATH-only). */
async function currentAliases(): Promise<Map<string, string> | null> {
	return Promise.race([loadShellAliases(), Bun.sleep(ALIAS_WAIT_MS).then(() => null)]).catch(() => null);
}

let shellHistorySnapshot: ShellCommandRecord[] = [];
let shellHistoryLoadStarted = false;

/** Kick off (once) the shell-history load backing ghost-text suggestions. */
function ensureShellHistory(): void {
	if (shellHistoryLoadStarted) return;
	shellHistoryLoadStarted = true;
	void loadShellCommandHistory()
		.then(records => {
			shellHistorySnapshot = records;
		})
		.catch(() => undefined);
}

/** Newest record whose command starts with `matchKey`, or null. */
function newestPrefixMatch(records: ShellCommandRecord[], matchKey: string): ShellCommandRecord | null {
	for (let i = records.length - 1; i >= 0; i--) {
		if (records[i].command.startsWith(matchKey)) return records[i];
	}
	return null;
}

export interface BashAutocompleteDeps {
	/** `!` / `!!` commands on the current session branch, oldest → newest. */
	sessionBashCommands(): ShellCommandRecord[];
	/** Test seam: replaces the shell-history snapshot (also skips its load). */
	shellHistoryRecords?: ShellCommandRecord[];
	/** Test seam: replaces the spawned `alias -L` parse. */
	aliases?: Map<string, string>;
	/** Test seam: overrides the scanned PATH. */
	pathEnv?: string;
	/** Working directory for relative path completion; defaults to `process.cwd()`. */
	cwd?: () => string;
}

/**
 * Wraps the composer's autocomplete provider with bash-mode behavior for
 * `!` / `!!` input: Tab completes the command name (PATH executables + shell
 * accepted with → like zsh-autosuggestions.
 */
export class BashAutocompleteProvider implements AutocompleteProvider {
	readonly #inner: AutocompleteProvider;
	readonly #deps: BashAutocompleteDeps;

	constructor(inner: AutocompleteProvider, deps: BashAutocompleteDeps) {
		this.#inner = inner;
		this.#deps = deps;
		// Preload now: the snapshot must be ready before the first bash-mode
		// render, or the ghost suggestion misses the frame that shows the text.
		if (!deps.shellHistoryRecords) ensureShellHistory();
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (isBashBuffer(lines)) return Promise.resolve(null);
		return this.#inner.getSuggestions(lines, cursorLine, cursorCol, signal);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		if (isBashCommandItem(item)) {
			// Replace the command-name token with the selected value plus a space.
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
			const after = line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = `${before}${item.value} ${after}`;
			return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
		}
		if (isBashFileItem(item)) {
			// Replace the path token; directories keep the popup chainable, files get a trailing space.
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
			const after = line.slice(cursorCol);
			const suffix = item.value.endsWith("/") ? "" : " ";
			const newLines = [...lines];
			newLines[cursorLine] = `${before}${item.value}${suffix}${after}`;
			return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + suffix.length };
		}
		return this.#inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	async getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const commandToken = this.#commandNameToken(lines, cursorLine, cursorCol);
		if (commandToken !== null) {
			if (signal?.aborted) return null;
			const pathEnv = this.#deps.pathEnv ?? process.env.PATH ?? "";
			const commands = await loadPathCommands(pathEnv);
			const raced = this.#deps.aliases ?? (await currentAliases());
			if (signal?.aborted) return null;
			let items = this.#commandItems(commandToken, commands, raced);
			if (items === null && !this.#deps.aliases) {
				// Nothing matched with the (possibly still-loading) aliases: wait
				// for the full alias load instead of showing an empty popup —
				// an alias-only prefix must not silently miss its first Tab.
				const aliases = await loadShellAliases();
				if (signal?.aborted) return null;
				items = this.#commandItems(commandToken, commands, aliases);
			}
			if (items === null) return null;
			return { items, prefix: commandToken };
		}
		if (!isBashBuffer(lines)) {
			return this.#inner.getForceFileSuggestions?.(lines, cursorLine, cursorCol, signal) ?? null;
		}
		return this.#bashFileSuggestions(lines, cursorLine, cursorCol, signal);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		if (isBashBuffer(lines)) return true;
		return this.#inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!isBashBuffer(lines)) return this.#inner.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
		ensureShellHistory();
		// Also start the alias load here so the first Tab in bash mode usually
		// finds it finished instead of racing the 300ms budget.
		if (!this.#deps.aliases) void loadShellAliases();
		const fragment = this.#trailingCommandFragment(lines, cursorLine, cursorCol);
		if (fragment === null) return null;
		const matchKey = fragment.trimStart();
		const shellMatch = newestPrefixMatch(this.#shellRecords(), matchKey);
		const sessionMatch = newestPrefixMatch(this.#deps.sessionBashCommands(), matchKey);
		const best =
			shellMatch && sessionMatch
				? sessionMatch.timestamp >= shellMatch.timestamp
					? sessionMatch
					: shellMatch
				: (sessionMatch ?? shellMatch);
		if (!best) return null;
		return best.command.slice(matchKey.length) || null;
	}

	getInsertableHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		// Only the bash ghost suggestion is insertable; wrapped-provider hints
		// are descriptive and must never land in the buffer.
		if (!isBashBuffer(lines)) return null;
		return this.getInlineHint(lines, cursorLine, cursorCol);
	}

	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return this.#inner.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
	}

	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		return this.#inner.trySyncInlineReplace?.(textBeforeCursor) ?? null;
	}

	#shellRecords(): ShellCommandRecord[] {
		if (this.#deps.shellHistoryRecords) return this.#deps.shellHistoryRecords;
		ensureShellHistory();
		return shellHistorySnapshot;
	}

	/** Alias-first command-name candidates for `token`, or null when nothing matches. */
	#commandItems(token: string, commands: string[], aliases: Map<string, string> | null): BashCommandItem[] | null {
		const lowerToken = token.toLowerCase();
		const items: BashCommandItem[] = [];
		const seen = new Set<string>();
		if (aliases) {
			for (const name of [...aliases.keys()].sort((a, b) => a.localeCompare(b))) {
				if (!name.toLowerCase().startsWith(lowerToken)) continue;
				seen.add(name);
				items.push({ value: name, label: name, description: aliases.get(name), bashCommandCompletion: true });
			}
		}
		for (const name of commands) {
			if (seen.has(name) || !name.toLowerCase().startsWith(lowerToken)) continue;
			items.push({ value: name, label: name, bashCommandCompletion: true });
		}
		return items.length > 0 ? items.slice(0, MAX_COMMAND_ITEMS) : null;
	}

	/**
	 * The command-name token being completed, or null when the cursor is not
	 * completing the first token of a bash command (path-like tokens and later
	 * tokens go to path completion instead).
	 */
	#commandNameToken(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!isBashBuffer(lines) || cursorLine !== 0) return null;
		const parsed = parseBashLine(lines[0] ?? "");
		if (!parsed || cursorCol < parsed.prefixEnd) return null;
		// Tolerate the `! cmd` spelling (the submit path trims the same way):
		// a leading space is still the command-name position.
		const commandBeforeCursor = (lines[0] ?? "").slice(parsed.prefixEnd, cursorCol).trimStart();
		if (/\s/.test(commandBeforeCursor) || isPathLikeToken(commandBeforeCursor)) return null;
		return commandBeforeCursor;
	}

	/**
	 * The path token before the cursor (whitespace-delimited), or null when the
	 * cursor sits inside the `!` prefix. An empty token means "list the cwd".
	 */
	#pathTokenBeforeCursor(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol);
		const tokenStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
		const token = before.slice(tokenStart);
		if (token.startsWith("!")) return null;
		return token;
	}

	/** Complete a path token against the filesystem, directories first. */
	async #bashFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const token = this.#pathTokenBeforeCursor(lines, cursorLine, cursorCol);
		if (token === null || signal?.aborted) return null;

		const cwd = this.#deps.cwd?.() ?? process.cwd();
		let searchDir: string;
		let filePrefix: string;
		let dirPart: string;
		if (token === "" || token.endsWith("/")) {
			dirPart = token;
			filePrefix = "";
		} else {
			const lastSlash = token.lastIndexOf("/");
			dirPart = lastSlash === -1 ? "" : token.slice(0, lastSlash + 1);
			filePrefix = token.slice(dirPart.length);
		}
		if (dirPart.startsWith("~")) {
			searchDir = path.join(os.homedir(), dirPart.slice(1));
		} else if (dirPart.startsWith("/")) {
			searchDir = dirPart;
		} else {
			searchDir = path.resolve(cwd, dirPart);
		}

		let entries: Dirent[];
		try {
			entries = await fs.readdir(searchDir, { withFileTypes: true });
		} catch {
			return null;
		}
		if (signal?.aborted) return null;

		const lowerPrefix = filePrefix.toLowerCase();
		const items: BashFileItem[] = [];
		for (const entry of entries) {
			if (!entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
				} catch {
					continue;
				}
			}
			const value = `${dirPart}${entry.name}${isDirectory ? "/" : ""}`;
			items.push({ value, label: `${entry.name}${isDirectory ? "/" : ""}`, bashFileCompletion: true });
		}
		if (items.length === 0) return null;
		items.sort((a, b) => {
			const aDir = a.value.endsWith("/");
			const bDir = b.value.endsWith("/");
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.label.localeCompare(b.label);
		});
		return { items, prefix: token };
	}

	/** The command text before the cursor when the cursor sits at the very end of the buffer. */
	#trailingCommandFragment(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (lines.length !== 1 || cursorLine !== 0) return null;
		const line = lines[0] ?? "";
		if (cursorCol !== line.length) return null;
		const parsed = parseBashLine(line);
		if (!parsed) return null;
		return parsed.fragment;
	}
}
