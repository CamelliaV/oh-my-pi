import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatLocalDateTimeWithOffset } from "../chrome/local-date";
import { replaceTabs, truncateToWidth } from "../render/render-utils";
import type { AgentProgress, AgentSource } from "../tools/task";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
	execution?: SubagentExecutionState;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
	execution?: SubagentExecutionState;
}

/** Minimal event subscription surface supplied by the host. */
export interface EventBusLike {
	on(channel: string, listener: (data: unknown) => void): () => void;
}

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Sync task spawns and eval `agent()` spawns additionally render live in
	 * their own inline tool block / eval cell; the pinned HUD jump-lists every
	 * active subagent either way.
	 */
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	/** Latest progress snapshot from the subagent executor */
	progress?: AgentProgress;
	/** Latest lifecycle/progress execution snapshot, including pre-session queue state. */
	execution?: SubagentExecutionState;
	/** Restored snapshot without a live executor; never infer activity from its saved phase. */
	historical?: boolean;
}

/** Coarse source of an observer change; callers use it to separate lifecycle work from high-frequency progress. */
export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};
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

export function latestSubagentExecution(
	...snapshots: Array<SubagentExecutionState | undefined>
): SubagentExecutionState | undefined {
	let latest: SubagentExecutionState | undefined;
	for (const snapshot of snapshots) {
		if (snapshot && (!latest || snapshot.updatedAt > latest.updatedAt)) latest = snapshot;
	}
	return latest;
}

function executionStatus(execution: SubagentExecutionState): ObservableSession["status"] {
	switch (execution.phase) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "aborted";
		default:
			return "active";
	}
}


function progressStatus(progress: AgentProgress): ObservableSession["status"] {
	return progress.status === "running" || progress.status === "pending" ? "active" : progress.status;
}
const PHASE_LABELS: Record<SubagentExecutionPhase, string> = {
	queued: "排队中",
	creating: "创建会话",
	"waiting-model": "等待模型",
	responding: "生成回应",
	tool: "执行工具",
	waiting: "等待中",
	retrying: "自动重试",
	finishing: "收尾中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

const NO_ACTIVITY_HINT_MS = 60_000;
const STALE_HINT_MS = 300_000;
const MAX_EVENT_ROWS = 6;

export type ExecutionViewColor = "accent" | "success" | "warning" | "error" | "dim";

export interface SubagentExecutionView {
	phase?: SubagentExecutionPhase;
	label: string;
	color: ExecutionViewColor;
	active: boolean;
	failed: boolean;
	abnormal: boolean;
	summary: string;
	details: string[];
	events: string[];
}

export interface SubagentExecutionViewInput {
	id: string;
	execution?: SubagentExecutionState;
	status?: AgentProgress["status"] | "active" | "idle" | "parked";
	progress?: AgentProgress;
	error?: string;
	historical?: boolean;
}

function executionDisplayText(text: string, width = 120): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/\s*[\r\n]+\s*/g, " ↵ "), Math.max(1, width));
}

