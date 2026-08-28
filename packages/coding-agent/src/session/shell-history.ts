import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { HistoryEntry, HistorySearchSource } from "./history-storage";
import type { SessionManager } from "./session-manager";

/** One shell-history command with its execution time (Unix seconds). */
export interface ShellCommandRecord {
	command: string;
	timestamp: number;
}

/** Resolved shell history file plus the format to parse it as. */
export interface ShellHistoryFile {
	path: string;
	format: "zsh" | "bash";
}

/** Extended zsh history entry header: `: <start-time>:<elapsed>;<command>`. */
const ZSH_EXTENDED_RE = /^: ?(\d+):(\d*);(.*)$/;
/** Bash `HISTTIMEFORMAT` timestamp marker line: `#<epoch>`. */
const BASH_TIMESTAMP_RE = /^#(\d{9,})$/;

/**
 * Parse zsh history file content. Mirrors zsh's own reader: lines with an
 * extended-history header carry the entry timestamp, everything else is a
 * plain command, and each embedded newline of a multi-line command is stored
 * as `\` + newline (joined back here). Entries without a timestamp (extended
 * history off) fall back to `fallbackTimestampSeconds`.
 */
export function parseZshHistory(text: string, fallbackTimestampSeconds: number): ShellCommandRecord[] {
	const lines = text.split("\n");
	const records: ShellCommandRecord[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index++];
		if (line === "") continue;
		let timestamp = fallbackTimestampSeconds;
		let command: string;
		const extended = ZSH_EXTENDED_RE.exec(line);
		if (extended) {
			timestamp = Number(extended[1]);
			command = extended[3];
		} else {
			command = line;
		}
		while (command.endsWith("\\") && index < lines.length) {
			command = `${command.slice(0, -1)}\n${lines[index++]}`;
		}
		if (command.trim()) records.push({ command, timestamp });
	}
	return records;
}

/**
 * Parse bash history file content. With `HISTTIMEFORMAT` markers (`#<epoch>`
 * lines) each marker starts an entry and consecutive lines form one
 * (potentially multi-line) command; without markers every non-empty line is
 * one command.
 */
export function parseBashHistory(text: string, fallbackTimestampSeconds: number): ShellCommandRecord[] {
	const lines = text.split("\n");
	if (!lines.some(line => BASH_TIMESTAMP_RE.test(line))) {
		return lines.filter(line => line.trim()).map(command => ({ command, timestamp: fallbackTimestampSeconds }));
	}
	const records: ShellCommandRecord[] = [];
	let timestamp = fallbackTimestampSeconds;
	let command: string[] = [];
	const flush = () => {
		const joined = command.join("\n").trim();
		if (joined) records.push({ command: joined, timestamp });
		command = [];
	};
	for (const line of lines) {
		const marker = BASH_TIMESTAMP_RE.exec(line);
		if (marker) {
			flush();
			timestamp = Number(marker[1]);
			continue;
		}
		if (line === "" && command.length === 0) continue;
		command.push(line);
	}
	flush();
	return records;
}

/**
 * Resolve the user's shell history file. `HISTFILE` (when exported) wins;
 * otherwise the default path for `$SHELL`. Fish and unknown shells yield
 * `undefined` (callers fall back to session-only command history).
 */
export function resolveShellHistoryFile(env: NodeJS.ProcessEnv = process.env): ShellHistoryFile | undefined {
	const histfile = env.HISTFILE?.trim();
	const shellName = path.basename(env.SHELL?.trim() ?? "").toLowerCase();
	if (histfile) return { path: histfile, format: shellName.includes("bash") ? "bash" : "zsh" };
	if (shellName.includes("bash")) return { path: path.join(os.homedir(), ".bash_history"), format: "bash" };
	if (shellName.includes("zsh")) return { path: path.join(os.homedir(), ".zsh_history"), format: "zsh" };
	return undefined;
}

/** Cap on bytes read from the history file: only the tail is searched. */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** Safety bound on parsed entries kept in memory. */
const HISTORY_MAX_ENTRIES = 100_000;

interface ShellHistoryCache {
	file: ShellHistoryFile;
	size: number;
	mtimeMs: number;
	records: ShellCommandRecord[];
}

let shellHistoryCache: ShellHistoryCache | undefined;

/**
 * Load the user's shell history, newest-last. Reads at most the last
 * {@link HISTORY_TAIL_BYTES} of the file and caches by path + size + mtime so
 * repeated opens skip re-parsing (SHARE_HISTORY keeps appending, so the stat
 * check re-reads as soon as the file changes). Unreadable or missing files
 * yield an empty list.
 */
