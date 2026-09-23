import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { formatLocalDateTimeWithOffset } from "@oh-my-pi/pi-tui/chrome/local-date";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { SubagentExecutionPhase, SubagentExecutionState } from "./execution-state";

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
	/** One-line phase, including current retry/continuation facts when known. */
	summary: string;
	/** Bounded abnormal detail rows, or full inspection rows when requested. */
	details: string[];
	/** Bounded factual transitions, populated only for an expanded inspector. */
	events: string[];
}

export interface SubagentExecutionViewInput {
	id: string;
	execution?: SubagentExecutionState;
	status?: AgentProgress["status"] | "active" | "idle" | "parked";
	progress?: AgentProgress;
	error?: string;
	/** A cold, unfinished snapshot is not proof of a currently running task. */
	historical?: boolean;
}

/** One terminal-safe line shared by the task card, anchored HUD and Agent Hub. */
export function executionDisplayText(text: string, width = 120): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/\s*[\r\n]+\s*/g, " ↵ "), Math.max(1, width));
}

/** Registry persistence and observer delivery can arrive in either order. */
export function latestSubagentExecution(
	...snapshots: Array<SubagentExecutionState | undefined>
): SubagentExecutionState | undefined {
	let latest: SubagentExecutionState | undefined;
	for (const snapshot of snapshots) {
		if (snapshot && (!latest || snapshot.updatedAt > latest.updatedAt)) latest = snapshot;
	}
	return latest;
}

export function isExecutionTerminal(phase: SubagentExecutionPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function clock(at: number): string {
	return formatLocalDateTimeWithOffset(new Date(at));
}

function duration(ms: number): string {
	return formatDuration(Math.max(0, ms));
}

/** Pure projection: caller supplies its live or frozen clock; no timers or history writes. */
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
		? `已停止（历史：${PHASE_LABELS[phase!]}）`
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
	else if (active && recovery?.startedAt) summaryParts.push(`已继续 · 第 ${execution!.run} 轮`);
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
			add(
				`无新活动 ${duration(activityAge)}${silent && activityAge >= STALE_HINT_MS ? " · 疑似停滞，尚未确认" : ""}`,
			);
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
		if (recovery.startedAt) add(`实际继续：${clock(recovery.startedAt)} · 第 ${execution!.run} 轮`);
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
