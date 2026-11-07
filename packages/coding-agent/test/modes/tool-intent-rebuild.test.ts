// A card rebuilt from a stored assistant message renders the model's intent row.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import "@oh-my-pi/pi-coding-agent/internal-urls/router";
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
	it.each([
		{ name: "bash", args: { i: "Listing the working tree", command: "ls -la" }, intent: undefined },
		{ name: "glob", args: { i: "Listing the working tree", path: "src/**/*.ts" }, intent: undefined },
		{ name: "read", args: { path: "skill://release-history" }, intent: "Listing the working tree" },
		{ name: "read", args: { path: "src/a.ts" }, intent: "Listing the working tree" },
	])("renders stored $name intent in ANSI and the visible native head ($args)", ({ name, args, intent }) => {
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
					name,
					// A stored block keeps `i`; the harness only strips it from executed args.
					arguments: args,
					intent,
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
			messages: [
				message as AgentMessage,
				{
					role: "toolResult",
					toolName: name,
					toolCallId: "tc-bash",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		const card = ctx.chatContainer.children.find(
			(child): child is ToolExecutionComponent | ReadToolGroupComponent =>
				child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent,
		);
		if (!card) throw new Error("no card for the stored call");
		const rows = Bun.stripANSI(card.render(100).join("\n"));
		expect(rows).toContain("Listing the working tree");
		const cx: DescribeContext = {
			cols: 100,
			dark: true,
			reduceMotion: false,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		const node = card.describe(cx);
		if (node.k !== "tool") throw new Error("no native tool card");
		// The intent tooltip alone is invisible without a hover.
		expect(JSON.stringify([node.p?.title, node.p?.target])).toContain("Listing the working tree");
	});
});
