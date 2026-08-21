import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type KeyId, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "../src/extensibility/extensions";
import { initTheme } from "../src/modes/theme/theme";
import { createWorkspaceInspectorExtension } from "../src/workspace-inspector";
import { WorkspaceInspectorComponent } from "../src/workspace-inspector/component";
import { loadCommitDiff, loadDiff, loadHistory, loadWorkspaceSnapshot } from "../src/workspace-inspector/git-snapshot";

const tempDirs: string[] = [];

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(await new Response(proc.stderr).text());
	}
}

async function createRepository(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-inspector-"));
	tempDirs.push(cwd);
	await runGit(cwd, ["init", "-q"]);
	await runGit(cwd, ["config", "user.name", "Inspector Test"]);
	await runGit(cwd, ["config", "user.email", "inspector@example.test"]);
	await Bun.write(path.join(cwd, "modified.ts"), "export const value = 1;\n");
	await Bun.write(path.join(cwd, "old.ts"), "export const oldName = 1;\n");
	await runGit(cwd, ["add", "."]);
	await runGit(cwd, ["commit", "-qm", "initial workspace"]);
	return cwd;
}

beforeAll(async () => {
	await initTheme(false, "unicode", false, "dark", "light");
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

describe("workspace inspector", () => {
	it("registers the changes command and Alt+G shortcut", () => {
		const commands: string[] = [];
		const shortcuts: string[] = [];
		createWorkspaceInspectorExtension({
			registerCommand: (name: string) => commands.push(name),
			registerShortcut: (shortcut: KeyId) => shortcuts.push(shortcut),
		} as unknown as ExtensionAPI);
		expect(commands).toEqual(["changes"]);
		expect(shortcuts).toEqual(["alt+g"]);
	});

	it("reports staged, unstaged, renamed, and untracked working-tree changes", async () => {
		const cwd = await createRepository();
		await Bun.write(path.join(cwd, "modified.ts"), "export const value = 2;\n");
		await runGit(cwd, ["add", "modified.ts"]);
		await fs.appendFile(path.join(cwd, "modified.ts"), "export const tail = true;\n");
		await runGit(cwd, ["mv", "old.ts", "renamed.ts"]);
		await Bun.write(path.join(cwd, "untracked.ts"), "export const fresh = true;\n");

		const result = await loadWorkspaceSnapshot(cwd);
		expect(result.error).toBeUndefined();
		expect(result.snapshot?.branch).toBe("master");
		expect(result.snapshot?.changes).toEqual([
			{ additions: 2, deletions: 1, index: "M", oldPath: undefined, path: "modified.ts", worktree: "M" },
			{ additions: 0, deletions: 0, index: "R", oldPath: "old.ts", path: "renamed.ts", worktree: " " },
			{ additions: 0, deletions: 0, index: "?", oldPath: undefined, path: "untracked.ts", worktree: "?" },
		]);
	});

	it("loads untracked diffs and commit history without mutating the repository", async () => {
		const cwd = await createRepository();
		await Bun.write(path.join(cwd, "untracked.ts"), "export const fresh = true;\n");
		const snapshot = await loadWorkspaceSnapshot(cwd);
		const untracked = snapshot.snapshot?.changes.find(change => change.path === "untracked.ts");
		expect(untracked).toBeDefined();

		const diff = await loadDiff(cwd, untracked!);
		expect(diff).toContain("+export const fresh = true;");
		const history = await loadHistory(cwd);
		expect(history[0]?.subject).toBe("initial workspace");
		const commitDiff = await loadCommitDiff(cwd, history[0]!.sha);
		expect(commitDiff).toContain("+export const value = 1;");
	});

	it("renders a complete fullscreen frame with equal-width rows", async () => {
		const cwd = await createRepository();
		await Bun.write(path.join(cwd, "untracked.ts"), "export const fresh = true;\n");
		let renderRequests = 0;
		const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
		const component = await WorkspaceInspectorComponent.create({
			cwd,
			tui,
			onClose: () => {},
			notify: () => {},
			select: async (_title, options) => options[0],
		});
		try {
			const frame = component.render(100);
			expect(frame).toHaveLength(Math.max(16, process.stdout.rows || 40));
			expect(frame.every(line => visibleWidth(line) === 100)).toBe(true);
			expect(frame.join("\n")).toContain("Workspace Inspector · Changes");
			expect(frame.join("\n")).toContain("untracked.ts");
			expect(renderRequests).toBeGreaterThan(0);
		} finally {
			component.dispose();
		}
	});
});
