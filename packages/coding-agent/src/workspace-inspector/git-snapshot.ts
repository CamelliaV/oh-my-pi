import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

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

/** Read-only Git state used by the workspace inspector. */
export async function loadWorkspaceSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshotResult> {
	try {
		const repository = vcs.git(cwd);
		if (!repository) return { snapshot: null, error: "not a git repository" };
		const [statusText, head, numstat] = await Promise.all([
			repository.statusPorcelain({ untracked: "all", nulTerminated: true }, signal),
			repository.head(signal),
			// An unborn HEAD (fresh repository) has no diff base; the old
			// allowFailure option became a caught VcsError here.
			repository.numstat({ base: "HEAD" }, signal).catch(error => {
				if (vcs.isVcsError(error)) return [];
				throw error;
			}),
		]);
		const entries = parseDetailedStatus(statusText);
		const counts = new Map(numstat.map(entry => [entry.path, entry]));
		const changes = entries
			.map(entry => {
				const count = counts.get(entry.path);
				return {
					path: entry.path,
					oldPath: entry.oldPath,
					index: entry.index,
					worktree: entry.worktree,
					additions: count?.added ?? 0,
					deletions: count?.removed ?? 0,
				};
			})
			.sort((left, right) => left.path.localeCompare(right.path));
		return {
			snapshot: {
				branch: head.kind === "ref" ? (head.branch ?? head.refName ?? "HEAD") : "(detached)",
				head: head.commit ? head.commit.slice(0, 8) : null,
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
	const repository = vcs.git(cwd);
	if (!repository) return [];
	const lines = await repository.logOnelines(limit, signal);
	return lines
		.map(line => line.match(/^([0-9a-f]+)\s+(.+)$/i))
		.filter((match): match is RegExpMatchArray => match !== null)
		.map(match => ({ sha: match[1], subject: match[2] }));
}

export async function loadDiff(cwd: string, change: WorkspaceChange, signal?: AbortSignal): Promise<string> {
	const repository = vcs.git(cwd);
	if (!repository) return "";
	if (change.index === "?" && change.worktree === "?") {
		return repository.diffNoIndex("/dev/null", path.resolve(cwd, change.path), false, signal);
	}
	try {
		return await repository.diffText({ base: "HEAD", files: [change.path] }, signal);
	} catch (error) {
		// An unborn HEAD has nothing to diff against; the old allowFailure
		// option became a caught VcsError here.
		if (vcs.isVcsError(error)) return "";
		throw error;
	}
}

export async function loadCommitDiff(cwd: string, sha: string, signal?: AbortSignal): Promise<string> {
	const repository = vcs.git(cwd);
	if (!repository) return "";
	const result = await repository.showCommit(sha, undefined, signal);
	return result.data.toString();
}
