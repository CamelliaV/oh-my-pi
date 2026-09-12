import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import type { SessionUsageSnapshot } from "@oh-my-pi/pi-coding-agent/modes/components/work-usage";
import { buildSessionUsageTimeline } from "@oh-my-pi/pi-coding-agent/modes/components/work-usage";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function ctxWith(
	sessionUsage: SegmentContext["sessionUsage"],
	options: SegmentContext["options"] = {},
): SegmentContext {
	return {
		sessionUsage,
		options,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
	} as unknown as SegmentContext;
}

const SESSION: SessionUsageSnapshot = {
	usage: {
		input: 269_218_520,
		output: 9_541_818,
		cacheRead: 2_129_196_703,
		cacheWrite: 1_596_482,
		totalTokens: 2_400_956_721,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	works: 1_921,
	requests: 23_042,
	startedAt: 1_789_000_000_000,
	endedAt: 1_789_000_630_862_917,
	wallMs: 630_862_917,
	modelMs: 589_862_917,
	toolMs: 41_000_000,
	waitMs: 0,
	cacheRate: 0.916,
	cacheReportedRequests: 22_831,
	cacheEligibleRequests: 23_042,
	cacheReadTokens: 2_129_196_703,
	cachePromptTokens: 2_322_258_445,
	actualCost: 0,
	actualCostRequests: 0,
	estimatedCost: 0,
	estimatedCostRequests: 0,
	unknownCostRequests: 0,
};

// ANSI is irrelevant to the math; strip it before asserting numbers.
function plain(text: string): string {
	return stripVTControlCharacters(text);
}

function branchEntry(message: AgentMessage): SessionEntry {
	return { type: "message", message } as SessionEntry;
}

function assistantMessage(options: {
	timestamp: number;
	duration: number;
	input: number;
	output: number;
	cacheRead: number;
}): AgentMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		stopReason: "stop",
		usage: {
			input: options.input,
			output: options.output,
			cacheRead: options.cacheRead,
			cacheWrite: 0,
			totalTokens: options.input + options.output + options.cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: options.timestamp,
		duration: options.duration,
	} as AgentMessage;
}

describe("session_usage status-line segment", () => {
	it("stays hidden on a session with no billed work yet", () => {
		expect(renderSegment("session_usage", ctxWith(null)).visible).toBe(false);
		expect(renderSegment("session_usage", ctxWith(undefined)).visible).toBe(false);
	});

	it("renders cumulative time, tokens, cache rate and throughput", () => {
		const result = renderSegment("session_usage", ctxWith(SESSION));
		const text = plain(result.content);

		expect(result.visible).toBe(true);
		// Model + tool time: 589,862,917 + 41,000,000 ms = 7d7h.
		expect(text).toContain("7d7h");
		expect(text).toContain("269M");
		expect(text).toContain("9.5M");
		expect(text).toContain("91.6%");
		expect(text).toContain("16.2 tok/s");
		// Requests are off by default — the segment is meant to be compact.
		expect(text).not.toContain("23K");
	});

	it("drops individual parts through segment options", () => {
		const text = plain(
			renderSegment(
				"session_usage",
				ctxWith(SESSION, { sessionUsage: { cache: false, rate: false, requests: false } }),
			).content,
		);
		expect(text).toContain("7d7h");
		expect(text).not.toContain("%");
		expect(text).not.toContain("tok/s");
	});

	it("shows the request count only when asked", () => {
		const text = plain(
			renderSegment("session_usage", ctxWith(SESSION, { sessionUsage: { requests: true } })).content,
		);
		expect(text).toContain("23K req");
	});

	it("omits the cache rate when no provider ever reported the read bucket", () => {
		const text = plain(renderSegment("session_usage", ctxWith({ ...SESSION, cacheRate: null })).content);
		expect(text).not.toContain("%");
		expect(text).toContain("16.2 tok/s");
	});

	it("omits time and throughput when only token buckets exist", () => {
		// Tokens without a measured duration (a relay that reports usage but
		// never a duration) must not imply zero processing time or throughput.
		const text = plain(
			renderSegment(
				"session_usage",
				ctxWith({
					...SESSION,
					usage: { ...SESSION.usage, input: 500, output: 100 },
					modelMs: 0,
					toolMs: 0,
					cacheRate: null,
				}),
			).content,
		);
		expect(text).toContain("500");
		expect(text).toContain("100");
		expect(text).not.toContain("tok/s");
		expect(text).not.toContain("0ms");
	});

	it("uses the startup placeholder while the session is still painting", () => {
		const result = renderSegment("session_usage", {
			...ctxWith(SESSION),
			startupPlaceholder: true,
		} as SegmentContext);
		const text = plain(result.content);
		expect(result.visible).toBe(true);
		expect(text).toContain("…");
		expect(text).not.toContain("7d7h");
	});
});

describe("session_usage data source: replayed persisted branch", () => {
	const t0 = 1_789_000_000_000;

	it("an empty branch (new session) yields no snapshot", () => {
		expect(buildSessionUsageTimeline([]).at(-1)?.session).toBeUndefined();
	});

	it("a resumed session restores its cumulative totals from persisted durations", () => {
		// What a loaded session file replays: the user turn, one completed
		// request with a persisted duration. No live event ever fires — the
		// totals come from the branch alone.
		const entries = [
			branchEntry({ role: "user", content: "continue", timestamp: t0 }),
			branchEntry(
				assistantMessage({
					timestamp: t0 + 2_000,
					duration: 45_000,
					input: 1_000,
					output: 2_000,
					cacheRead: 7_000,
				}),
			),
		];
		const snapshot = buildSessionUsageTimeline(entries).at(-1)?.session;
		expect(snapshot).toBeDefined();
		expect(snapshot!.requests).toBe(1);
		expect(snapshot!.modelMs).toBe(45_000);
		expect(snapshot!.usage.input).toBe(1_000);
		expect(snapshot!.usage.output).toBe(2_000);
		// The restored snapshot renders — this is exactly what the segment
		// receives after `omp -r` on a session that already worked.
		const result = renderSegment("session_usage", ctxWith(snapshot!));
		expect(result.visible).toBe(true);
		expect(plain(result.content)).toContain("45.0s");
		expect(plain(result.content)).toContain("2K");
	});

	it("later works accumulate on top of the restored totals", () => {
		const secondWork = [
			...[],
			branchEntry({ role: "user", content: "more", timestamp: t0 + 600_000 }),
			branchEntry(
				assistantMessage({ timestamp: t0 + 602_000, duration: 15_000, input: 3_000, output: 4_000, cacheRead: 0 }),
			),
		];
		const first = [
			branchEntry({ role: "user", content: "continue", timestamp: t0 }),
			branchEntry(
				assistantMessage({
					timestamp: t0 + 2_000,
					duration: 45_000,
					input: 1_000,
					output: 2_000,
					cacheRead: 7_000,
				}),
			),
		];
		const restored = buildSessionUsageTimeline(first).at(-1)!.session;
		const grown = buildSessionUsageTimeline([...first, ...secondWork]).at(-1)!.session;
		expect(grown.requests).toBe(restored.requests + 1);
		expect(grown.modelMs).toBe(restored.modelMs + 15_000);
		expect(grown.usage.output).toBe(restored.usage.output + 4_000);
	});
});
