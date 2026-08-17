import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	model: Model;
	settings: Settings;
	notices: string[];
}

describe("Codex remote compaction routing", () => {
	let harness: Harness | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		try {
			await harness?.session.dispose();
		} finally {
			authStorage?.close();
			vi.restoreAllMocks();
			harness = undefined;
			authStorage = undefined;
		}
	});

	async function createHarness(remoteEnabled = true): Promise<Harness> {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected bundled Codex model");
		expect(model.api).toBe("openai-codex-responses");
		expect(model.input).toContain("image");

		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);

		const settings = Settings.isolated({
			"compaction.strategy": "snapcompact",
			"compaction.keepRecentTokens": 1,
			"compaction.remoteEnabled": remoteEnabled,
		});
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		});

		harness = { session, sessionManager, model, settings, notices };
		return harness;
	}

	function mockSnapcompact(summary = "snapcompact fallback") {
		return vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => ({
			summary,
			shortSummary: "snapcompact",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
			},
		}));
	}

	function triggerThreshold(current: Harness): Promise<{ action: string; errorMessage?: string }> {
		const end = Promise.withResolvers<{ action: string; errorMessage?: string }>();
		current.session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				end.resolve({ action: event.action, errorMessage: event.errorMessage });
			}
		});

		const contextWindow = current.model.contextWindow ?? 0;
		const threshold = compactionModule.resolveThresholdTokens(contextWindow, current.settings.getGroup("compaction"));
		const promptTokens = Math.floor((threshold + contextWindow) / 2);
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: current.model.api,
			provider: current.model.provider,
			model: current.model.id,
			stopReason: "stop" as const,
			usage: {
				input: promptTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		current.session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		current.session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		return end.promise;
	}

	it("uses provider-native Codex compaction before the configured snapcompact strategy", async () => {
		const current = await createHarness();
		const snapcompactSpy = vi.spyOn(snapcompact, "compact");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "remote Codex compaction",
			shortSummary: "remote",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider, model: model.id },
		}));

		const result = await current.session.compact();

		expect(result.summary).toBe("remote Codex compaction");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [preparation, candidate] = compactSpy.mock.calls[0]!;
		expect(preparation.settings).toMatchObject({ strategy: "context-full", remoteEnabled: true });
		expect(`${candidate.provider}/${candidate.id}`).toBe(`${current.model.provider}/${current.model.id}`);
		expect(snapcompactSpy).not.toHaveBeenCalled();
	});

	it("falls back to configured snapcompact after provider-native Codex compaction fails", async () => {
		const current = await createHarness();
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new compactionModule.NativeCompactionError(new Error("remote endpoint unavailable")));
		const snapcompactSpy = mockSnapcompact();

		const result = await current.session.compact();

		expect(result.summary).toBe("snapcompact fallback");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(snapcompactSpy).toHaveBeenCalledTimes(1);
		expect(current.notices).toContain("Codex remote compaction failed; using configured snapcompact fallback.");
	});

	it("keeps explicit /compact snapcompact local-only", async () => {
		const current = await createHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact");
		const snapcompactSpy = mockSnapcompact("explicit snapcompact");

		const result = await current.session.compact(undefined, { mode: "snapcompact" });

		expect(result.summary).toBe("explicit snapcompact");
		expect(snapcompactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("keeps configured snapcompact when Codex remote compaction is disabled", async () => {
		const current = await createHarness(false);
		const compactSpy = vi.spyOn(compactionModule, "compact");
		const snapcompactSpy = mockSnapcompact("remote disabled snapcompact");

		const result = await current.session.compact();

		expect(result.summary).toBe("remote disabled snapcompact");
		expect(snapcompactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("uses provider-native Codex compaction for automatic snapcompact maintenance", async () => {
		const current = await createHarness();
		const snapcompactSpy = vi.spyOn(snapcompact, "compact");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "automatic remote Codex compaction",
			shortSummary: "remote",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: {},
		}));
		const end = triggerThreshold(current);

		expect(await end).toEqual({ action: "context-full", errorMessage: undefined });
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]![0].settings.strategy).toBe("context-full");
		expect(snapcompactSpy).not.toHaveBeenCalled();
		expect(current.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "automatic remote Codex compaction",
		});
	});

	it("falls back to snapcompact when automatic provider-native Codex compaction fails", async () => {
		const current = await createHarness();
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new compactionModule.NativeCompactionError(new Error("remote endpoint unavailable")));
		const snapcompactSpy = mockSnapcompact("automatic snapcompact fallback");

		const end = triggerThreshold(current);

		expect(await end).toEqual({ action: "snapcompact", errorMessage: undefined });
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(snapcompactSpy).toHaveBeenCalledTimes(1);
		expect(current.notices).toContain("Codex remote compaction failed; using configured snapcompact fallback.");
		expect(current.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "automatic snapcompact fallback",
		});
	});
});
