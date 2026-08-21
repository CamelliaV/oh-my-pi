import * as path from "node:path";
import * as git from "../utils/git";

export interface WorkspaceChange {
	path: string;
	oldPath?: string;
	index: string;
	worktree: string;
	additions: number;
	deletions: number;
}

export interface WorkspaceSnapshot {
	branch: string;
	head: string | null;
	changes: WorkspaceChange[];
}

export interface HistoryEntry {
	sha: string;
	subject: string;
}

export interface GitSnapshotResult {
	snapshot: WorkspaceSnapshot | null;
	error?: string;
}
interface StatusEntry {
	index: string;
	worktree: string;
	path: string;
	oldPath?: string;
}

function parseDetailedStatus(text: string): StatusEntry[] {
	const fields = text.split("\0");
	const entries: StatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const status = field.slice(0, 2);
		const filePath = field.slice(3);
		const isRename = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
		if (isRename && fields[index + 1]) {
			entries.push({
				index: status[0] ?? " ",
				worktree: status[1] ?? " ",
				path: filePath,
				oldPath: fields[index + 1],
			});
			index += 1;
			continue;
		}
		entries.push({ index: status[0] ?? " ", worktree: status[1] ?? " ", path: filePath });
	}
	return entries;
}

function parseOneline(line: string): HistoryEntry | null {
	const match = line.match(/^([0-9a-f]+)\s+(.+)$/i);
	return match ? { sha: match[1], subject: match[2] } : null;
}

/** Read-only Git state used by the workspace inspector. */
export async function loadWorkspaceSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshotResult> {
	try {
		const [statusText, head, numstat] = await Promise.all([
			git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true, signal }),
			git.head.resolve(cwd, signal),
			git.diff.numstat(cwd, { allowFailure: true, base: "HEAD", signal }),
		]);
		const entries = parseDetailedStatus(statusText);
		const counts = new Map(numstat.map(entry => [entry.path, entry]));
		const changes = entries
			.map(entry => {
				const count = counts.get(entry.path) ?? { additions: 0, deletions: 0 };
				return {
					path: entry.path,
					oldPath: entry.oldPath,
					index: entry.index,
					worktree: entry.worktree,
					additions: count.additions,
					deletions: count.deletions,
				};
			})
			.sort((left, right) => left.path.localeCompare(right.path));
		return {
			snapshot: {
				branch: head?.kind === "ref" ? (head.branchName ?? head.ref) : "(detached)",
				head: head?.commit ? head.commit.slice(0, 8) : null,
				changes,
			},
		};
	} catch (error) {
		return {
			snapshot: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function loadHistory(cwd: string, limit = 50, signal?: AbortSignal): Promise<HistoryEntry[]> {
	const lines = await git.log.onelines(cwd, limit, signal);
	return lines.map(parseOneline).filter((entry): entry is HistoryEntry => entry !== null);
}

export async function loadDiff(cwd: string, change: WorkspaceChange, signal?: AbortSignal): Promise<string> {
	if (change.index === "?" && change.worktree === "?") {
		return git.diff(cwd, {
			allowFailure: true,
			noIndex: { left: "/dev/null", right: path.resolve(cwd, change.path) },
			signal,
		});
	}
	return git.diff(cwd, { allowFailure: true, base: "HEAD", files: [change.path], signal });
}

export async function loadCommitDiff(cwd: string, sha: string, signal?: AbortSignal): Promise<string> {
	return git.show(cwd, sha, { signal });
}
