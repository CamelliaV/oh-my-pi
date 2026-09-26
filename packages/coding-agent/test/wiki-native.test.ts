import { afterEach, describe, expect, it, vi } from "bun:test";
import { Tokenizer, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createMemoryRuntimeContext } from "@oh-my-pi/pi-coding-agent/memory-backend/runtime";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { wikiBackend } from "@oh-my-pi/pi-coding-agent/wiki/backend";
import { loadWikiConfig } from "@oh-my-pi/pi-coding-agent/wiki/config";
import { createWikiComplete } from "@oh-my-pi/pi-coding-agent/wiki/model";
import { formatWikiRecall, setWikiState, WikiState, wikiTurnEvidence } from "@oh-my-pi/pi-coding-agent/wiki/state";
import { WikiStore } from "@oh-my-pi/pi-coding-agent/wiki/store";
import { ExternalVault } from "@oh-my-pi/pi-coding-agent/wiki/external-vault";
import type { WikiComplete, WikiEvidenceRole, WikiPage } from "@oh-my-pi/pi-coding-agent/wiki/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "p",
		model: "main",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
const openStates: WikiState[] = [];
afterEach(async () => {
	for (const state of openStates.splice(0)) {
		setWikiState(state.session, undefined);
		await state.dispose();
	}
});

interface ModelData {
	query?: string;
	sources?: Array<{
		id: string;
		revision: number;
		content?: string;
		passage?: number;
		passages?: Array<{ role: WikiEvidenceRole; content: string }>;
	}>;
	catalog?: WikiPage[];
	pages?: WikiPage[];
}
const compile: WikiComplete = async request => {
	const data = JSON.parse(request.prompt.match(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/)![1]!) as ModelData;
	if (request.task === "maintain") {
		if (!data.pages)
			return JSON.stringify({ pages: data.catalog?.map(page => ({ id: page.id, revision: page.revision })) ?? [] });
		const source = data.sources![0]!;
		const content = source.passages![0]!.content;
		const existing = data.pages[0];
		return JSON.stringify({
			pages: [
				{
					id: existing?.id ?? "w-deployment",
					expectedRevision: existing?.revision ?? null,
					title: "Deployment",
					summary: "Current deployment region",
					body: `## Current\n${content}`,
					kind: "knowledge",
					status: "active",
					sources: [...(existing?.sources ?? []), { id: source.id, revision: source.revision }],
					links: [],
					evidence: [{ id: source.id, revision: source.revision, passage: 0 }],
				},
			],
			processed: [{ id: source.id, revision: source.revision }],
		});
	}
	if (data.sources)
		return JSON.stringify({
			passages: data.sources.map(source => ({
				id: source.id,
				revision: source.revision,
				passage: source.passage,
			})),
		});
	if (!data.pages)
		return JSON.stringify({
			pages:
				data.query === "unknown"
					? []
					: (data.catalog?.map(page => ({ id: page.id, revision: page.revision })) ?? []),
		});
	return JSON.stringify({
		passages: data.pages.map(page => ({ id: page.id, revision: page.revision, quote: page.body })),
	});
};

