import * as path from "node:path";
import type { AsyncJob } from "../async/job-manager";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { emitSubagentFrame } from "../utils/event-bus";
import {
	createSubagentExecution,
	readSubagentExecution,
	type SubagentExecutionState,
} from "./execution-state";
import { type AgentProgress, type SubagentProgressPayload, TASK_SUBAGENT_PROGRESS_CHANNEL } from "./types";

/** Initial observable task identity, before a session or model request exists. */
export function createQueuedSubagentProgress(
	identity: Pick<AgentProgress, "id" | "agent" | "agentSource" | "task"> &
		Partial<Pick<AgentProgress, "index" | "assignment" | "description" | "modelRole">>,
	now = Date.now(),
): AgentProgress {
	return {
		...identity,
		index: identity.index ?? 0,
		status: "pending",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		execution: createSubagentExecution(now),
	};
}

/** Publish adapters' queue/failure transitions through the same channel as live execution. */
export function publishSubagentProgress(
	session: Pick<ToolSession, "eventBus" | "subagentEventBus" | "getSessionFile">,
	progress: AgentProgress,
	metadata: Pick<SubagentProgressPayload, "parentToolCallId" | "detached" | "sessionFile"> = {},
): void {
	const parentFile = session.getSessionFile();
	const payload: SubagentProgressPayload = {
		index: progress.index,
		agent: progress.agent,
		agentSource: progress.agentSource,
		task: progress.task,
		assignment: progress.assignment,
		progress: { ...progress },
		execution: progress.execution,
		sessionFile: parentFile ? path.join(parentFile.slice(0, -".jsonl".length), `${progress.id}.jsonl`) : undefined,
		...metadata,
	};
	emitSubagentFrame(session.eventBus, session.subagentEventBus, TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
}

/** Persist an owner-side recovery/delivery update without changing the child's process lifecycle. */
export function recordSubagentExecution(
	registry: AgentRegistry,
	id: string,
	execution: SubagentExecutionState,
	expectedSessionFile?: string,
): boolean {
	const ref = registry.get(id);
	if (!ref || (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)) return false;
	const previous = ref.history?.execution;
	if (previous && (previous.run > execution.run || previous.updatedAt > execution.updatedAt)) return false;
	if (!registry.setHistory(id, { execution }, expectedSessionFile)) return false;
	registry.get(id)?.session?.sessionManager?.appendCustomEntry("subagent-execution", execution);
	return true;
}

/** Capture the failed run a job reports, rather than a newer run under the same agent id. */
export function subagentFailureFromJob(job: AsyncJob | undefined): { id: string; execution: SubagentExecutionState } | undefined {
	if (!job || job.type !== "task" || job.status !== "failed") return undefined;
	const id = job.agentId ?? job.id;
	const progress: unknown = job.latestDetails?.progress;
	if (!Array.isArray(progress)) return undefined;
	for (const row of progress) {
		if (!row || typeof row !== "object" || row.id !== id) continue;
		const execution = readSubagentExecution(row.execution);
		if (execution?.phase === "failed") return { id, execution };
	}
	return undefined;
}

/** A delivery receipt acknowledges visibility, never understanding or acceptance by the parent. */
export function markSubagentFailureDelivered(
	registry: AgentRegistry,
	failure: { id: string; execution: SubagentExecutionState } | undefined,
): void {
	if (!failure) return;
	const current = registry.get(failure.id)?.history?.execution;
	if (!current || current.run !== failure.execution.run || current.stoppedAt !== failure.execution.stoppedAt || current.phase !== "failed" || current.notification?.state === "delivered") return;
	const now = Math.max(Date.now(), current.updatedAt + 1);
	recordSubagentExecution(registry, failure.id, { ...current, updatedAt: now, notification: { state: "delivered", at: now } });
}
