import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

interface Interval {
	start: number;
	end: number;
}

export interface WorkUsageSnapshot {
	usage: Usage;
	requests: number;
	startedAt: number;
	endedAt: number;
	wallMs: number;
	modelMs: number;
	toolMs: number;
	waitMs: number;
	cacheRate: number | null;
	cacheReportedRequests: number;
	cacheEligibleRequests: number;
	actualCost: number;
	actualCostRequests: number;
	estimatedCost: number;
	estimatedCostRequests: number;
	unknownCostRequests: number;
}

function intervalDuration(intervals: Interval[]): number {
	if (intervals.length === 0) return 0;
	const sorted = intervals.toSorted((a, b) => a.start - b.start || a.end - b.end);
	let total = 0;
	let start = sorted[0]!.start;
	let end = sorted[0]!.end;
	for (let i = 1; i < sorted.length; i++) {
		const interval = sorted[i]!;
		if (interval.start <= end) {
			end = Math.max(end, interval.end);
			continue;
		}
		total += end - start;
		start = interval.start;
		end = interval.end;
	}
	return total + end - start;
}

function appendInterval(intervals: Interval[], start: number, end: number): void {
	if (!Number.isFinite(start) || !Number.isFinite(end)) return;
	intervals.push({ start, end: Math.max(start, end) });
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Aggregates one user-initiated unit of work across every model request and
 * tool execution. Provider-reported cache buckets and cost provenance remain
 * explicit: missing telemetry is never converted into a measured zero.
 */
export class WorkUsageAccumulator {
	#usage: Usage | undefined;
	#requests = 0;
	#startedAt: number | undefined;
	#endedAt: number | undefined;
	#modelIntervals: Interval[] = [];
	#toolIntervals: Interval[] = [];
	#toolStarts = new Map<string, number>();
	#cacheReadTokens = 0;
	#cachePromptTokens = 0;
	#cacheReportedRequests = 0;
	#cacheEligibleRequests = 0;
	#actualCost = 0;
	#actualCostRequests = 0;
	#estimatedCost = 0;
	#estimatedCostRequests = 0;
	#unknownCostRequests = 0;

	/** True when at least one billed request was accumulated. */
	get active(): boolean {
		return this.#usage !== undefined;
	}

	/** Record the user-visible start of this unit of work. */
	begin(timestamp = Date.now()): void {
		if (!Number.isFinite(timestamp)) return;
		this.#startedAt = Math.min(this.#startedAt ?? timestamp, timestamp);
	}

	add(message: AssistantMessage): void {
		const usage = message.usage;
		if (this.#usage === undefined) {
			this.#usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		const aggregate = this.#usage;
		aggregate.input += usage.input;
		aggregate.output += usage.output;
		aggregate.cacheRead += usage.cacheRead;
		aggregate.cacheWrite += usage.cacheWrite;
		aggregate.totalTokens += usage.totalTokens;
		aggregate.cost.input += usage.cost.input;
		aggregate.cost.output += usage.cost.output;
		aggregate.cost.cacheRead += usage.cost.cacheRead;
		aggregate.cost.cacheWrite += usage.cost.cacheWrite;
		aggregate.cost.total += usage.cost.total;
		if (usage.contextTokens !== undefined) {
			aggregate.contextTokens = Math.max(aggregate.contextTokens ?? 0, usage.contextTokens);
		}
		if (usage.reasoningTokens !== undefined) {
			aggregate.reasoningTokens = (aggregate.reasoningTokens ?? 0) + usage.reasoningTokens;
		}
		if (usage.premiumRequests !== undefined) {
			aggregate.premiumRequests = (aggregate.premiumRequests ?? 0) + usage.premiumRequests;
		}
		if (usage.orchestration) {
			aggregate.orchestration ??= {};
			if (usage.orchestration.input !== undefined) {
				aggregate.orchestration.input = (aggregate.orchestration.input ?? 0) + usage.orchestration.input;
			}
			if (usage.orchestration.cacheRead !== undefined) {
				aggregate.orchestration.cacheRead =
					(aggregate.orchestration.cacheRead ?? 0) + usage.orchestration.cacheRead;
			}
			if (usage.orchestration.output !== undefined) {
				aggregate.orchestration.output = (aggregate.orchestration.output ?? 0) + usage.orchestration.output;
			}
		}
		if (usage.cttl) {
			aggregate.cttl ??= {};
			if (usage.cttl.ephemeral5m !== undefined) {
				aggregate.cttl.ephemeral5m = (aggregate.cttl.ephemeral5m ?? 0) + usage.cttl.ephemeral5m;
			}
			if (usage.cttl.ephemeral1h !== undefined) {
				aggregate.cttl.ephemeral1h = (aggregate.cttl.ephemeral1h ?? 0) + usage.cttl.ephemeral1h;
			}
		}
		if (usage.server) {
			aggregate.server ??= {};
			if (usage.server.webSearch !== undefined) {
				aggregate.server.webSearch = (aggregate.server.webSearch ?? 0) + usage.server.webSearch;
			}
			if (usage.server.webFetch !== undefined) {
				aggregate.server.webFetch = (aggregate.server.webFetch ?? 0) + usage.server.webFetch;
			}
		}

		this.#requests++;
		const requestStart = message.timestamp;
		const requestEnd = requestStart + Math.max(0, message.duration ?? 0);
		this.begin(requestStart);
		this.#endedAt = Math.max(this.#endedAt ?? requestEnd, requestEnd);
		appendInterval(this.#modelIntervals, requestStart, requestEnd);
		for (const content of message.content) {
			if (content.type === "toolCall") this.#toolStarts.set(content.id, requestEnd);
		}

		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens > 0) {
			this.#cacheEligibleRequests++;
			const telemetry = usage.cacheTelemetry;
			if (telemetry?.read === "reported" && telemetry.write !== "unavailable") {
				this.#cacheReportedRequests++;
				this.#cacheReadTokens += usage.cacheRead;
				this.#cachePromptTokens += promptTokens;
			}
		}

		switch (usage.costTelemetry?.source) {
			case "provider":
				this.#actualCost += usage.cost.total;
				this.#actualCostRequests++;
				if (usage.costTelemetry.estimatedTotal !== undefined) {
					this.#estimatedCost += usage.costTelemetry.estimatedTotal;
					this.#estimatedCostRequests++;
				}
				break;
			case "catalog":
				this.#estimatedCost += usage.costTelemetry.estimatedTotal ?? usage.cost.total;
				this.#estimatedCostRequests++;
				break;
			case "unavailable":
				this.#unknownCostRequests++;
				break;
			default:
				if (usage.cost.total > 0) this.#estimatedCost += usage.cost.total;
				else this.#unknownCostRequests++;
		}
	}

	startTool(toolCallId: string, timestamp = Date.now()): void {
		if (!Number.isFinite(timestamp)) return;
		this.begin(timestamp);
		this.#toolStarts.set(toolCallId, timestamp);
	}

	endTool(toolCallId: string, timestamp = Date.now()): void {
		const start = this.#toolStarts.get(toolCallId);
		this.#toolStarts.delete(toolCallId);
		if (start === undefined || !Number.isFinite(timestamp)) return;
		appendInterval(this.#toolIntervals, start, timestamp);
		this.#endedAt = Math.max(this.#endedAt ?? timestamp, timestamp);
	}

	/** Rebuild-time tool timing from the persisted call/result timestamps. */
	addToolResult(message: ToolResultMessage): void {
		this.endTool(message.toolCallId, message.timestamp);
	}

	/** Aggregate and clear. Returns undefined when nothing was billed. */
	flush(endedAt?: number): WorkUsageSnapshot | undefined {
		if (this.#usage === undefined) return undefined;
		if (endedAt !== undefined && Number.isFinite(endedAt)) {
			this.#endedAt = Math.max(this.#endedAt ?? endedAt, endedAt);
		}
		const startedAt = this.#startedAt ?? this.#endedAt ?? 0;
		const finalEndedAt = Math.max(startedAt, this.#endedAt ?? startedAt);
		const modelMs = intervalDuration(this.#modelIntervals);
		const activeMs = intervalDuration([...this.#modelIntervals, ...this.#toolIntervals]);
		const toolMs = Math.max(0, activeMs - modelMs);
		const wallMs = finalEndedAt - startedAt;
		const snapshot: WorkUsageSnapshot = {
			usage: this.#usage,
			requests: this.#requests,
			startedAt,
			endedAt: finalEndedAt,
			wallMs,
			modelMs,
			toolMs,
			waitMs: Math.max(0, wallMs - activeMs),
			cacheRate: this.#cachePromptTokens > 0 ? this.#cacheReadTokens / this.#cachePromptTokens : null,
			cacheReportedRequests: this.#cacheReportedRequests,
			cacheEligibleRequests: this.#cacheEligibleRequests,
			actualCost: this.#actualCost,
			actualCostRequests: this.#actualCostRequests,
			estimatedCost: this.#estimatedCost,
			estimatedCostRequests: this.#estimatedCostRequests,
			unknownCostRequests: this.#unknownCostRequests,
		};
		this.#usage = undefined;
		this.#requests = 0;
		this.#startedAt = undefined;
		this.#endedAt = undefined;
		this.#modelIntervals = [];
		this.#toolIntervals = [];
		this.#toolStarts.clear();
		this.#cacheReadTokens = 0;
		this.#cachePromptTokens = 0;
		this.#cacheReportedRequests = 0;
		this.#cacheEligibleRequests = 0;
		this.#actualCost = 0;
		this.#actualCostRequests = 0;
		this.#estimatedCost = 0;
		this.#estimatedCostRequests = 0;
		this.#unknownCostRequests = 0;
		return snapshot;
	}
}

/** Format the work aggregate with the same accent hierarchy as prompt chrome. */
export function formatWorkUsageRow(snapshot: WorkUsageSnapshot): string {
	const { usage } = snapshot;
	const timing = [
		`work ${formatDuration(snapshot.wallMs)}`,
		`model ${formatDuration(snapshot.modelMs)}`,
		`tool ${formatDuration(snapshot.toolMs)}`,
		`wait ${formatDuration(snapshot.waitMs)}`,
	].join("  ");
	const tokens = [
		`${theme.icon.input} ${formatNumber(usage.input)}`,
		`${theme.icon.output} ${formatNumber(usage.output)}`,
		`${theme.icon.cache} R${formatNumber(usage.cacheRead)}/W${formatNumber(usage.cacheWrite)}`,
	].join("  ");
	const headerParts = [
		theme.fg("accent", theme.bold(`${theme.icon.time} WORK`)),
		theme.fg("muted", timing),
		theme.fg("accent", `${snapshot.requests} req`),
	];
	const detailParts = [theme.fg("userMessageText", tokens)];
	if (usage.reasoningTokens !== undefined) {
		detailParts.push(theme.fg("muted", `reason ${formatNumber(usage.reasoningTokens)}`));
	}
	if (usage.orchestration) {
		detailParts.push(
			theme.fg(
				"muted",
				`orch I${formatNumber(usage.orchestration.input ?? 0)}/R${formatNumber(usage.orchestration.cacheRead ?? 0)}/O${formatNumber(usage.orchestration.output ?? 0)}`,
			),
		);
	}
	const cacheRate = snapshot.cacheRate === null ? "N/A" : `${(snapshot.cacheRate * 100).toFixed(1)}%`;
	const cacheColor = snapshot.cacheRate === null ? "muted" : snapshot.cacheRate > 0 ? "success" : "warning";
	detailParts.push(
		theme.fg(cacheColor, `cache ${cacheRate} (${snapshot.cacheReportedRequests}/${snapshot.cacheEligibleRequests})`),
	);
	if (snapshot.actualCostRequests > 0) {
		detailParts.push(theme.fg("success", `${formatCost(snapshot.actualCost)} actual`));
	}
	if (snapshot.estimatedCostRequests > 0) {
		detailParts.push(theme.fg("accent", `~${formatCost(snapshot.estimatedCost)} catalog`));
	}
	if (snapshot.unknownCostRequests > 0) {
		detailParts.push(theme.fg("warning", `cost N/A (${snapshot.unknownCostRequests})`));
	}
	return `${headerParts.join("  ")}\n${detailParts.join("  ")}`;
}

/** Render the work total with prompt-style accent chrome, not recap-level dim text. */
export function createWorkUsageRowBlock(snapshot: WorkUsageSnapshot): Container {
	const block = new Container();
	const border = new DynamicBorder(str => theme.fg("borderAccent", str));
	block.addChild(new Spacer(1));
	block.addChild(border);
	block.addChild(new Text(formatWorkUsageRow(snapshot), 1, 0));
	block.addChild(new DynamicBorder(str => theme.fg("borderAccent", str)));
	return block;
}