async function fixture(temp: TempDir, cwd: string, complete = compile, extraSettings: Record<string, unknown> = {}) {
	const settings = Settings.isolated({
		"memory.backend": "wiki",
		"wiki.root": temp.join("wiki"),
		"wiki.autoMaintain": false,
		"wiki.includeGlobal": false,
		...extraSettings,
	});
	const obfuscator = new SecretObfuscator([{ type: "plain", content: "CONFIGUREDCREDENTIAL12345" }]);
	const session = {
		sessionId: "wiki-fixture",
		settings,
		obfuscator,
		sessionManager: { getCwd: () => cwd },
		agent: { tokenizer: new Tokenizer() },
		refreshBaseSystemPrompt: async () => {},
		refreshSkills: async () => {},
	} as unknown as AgentSession;
	const config = loadWikiConfig(settings, temp.join("agent"), cwd);
	const state = new WikiState({ session, config, agentDir: temp.join("agent"), complete });
	await state.open();
	setWikiState(session, state);
	openStates.push(state);
	const context = { session, agentDir: temp.join("agent"), cwd };
	const toolSession = { settings, cwd, getMemoryContext: () => context } as ToolSession;
	return { state, session, context, toolSession, settings, config };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

describe("native Wiki memory", () => {
	it("stores redacted evidence, compiles it, serves native recall/read, and removes corrected or forgotten content", async () => {
		await using temp = TempDir.createSync("wiki-native-");
		const { state, toolSession, context, settings } = await fixture(temp, temp.join("project"));
		const retain = MemoryRetainTool.createIf(toolSession)!;
		await retain.execute("capture", {
			items: [
				{
					content: "Deployment region west; credential CONFIGUREDCREDENTIAL12345",
					context: "password=unprefixed-secret",
				},
			],
		});
		const pending = (await state.snapshot()).pending;
		expect(pending[0]?.content).toContain("region west");
		expect(JSON.stringify(pending)).not.toContain("CONFIGUREDCREDENTIAL12345");
		expect(JSON.stringify(pending)).not.toContain("unprefixed-secret");
		await state.maintain();
		const recall = MemoryRecallTool.createIf(toolSession)!;
		const recalled = resultText(await recall.execute("recall", { query: "deployment" }));
		expect(recalled).toContain("region west");
		expect(recalled).toContain(`memory://${pending[0]!.id}`);
		const runtime = createMemoryRuntimeContext(context);
		const read = await InternalUrlRouter.instance().resolve("memory://w-deployment", { settings, memory: runtime });
		expect(read.content).toContain("region west");
		await MemoryEditTool.createIf(toolSession)!.execute("update", {
			op: "update",
			id: pending[0]!.id,
			content: "Deployment region east",
		});
		expect((await state.snapshot()).pages).toEqual([]);
		await state.maintain();
		expect(resultText(await recall.execute("recall-new", { query: "deployment" }))).toContain("region east");
		expect(resultText(await recall.execute("recall-new", { query: "deployment" }))).not.toContain("region west");
		await MemoryEditTool.createIf(toolSession)!.execute("forget", { op: "forget", id: pending[0]!.id });
		expect((await state.recall("deployment")).items).toEqual([]);
		await state.dispose();
		openStates.splice(openStates.indexOf(state), 1);
	});

	it("replaces compiled-page evidence when a page is explicitly corrected", async () => {
		await using temp = TempDir.createSync("wiki-page-correction-");
		const { state, toolSession } = await fixture(temp, temp.join("project"));
		await state.capture({ content: "Deployment region west" });
		await state.maintain();
		await MemoryEditTool.createIf(toolSession)!.execute("correct-page", {
			op: "update",
			id: "w-deployment",
			content: "Deployment region east",
		});
		const recalled = resultText(
			await MemoryRecallTool.createIf(toolSession)!.execute("recall", { query: "deployment" }),
		);
		expect(recalled).toContain("region east");
		expect(recalled).not.toContain("region west");
	});

	it("injects original user preferences rather than contradictory generated page prose", async () => {
		await using temp = TempDir.createSync("wiki-preference-authority-");
		const { state } = await fixture(temp, temp.join("project"));
		const store = new WikiStore({ root: state.config.root });
		await store.open();
		try {
			const quote = "请给我 human readable 的总结表格，不要原始 SQL 行。";
			const source = await store.capture({
				source: "task-observations",
				content: JSON.stringify([
					{ role: "user", content: quote },
					{ role: "assistant", content: quote },
				]),
			});
			const ref = { id: source.id, revision: source.revision };
			await store.publish(await store.snapshot(), {
				pages: [
					{
						id: "w-format",
						expectedRevision: null,
						title: "Format",
						summary: "Generated synopsis",
						body: "Always dump raw SQL rows instead of readable summaries.",
						kind: "preference",
						status: "active",
						sources: [ref],
						links: [],
						evidence: [{ ...ref, passage: 0, role: "user", quote }],
					},
				],
				processed: [ref],
			});
			const instructions = await state.instructions();
			expect(instructions).toContain(quote);
			expect(instructions).not.toContain("Always dump raw SQL");
			await state.mutate("w-format", {
				op: "update",
				content: "A tool-authored correction is not a user quotation.",
			});
			expect(await state.instructions()).not.toContain(quote);
		} finally {
			store.close();
		}
	});

	it("rejects cross-project reads and explicit source ids outside the owning context", async () => {
		await using temp = TempDir.createSync("wiki-scope-");
		const one = await fixture(temp, temp.join("one"));
		const two = await fixture(temp, temp.join("two"));
		const source = await one.state.capture({ content: "Private project deployment region west" });
		await one.state.maintain();
		expect((await wikiBackend.read!(two.context, source.id)).status).toBe("not_found");
		await expect(
			InternalUrlRouter.instance().resolve("memory://w-deployment", {
				settings: two.settings,
				memory: createMemoryRuntimeContext(two.context),
			}),
		).rejects.toThrow("not found");
		await one.state.dispose();
		await two.state.dispose();
		openStates.length = 0;
	});

	it("rejects a recalled revision changed during model execution rather than caching stale evidence", async () => {
		await using temp = TempDir.createSync("wiki-race-");
		const pending = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		let awaitRead = false;
		const fx = await fixture(temp, temp.join("project"), async request => {
			if (request.task === "recall" && awaitRead) {
				started.resolve();
				return pending.promise;
			}
			return compile(request);
		});
		const source = await fx.state.capture({ content: "Deployment region west" });
		await fx.state.maintain();
		awaitRead = true;
		const inFlight = fx.state.recall("deployment");
		await started.promise;
		await fx.state.mutate(source.id, { op: "forget" });
		pending.resolve('{"pages":[]}');
		await expect(inFlight).rejects.toThrow("changed during recall");
		expect((await fx.state.recall("deployment")).items).toEqual([]);
		await fx.state.dispose();
		openStates.length = 0;
	});

	it("falls back to FTS keyword search when the recall model fails", async () => {
		await using temp = TempDir.createSync("wiki-fts-fallback-");
		let recall = false;
		const fx = await fixture(temp, temp.join("project"), async request => {
			if (request.task === "recall" && recall) throw new Error("recall model down");
			return compile(request);
		});
		await fx.state.capture({ content: "Deployment region west" });
		await fx.state.maintain();
		recall = true;
		const result = await fx.state.recall("deployment");
		expect(result.degraded).toContain("keyword search");
		expect(formatWikiRecall(result)).toContain("keyword search");
		await fx.state.dispose();
		openStates.length = 0;
	});

	it("falls back to FTS when the whole recall exceeds wiki.timeoutSeconds", async () => {
		await using temp = TempDir.createSync("wiki-recall-timeout-");
		let hang = false;
		const hung = Promise.withResolvers<string>();
		const fx = await fixture(
			temp,
			temp.join("project"),
			async request => {
				if (request.task === "recall" && hang) return hung.promise;
				return compile(request);
			},
			{ "wiki.timeoutSeconds": 1 },
		);
		await fx.state.capture({ content: "Deployment region west" });
		await fx.state.maintain();
		hang = true;
		const result = await fx.state.recall("deployment");
		expect(result.degraded).toContain("timed out");
		expect(result.items.map(item => item.content).join("\n")).toContain("region west");
		await fx.state.dispose();
		openStates.length = 0;
	});

	it("retries a failed recall request on the session model", async () => {
		const recall = makeModel("p", "recall");
		const main = makeModel("p", "main");
		const settings = Settings.isolated({ modelRoles: { memory: "online" } });
		const registry = {
			getAvailable: () => [recall, main],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as ModelRegistry;
		const session = {
			sessionId: "wiki-hop",
			model: main,
			obfuscator: new SecretObfuscator([]),
		} as AgentSession;
		const config = { ...loadWikiConfig(settings, "/tmp/agent", "/tmp/project") };
		config.recallModel = "p/recall";
		config.model = "p/recall";
		const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValueOnce(new Error("recall down"))
			.mockResolvedValueOnce(assistant("session ok"));
		const complete = createWikiComplete(session, settings, registry, config, usage);
		await expect(complete({ task: "recall", system: "s", prompt: "p", maxTokens: 16 })).resolves.toBe("session ok");
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["recall", "main"]);
		spy.mockRestore();
	});

	it("captures observable results but excludes reasoning and memory feedback from automatic evidence", () => {
		const evidence = wikiTurnEvidence([
			{ role: "user", content: "verify deployment" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning canary" },
					{ type: "text", text: "Checking" },
				],
			},
			{ role: "toolResult", toolName: "recall", content: [{ type: "text", text: "old memory feedback" }] },
			{
				role: "toolResult",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "deployment passed" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "Verified west deployment" }] },
		] as AgentMessage[]);
		expect(evidence).toContain("deployment passed");
		expect(evidence).not.toContain("private reasoning canary");
		expect(evidence).not.toContain("old memory feedback");
	});

	it("appends external vault evidence and recalls it without crossing project scopes", async () => {
		await using temp = TempDir.createSync("external-vault-");
		const vault = new ExternalVault(temp.join("."));
		const written = await vault.append({
			content: "Marker VAULTSCOPE says the external vault is the memory store.",
			scope: "project-a",
		});
		await Bun.write(
			temp.join("wiki/memory/cutover.md"),
			"---\nid: w-cutover\nscope: project-a\nstatus: active\n---\n# Vault cutover\n\nCompiled notes are read from wiki.\n",
		);
		await Bun.write(
			temp.join("wiki/other/secret.md"),
			"---\nid: w-secret\nscope: project-b\nstatus: active\n---\n# Secret\n\nVAULTSCOPE belongs to another project.\n",
		);
		const notes = await vault.notes(["project-a"]);
		expect(vault.search("VAULTSCOPE", notes, 5).map(note => note.id)).toEqual([written.id]);
		expect((await vault.find("w-cutover", ["project-a"]))?.kind).toBe("page");
		expect(await vault.find(written.id, ["project-b"])).toBeUndefined();
		expect(await vault.find("w-secret", ["project-a"])).toBeUndefined();
	});
});
