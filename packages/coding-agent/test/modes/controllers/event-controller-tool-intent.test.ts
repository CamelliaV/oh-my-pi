// A live tool card renders the model's intent, as a card rebuilt from the transcript does.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui/tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/** The native node a TSP terminal draws for the card. */
function toolNode(component: ToolExecutionComponent): NativeNode {
	const cx: DescribeContext = {
		cols: 100,
		reduceMotion: false,
		dark: true,
		supports: kind => kind === "tool" || kind === "media",
		feature: () => true,
	};
	const node = component.describe(cx);
	if (!node) throw new Error("card described nothing");
	return node;
}

function headTarget(component: ToolExecutionComponent): unknown {
	return (toolNode(component).p as Record<string, unknown>).target;
}

/** The rows a non-TSP terminal paints for the card. */
function renderedText(component: ToolExecutionComponent): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("EventController tool intent", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function fixture(message?: AssistantMessage) {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming: true, hasBuiltInTool: () => true, getToolByName: () => undefined },
			...(message === undefined
				? {}
				: { streamingComponent: new AssistantMessageComponent(), streamingMessage: message }),
		});
		return { controller: new EventController(ctx), pendingTools, ctx };
	}

	const start = (intent: string | undefined) => ({
		type: "tool_execution_start" as const,
		toolCallId: "tc-bash",
		toolName: "bash",
		// The executed args: the harness strips `i` before running the tool.
		args: { command: "ls -la" },
		...(intent === undefined ? {} : { intent }),
	});

	it("shows the intent on a card created by tool_execution_start", async () => {
		const { controller, pendingTools } = fixture();
		await controller.handleEvent(start("Listing the working tree"));
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no card for the call");
		expect(headTarget(card)).toBe("Listing the working tree");
		expect(renderedText(card)).toContain("Listing the working tree");
	});

	it("shows the intent when the only streamed update mounts the card", async () => {
		const message = assistantMessage([
			{
				type: "toolCall",
				id: "tc-bash",
				name: "bash",
				arguments: { i: "Listing the working tree", command: "ls -la" },
			},
		]);
		const { controller, pendingTools } = fixture(message);
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no card for the call");
		expect(renderedText(card)).toContain("Listing the working tree");
	});

	it("keeps the intent when tool_execution_start refreshes a streamed card", async () => {
		const { controller, pendingTools, ctx } = fixture();
		const streamed = new ToolExecutionComponent(
			"bash",
			{ command: "ls -la", i: "Listing the working tree" },
			{ useBuiltInRenderer: true },
			undefined,
			ctx.ui as unknown as TUI,
			"/tmp",
			"tc-bash",
		);
		pendingTools.set("tc-bash", streamed);
		await controller.handleEvent(start("Listing the working tree"));
		expect(headTarget(streamed)).toBe("Listing the working tree");
		expect(renderedText(streamed)).toContain("Listing the working tree");
	});
});
