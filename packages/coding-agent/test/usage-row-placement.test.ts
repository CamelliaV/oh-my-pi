/**
 * Regression coverage for per-turn usage placement across transcript rebuilds.
 * Read-only turns keep their metrics inside the compact read group; other
 * assistant turns retain a standalone row below their visible content/tools.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { formatWorkUsageRow, WorkUsageAccumulator } from "../src/modes/components/work-usage";

// 4242 → "4.2K": distinctive enough not to collide with a read group's render.
const USAGE_INPUT = 4242;
const USAGE_LABEL = formatNumber(USAGE_INPUT);
// Fixed local wall-clock time so the rendered stamp is deterministic across time zones.
// Single-digit month/day/hour/minute/second exercise the formatter's zero-padding.
const USAGE_TS = new Date(2026, 0, 2, 3, 4, 5).getTime();
const USAGE_TS_LABEL = "2026-01-02 03:04:05";
const SECOND_USAGE_TS = new Date(2026, 0, 2, 3, 4, 6).getTime();
const SECOND_USAGE_TS_LABEL = "2026-01-02 03:04:06";

function readTurn(
	toolCallId = "r1",
	filePath = "src/foo.ts",
	usageInput = USAGE_INPUT,
	timestamp = USAGE_TS,
): AgentMessage[] {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: filePath } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: usageInput,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usageInput + 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	} as unknown as AgentMessage;
	const toolResult = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "line1\nline2" }],
		timestamp,
	} as unknown as AgentMessage;
	return [assistant, toolResult];
}

function makeHarness(showTokenUsage: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	let helpers: UiHelpers;
	const ctx = {
		chatContainer: new Container(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: (key: string) => (key === "display.showTokenUsage" ? showTokenUsage : false) },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		session: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

describe("UiHelpers.renderSessionContext token-usage row placement", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("nests the usage row inside the read group for a read-only turn", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		const group = children.find(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(group).toBeDefined();

		const rendered = group!.render(120).join("\n");
		expect(rendered).toContain(USAGE_LABEL);
		expect(rendered).toContain(USAGE_TS_LABEL);
		expect(children.indexOf(group!)).toBeLessThan(children.length - 1);
		expect(children[children.length - 1]?.render(120).join("\n")).toContain("work");
		expect(children.filter(component => component.render(120).join("\n").includes(USAGE_TS_LABEL))).toHaveLength(1);
	});

	it("interleaves consecutive read-only turns with their paths in one group", () => {
		const { ctx, helpers } = makeHarness(true);
		const messages = [...readTurn(), ...readTurn("r2", "src/bar.ts", 2121, SECOND_USAGE_TS)];
		helpers.renderSessionContext({ messages } as SessionContext);

		const groups = ctx.chatContainer.children.filter(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(1);
		const lines = Bun.stripANSI(groups[0]!.render(120).join("\n")).split("\n");
		const fooIndex = lines.findIndex(line => line.includes("src/foo.ts"));
		const firstUsageIndex = lines.findIndex(line => line.includes(USAGE_TS_LABEL));
		const barIndex = lines.findIndex(line => line.includes("src/bar.ts"));
		const secondUsageIndex = lines.findIndex(line => line.includes(SECOND_USAGE_TS_LABEL));
		expect(fooIndex).toBeLessThan(firstUsageIndex);
		expect(firstUsageIndex).toBeLessThan(barIndex);
		expect(barIndex).toBeLessThan(secondUsageIndex);
	});

	it("keeps the work summary when per-request token rows are off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		expect(children.some(c => c.render(120).join("\n").includes(USAGE_TS_LABEL))).toBe(false);
		expect(children[children.length - 1]?.render(120).join("\n")).toContain("work");
	});
});

describe("ChatTranscriptBuilder token-usage row timestamp", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("renders the turn's local timestamp on the rebuilt usage row", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: USAGE_INPUT,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: USAGE_INPUT + 7,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: USAGE_TS,
		} as unknown as AgentMessage;
		builder.rebuild([{ type: "message", id: "m1", parentId: null, timestamp: new Date(0).toISOString(), message }]);
		const children = builder.container.children;
		const rendered = children.map(child => child.render(120).join("\n")).join("\n");
		expect(rendered).toContain(USAGE_TS_LABEL);
		expect(children[children.length - 1]?.render(120).join("\n")).toContain("work");
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("keeps grouped read metrics nested on the reusable transcript-builder path", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const messages = [...readTurn(), ...readTurn("r2", "src/bar.ts", 2121, SECOND_USAGE_TS)];
		builder.rebuild(
			messages.map((message, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp: new Date(0).toISOString(),
				message,
			})),
		);

		const groups = builder.container.children.filter(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(1);
		const rendered = groups[0]!.render(120).join("\n");
		expect(rendered).toContain(USAGE_TS_LABEL);
		expect(rendered).toContain(SECOND_USAGE_TS_LABEL);
		expect(
			builder.container.children.filter(component => component.render(120).join("\n").includes(USAGE_LABEL)),
		).toEqual([groups[0]!]);
	});
});

function workAssistant(options: {
	timestamp: number;
	duration: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheTelemetry?: { read: "reported" | "unavailable"; write: "reported" | "unavailable" | "not-applicable" };
	cost: number;
	costSource?: "provider" | "catalog" | "unavailable";
	toolCallId?: string;
}): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: options.toolCallId
			? [{ type: "toolCall", id: options.toolCallId, name: "read", arguments: { path: "src/foo.ts" } }]
			: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		stopReason: options.toolCallId ? "toolUse" : "stop",
		usage: {
			input: options.input,
			output: 10,
			cacheRead: options.cacheRead,
			cacheWrite: options.cacheWrite,
			totalTokens: options.input + options.cacheRead + options.cacheWrite + 10,
			...(options.cacheTelemetry ? { cacheTelemetry: options.cacheTelemetry } : {}),
			cost: { input: options.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: options.cost },
			...(options.costSource ? { costTelemetry: { source: options.costSource } } : {}),
		},
		timestamp: options.timestamp,
		duration: options.duration,
	} as Extract<AgentMessage, { role: "assistant" }>;
}

describe("work usage accounting", () => {
	it("separates wall, model, tool, and wait time while weighting reported cache tokens", () => {
		const usage = new WorkUsageAccumulator();
		usage.begin(1_000);
		usage.add(
			workAssistant({
				timestamp: 1_100,
				duration: 400,
				input: 100,
				cacheRead: 800,
				cacheWrite: 100,
				cacheTelemetry: { read: "reported", write: "reported" },
				cost: 0.2,
				costSource: "provider",
				toolCallId: "r1",
			}),
		);
		usage.startTool("r1", 1_600);
		usage.endTool("r1", 2_100);
		usage.add(
			workAssistant({
				timestamp: 2_200,
				duration: 300,
				input: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				cacheTelemetry: { read: "unavailable", write: "not-applicable" },
				cost: 0.3,
				costSource: "catalog",
			}),
		);

		const snapshot = usage.flush(2_600)!;
		expect(snapshot.wallMs).toBe(1_600);
		expect(snapshot.modelMs).toBe(700);
		expect(snapshot.toolMs).toBe(500);
		expect(snapshot.waitMs).toBe(400);
		expect(snapshot.cacheRate).toBe(0.8);
		expect(snapshot.cacheReportedRequests).toBe(1);
		expect(snapshot.cacheEligibleRequests).toBe(2);
		expect(snapshot.actualCost).toBeCloseTo(0.2, 8);
		expect(snapshot.estimatedCost).toBeCloseTo(0.3, 8);
		const row = formatWorkUsageRow(snapshot);
		expect(row).toContain("cache 80.0% (1/2)");
		expect(row).toContain("$0.20 actual");
		expect(row).toContain("~$0.30 catalog");
	});

	it("shows unavailable cache and cost telemetry instead of measured zero", () => {
		const usage = new WorkUsageAccumulator();
		usage.add(
			workAssistant({
				timestamp: 1_000,
				duration: 250,
				input: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			}),
		);

		const snapshot = usage.flush()!;
		expect(snapshot.cacheRate).toBeNull();
		expect(snapshot.cacheReportedRequests).toBe(0);
		expect(snapshot.cacheEligibleRequests).toBe(1);
		expect(snapshot.unknownCostRequests).toBe(1);
		expect(formatWorkUsageRow(snapshot)).toContain("cache N/A (0/1)");
		expect(formatWorkUsageRow(snapshot)).toContain("cost N/A (1)");
	});
});
