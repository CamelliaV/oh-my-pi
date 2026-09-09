import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deleteManagedSkill, writeManagedSkill } from "../src/autolearn/managed-skills";
import { WikiSkills } from "../src/wiki/skills";
import { WikiStore } from "../src/wiki/store";
import type { WikiComplete, WikiPage, WikiSkillDraft, WikiSource } from "../src/wiki/types";

const evaluatorSource = `
import * as fs from "node:fs/promises";
import * as vm from "node:vm";
const input = JSON.parse(await fs.readFile(process.env.OMP_WIKI_SKILL_INPUT, "utf8"));
if (process.env.HOME !== process.cwd()) process.exit(41);
async function score(file) {
  const text = await fs.readFile(file, "utf8");
  const code = text.match(/\x60\x60\x60js\\n([^]*?)\\n\x60\x60\x60/);
  const normalize = code ? vm.runInNewContext("(" + code[1] + ")", {}, {timeout: 100}) : value => value;
  const cases = [["  ALPHA  ", "alpha"], [" Beta ", "beta"], ["GAMMA", "gamma"]];
  return cases.filter(([value, expected]) => normalize(value) === expected).length;
}
const baseline = await score(input.baseline.path);
const candidate = await score(input.candidate.path);
await fs.writeFile(process.env.OMP_WIKI_SKILL_OUTPUT, JSON.stringify({baseline, candidate, report: candidate + "/3 identifier cases passed"}));
`;

function procedure(expression = "value => value.trim().toLowerCase()"): string {
	return `## Applicability\nUse only for whitespace-normalized, case-insensitive identifier matching.\n\n## Procedure\n\`\`\`js\n${expression}\n\`\`\``;
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		},
	);
}

