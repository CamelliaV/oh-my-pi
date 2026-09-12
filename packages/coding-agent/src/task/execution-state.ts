export type SubagentExecutionPhase =
	| "queued"
	| "creating"
	| "waiting-model"
	| "responding"
	| "tool"
	| "waiting"
	| "retrying"
	| "finishing"
	| "completed"
	| "failed"
	| "cancelled";

export interface SubagentExecutionState {
	phase: SubagentExecutionPhase;
	since: number;
	updatedAt: number;
	run: number;
	startedAt: number;
	runStartedAt?: number;
	lastActivityAt: number;
	lastProgressAt?: number;
	lastProgress?: string;
	activity?: string;
	retries: number;
	retryWaitMs: number;
	retry?: { attempt: number; maxAttempts: number; startedAt: number; retryAt: number; error: string };
	lastError?: string;
	stoppedAt?: number;
	recovery?: { requestedAt: number; requestedBy: string; startedAt?: number };
	notification?: { state: "pending" | "delivered"; at: number };
	events: Array<{ at: number; phase: SubagentExecutionPhase; detail?: string }>;
}

export const SUBAGENT_EXECUTION_ENTRY_TYPE = "subagent-execution";
const MAX_EXECUTION_EVENTS = 24;
const phases = new Set<SubagentExecutionPhase>([
	"queued",
	"creating",
	"waiting-model",
	"responding",
	"tool",
	"waiting",
	"retrying",
	"finishing",
	"completed",
	"failed",
	"cancelled",
]);

/** Public snapshots never share writable nested state with a run or persisted entry. */
function snapshot(state: SubagentExecutionState): SubagentExecutionState {
	// `Object.freeze` yields readonly arrays, which are not assignable to the
	// mutable `events` field; the deep freeze is the point, so assert the shape.
	return Object.freeze({
		...state,
		retry: state.retry ? Object.freeze({ ...state.retry }) : undefined,
		recovery: state.recovery ? Object.freeze({ ...state.recovery }) : undefined,
		notification: state.notification ? Object.freeze({ ...state.notification }) : undefined,
		events: Object.freeze(state.events.map(event => Object.freeze({ ...event }))),
	}) as SubagentExecutionState;
}

export function createSubagentExecution(now = Date.now()): SubagentExecutionState {
	return snapshot({
		phase: "queued",
		since: now,
		updatedAt: now,
		run: 0,
		startedAt: now,
		lastActivityAt: now,
		retries: 0,
		retryWaitMs: 0,
		events: [{ at: now, phase: "queued" }],
	});
}

/** Semantic changes only; repeated observations do not create heartbeat history. */
export function transitionSubagentExecution(
	previous: SubagentExecutionState,
	phase: SubagentExecutionPhase,
	activity?: string,
	now = Date.now(),
): SubagentExecutionState {
	const at = Math.max(now, previous.updatedAt + 1);
	const terminal = phase === "failed" || phase === "cancelled" || phase === "completed";
	return snapshot({
		...previous,
		phase,
		since: previous.phase === phase ? previous.since : at,
		updatedAt: at,
		lastActivityAt: at,
		activity,
		...(terminal ? { stoppedAt: at } : {}),
		...(phase === "failed"
			? { lastError: activity ?? previous.lastError, notification: { state: "pending" as const, at } }
			: {}),
		...(phase === "cancelled" ? { lastError: activity ?? previous.lastError } : {}),
		events: [
			...previous.events.slice(-(MAX_EXECUTION_EVENTS - 1)),
			{ at, phase, ...(activity ? { detail: activity } : {}) },
		],
	});
}

export function requestSubagentRecovery(
	previous: SubagentExecutionState,
	requestedBy: string,
	now = Date.now(),
): SubagentExecutionState {
	if (
		previous.recovery &&
		previous.recovery.startedAt === undefined &&
		(previous.phase === "queued" || previous.phase === "creating")
	) {
		return previous;
	}
	const at = Math.max(now, previous.updatedAt + 1);
	return snapshot({
		...transitionSubagentExecution(previous, "queued", "Continuation requested", at),
		recovery: { requestedAt: at, requestedBy },
	});
}

/** Run counts change at actual execution, never when a continuation is merely requested. */
export function startSubagentExecution(previous: SubagentExecutionState, now = Date.now()): SubagentExecutionState {
	const at = Math.max(now, previous.updatedAt + 1);
	const recovering = previous.recovery?.startedAt === undefined && previous.recovery !== undefined;
	return snapshot({
		...transitionSubagentExecution(
			previous,
			"creating",
			recovering ? "Starting requested continuation" : "Preparing session",
			at,
		),
		run: previous.run + 1,
		runStartedAt: at,
		stoppedAt: undefined,
		retry: undefined,
		recovery: recovering ? { ...previous.recovery!, startedAt: at } : undefined,
	});
}

/** Streaming heartbeats are coalesced by the caller; they never count as successful work. */
export function touchSubagentExecution(previous: SubagentExecutionState, now: number): SubagentExecutionState {
	if (now <= previous.lastActivityAt) return previous;
	return snapshot({ ...previous, lastActivityAt: now, updatedAt: Math.max(now, previous.updatedAt) });
}

export function progressSubagentExecution(
	previous: SubagentExecutionState,
	detail: string,
	now = Date.now(),
): SubagentExecutionState {
	const at = Math.max(now, previous.updatedAt);
	return snapshot({
		...previous,
		lastProgressAt: at,
		lastProgress: detail,
		lastActivityAt: at,
		updatedAt: at,
		lastError: undefined,
		notification: undefined,
	});
}

