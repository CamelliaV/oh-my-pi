import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../../registry/persisted-agents";
import {
	createQueuedSubagentProgress,
	publishSubagentProgress,
	recordSubagentExecution,
} from "../../task/execution-progress";
import {
	createSubagentExecution,
	requestSubagentRecovery,
	transitionSubagentExecution,
} from "../../task/execution-state";
import type { ToolSession } from "..";
import { executeSend } from "./messaging";
import { type CoordinationDetails, hubErrorResult } from "./types";

/** Explicit, idempotent continuation; ordinary peer questions remain ordinary sends. */
export async function executeResume(
	session: ToolSession,
	params: { to?: string; message?: string },
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const registry = session.agentRegistry;
	const senderId = session.getAgentId?.() ?? MAIN_AGENT_ID;
	const to = params.to?.trim();
	const message = params.message?.trim();
	if (!registry || !to || to === "all" || to === senderId || !message) {
		return hubErrorResult("resume requires one subagent id in `to` and continuation instructions in `message`.", {
			op: "resume",
			from: senderId,
			to,
		});
	}
	if (session.getPlanModeState?.()?.enabled || session.restrictToolNames) {
		return hubErrorResult("Subagent continuation is unavailable in plan mode or a restricted session.", {
			op: "resume",
			from: senderId,
			to,
		});
	}
	const root = await ensurePersistedRoster(registry, session.getSessionFile());
	if (signal?.aborted) throw signal.reason ?? new Error("Continuation cancelled before delivery");
	const ref = registry.get(to);
	if (!ref || ref.kind !== "sub" || !isCurrentSessionRosterRef(ref, root)) {
		return hubErrorResult(`No resumable subagent "${to}" belongs to this session. Use hub list to identify it.`, {
			op: "resume",
			from: senderId,
			to,
		});
	}
	if (ref.status === "aborted") {
		return hubErrorResult(
			`子任务 ${to} 已被明确终止，原会话不可续跑。可读取 history://${to} 后重新派发；不得把替代任务称为原会话恢复。`,
			{ op: "resume", from: senderId, to },
		);
	}
	const previous = ref.history?.execution ?? createSubagentExecution(ref.createdAt);
	if (
		previous.recovery &&
		!previous.recovery.startedAt &&
		(previous.phase === "queued" || previous.phase === "creating")
	) {
		return {
			content: [{ type: "text", text: `${to} 的续跑已在安排中，未重复提交。当前阶段：${previous.phase}。` }],
			details: { op: "resume", from: senderId, to, execution: previous },
		};
	}
	if (ref.status === "running" || ref.session?.isStreaming) {
		return {
			content: [{ type: "text", text: `${to} 已在运行，未创建第二次运行。如需补充指令，请使用 hub send。` }],
			details: { op: "resume", from: senderId, to, execution: ref.history?.execution },
		};
	}
	const requested = requestSubagentRecovery(previous, senderId);
	const progress = createQueuedSubagentProgress({
		id: to,
		agent: ref.history?.agent ?? ref.displayName,
		agentSource: "user",
		task: message,
		description: ref.activity,
	});
	progress.execution = requested;
	const metadata = { detached: true, sessionFile: ref.sessionFile ?? undefined };
	recordSubagentExecution(registry, to, requested, ref.sessionFile ?? undefined);
	publishSubagentProgress(session, progress, metadata);
	try {
		const delivered = await executeSend(
			{ registry, senderId, settings: session.settings, sessionFileHint: session.getSessionFile() },
			{ to, message },
			signal,
		);
		if (delivered.isError) {
			const reason = delivered.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
			throw new Error(reason || "Continuation delivery failed");
		}
		const current = registry.get(to)?.history?.execution ?? requested;
		const running = current.run > previous.run;
		return {
			content: [
				{
					type: "text",
					text: running
						? `已向 ${to} 的原会话提交续跑，第 ${current.run} 次运行已开始。任务尚未完成，仍需观察后续结果。`
						: `已向 ${to} 的原会话提交续跑请求，保留上下文与累计重试记录。当前等待唤醒或执行名额；尚不能声称已经恢复工作。`,
				},
			],
			details: { ...delivered.details, op: "resume", from: senderId, to, execution: current },
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// A concurrent wake already owns a newer run: never overwrite it with this delivery's failure.
		const current = registry.get(to)?.history?.execution;
		if (
			!current ||
			(current.run === requested.run && current.recovery?.requestedAt === requested.recovery?.requestedAt)
		) {
			const failed = transitionSubagentExecution(requested, "failed", `续跑未启动：${reason}`);
			progress.status = "failed";
			progress.execution = failed;
			recordSubagentExecution(registry, to, failed, ref.sessionFile ?? undefined);
			publishSubagentProgress(session, progress, metadata);
		}
		return hubErrorResult(
			`无法继续 ${to}：${reason}\n原任务未恢复。读取 history://${to} 检查原因；确需替代任务时明确重新派发。`,
			{ op: "resume", from: senderId, to, execution: registry.get(to)?.history?.execution },
		);
	}
}
