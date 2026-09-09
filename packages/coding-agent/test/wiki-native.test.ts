import { afterEach, describe, expect, it } from "bun:test";
import { Tokenizer, type AgentMessage } from "@oh-my-pi/pi-agent-core";
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
import { setWikiState, WikiState, wikiTurnEvidence } from "@oh-my-pi/pi-coding-agent/wiki/state";
import type { WikiComplete, WikiPage, WikiSource } from "@oh-my-pi/pi-coding-agent/wiki/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const openStates: WikiState[] = [];
afterEach(async () => {
	for (const state of openStates.splice(0)) {
		setWikiState(state.session, undefined);
		await state.dispose();
	}
});

interface ModelData {
	query?: string;
	sources?: WikiSource[];
	catalog?: WikiPage[];
	pages?: WikiPage[];
}
const compile: WikiComplete = async request => {
	const data = JSON.parse(request.prompt.match(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/)![1]!) as ModelData;
	if (request.task === "maintain") {
		if (!data.pages)
			return JSON.stringify({ pages: data.catalog?.map(page => ({ id: page.id, revision: page.revision })) ?? [] });
		const source = data.sources![0]!;
		const existing = data.pages[0];
		return JSON.stringify({
			pages: [
				{
					id: existing?.id ?? "w-deployment",
					expectedRevision: existing?.revision ?? null,
					title: "Deployment",
					summary: "Current deployment region",
					body: `## Current\n${source.content}`,
					kind: "knowledge",
					status: "active",
					sources: [...(existing?.sources ?? []), { id: source.id, revision: source.revision }],
					links: [],
					evidence: [{ id: source.id, revision: source.revision, quote: source.content }],
				},
			],
			processed: [{ id: source.id, revision: source.revision }],
		});
	}
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

async function fixture(temp: TempDir, cwd: string, complete = compile) {
	const settings = Settings.isolated({
		"memory.backend": "wiki",
		"wiki.root": temp.join("wiki"),
		"wiki.autoMaintain": false,
		"wiki.includeGlobal": false,
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
		expect(recalled).toContain("memory://w-deployment");
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
		expect(
			wikiTurnEvidence([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			] as AgentMessage[]),
		).toBeUndefined();
	});
});
