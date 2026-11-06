import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

function buildTestModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "test-api",
		provider,
		kind: "chat",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

interface Harness {
	controller: CommandController;
	warnings: string[];
	errors: string[];
	promptCalls: Array<{ text: string; options: unknown }>;
	modelSwitches: Array<{ model: Model<Api>; role: string; options: unknown }>;
	toolClears: string[][];
	basePrompts: string[][];
	events: string[];
	newSessionOptions: unknown;
	currentId: () => string;
	currentTitle: () => string | undefined;
}

function makeHarness(
	messages: AgentMessage[],
	options: { isStreaming?: boolean; sessionFile?: string; title?: string } = {},
): Harness {
	let currentId = "source-session-id";
	let currentTitle: string | undefined = options.title;
	const warnings: string[] = [];
	const errors: string[] = [];
	const promptCalls: Array<{ text: string; options: unknown }> = [];
	const modelSwitches: Array<{ model: Model<Api>; role: string; options: unknown }> = [];
	const toolClears: string[][] = [];
	const basePrompts: string[][] = [];
	const events: string[] = [];
	let newSessionOptions: unknown;
	const sourceModel = buildTestModel("test", "source-model");
	const explainerModel = buildTestModel("test", "explainer-model");
	const settings = Settings.isolated({ modelRoles: { explainer: "test/explainer-model" } });

	const session = {
		isStreaming: options.isStreaming === true,
		isCompacting: false,
		model: sourceModel,
		modelRegistry: { getAvailable: () => [sourceModel, explainerModel] },
		newSession: async (next?: unknown) => {
			newSessionOptions = next;
			currentId = "explain-session-id";
			events.push("new-session");
			return true;
		},
		setModel: async (model: Model<Api>, role: string, modelOptions?: unknown) => {
			modelSwitches.push({ model, role, options: modelOptions });
			session.model = model;
			events.push("set-model");
			return { switched: true };
		},
		setActiveToolsByName: async (names: string[]) => {
			toolClears.push(names);
			events.push("clear-tools");
		},
		setSessionSystemPrompt: (prompt: string[]) => {
			basePrompts.push(prompt);
			events.push("base-prompt");
		},
		prompt: async (text: string, promptOptions?: unknown) => {
			promptCalls.push({ text, options: promptOptions });
			events.push("prompt");
			return true;
		},
	};
	const sessionManager = {
		getSessionId: () => currentId,
		getSessionFile: () => options.sessionFile,
		getSessionName: () => currentTitle,
		getCwd: () => process.cwd(),
		buildSessionContext: () => ({ messages }),
		setSessionName: async (title: string) => {
			currentTitle = title;
			return true;
		},
	};
	const ctx = {
		session,
		sessionManager,
		settings,
		focusedAgentId: undefined,
		unfocusSession: async () => {},
		eventController: { resetTranscriptAnchors: () => {} },
		resetObserverRegistry: () => {},
		statusLine: { invalidate: () => {}, resetActiveTime: () => {} },
		updateEditorBorderColor: () => {},
		clearTransientSessionUi: () => {},
		resetTranscript: () => {},
		present: () => {},
		reloadTodos: async () => {},
		ui: { requestRender: () => {} },
		showWarning: (text: string) => warnings.push(text),
		showError: (text: string) => errors.push(text),
	} as unknown as InteractiveModeContext;

	return {
		controller: new CommandController(ctx),
		warnings,
		errors,
		promptCalls,
		modelSwitches,
		toolClears,
		basePrompts,
		events,
		get newSessionOptions() {
			return newSessionOptions;
		},
		currentId: () => currentId,
		currentTitle: () => currentTitle,
	};
}

describe("CommandController.handleExplainCommand", () => {
	it("starts a linked session, names it after the source, and seeds one synthetic explainer turn", async () => {
		const harness = makeHarness([user("fix the cache"), assistant("cached it")], {
			sessionFile: "/tmp/source-session.jsonl",
			title: "Fix the cache",
		});

		await harness.controller.handleExplainCommand("why the key changed");

		expect(harness.newSessionOptions).toEqual({ parentSession: "/tmp/source-session.jsonl" });
		expect(harness.currentId()).toBe("explain-session-id");
		expect(harness.currentTitle()).toBe("Explain · Fix the cache");
		expect(harness.modelSwitches).toHaveLength(1);
		expect(harness.modelSwitches[0]?.role).toBe("explainer");
		expect(harness.modelSwitches[0]?.model.id).toBe("explainer-model");
		expect(harness.modelSwitches[0]?.options).toEqual({ persist: false });
		expect(harness.toolClears).toEqual([[]]);
		expect(harness.basePrompts).toHaveLength(1);
		expect(harness.basePrompts[0]?.[0]).toContain("only evidence");
		expect(harness.events).toEqual(["new-session", "set-model", "clear-tools", "base-prompt", "prompt"]);
		expect(harness.promptCalls).toHaveLength(1);
		const [call] = harness.promptCalls;
		expect(call?.options).toEqual({ synthetic: true });
		expect(call?.text).toContain("Session id: source-session-id");
		expect(call?.text).toContain("Session title: Fix the cache");
		expect(call?.text).toContain("### User");
		expect(call?.text).toContain("fix the cache");
		expect(call?.text).toContain("### Assistant");
		expect(call?.text).toContain("cached it");
		expect(call?.text).toContain("why the key changed");
		expect(call?.text).toContain("NEVER use analogies");
		expect(harness.warnings).toEqual([]);
		expect(harness.errors).toEqual([]);
	});

	it("refuses to switch while the source turn is still streaming", async () => {
		const harness = makeHarness([user("pending")], { isStreaming: true });

		await harness.controller.handleExplainCommand("");

		expect(harness.newSessionOptions).toBeUndefined();
		expect(harness.currentId()).toBe("source-session-id");
		expect(harness.promptCalls).toEqual([]);
		expect(harness.toolClears).toEqual([]);
		expect(harness.basePrompts).toEqual([]);
		expect(harness.warnings[0]).toContain("/explain");
	});

	it("reports when there is no reply to explain instead of starting an empty session", async () => {
		const harness = makeHarness([user("still waiting")]);

		await harness.controller.handleExplainCommand("");

		expect(harness.newSessionOptions).toBeUndefined();
		expect(harness.currentId()).toBe("source-session-id");
		expect(harness.promptCalls).toEqual([]);
		expect(harness.toolClears).toEqual([]);
		expect(harness.basePrompts).toEqual([]);
		expect(harness.warnings[0]).toBe("The latest turn has no reply to explain yet.");
	});
});
