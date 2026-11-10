import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { requestRemoteCompaction } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { seanceIsolationOptions } from "@oh-my-pi/pi-coding-agent/task/seance-policy";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { assistantMsg, userMsg } from "./utilities";

const baseModel = getBundledModel("openai-codex", "gpt-5.6-sol");
if (!baseModel) throw new Error("Expected bundled Codex fixture model");
const localModel: Model = {
	...baseModel,
	provider: "magpie",
	id: "group/offline-session-routing",
	baseUrl: "http://127.0.0.1:1/v1",
	preferWebsockets: false,
};
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function route(payload: unknown) {
	assert.ok(payload && typeof payload === "object" && "magpie_session_route" in payload);
	const value = payload.magpie_session_route;
	assert.ok(
		value &&
			typeof value === "object" &&
			"version" in value &&
			typeof value.version === "number" &&
			"session_id" in value &&
			typeof value.session_id === "string" &&
			"run_id" in value &&
			typeof value.run_id === "string",
	);
	expect(value).toEqual({ version: 1, session_id: expect.any(String), run_id: expect.stringMatching(uuidV4) });
	return value;
}

describe("native Magpie session routing", () => {
	let temp: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	const managers: SessionManager[] = [];

	beforeAll(() => {
		temp = TempDir.createSync("magpie-session-route-");
		authStorage = createInMemoryAuthStorage();
		registry = new ModelRegistry(authStorage, path.join(temp.path(), "models.yml"), { ignoreLocalModelConfig: true });
	});

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.close();
	});

	afterAll(() => {
		authStorage.close();
		temp.removeSync();
	});

	function manager() {
		const value = SessionManager.inMemory(temp.path());
		managers.push(value);
		return value;
	}

	async function fixture(factory?: ExtensionFactory, sessionManager = manager()) {
		const runtime = new ExtensionRuntime();
		const extensions = factory
			? [await loadExtensionFromFactory(factory, temp.path(), new EventBus(), runtime, "magpie-test")]
			: [];
		const runner = new ExtensionRunner(extensions, runtime, temp.path(), sessionManager, registry);
		return { runner, sessionManager };
	}

	test("zero-extension startup adds real identity without changing the input or cache key", async () => {
		const { runner, sessionManager } = await fixture();
		await runner.emit({ type: "session_start" });
		const messages = Object.freeze([Object.freeze({ role: "user", content: "hello" })]);
		const original = Object.freeze({ prompt_cache_key: "shared-cache-family", session_id: "provider-id", messages });
		const result = await runner.emitBeforeProviderRequest(original, localModel);
		expect(route(result).session_id).toBe(sessionManager.getSessionId());
		assert.ok(result && typeof result === "object" && "magpie_session_route" in result);
		const { magpie_session_route: _identity, ...rest } = result;
		expect(rest).toEqual(original);
		expect(result).not.toBe(original);
		expect(original).not.toHaveProperty("magpie_session_route");
	});

	test("remote summaries use their actual endpoint and never inherit local group identity", async () => {
		const { runner } = await fixture();
		await runner.emit({ type: "session_start" });
		for (const [endpoint, chat, localGroup] of [
			["https://summary.example.test/summarize", false, false],
			["http://127.0.0.1:2/summarize", false, false],
			["https://summary.example.test/v1/chat/completions", true, false],
			["http://127.0.0.1:2/v1/chat/completions", true, true],
		] as const) {
			let sent: Record<string, unknown> | undefined;
			await requestRemoteCompaction(endpoint, { systemPrompt: "summarize", prompt: "history", maxTokens: 100 }, undefined, {
				model: localModel,
				onPayload: async (payload, model, signal) => {
					expect(model?.baseUrl).toBe(endpoint);
					expect(model?.api).toBe(chat ? "openai-completions" : "remote-compaction");
					return runner.emitBeforeProviderRequest(payload, model, signal);
				},
				fetch: asGlobalFetch(async (_url, init) => {
					sent = JSON.parse(String(init?.body));
					return Response.json(chat ? { choices: [{ message: { content: "summary" } }] } : { summary: "summary" });
				}),
			});
			assert.ok(sent);
			if (localGroup) route(sent);
			else expect(sent).not.toHaveProperty("magpie_session_route");
		}
	});

	test("ordinary turns, tools, provider retries, warming and model switches preserve the run", async () => {
		const { runner } = await fixture();
		await runner.emit({ type: "session_start" });
		const first = await runner.emitBeforeProviderRequest({ prompt_cache_key: "cache" }, localModel);
		const expected = route(first);
		await runner.emitBeforeAgentStart("next user turn", undefined, []);
		await runner.emitContext([]);
		await runner.emitAfterProviderResponse({ status: 200, headers: {} }, localModel);
		for (const role of ["user", "assistant", "tool", "user"]) {
			expect(
				route(await runner.emitBeforeProviderRequest({ messages: [{ role, content: "next" }] }, localModel)),
			).toEqual(expected);
		}
		expect(await runner.emitBeforeProviderRequest(first, localModel)).toBe(first);
		expect(route(await runner.emitBeforeProviderRequest({}, { ...localModel, id: "group/another" }))).toEqual(
			expected,
		);
	});

	test("resume of the same saved ID starts a new run and rejects requests retained from the old run", async () => {
		const { runner, sessionManager } = await fixture();
		await runner.emit({ type: "session_start" });
		const before = await runner.emitBeforeProviderRequest({ prompt_cache_key: "persistent-cache" }, localModel);
		await runner.emit({ type: "session_switch", reason: "resume", previousSessionFile: undefined });
		const after = await runner.emitBeforeProviderRequest({ prompt_cache_key: "persistent-cache" }, localModel);
		expect(route(after).session_id).toBe(sessionManager.getSessionId());
		expect(route(after).run_id).not.toBe(route(before).run_id);
		expect(after).toHaveProperty("prompt_cache_key", "persistent-cache");
		await expect(runner.emitBeforeProviderRequest(before, localModel)).rejects.toThrow(
			"Existing routing metadata conflicts",
		);
	});

	test("new sessions and branches activate the current SessionManager identity", async () => {
		const { runner, sessionManager } = await fixture();
		await runner.emit({ type: "session_start" });
		const first = route(await runner.emitBeforeProviderRequest({}, localModel));
		await sessionManager.newSession();
		await runner.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });
		const second = route(await runner.emitBeforeProviderRequest({}, localModel));
		expect(second.session_id).not.toBe(first.session_id);
		expect(second.run_id).not.toBe(first.run_id);
		await sessionManager.newSession();
		await runner.emit({ type: "session_branch", reason: "fork", previousSessionFile: undefined });
		const third = route(await runner.emitBeforeProviderRequest({}, localModel));
		expect(third.session_id).toBe(sessionManager.getSessionId());
		expect(new Set([first.run_id, second.run_id, third.run_id]).size).toBe(3);
	});

	test("separate runners and subagents never share runs, and same-process revive renews only that child", async () => {
		const parent = await fixture();
		const sameSavedSession = await fixture(undefined, parent.sessionManager);
		const child = await fixture();
		for (const item of [parent, sameSavedSession, child]) await item.runner.emit({ type: "session_start" });
		const request = { prompt_cache_key: "same-family" };
		const first = route(await parent.runner.emitBeforeProviderRequest(request, localModel));
		const second = route(await sameSavedSession.runner.emitBeforeProviderRequest(request, localModel));
		const third = route(await child.runner.emitBeforeProviderRequest(request, localModel));
		expect(first.session_id).toBe(second.session_id);
		expect(third.session_id).not.toBe(first.session_id);
		expect(new Set([first.run_id, second.run_id, third.run_id]).size).toBe(3);
		await child.runner.emit({ type: "session_shutdown" });
		await expect(child.runner.emitBeforeProviderRequest(request, localModel)).rejects.toThrow(
			"Missing session activation",
		);
		await child.runner.emit({ type: "session_start" });
		const revived = route(await child.runner.emitBeforeProviderRequest(request, localModel));
		expect(revived.session_id).toBe(third.session_id);
		expect(revived.run_id).not.toBe(third.run_id);
		expect(route(await parent.runner.emitBeforeProviderRequest(request, localModel))).toEqual(first);
	});

	for (const baseUrl of [
		"http://localhost:1/v1",
		"https://localhost./v1",
		"http://127.20.30.40/v1",
		"http://[::1]:1/v1",
	]) {
		test(`accepts loopback gateway ${baseUrl}`, async () => {
			const { runner, sessionManager } = await fixture();
			await runner.emit({ type: "session_start" });
			expect(route(await runner.emitBeforeProviderRequest({}, { ...localModel, baseUrl })).session_id).toBe(
				sessionManager.getSessionId(),
			);
		});
	}

	for (const [label, model] of [
		["other provider", { ...localModel, provider: "other" }],
		["direct model", { ...localModel, id: "provider/model" }],
		["not a group selector", { ...localModel, id: "group" }],
		["remote gateway", { ...localModel, baseUrl: "https://remote.example/v1" }],
		["LAN gateway", { ...localModel, baseUrl: "http://192.168.1.2/v1" }],
		["wildcard address", { ...localModel, baseUrl: "http://0.0.0.0/v1" }],
		["deceptive hostname", { ...localModel, baseUrl: "http://localhost.example/v1" }],
		["userinfo hostname", { ...localModel, baseUrl: "http://localhost@remote.example/v1" }],
		["non-HTTP scheme", { ...localModel, baseUrl: "ftp://localhost/v1" }],
		["invalid URL", { ...localModel, baseUrl: "not-a-url" }],
		["unknown model", undefined],
	] as const) {
		test(`${label} is unchanged and needs no activation`, async () => {
			const { runner } = await fixture();
			const original = Object.freeze({ prompt_cache_key: "untouched" });
			expect(await runner.emitBeforeProviderRequest(original, model)).toBe(original);
		});
	}

	test("missing or invalid identity rejects outside extension error isolation", async () => {
		const { runner, sessionManager } = await fixture();
		const reported: string[] = [];
		runner.onError(error => reported.push(error.error));
		await expect(
			runner.emitBeforeProviderRequest({ prompt_cache_key: "not-an-identity" }, localModel),
		).rejects.toThrow("Missing session activation");
		await runner.emit({ type: "session_start" });
		const invalid = spyOn(sessionManager, "getSessionId").mockReturnValue("");
		try {
			await expect(runner.emitBeforeProviderRequest({}, localModel)).rejects.toThrow(
				"Missing or invalid OMP session identity",
			);
		} finally {
			invalid.mockRestore();
		}
		await sessionManager.newSession();
		await expect(runner.emitBeforeProviderRequest({}, localModel)).rejects.toThrow("Session activation changed");
		expect(reported).toEqual([]);
	});

	test("conflicting or malformed metadata cannot reach the provider, even when hooks fail open", async () => {
		const { runner } = await fixture(pi => {
			pi.on("before_provider_request", () => {
				throw new Error("unrelated extension failure");
			});
		});
		const reported: string[] = [];
		runner.onError(error => reported.push(error.error));
		await runner.emit({ type: "session_start" });
		const current = route(await runner.emitBeforeProviderRequest({}, localModel));
		const sent: unknown[] = [];
		for (const supplied of [
			null,
			{},
			{ ...current, run_id: "old-run" },
			{ ...current, session_id: "other-session" },
			{ ...current, version: 2 },
		]) {
			const original = Object.freeze({ prompt_cache_key: "unchanged", magpie_session_route: supplied });
			const dispatch = async () => {
				const body = await runner.emitBeforeProviderRequest(original, localModel);
				sent.push(body);
			};
			await expect(dispatch()).rejects.toThrow("Existing routing metadata conflicts");
			expect(original.magpie_session_route).toBe(supplied);
		}
		expect(sent).toEqual([]);
		expect(reported.every(message => message === "unrelated extension failure")).toBe(true);
	});

	test("native metadata is attached after extension payload replacements", async () => {
		const { runner, sessionManager } = await fixture(pi => {
			pi.on("before_provider_request", () => ({ prompt_cache_key: "extension-key", transformed: true }));
		});
		await runner.emit({ type: "session_start" });
		const result = await runner.emitBeforeProviderRequest({}, localModel);
		expect(result).toMatchObject({ prompt_cache_key: "extension-key", transformed: true });
		expect(route(result).session_id).toBe(sessionManager.getSessionId());
	});

	test("a request awaiting an extension cannot be relabeled by a concurrent resume", async () => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const { runner } = await fixture(pi => {
			pi.on("before_provider_request", async () => {
				entered.resolve();
				await released.promise;
			});
		});
		await runner.emit({ type: "session_start" });
		const pending = runner.emitBeforeProviderRequest({}, localModel);
		// Bun's rejects matcher can pump the pending promise immediately. Attach a
		// normal rejection handler first, and assert only after releasing the hook.
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await entered.promise;
		try {
			await runner.emit({ type: "session_switch", reason: "resume", previousSessionFile: undefined });
		} finally {
			released.resolve();
		}
		const failure = await outcome;
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({ message: expect.stringContaining("Session activation changed") });
	});

	for (const payload of [null, "request", 1, []]) {
		test(`invalid payload ${JSON.stringify(payload)} fails closed`, async () => {
			const { runner } = await fixture();
			await runner.emit({ type: "session_start" });
			await expect(runner.emitBeforeProviderRequest(payload, localModel)).rejects.toThrow(
				"Expected a provider request object",
			);
		});
	}

	for (const mode of ["manual", "auto"] as const) {
		test(`zero-extension ${mode} compaction sends the existing activation identity`, async () => {
			const { runner, sessionManager } = await fixture();
			const model: Model = {
				...localModel,
				remoteCompaction: { enabled: true, v2StreamingEnabled: true },
			};
			const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
			agent.promptCacheKey = "persistent-compaction-cache";
			const session = new AgentSession({
				agent, sessionManager, modelRegistry: registry, extensionRunner: runner,
				settings: Settings.isolated({
					"compaction.autoContinue": false,
					"compaction.keepRecentTokens": 1,
					"compaction.methodOrder": ["remote"],
					"contextPromotion.enabled": false,
				}),
			});
			const captured: unknown[] = [];
			authStorage.keys.setRuntime("magpie", "fixture-key");
			const available = spyOn(registry, "getAvailable").mockReturnValue([model]);
			const apiKey = spyOn(registry, "getApiKey").mockResolvedValue("fixture-key");
			const fetch = spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async (_input, init) => {
				captured.push(JSON.parse(String(init?.body)));
				const events = [
					{ type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "fixture-encrypted" } },
					{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			}));
			try {
				await runner.emit({ type: "session_start" });
				expect(runner.hasHandlers("before_provider_request")).toBe(false);
				const expected = route(await runner.emitBeforeProviderRequest({}, model));
				session.subscribe(() => {});
				for (const text of ["first", "second"]) {
					for (const message of [userMsg(`${text} question`), assistantMsg(`${text} answer`)]) {
						session.agent.appendMessage(message);
						session.sessionManager.appendMessage(message);
					}
				}
				if (mode === "manual") {
					const result = await session.compact();
					expect(result?.shortSummary).toBe("Remote compaction");
				} else {
					const completed = Promise.withResolvers<void>();
					session.subscribe(event => { if (event.type === "auto_compaction_end") completed.resolve(); });
					const threshold = {
						...assistantMsg("threshold reached"),
						api: model.api, provider: model.provider, model: model.id,
						usage: {
							input: model.contextWindow, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: model.contextWindow + 1,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					session.agent.emitExternalEvent({ type: "message_end", message: threshold });
					session.agent.emitExternalEvent({ type: "agent_end", messages: [threshold] });
					await completed.promise;
				}
				await session.waitForIdle();
				expect(captured).toHaveLength(1);
				expect(route(captured[0])).toEqual(expected);
				expect(captured[0]).toHaveProperty("prompt_cache_key", "persistent-compaction-cache");
				expect(route(await runner.emitBeforeProviderRequest({}, model))).toEqual(expected);
			} finally {
				fetch.mockRestore();
				apiKey.mockRestore();
				available.mockRestore();
				await session.dispose();
			}
		});
	}

	for (const seance of [false, true]) {
		test(`SDK ${seance ? "seance isolation" : "disabled extension discovery"} retains the native identity boundary`, async () => {
			const sessionManager = manager();
			const { session } = await createAgentSession({
				cwd: temp.path(),
				agentDir: temp.path(),
				authStorage,
				modelRegistry: registry,
				model: localModel,
				settings: Settings.isolated(),
				sessionManager,
				disableExtensionDiscovery: true,
				preloadedPreparedExtensions: [],
				preloadedCustomToolPaths: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
				...(seance ? seanceIsolationOptions(temp.path()) : {}),
			});
			try {
				await initializeExtensions(session, {
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						throw new Error(error.error);
					},
				});
				assert.ok(session.extensionRunner);
				const first = route(await session.extensionRunner.emitBeforeProviderRequest({}, localModel));
				expect(first.session_id).toBe(sessionManager.getSessionId());
				await session.extensionRunner.emit({ type: "session_start" });
				const resumed = route(await session.extensionRunner.emitBeforeProviderRequest({}, localModel));
				expect(resumed.session_id).toBe(first.session_id);
				expect(resumed.run_id).not.toBe(first.run_id);
			} finally {
				await session.dispose();
			}
		});
	}
});