export async function loadShellCommandHistory(options?: { file?: ShellHistoryFile }): Promise<ShellCommandRecord[]> {
	const file = options?.file ?? resolveShellHistoryFile();
	if (!file) return [];
	try {
		const stat = await fs.stat(file.path);
		if (
			shellHistoryCache &&
			shellHistoryCache.file.path === file.path &&
			shellHistoryCache.file.format === file.format &&
			shellHistoryCache.size === stat.size &&
			shellHistoryCache.mtimeMs === stat.mtimeMs
		) {
			return shellHistoryCache.records;
		}
		const handle = Bun.file(file.path);
		const blob = stat.size > HISTORY_TAIL_BYTES ? handle.slice(stat.size - HISTORY_TAIL_BYTES) : handle;
		let text = await blob.text();
		if (stat.size > HISTORY_TAIL_BYTES) {
			// Drop the leading partial line left by the byte slice.
			const firstNewline = text.indexOf("\n");
			text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
		}
		const fallback = Math.floor(stat.mtimeMs / 1000);
		const parsed = file.format === "bash" ? parseBashHistory(text, fallback) : parseZshHistory(text, fallback);
		const records = parsed.length > HISTORY_MAX_ENTRIES ? parsed.slice(parsed.length - HISTORY_MAX_ENTRIES) : parsed;
		shellHistoryCache = { file, size: stat.size, mtimeMs: stat.mtimeMs, records };
		return records;
	} catch (error) {
		if (isEnoent(error)) return [];
		logger.warn("Failed to read shell history file", {
			path: file.path,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/** Commands executed via omp's `!` / `!!` on the current branch, oldest → newest. */
export function sessionBashCommands(sessionManager: SessionManager): ShellCommandRecord[] {
	const records: ShellCommandRecord[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "bashExecution") continue;
		records.push({ command: message.command, timestamp: Math.floor(message.timestamp / 1000) });
	}
	return records;
}

/**
 * Merge shell and session command histories into history-picker entries:
 * deduplicated by normalized command text (newest occurrence wins, carrying
 * its origin) and ordered newest first.
 */
export function mergeCommandHistories(shell: ShellCommandRecord[], session: ShellCommandRecord[]): HistoryEntry[] {
	const merged = new Map<string, HistoryEntry>();
	const add = (record: ShellCommandRecord, origin: "shell" | "omp") => {
		const key = record.command.replace(/\s+/g, " ").trim();
		if (!key) return;
		const existing = merged.get(key);
		if (existing && existing.created_at >= record.timestamp) return;
		merged.set(key, { id: 0, prompt: record.command, created_at: record.timestamp, origin });
	};
	for (const record of shell) add(record, "shell");
	for (const record of session) add(record, "omp");
	return [...merged.values()].sort((a, b) => b.created_at - a.created_at);
}

/**
 * History-search source over merged command history. Matches the
 * `HistoryStorage` contract: unique entries, every query token must appear
 * (case-insensitive substring), newest first.
 */
export class CommandHistorySource implements HistorySearchSource {
	#entries: HistoryEntry[];
	#searchText: string[];

	constructor(entries: HistoryEntry[]) {
		this.#entries = entries;
		this.#searchText = entries.map(entry => entry.prompt.toLowerCase());
	}

	getRecent(limit: number): HistoryEntry[] {
		return this.#entries.slice(0, Math.max(0, limit));
	}

	search(query: string, limit: number): HistoryEntry[] {
		const tokens = query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(token => token.length > 0);
		if (tokens.length === 0) return this.getRecent(limit);
		const out: HistoryEntry[] = [];
		for (let i = 0; i < this.#entries.length && out.length < limit; i++) {
			if (tokens.every(token => this.#searchText[i].includes(token))) out.push(this.#entries[i]);
		}
		return out;
	}
}

/**
 * Build the command-history source for the bash-mode history picker: the
 * user's shell history merged with this session's `!` / `!!` commands. Never
 * throws — a missing history file degrades to session-only entries.
 */
export async function createCommandHistorySource(
	sessionManager: SessionManager,
	options?: { file?: ShellHistoryFile },
): Promise<CommandHistorySource> {
	const shell = await loadShellCommandHistory(options);
	return new CommandHistorySource(mergeCommandHistories(shell, sessionBashCommands(sessionManager)));
}
