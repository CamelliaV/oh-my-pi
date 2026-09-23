import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import * as vcs from "@oh-my-pi/pi-natives/vcs";

import type { ActiveRepoContext } from "@oh-my-pi/pi-tui/status-line/host";

function compareEntryNames(left: fs.Dirent, right: fs.Dirent): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function buildContext(cwd: string, repoRoot: string): ActiveRepoContext {
	const resolvedCwd = path.resolve(cwd);
	const resolvedRepoRoot = path.resolve(repoRoot);
	return {
		cwd: resolvedCwd,
		repoRoot: resolvedRepoRoot,
		relativeRepoRoot: path.relative(resolvedCwd, resolvedRepoRoot),
		source: "single-direct-child-repo",
	};
}

/** Whether `cwd` already sits inside a VCS repository. */
function insideRepository(cwd: string): boolean {
	try {
		return vcs.repo(cwd) !== null;
	} catch {
		return false;
	}
}

async function readDirectChildren(cwd: string): Promise<fs.Dirent[]> {
	try {
		const entries = await fsPromises.readdir(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch {
		return [];
	}
}

function readDirectChildrenSync(cwd: string): fs.Dirent[] {
	try {
		const entries = fs.readdirSync(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch {
		return [];
	}
}

async function resolveDirectChildDirectory(cwd: string, entry: fs.Dirent): Promise<string | null> {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = await fsPromises.stat(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		return null;
	}
}

function resolveDirectChildDirectorySync(cwd: string, entry: fs.Dirent): string | null {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = fs.statSync(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		return null;
	}
}

async function hasGitRepository(childPath: string): Promise<boolean> {
	try {
		// Skip markerless siblings before native discovery can walk their ancestors.
		const stat = await fsPromises.stat(path.join(childPath, ".git"));
		if (!stat.isDirectory() && !stat.isFile()) return false;
		const info = vcs.gitInfo(childPath);
		// Resolve gitfiles through the shared parser, but never adopt an ancestor.
		if (!info || path.resolve(info.repoRoot) !== childPath) return false;
		return (await fsPromises.stat(info.headPath)).isFile();
	} catch {
		return false;
	}
}

function hasGitRepositorySync(childPath: string): boolean {
	try {
		const stat = fs.statSync(path.join(childPath, ".git"));
		if (!stat.isDirectory() && !stat.isFile()) return false;
		const info = vcs.gitInfo(childPath);
		if (!info || path.resolve(info.repoRoot) !== childPath) return false;
		return fs.statSync(info.headPath).isFile();
	} catch {
		return false;
	}
}

async function findSingleDirectChildRepo(cwd: string): Promise<ActiveRepoContext | null> {
	let context: ActiveRepoContext | null = null;
	for (const entry of await readDirectChildren(cwd)) {
		const childPath = await resolveDirectChildDirectory(cwd, entry);
		if (!childPath) continue;
		if (!(await hasGitRepository(childPath))) continue;
		if (context) return null;
		context = buildContext(cwd, childPath);
	}
	return context;
}

function findSingleDirectChildRepoSync(cwd: string): ActiveRepoContext | null {
	let context: ActiveRepoContext | null = null;
	for (const entry of readDirectChildrenSync(cwd)) {
		const childPath = resolveDirectChildDirectorySync(cwd, entry);
		if (!childPath) continue;
		if (!hasGitRepositorySync(childPath)) continue;
		if (context) return null;
		context = buildContext(cwd, childPath);
	}
	return context;
}

export async function resolveActiveRepoContext(cwd: string): Promise<ActiveRepoContext | null> {
	const resolvedCwd = path.resolve(cwd);
	if (insideRepository(resolvedCwd)) return null;
	return findSingleDirectChildRepo(resolvedCwd);
}

export function resolveActiveRepoContextSync(cwd: string): ActiveRepoContext | null {
	const resolvedCwd = path.resolve(cwd);
	if (insideRepository(resolvedCwd)) return null;
	return findSingleDirectChildRepoSync(resolvedCwd);
}

/**
 * Fire-and-forget warm-up of the working-tree status scan for the repository
 * the status line will target (the same `vcs.repo(projectDir)` →
 * `resolveActiveRepoContextSync` fallback it uses). The interactive status
 * bar fetches its counts lazily on the first paint; a cold scan (index load +
 * worktree lstat storm) runs well over 100ms on real repos, so the counts
 * always landed one repaint late. Paying the cold scan during startup —
 * parallel with session construction, on the natives blocking pool — leaves
 * the status line's first paint a warm handoff or, at worst, a warm re-scan.
 */
interface PrewarmedVcsStatus {
	root: string;
	status: { staged: number; unstaged: number; untracked: number };
	fetchedAt: number;
}

/** One-shot slot for the startup prewarm scan, consumed by the status line's
 * first `#getStatus` via {@link takePrewarmedVcsStatus}. */
let prewarmedVcsStatus: PrewarmedVcsStatus | undefined;

/** How long a prewarmed scan stays adoptable — generous vs the status line's
 * 1s cache TTL so slow startups can still hand the value off. */
const PREWARMED_STATUS_TTL_MS = 1500;

export async function prewarmVcsStatusScan(cwd: string): Promise<void> {
	try {
		let repository = vcs.repo(cwd);
		if (!repository) {
			const context = resolveActiveRepoContextSync(cwd);
			if (context) repository = vcs.repo(context.repoRoot);
		}
		if (!repository) return;
		const root = repository.root();
		const status = await repository.statusSummary();
		prewarmedVcsStatus = { root, status, fetchedAt: Date.now() };
	} catch {
		// Best-effort warm-up only; the status line refetches on its own schedule.
	}
}

/**
 * One-shot handoff of the prewarmed working-tree status, keyed by repository
 * root so a session that switched projects at startup never adopts another
 * repo's counts. Adopting the value lets the status line's FIRST paint carry
 * the staged/unstaged/untracked counts instead of launching its own async
 * scan and waiting for a repaint while startup initialization monopolizes the
 * event loop. Expired or foreign-root entries return `undefined`.
 */
export function takePrewarmedVcsStatus(
	root: string,
): { staged: number; unstaged: number; untracked: number } | undefined {
	const entry = prewarmedVcsStatus;
	if (entry === undefined) return undefined;
	prewarmedVcsStatus = undefined;
	if (entry.root !== root || Date.now() - entry.fetchedAt > PREWARMED_STATUS_TTL_MS) return undefined;
	return entry.status;
}
