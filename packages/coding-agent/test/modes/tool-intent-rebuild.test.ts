// A card rebuilt from a stored assistant message renders the model's intent row.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	resetSettingsForTest();
});

describe("tool intent on a rebuilt transcript", () => {
	it("renders the stored call's intent row", () => {
		const ctx = createInteractiveModeContext({
			session: { isStreaming: false },
			viewSession: { isStreaming: false, hasBuiltInTool: () => true, getToolByName: () => undefined },
		});
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tc-bash",
					name: "bash",
					// A stored block keeps `i`; the harness only strips it from executed args.
					arguments: { i: "Listing the working tree", command: "ls -la" },
				},
			],
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
		new UiHelpers(ctx).renderSessionContext({
			messages: [message as AgentMessage],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		const card = ctx.chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		if (!card) throw new Error("no card for the stored call");
		const rows = Bun.stripANSI(card.render(100).join("\n"));
		expect(rows).toContain("Listing the working tree");
	});
});
