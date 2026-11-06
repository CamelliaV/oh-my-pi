import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	type Context,
	type Model,
	type ModelSpec,
	clearCustomApis,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "prompt-override-model",
		name: "Prompt Override Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

describe("AgentSession.setSessionSystemPrompt", () => {
	it("replaces the effective prompt, survives base rebuilds, and clears on newSession", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-override-");
		const marker = `RULES_${Bun.nanoseconds().toString(36)}`;
		await fs.writeFile(path.join(tempDir.path(), "AGENTS.md"), marker);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(`prompt-override-${marker}`),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.systemPrompt.join("\n")).toContain(marker);

			session.setSessionSystemPrompt(["MINIMAL EXPLAINER BASE"]);
			expect(session.systemPrompt).toEqual(["MINIMAL EXPLAINER BASE"]);

			// A tool/settings rebuild regenerates the underlying base but must not
			// replace the provider-visible session prompt.
			await session.refreshBaseSystemPrompt();
			expect(session.baseSystemPrompt.join("\n")).toContain(marker);
			expect(session.systemPrompt).toEqual(["MINIMAL EXPLAINER BASE"]);

			await session.newSession();
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt.join("\n")).toContain(marker);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("sends the session override as the provider-visible system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-override-request-");
		const marker = Bun.nanoseconds().toString(36);
		await fs.writeFile(path.join(tempDir.path(), "AGENTS.md"), `RULES_${marker}`);
		const api = `prompt-override-request-${marker}`;
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			session.setSessionSystemPrompt(["MINIMAL EXPLAINER BASE"]);
			await session.prompt("hello");
			expect(contexts[0]?.systemPrompt).toEqual(["MINIMAL EXPLAINER BASE"]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