async function waitForFile(file: string): Promise<string> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try {
			const text = await fs.readFile(file, "utf8");
			if (text.length > 0) return text;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Evaluator did not become ready: ${file}`);
}

describe("Wiki skill publication gates", () => {
	let temporary: string;
	let root: string;
	let agentDir: string;
	let store: WikiStore;
	let source: WikiSource;
	let page: WikiPage;
	let skills: WikiSkills;
	let drafts: WikiSkillDraft[];
	let evaluator: string[];
	let complete: WikiComplete;

	beforeEach(async () => {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wiki-skills-"));
		root = path.join(temporary, "wiki");
		agentDir = path.join(temporary, "agent");
		store = new WikiStore({ root });
		await store.open();
		source = await store.capture({ content: `Identifier matching procedure:\n${procedure()}` });
		await store.publish(await store.snapshot(), {
			pages: [
				{
					id: "w-identifiers",
					expectedRevision: null,
					title: "Identifier matching",
					summary: "Normalize identifier input.",
					body: procedure(),
					kind: "pattern",
					status: "active",
					sources: [{ id: source.id, revision: source.revision }],
					links: [],
				},
			],
			processed: [{ id: source.id, revision: source.revision }],
		});
		page = (await store.snapshot()).pages[0]!;
		drafts = [
			{
				name: "wiki-test-identifiers",
				description: "Normalize identifiers for case-insensitive matching.",
				body: procedure(),
				reason: "Reusable identifier comparison procedure.",
				pages: [{ id: page.id, revision: page.revision }],
			},
		];
		complete = async () => JSON.stringify({ candidates: drafts });
		skills = new WikiSkills({ root, agentDir, complete: request => complete(request) });
		const script = path.join(temporary, "evaluate.mjs");
		await fs.writeFile(script, evaluatorSource);
		evaluator = [process.execPath, script];
	});

	afterEach(async () => {
		store?.close();
		await fs.rm(temporary, { recursive: true, force: true });
	});

	const skillPath = () => path.join(agentDir, "managed-skills", "wiki-test-identifiers", "SKILL.md");
	const evaluations = async () =>
		(await fs.readdir(path.join(root, "skills"))).filter(name => name.startsWith("eval-"));

	it("keeps proposals inert and publishes only a successful behavioral improvement", async () => {
		const [candidate] = await skills.propose([page]);
		expect(candidate!.status).toBe("pending");
		expect(await exists(skillPath())).toBe(false);
		const accepted = await skills.validate(candidate!.id, evaluator);
		expect(accepted.status).toBe("accepted");
		expect(accepted.validation).toMatchObject({ kind: "behavioral", baseline: 0, candidate: 3 });
		const content = await fs.readFile(skillPath(), "utf8");
		expect(content).toContain(procedure());
		expect(accepted.publishedHash).toBe(createHash("sha256").update(content).digest("hex"));
		expect(await evaluations()).toEqual([]);
		const reopened = new WikiSkills({ root, agentDir, complete });
		expect((await reopened.list())[0]?.status).toBe("accepted");
	});

	it("rejects equal scores, keeps source knowledge, and suppresses repeated rejected bodies under new names", async () => {
		drafts[0]!.body = procedure("value => value");
		const [candidate] = await skills.propose([page]);
		const rejected = await skills.validate(candidate!.id, evaluator);
		expect(rejected.status).toBe("rejected");
		expect(rejected.validation).toMatchObject({ kind: "behavioral", baseline: 0, candidate: 0 });
		expect(await exists(skillPath())).toBe(false);
		expect(await store.read(source.id)).toMatchObject({ status: "active", content: source.content });
		expect(await store.read(page.id)).toMatchObject({ status: "active", body: page.body });
		drafts[0]!.name = "wiki-test-renamed-identifiers";
		const reopened = new WikiSkills({ root, agentDir, complete });
		expect(await reopened.propose([page])).toEqual([]);
	});

	it("publishes manual approval without fabricating evaluation scores and supports hash-owned updates", async () => {
		drafts[0]!.body = procedure("value => value");
		const [first] = await skills.propose([page]);
		const approved = await skills.approve(first!.id);
		expect(approved.status).toBe("accepted");
		expect(approved.validation?.kind).toBe("manual");
		expect(approved.validation?.baseline).toBeUndefined();
		expect(approved.validation?.candidate).toBeUndefined();
		drafts[0]!.body = procedure();
		const [second] = await skills.propose([page]);
		const updated = await skills.validate(second!.id, evaluator);
		expect(updated.status).toBe("accepted");
		expect(updated.validation).toMatchObject({ kind: "behavioral", baseline: 0, candidate: 3 });
		expect(await fs.readFile(skillPath(), "utf8")).toContain(`wiki-skill:${second!.id}`);
		const firstAfter = (await skills.list()).find(item => item.id === first!.id)!;
		expect(firstAfter.status).toBe("invalidated");
		expect(firstAfter.publishedHash).toBeUndefined();
	});

	it("rejects an accepted skill explicitly while preserving its Wiki evidence and user-added resources", async () => {
		const [candidate] = await skills.propose([page]);
		await skills.approve(candidate!.id);
		const resource = path.join(path.dirname(skillPath()), "user-data.txt");
		await fs.writeFile(resource, "keep this resource");
		expect((await skills.reject(candidate!.id, "Procedure is no longer useful")).status).toBe("rejected");
		expect(await exists(skillPath())).toBe(false);
		expect(await fs.readFile(resource, "utf8")).toBe("keep this resource");
		expect(await store.read(page.id)).toMatchObject({ status: "active", body: page.body });
	});

	it("does not publish when a successful-looking evaluator exits nonzero or returns non-finite scores", async () => {
		const [candidate] = await skills.propose([page]);
		const failing = path.join(temporary, "failing.mjs");
		await fs.writeFile(failing, `${evaluatorSource}\nprocess.exit(17);\n`);
		await expect(skills.validate(candidate!.id, [process.execPath, failing])).rejects.toThrow("exited with code 17");
		const nonfinite = path.join(temporary, "nonfinite.mjs");
		await fs.writeFile(
			nonfinite,
			`await Bun.write(process.env.OMP_WIKI_SKILL_OUTPUT, '{"baseline":0,"candidate":1e999,"report":"overflow"}');`,
		);
		await expect(skills.validate(candidate!.id, [process.execPath, nonfinite])).rejects.toThrow("finite");
		expect((await skills.list())[0]?.status).toBe("pending");
		expect(await exists(skillPath())).toBe(false);
		expect(await evaluations()).toEqual([]);
	});

	it("requires configured argv and removes a timed-out evaluation workspace", async () => {
		const [candidate] = await skills.propose([page]);
		await expect(skills.validate(candidate!.id, [])).rejects.toThrow("trusted Wiki skill evaluator argv");
		const hanging = path.join(temporary, "hanging.mjs");
		await fs.writeFile(hanging, "setInterval(() => {}, 1000);");
		const bounded = new WikiSkills({ root, agentDir, complete, evaluatorTimeoutMs: 100 });
		await expect(bounded.validate(candidate!.id, [process.execPath, hanging])).rejects.toThrow("timed out");
		expect((await skills.list())[0]?.status).toBe("pending");
		expect(await exists(skillPath())).toBe(false);
		expect(await evaluations()).toEqual([]);
	});

	it("cancels and reaps the evaluator child before removing its private workspace", async () => {
		const [candidate] = await skills.propose([page]);
		const ready = path.join(temporary, "ready.json");
		const hanging = path.join(temporary, "cancel.mjs");
		await fs.writeFile(
			hanging,
			`await Bun.write(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,cwd:process.cwd()})); setInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const running = skills.validate(candidate!.id, [process.execPath, hanging], controller.signal);
		void running.catch(() => {});
		try {
			const child = JSON.parse(await waitForFile(ready)) as { pid: number; cwd: string };
			controller.abort();
			await expect(running).rejects.toThrow("cancelled");
			expect(await exists(child.cwd)).toBe(false);
			expect(() => process.kill(child.pid, 0)).toThrow();
		} finally {
			controller.abort();
			await running.catch(() => {});
		}
		expect(await exists(skillPath())).toBe(false);
	});

	it("rejects evaluator mutation of read-only input fixtures even after a passing score", async () => {
		const [candidate] = await skills.propose([page]);
		const tampering = path.join(temporary, "tampering.mjs");
		await fs.writeFile(
			tampering,
			`${evaluatorSource}\nawait fs.chmod(input.candidate.path, 0o600); await fs.writeFile(input.candidate.path, "changed");`,
		);
		await expect(skills.validate(candidate!.id, [process.execPath, tampering])).rejects.toThrow("immutable fixtures");
		expect(await exists(skillPath())).toBe(false);
		expect(await evaluations()).toEqual([]);
	});

	it("retracts a source-invalidated publication and refuses stale pending approval", async () => {
		const [accepted] = await skills.propose([page]);
		await skills.approve(accepted!.id);
		drafts[0]!.body = procedure("value => value.trim()");
		const [pending] = await skills.propose([page]);
		await store.mutate(source.id, { op: "invalidate" });
		await skills.reconcile((await store.snapshot()).pages);
		expect(await exists(skillPath())).toBe(false);
		expect((await skills.list()).map(item => item.status)).toEqual(["invalidated", "invalidated"]);
		await expect(skills.approve(pending!.id)).rejects.toThrow("invalidated");
	});

	it("rechecks source revisions after model and evaluator work without holding the store lock across either", async () => {
		complete = async () => {
			await store.mutate(source.id, { op: "update", content: "Corrected identifier procedure." });
			return JSON.stringify({ candidates: drafts });
		};
		expect(await skills.propose([page])).toEqual([]);
		// Restore a current supported pattern to exercise the independent evaluator boundary.
		source = (await store.read(source.id)) as WikiSource;
		await store.publish(await store.snapshot(), {
			pages: [
				{
					id: "w-identifiers-current",
					expectedRevision: null,
					title: "Current identifier procedure",
					summary: "Current normalization.",
					body: procedure(),
					kind: "pattern",
					status: "active",
					sources: [{ id: source.id, revision: source.revision }],
					links: [],
				},
			],
			processed: [{ id: source.id, revision: source.revision }],
		});
		page = (await store.snapshot()).pages.find(item => item.id === "w-identifiers-current")!;
		drafts[0]!.pages = [{ id: page.id, revision: page.revision }];
		complete = async () => JSON.stringify({ candidates: drafts });
		const [candidate] = await skills.propose([page]);
		const ready = path.join(temporary, "evaluator-ready");
		const proceed = path.join(temporary, "evaluator-proceed");
		const controlled = path.join(temporary, "controlled.mjs");
		await fs.writeFile(
			controlled,
			`await Bun.write(${JSON.stringify(ready)}, "ready"); while (!(await Bun.file(${JSON.stringify(proceed)}).exists())) await Bun.sleep(10);\n${evaluatorSource}`,
		);
		const running = skills.validate(candidate!.id, [process.execPath, controlled]);
		void running.catch(() => {});
		try {
			await waitForFile(ready);
			await store.mutate(source.id, { op: "update", content: "This procedure was superseded during evaluation." });
		} finally {
			await fs.writeFile(proceed, "continue");
		}
		await expect(running).rejects.toThrow("invalidated");
		expect(await exists(skillPath())).toBe(false);
		expect(await evaluations()).toEqual([]);
	});

	it("protects authored frontmatter names and unrelated managed skills introduced after proposal", async () => {
		const [candidate] = await skills.propose([page]);
		const authoredDir = path.join(agentDir, "skills", "different-directory");
		await fs.mkdir(authoredDir, { recursive: true });
		const authoredPath = path.join(authoredDir, "SKILL.md");
		const authored =
			"---\nname: wiki-test-identifiers\ndescription: User-authored procedure\n---\nKeep the author's content.\n";
		await fs.writeFile(authoredPath, authored);
		await expect(skills.approve(candidate!.id)).rejects.toThrow("authored skill");
		await expect(skills.validate(candidate!.id, evaluator)).rejects.toThrow("authored skill");
		expect(await fs.readFile(authoredPath, "utf8")).toBe(authored);
		await fs.rm(authoredDir, { recursive: true });
		await writeManagedSkill({
			action: "create",
			agentDir,
			name: drafts[0]!.name,
			description: "Unrelated managed skill",
			body: "Keep this unrelated body.",
		});
		const unrelated = await fs.readFile(skillPath(), "utf8");
		await expect(skills.approve(candidate!.id)).rejects.toThrow("unrelated");
		await expect(skills.validate(candidate!.id, evaluator)).rejects.toThrow("unrelated");
		expect(await fs.readFile(skillPath(), "utf8")).toBe(unrelated);
	});

	it("preserves a user's later edits through update attempts and source invalidation", async () => {
		const [first] = await skills.propose([page]);
		await skills.approve(first!.id);
		drafts[0]!.body = procedure("value => value.trim()");
		const [second] = await skills.propose([page]);
		const edited = "User rewrote this managed file; it is no longer Wiki-owned content.\n";
		await fs.writeFile(skillPath(), edited);
		await expect(skills.approve(second!.id)).rejects.toThrow("user-edited");
		await store.mutate(source.id, { op: "forget" });
		await skills.reconcile((await store.snapshot()).pages);
		expect(await fs.readFile(skillPath(), "utf8")).toBe(edited);
		expect((await skills.list()).every(item => item.status === "invalidated")).toBe(true);
	});

	it("persists sanitized proposals and outcomes while rejecting invented references and missing applicability", async () => {
		const secret = "sk_test_abcdefghijklmnopqrstuvwxyz";
		drafts[0]!.body += `\nExample key: ${secret}`;
		const [candidate] = await skills.propose([page]);
		await skills.reject(candidate!.id, `Not reusable; password=${secret}`);
		const saved = await fs.readFile(path.join(root, "skills", "candidates.json"), "utf8");
		const log = await fs.readFile(path.join(root, "skills", "outcomes.jsonl"), "utf8");
		expect(saved).not.toContain(secret);
		expect(log).not.toContain(secret);
		expect((await skills.list())[0]?.reason).toContain("[REDACTED]");
		drafts = [
			{
				...drafts[0]!,
				name: "wiki-test-invented",
				body: procedure("value => value.trim()"),
				pages: [{ id: "w-invented", revision: 1 }],
			},
			{ ...drafts[0]!, name: "wiki-test-unscoped", body: "Apply everywhere without a scope." },
		];
		expect(await skills.propose([page])).toEqual([]);
	});

	it("enforces expected hashes in the shared write and delete primitives", async () => {
		await writeManagedSkill({
			action: "create",
			agentDir,
			name: drafts[0]!.name,
			description: "Owned baseline",
			body: "original",
		});
		const expectedHash = createHash("sha256")
			.update(await fs.readFile(skillPath()))
			.digest("hex");
		await fs.writeFile(skillPath(), "User replacement");
		await expect(
			writeManagedSkill({
				action: "update",
				agentDir,
				expectedHash,
				name: drafts[0]!.name,
				description: "New body",
				body: "replacement",
			}),
		).rejects.toThrow("changed since publication");
		await expect(deleteManagedSkill(drafts[0]!.name, { agentDir, expectedHash })).rejects.toThrow(
			"changed since publication",
		);
		expect(await fs.readFile(skillPath(), "utf8")).toBe("User replacement");
	});

	it("purges copied content from pending, rejected, and published candidates after source disappearance", async () => {
		const forgotten = "private-orchid-procedure";
		drafts[0]!.reason = `Use the ${forgotten} procedure.`;
		drafts[0]!.body += `\n${forgotten}`;
		const [pending] = await skills.propose([page]);
		drafts[0]!.name = "wiki-test-rejected-orchid";
		drafts[0]!.body = `${procedure("value => value")}\n${forgotten}`;
		const [rejected] = await skills.propose([page]);
		await skills.reject(rejected!.id, `${forgotten} does not generalize.`);
		drafts[0]!.name = "wiki-test-published-orchid";
		drafts[0]!.body = `${procedure("value => value.trim()")}\n${forgotten}`;
		const [published] = await skills.propose([page]);
		await skills.approve(published!.id);
		await store.mutate(source.id, { op: "forget" });
		await skills.reconcile((await store.snapshot()).pages);
		const listed = await skills.list();
		expect(listed.find(item => item.id === pending!.id)?.status).toBe("invalidated");
		expect(listed.find(item => item.id === rejected!.id)?.status).toBe("rejected");
		expect(listed.find(item => item.id === published!.id)?.status).toBe("invalidated");
		expect(listed.every(item => item.body === "" && item.description === "" && item.name === "")).toBe(true);
		expect(JSON.stringify(listed)).not.toContain(forgotten);
		expect(await fs.readFile(path.join(root, "skills", "candidates.json"), "utf8")).not.toContain(forgotten);
		expect(await fs.readFile(path.join(root, "skills", "outcomes.jsonl"), "utf8")).not.toContain(forgotten);
		expect(await exists(path.join(agentDir, "managed-skills", "wiki-test-published-orchid", "SKILL.md"))).toBe(false);
	});

	it("clears candidate history and owned publications without deleting user-edited or unrelated skills", async () => {
		const [owned] = await skills.propose([page]);
		await skills.approve(owned!.id);
		drafts[0]!.name = "wiki-test-user-edited";
		drafts[0]!.body = procedure("value => value.trim()");
		const [edited] = await skills.propose([page]);
		await skills.approve(edited!.id);
		const editedPath = path.join(agentDir, "managed-skills", "wiki-test-user-edited", "SKILL.md");
		await fs.writeFile(editedPath, "Keep the user's later rewrite.");
		await writeManagedSkill({
			action: "create",
			agentDir,
			name: "wiki-test-unrelated",
			description: "Unrelated",
			body: "Keep unrelated content.",
		});
		await skills.clear();
		expect(await exists(path.join(root, "skills"))).toBe(false);
		expect(await exists(skillPath())).toBe(false);
		expect(await fs.readFile(editedPath, "utf8")).toBe("Keep the user's later rewrite.");
		expect(
			await fs.readFile(path.join(agentDir, "managed-skills", "wiki-test-unrelated", "SKILL.md"), "utf8"),
		).toContain("Keep unrelated content.");
		expect(await store.read(source.id)).toMatchObject({ status: "active", content: source.content });
		expect(await skills.list()).toEqual([]);
	});

	it("does not resurrect an in-flight proposal after another instance clears the skill store", async () => {
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>(resolve => {
			started = resolve;
		});
		const wait = new Promise<void>(resolve => {
			release = resolve;
		});
		complete = async () => {
			started();
			await wait;
			return JSON.stringify({ candidates: drafts });
		};
		const running = skills.propose([page]);
		void running.catch(() => {});
		try {
			await entered;
			await new WikiSkills({ root, agentDir, complete }).clear();
		} finally {
			release();
		}
		await expect(running).rejects.toThrow("cleared during proposal");
		expect(await skills.list()).toEqual([]);
		expect(await exists(skillPath())).toBe(false);
	});
});
