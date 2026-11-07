import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetUserRetryRulesCache } from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as utils from "@oh-my-pi/pi-utils";

const REGION_ERROR = "403 API access from your region is not available. (type=region_blocked param=region_blocked)";
let dir: utils.TempDir;
let auth: AuthStorage;
let session: AgentSession | undefined;

beforeEach(async () => {
	dir = await utils.TempDir.create("@omp-user-retry-");
	vi.spyOn(utils, "getAgentDir").mockReturnValue(dir.path());
	resetUserRetryRulesCache();
	auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	auth.keys.setRuntime("openai", "test-key");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	auth.close();
	vi.restoreAllMocks();
	resetUserRetryRulesCache();
	await dir.remove();
});

async function run(options: { rules: object; error?: string; persistent?: boolean; enabled?: boolean }) {
	await Bun.write(dir.join("retry-rules.json"), JSON.stringify(options.rules));
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Missing fixture model");
	let calls = 0;
	const mock = createMockModel({
		handler: () =>
			++calls === 1 || options.persistent
				? { throw: options.error ?? REGION_ERROR }
				: { content: ["Recovered"], stopReason: "stop" },
	});
	const settings = Settings.isolated({
		"retry.enabled": options.enabled ?? true,
		"retry.maxRetries": 1,
		"retry.baseDelayMs": 1,
		"retry.modelFallback": false,
		"compaction.enabled": false,
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: [], tools: [], messages: [] },
		streamFn: (requested, context, streamOptions) => mock.stream(requested, context, streamOptions),
	});
	session = new AgentSession({
		agent,
		settings,
		sessionManager: SessionManager.inMemory(dir.path()),
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings }),
	});
	const retries: string[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retries.push(event.errorMessage);
	});
	await session.prompt("Run the fixture");
	await session.waitForIdle();
	const last = agent.state.messages.findLast(message => message.role === "assistant");
	return { calls, retries, last, retrying: session.isRetrying };
}

describe("session recovery with user retry rules", () => {
	it("retries an explicitly opted-in 403 after the provider returns an error message", async () => {
		const result = await run({ rules: { retryablePatterns: ["region_blocked"] } });
		expect(result.calls).toBe(2);
		expect(result.retries).toHaveLength(1);
		expect(result.last).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Recovered" }] });
		expect(result.retrying).toBe(false);
	});

	it("keeps a matched 403 bounded by the session retry budget", async () => {
		const result = await run({ rules: { retryablePatterns: ["region_blocked"] }, persistent: true });
		expect(result.calls).toBe(2);
		expect(result.retries).toHaveLength(1);
		expect(result.last).toMatchObject({ stopReason: "error" });
		expect(result.retrying).toBe(false);
	});

	it("honors a negative rule over the opt-in and the built-in transient classification", async () => {
		const result = await run({
			rules: { retryablePatterns: ["overloaded"], nonRetryablePatterns: ["overloaded"] },
			error: "503 provider overloaded",
		});
		expect(result.calls).toBe(1);
		expect(result.retries).toEqual([]);
		expect(result.last).toMatchObject({ stopReason: "error" });
	});

	it("does not retry an ordinary unmatched 403", async () => {
		const result = await run({ rules: { retryablePatterns: ["different_error"] } });
		expect(result.calls).toBe(1);
		expect(result.retries).toEqual([]);
		expect(result.last).toMatchObject({ stopReason: "error" });
	});

	it("keeps retries disabled when the session setting is off", async () => {
		const result = await run({ rules: { retryablePatterns: ["region_blocked"] }, enabled: false });
		expect(result.calls).toBe(1);
		expect(result.retries).toEqual([]);
	});
});