/** Account for elapsed backoff once, capped at the announced delay (not request latency). */
export function settleSubagentRetry(previous: SubagentExecutionState, now = Date.now()): SubagentExecutionState {
	if (!previous.retry) return previous;
	const retryWaitMs = Math.max(0, Math.min(now, previous.retry.retryAt) - previous.retry.startedAt);
	return snapshot({
		...previous,
		retry: undefined,
		retryWaitMs: previous.retryWaitMs + retryWaitMs,
		updatedAt: Math.max(now, previous.updatedAt),
	});
}

export function retrySubagentExecution(
	previous: SubagentExecutionState,
	retry: { attempt: number; maxAttempts: number; delayMs: number; error: string },
	now = Date.now(),
): SubagentExecutionState {
	// A duplicated notification during the same sleep is not another attempt.
	if (
		previous.retry &&
		previous.retry.attempt === retry.attempt &&
		previous.retry.maxAttempts === retry.maxAttempts &&
		previous.retry.error === retry.error
	)
		return previous;
	const settled = settleSubagentRetry(previous, now);
	const at = Math.max(now, settled.updatedAt);
	return snapshot({
		...transitionSubagentExecution(settled, "retrying", retry.error, at),
		retries: settled.retries + 1,
		lastError: retry.error,
		retry: {
			attempt: retry.attempt,
			maxAttempts: retry.maxAttempts,
			startedAt: at,
			retryAt: at + Math.max(0, retry.delayMs),
			error: retry.error,
		},
	});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function time(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function count(value: unknown): value is number {
	return time(value) && Number.isSafeInteger(value);
}
function phase(value: unknown): value is SubagentExecutionPhase {
	return typeof value === "string" && phases.has(value as SubagentExecutionPhase);
}

/** Validate untrusted custom-entry data and detach it from the transcript's mutable objects. */
export function readSubagentExecution(value: unknown): SubagentExecutionState | undefined {
	const data = record(value);
	if (
		!data ||
		!phase(data.phase) ||
		!time(data.since) ||
		!time(data.updatedAt) ||
		!count(data.run) ||
		!time(data.startedAt) ||
		!time(data.lastActivityAt) ||
		!count(data.retries) ||
		!time(data.retryWaitMs) ||
		!Array.isArray(data.events)
	)
		return undefined;
	for (const key of ["runStartedAt", "lastProgressAt", "stoppedAt"] as const) {
		if (data[key] !== undefined && !time(data[key])) return undefined;
	}
	for (const key of ["lastProgress", "activity", "lastError"] as const) {
		if (data[key] !== undefined && typeof data[key] !== "string") return undefined;
	}
	const events: SubagentExecutionState["events"] = [];
	for (const value of data.events) {
		const event = record(value);
		if (
			!event ||
			!time(event.at) ||
			!phase(event.phase) ||
			(event.detail !== undefined && typeof event.detail !== "string")
		)
			return undefined;
		events.push({
			at: event.at,
			phase: event.phase,
			...(event.detail !== undefined ? { detail: event.detail } : {}),
		});
	}
	let retry: SubagentExecutionState["retry"];
	if (data.retry !== undefined) {
		const item = record(data.retry);
		if (
			!item ||
			!count(item.attempt) ||
			!count(item.maxAttempts) ||
			!time(item.startedAt) ||
			!time(item.retryAt) ||
			item.retryAt < item.startedAt ||
			typeof item.error !== "string"
		)
			return undefined;
		retry = {
			attempt: item.attempt,
			maxAttempts: item.maxAttempts,
			startedAt: item.startedAt,
			retryAt: item.retryAt,
			error: item.error,
		};
	}
	let recovery: SubagentExecutionState["recovery"];
	if (data.recovery !== undefined) {
		const item = record(data.recovery);
		if (
			!item ||
			!time(item.requestedAt) ||
			typeof item.requestedBy !== "string" ||
			(item.startedAt !== undefined && !time(item.startedAt))
		)
			return undefined;
		recovery = {
			requestedAt: item.requestedAt,
			requestedBy: item.requestedBy,
			...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
		};
	}
	let notification: SubagentExecutionState["notification"];
	if (data.notification !== undefined) {
		const item = record(data.notification);
		if (!item || (item.state !== "pending" && item.state !== "delivered") || !time(item.at)) return undefined;
		notification = { state: item.state, at: item.at };
	}
	return snapshot({
		phase: data.phase,
		since: data.since,
		updatedAt: data.updatedAt,
		run: data.run,
		startedAt: data.startedAt,
		lastActivityAt: data.lastActivityAt,
		retries: data.retries,
		retryWaitMs: data.retryWaitMs,
		...(data.runStartedAt !== undefined ? { runStartedAt: data.runStartedAt as number } : {}),
		...(data.lastProgressAt !== undefined ? { lastProgressAt: data.lastProgressAt as number } : {}),
		...(data.stoppedAt !== undefined ? { stoppedAt: data.stoppedAt as number } : {}),
		...(data.lastProgress !== undefined ? { lastProgress: data.lastProgress as string } : {}),
		...(data.activity !== undefined ? { activity: data.activity as string } : {}),
		...(data.lastError !== undefined ? { lastError: data.lastError as string } : {}),
		...(retry ? { retry } : {}),
		...(recovery ? { recovery } : {}),
		...(notification ? { notification } : {}),
		events: events.slice(-MAX_EXECUTION_EVENTS),
	});
}