function isExecutionTerminal(phase: SubagentExecutionPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function clock(at: number): string {
	return formatLocalDateTimeWithOffset(new Date(at));
}

function duration(ms: number): string {
	return formatDuration(Math.max(0, ms));
}

export function presentSubagentExecution(
	input: SubagentExecutionViewInput,
	now: number,
	expanded = false,
): SubagentExecutionView {
	const progress = input.progress;
	const execution = input.execution ?? progress?.execution;
	const status = input.status ?? progress?.status;
	const phase = execution?.phase;
	const legacyRetry = !execution && status === "running" ? progress?.retryState : undefined;
	const legacyFailure = !execution ? progress?.retryFailure : undefined;
	const failed = phase ? phase === "failed" : status === "failed";
	const cancelled = phase ? phase === "cancelled" : status === "aborted";
	const completed = phase ? phase === "completed" : status === "completed";
	const stoppedHistory = Boolean(input.historical && phase && !isExecutionTerminal(phase));
	const active = !stoppedHistory && !failed && !cancelled && !completed && status !== "idle" && status !== "parked";
	const label = stoppedHistory
		? `已停止（历史：${phase ? PHASE_LABELS[phase] : "未知"}）`
		: phase
			? PHASE_LABELS[phase]
			: legacyRetry
				? PHASE_LABELS.retrying
				: status === "pending"
					? PHASE_LABELS.queued
					: failed
						? PHASE_LABELS.failed
						: cancelled
							? PHASE_LABELS.cancelled
							: completed
								? PHASE_LABELS.completed
								: active
									? "运行中"
									: "结果未知";
	const retry = phase === "retrying" && !stoppedHistory ? execution?.retry : undefined;
	const retryAt = retry?.retryAt ?? (legacyRetry ? legacyRetry.startedAtMs + legacyRetry.delayMs : undefined);
	const retryError = retry?.error ?? legacyRetry?.errorMessage;
	const attempt = retry?.attempt ?? legacyRetry?.attempt;
	const maxAttempts = retry?.maxAttempts ?? legacyRetry?.maxAttempts;
	const recovery = execution?.recovery;
	const recoveryQueued = Boolean(recovery && !recovery.startedAt && !failed && !cancelled && !completed);
	const snapshotNow =
		execution && (!active || input.historical) ? Math.min(now, execution.stoppedAt ?? execution.updatedAt) : now;
	const activityAge = execution ? Math.max(0, snapshotNow - execution.lastActivityAt) : 0;
	const silent = active && !retry && !legacyRetry && activityAge >= NO_ACTIVITY_HINT_MS;
	const abnormal = failed || cancelled || stoppedHistory || Boolean(retry || legacyRetry || recoveryQueued || silent);
	const color: ExecutionViewColor = failed
		? "error"
		: completed
			? "success"
			: abnormal
				? "warning"
				: active
					? "accent"
					: "dim";
	const summaryParts = [label];
	if (attempt !== undefined) summaryParts.push(`${attempt}/${maxAttempts}`);
	if (retryAt !== undefined) summaryParts.push(retryAt > now ? `${duration(retryAt - now)} 后再试` : "等待重试启动");
	if (recoveryQueued && !stoppedHistory) summaryParts.push("已请求继续，尚未启动");
	else if (active && recovery?.startedAt && execution) summaryParts.push(`已继续 · 第 ${execution.run} 轮`);
	else if (active && execution && execution.run > 1) summaryParts.push(`第 ${execution.run} 轮`);
	const activity = phase === "tool" ? (progress?.currentTool ?? execution?.activity) : execution?.activity;
	if (activity && !abnormal) summaryParts.push(executionDisplayText(activity, 64));
	const details: string[] = [];
	const add = (text: string): void => {
		details.push(executionDisplayText(text, 180));
	};
	if (retryError) add(`失败原因：${retryError}`);
	else if ((abnormal || expanded) && (execution?.lastError || input.error || legacyFailure?.errorMessage)) {
		add(`${failed ? "失败原因" : "最近失败"}：${execution?.lastError ?? input.error ?? legacyFailure?.errorMessage}`);
	}
	if (retryAt !== undefined)
		add(`下次重试：${clock(retryAt)}${retryAt > now ? `（${duration(retryAt - now)} 后）` : "（等待实际启动）"}`);
	if (execution && (expanded || abnormal) && execution.retries > 0) {
		const waiting = retry
			? Math.min(Math.max(0, now - retry.startedAt), Math.max(0, retry.retryAt - retry.startedAt))
			: 0;
		add(`累计重试 ${execution.retries} 次 · 已等待 ${duration(execution.retryWaitMs + waiting)}`);
	} else if (legacyFailure && (failed || cancelled)) {
		add(`自动重试已停止 · 最后尝试 ${legacyFailure.attempt}`);
	}
	if (execution && (expanded || abnormal)) {
		const progressAt = execution.lastProgressAt;
		add(
			progressAt === undefined
				? `尚无成功步骤 · 自任务开始 ${duration(snapshotNow - execution.startedAt)}`
				: `无新进展 ${duration(snapshotNow - progressAt)}${execution.lastProgress ? ` · 上次：${execution.lastProgress}` : ""}`,
		);
		if (expanded || silent)
			add(`无新活动 ${duration(activityAge)}${silent && activityAge >= STALE_HINT_MS ? " · 疑似停滞，尚未确认" : ""}`);
	}
	if (failed || stoppedHistory) {
		const stoppedAge = execution?.stoppedAt !== undefined ? duration(now - execution.stoppedAt) : "unknown duration";
		add(
			stoppedHistory
				? `历史快照不代表仍在运行；已停止 ${stoppedAge}，等待 Main 处理`
				: `已停止 ${stoppedAge}，等待 Main 处理`,
		);
		add(`可对 Main 说「继续 ${executionDisplayText(input.id, 64)}」，由 Main 沿用原会话继续`);
		if (execution?.notification)
			add(execution.notification.state === "delivered" ? "失败通知已送达 Main；等待其决定" : "失败通知待送达 Main");
	}
	if (recovery && (expanded || recoveryQueued)) {
		add(`继续请求：${executionDisplayText(recovery.requestedBy, 40)} · ${clock(recovery.requestedAt)}`);
		if (recovery.startedAt && execution) add(`实际继续：${clock(recovery.startedAt)} · 第 ${execution.run} 轮`);
	}
	if (expanded && execution) {
		add(`任务开始：${clock(execution.startedAt)} · 已启动 ${execution.run} 轮`);
		add(`本阶段：${clock(execution.since)}`);
		if (execution.stoppedAt !== undefined) add(`停止于：${clock(execution.stoppedAt)}`);
		if (execution.notification)
			add(
				`${execution.notification.state === "delivered" ? "已通知 Main" : "等待通知 Main"} · ${clock(execution.notification.at)}`,
			);
		if (execution.activity && abnormal) add(`活动：${execution.activity}`);
	} else if (expanded && !execution) {
		add("旧记录未保存阶段与重试历史；仅显示已有状态");
	}
	const events =
		expanded && execution
			? execution.events
					.slice(-MAX_EVENT_ROWS)
					.map(event =>
						executionDisplayText(
							`${clock(event.at)} · ${PHASE_LABELS[event.phase]}${event.detail ? ` · ${event.detail}` : ""}`,
							180,
						),
					)
			: [];
	return {
		phase,
		label,
		color,
		active,
		failed,
		abnormal,
		summary: executionDisplayText(summaryParts.join(" · ")),
		details,
		events,
	};
}

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	#listeners = new Set<(kind: SessionObserverChangeKind) => void>();
	#eventBusUnsubscribers: Array<() => void> = [];
	#sortOrderById = new Map<string, number>();
	#parentSortOrderById = new Map<string, number>();
	#nextSortOrder = 0;

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: (kind: SessionObserverChangeKind) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(kind: SessionObserverChangeKind): void {
		for (const cb of this.#listeners) cb(kind);
	}

	#ensureSortOrder(id: string): number {
		const existing = this.#sortOrderById.get(id);
		if (existing !== undefined) return existing;
		const order = this.#nextSortOrder++;
		this.#sortOrderById.set(id, order);
		return order;
	}

	#ensureParentSortOrder(parentToolCallId: string | undefined, order: number): void {
		if (!parentToolCallId) return;
		if (this.#parentSortOrderById.has(parentToolCallId)) return;
		this.#parentSortOrderById.set(parentToolCallId, order);
	}

	#getStableOrder(session: ObservableSession): number {
		return this.#sortOrderById.get(session.id) ?? Number.MAX_SAFE_INTEGER;
	}

	#getGroupOrder(session: ObservableSession): number {
		const parentOrder = session.parentToolCallId
			? this.#parentSortOrderById.get(session.parentToolCallId)
			: undefined;
		return parentOrder ?? this.#getStableOrder(session);
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#ensureSortOrder("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners("main");
	}

	/** Return one tracked session without copying or sorting the registry. */
	getSession(id: string): ObservableSession | undefined {
		return this.#sessions.get(id);
	}

	getSessions(): ObservableSession[] {
		const sessions = [...this.#sessions.values()];
		sessions.sort((a, b) => {
			if (a.kind === "main" && b.kind !== "main") return -1;
			if (b.kind === "main" && a.kind !== "main") return 1;
			if (a.kind === "main" || b.kind === "main") return 0;

			const groupDiff = this.#getGroupOrder(a) - this.#getGroupOrder(b);
			if (groupDiff !== 0) return groupDiff;

			const aIndex = a.index ?? Number.MAX_SAFE_INTEGER;
			const bIndex = b.index ?? Number.MAX_SAFE_INTEGER;
			if (aIndex !== bIndex) return aIndex - bIndex;

			return this.#getStableOrder(a) - this.#getStableOrder(b);
		});
		return sessions;
	}

	getActiveSubagentCount(): number {
		let count = 0;
		for (const s of this.#sessions.values()) {
			if (s.kind === "subagent" && s.status === "active") count++;
		}
		return count;
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#notifyListeners("reset");
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBusLike, subagentEventBus: EventBusLike): void {
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		// The task executor dual-publishes every frame on the spawning session's
		// bus and on the session tree's observability bus. Subscribe to both so
		// producers that only emit on the injected session bus still land —
		// dual-published payloads share one object reference, so each is handled
		// exactly once.
		const seen = new WeakSet<object>();
		const dedupe =
			(handle: (data: unknown) => void) =>
			(data: unknown): void => {
				if (data !== null && typeof data === "object") {
					if (seen.has(data as object)) return;
					seen.add(data as object);
				}
				handle(data);
			};

		for (const bus of [eventBus, subagentEventBus]) {
			this.#eventBusUnsubscribers.push(
				bus.on(
					TASK_SUBAGENT_LIFECYCLE_CHANNEL,
					dedupe(data => {
						const payload = data as SubagentLifecyclePayload;
						const status = STATUS_MAP[payload.status];
						if (!status) return;

						const sortOrder = this.#ensureSortOrder(payload.id);
						this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
						const existing = this.#sessions.get(payload.id);
						if (existing) {
							const execution = latestSubagentExecution(payload.execution, existing.execution);
							if (payload.execution && execution !== payload.execution) return;
							const nextStatus = execution ? executionStatus(execution) : status;
							if (
								nextStatus === "active" &&
								(existing.status !== "active" || (execution && execution.run > (existing.execution?.run ?? -1)))
							)
								existing.progress = undefined;
							existing.execution = execution;
							existing.status = nextStatus;
							existing.historical = false;
							existing.lastUpdate = execution?.updatedAt ?? Date.now();
							existing.index = payload.index;
							existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
							existing.detached = payload.detached ?? existing.detached;
							if (payload.description) existing.description = payload.description;
							if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
						} else {
							this.#sessions.set(payload.id, {
								id: payload.id,
								kind: "subagent",
								label: payload.description ?? `Subagent #${payload.index}`,
								agent: payload.agent,
								description: payload.description,
								status: payload.execution ? executionStatus(payload.execution) : status,
								sessionFile: payload.sessionFile,
								parentToolCallId: payload.parentToolCallId,
								detached: payload.detached,
								index: payload.index,
								execution: payload.execution,
								lastUpdate: payload.execution?.updatedAt ?? Date.now(),
							});
						}
						this.#notifyListeners("lifecycle");
					}),
				),
			);

			this.#eventBusUnsubscribers.push(
				bus.on(
					TASK_SUBAGENT_PROGRESS_CHANNEL,
					dedupe(data => {
						const payload = data as SubagentProgressPayload;
						const progress = payload.progress;
						const id = progress.id;
						const existing = this.#sessions.get(id);

						const sortOrder = this.#ensureSortOrder(id);
						this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
						if (existing) {
							const execution = latestSubagentExecution(progress.execution, existing.execution);
							if (progress.execution && execution !== progress.execution) return;
							existing.execution = execution;
							existing.status = execution ? executionStatus(execution) : progressStatus(progress);
							existing.historical = false;
							existing.lastUpdate = execution?.updatedAt ?? Date.now();
							existing.index = payload.index;
							existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
							existing.detached = payload.detached ?? existing.detached;
							existing.progress = progress;
							if (progress.description) existing.description = progress.description;
							if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
						} else {
							this.#sessions.set(id, {
								id,
								kind: "subagent",
								label: progress.description ?? `Subagent #${payload.index}`,
								agent: payload.agent,
								description: progress.description,
								status: progress.execution ? executionStatus(progress.execution) : progressStatus(progress),
								sessionFile: payload.sessionFile,
								parentToolCallId: payload.parentToolCallId,
								detached: payload.detached,
								index: payload.index,
								execution: progress.execution,
								lastUpdate: progress.execution?.updatedAt ?? Date.now(),
								progress,
							});
						}
						this.#notifyListeners("progress");
					}),
				),
			);
		}
	}
}
