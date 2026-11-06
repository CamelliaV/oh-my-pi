/**
 * Build the bounded recent-transcript window seeded into a fresh `/explain`
 * session. The explainer role lives in `prompts/agents/explainer.md`; this
 * module only selects and renders evidence.
 *
 * A "turn" starts at a real user message and runs until the next one. Selection
 * walks backward so the newest work always wins the budget: at most
 * {@link EXPLAIN_EXCERPT_LIMITS.maxTurns} complete turns, at most
 * {@link EXPLAIN_EXCERPT_LIMITS.maxChars} rendered characters. Trailing turns
 * without an assistant/tool reply are skipped (there is nothing to explain yet),
 * and older turns are replaced by the session goal and compaction summary.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import explainCommandTemplate from "../../prompts/system/explain-command.md" with { type: "text" };

export const EXPLAIN_EXCERPT_LIMITS = {
	/** Completed turns kept at the tail of the source session. */
	maxTurns: 3,
	/** Rendered transcript budget; roughly 9k English tokens or 36k CJK tokens. */
	maxChars: 36_000,
	userChars: 4_000,
	assistantChars: 4_000,
	toolArgsChars: 500,
	toolResultChars: 1_800,
	toolErrorChars: 2_800,
	goalChars: 2_000,
	summaryChars: 3_000,
	focusChars: 2_000,
	titleChars: 60,
} as const;

/** Why `/explain` cannot start its session now, or undefined when it can. */
export function explainBlockedReason(session: { isStreaming: boolean; isCompacting: boolean }): string | undefined {
	if (session.isStreaming) return "Wait for the current turn to finish before running /explain.";
	if (session.isCompacting) return "Wait for compaction to finish before running /explain.";
	return undefined;
}

export interface ExplainExcerpt {
	/** Rendered recent turns, oldest first. */
	text: string;
	/** The first real user message, when it is older than the excerpt. */
	goal?: string;
	/** Latest compaction summary, when the source session was compacted. */
	summary?: string;
	turnsIncluded: number;
	turnsOmitted: number;
	messagesIncluded: number;
	chars: number;
}

export type ExplainExcerptResult = { ok: true; excerpt: ExplainExcerpt } | { ok: false; reason: string };

export interface PrepareExplainInput {
	sourceSessionId: string;
	sourceSessionTitle?: string;
	sourceSessionFile?: string;
	messages: readonly AgentMessage[];
	focus?: string;
	role: string;
}

export type PrepareExplainResult =
	| { ok: true; prompt: string; excerpt: ExplainExcerpt }
	| { ok: false; reason: string };

interface RenderedTurn {
	text: string;
	messages: number;
}

function messageRole(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	return typeof message.role === "string" ? message.role : undefined;
}

function messageContent(message: unknown): unknown {
	if (!isRecord(message) || !("content" in message)) return undefined;
	return message.content;
}

/** Render provider content blocks without trusting any member shape. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Head/tail clip: keep the opening ask and the latest conclusion, drop the middle. */
function clip(text: string, max: number): string {
	const value = text.trim();
	if (value.length <= max) return value;
	if (max <= 80) return `${value.slice(0, max).trimEnd()}…`;
	const tail = Math.floor(max * 0.3);
	const marker = `\n…[${value.length - max} characters omitted]…\n`;
	const head = Math.max(0, max - tail - marker.length);
	return `${value.slice(0, head).trimEnd()}${marker}${value.slice(-tail).trimStart()}`;
}

function isRealUser(message: unknown): boolean {
	if (messageRole(message) !== "user" || !isRecord(message)) return false;
	return message.synthetic !== true && message.steering !== true;
}

function messageText(message: unknown): string {
	switch (messageRole(message)) {
		case "user":
		case "developer":
			return contentText(messageContent(message));
		case "compactionSummary":
		case "branchSummary": {
			if (!isRecord(message)) return "";
			const summary = message.summary;
			return typeof summary === "string" ? summary : "";
		}
		default:
			return "";
	}
}

function renderMessage(message: unknown): string {
	switch (messageRole(message)) {
		case "user": {
			const text = messageText(message);
			return text.trim() ? `### User\n${clip(text, EXPLAIN_EXCERPT_LIMITS.userChars)}` : "";
		}
		case "assistant": {
			const parts: string[] = [];
			const content = messageContent(message);
			if (Array.isArray(content)) {
				const texts: string[] = [];
				for (const block of content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
				}
				const text = texts.join("\n");
				if (text.trim()) parts.push(clip(text, EXPLAIN_EXCERPT_LIMITS.assistantChars));
				for (const block of content) {
					if (!isRecord(block) || block.type !== "toolCall") continue;
					const name = typeof block.name === "string" ? block.name : "unknown";
					let args = "";
					try {
						args = JSON.stringify(block.arguments ?? {});
					} catch {
						args = String(block.arguments);
					}
					parts.push(`- tool call \`${name}\` ${clip(args, EXPLAIN_EXCERPT_LIMITS.toolArgsChars)}`);
				}
			}
			return parts.length > 0 ? `### Assistant\n${parts.join("\n")}` : "";
		}
		case "toolResult": {
			if (!isRecord(message)) return "";
			const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
			const text = contentText(messageContent(message));
			const limit =
				message.isError === true ? EXPLAIN_EXCERPT_LIMITS.toolErrorChars : EXPLAIN_EXCERPT_LIMITS.toolResultChars;
			const status = message.isError === true ? " (error)" : "";
			return `### Tool result: ${name}${status}\n${clip(text, limit)}`;
		}
		default:
			return "";
	}
}

function turnStarts(messages: readonly AgentMessage[]): number[] {
	const starts: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (isRealUser(messages[index])) starts.push(index);
	}
	return starts;
}

function renderTurn(messages: readonly AgentMessage[], start: number, end: number): RenderedTurn {
	const blocks: string[] = [];
	let count = 0;
	for (let index = start; index < end; index++) {
		const text = renderMessage(messages[index]);
		if (!text) continue;
		blocks.push(text);
		count++;
	}
	return { text: blocks.join("\n\n"), messages: count };
}

function hasReply(messages: readonly AgentMessage[], start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const role = messageRole(messages[index]);
		if (role === "assistant" || role === "toolResult") return true;
	}
	return false;
}

function latestCompactionSummary(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (messageRole(message) !== "compactionSummary") continue;
		const summary = messageText(message).trim();
		if (summary) return clip(summary, EXPLAIN_EXCERPT_LIMITS.summaryChars);
	}
	return undefined;
}

function firstRealUserText(messages: readonly AgentMessage[]): string | undefined {
	for (const message of messages) {
		if (!isRealUser(message)) continue;
		const text = messageText(message).trim();
		if (text) return clip(text, EXPLAIN_EXCERPT_LIMITS.goalChars);
	}
	return undefined;
}

/**
 * Select the latest complete turns from a resolved session context.
 * Returns a user-facing reason when there is no completed work yet.
 */
export function buildExplainExcerpt(messages: readonly AgentMessage[]): ExplainExcerptResult {
	const starts = turnStarts(messages);
	if (starts.length === 0) return { ok: false, reason: "No user turn to explain yet." };
	const turns: RenderedTurn[] = [];
	for (let index = 0; index < starts.length; index++) {
		const start = starts[index]!;
		const end = starts[index + 1] ?? messages.length;
		if (!hasReply(messages, start, end)) continue;
		turns.push(renderTurn(messages, start, end));
	}
	if (turns.length === 0) return { ok: false, reason: "The latest turn has no reply to explain yet." };

	const selected: RenderedTurn[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0 && selected.length < EXPLAIN_EXCERPT_LIMITS.maxTurns; index--) {
		const turn = turns[index]!;
		if (selected.length > 0 && used + turn.text.length > EXPLAIN_EXCERPT_LIMITS.maxChars) break;
		if (selected.length === 0 && turn.text.length > EXPLAIN_EXCERPT_LIMITS.maxChars) {
			selected.unshift({ ...turn, text: clip(turn.text, EXPLAIN_EXCERPT_LIMITS.maxChars) });
			used = EXPLAIN_EXCERPT_LIMITS.maxChars;
			break;
		}
		selected.unshift(turn);
		used += turn.text.length;
	}

	const included = selected.reduce((sum, turn) => sum + turn.messages, 0);
	const firstSelectedTurn = turns.length - selected.length;
	return {
		ok: true,
		excerpt: {
			text: selected.map(turn => turn.text).join("\n\n"),
			// The goal is redundant when the excerpt already opens on the first turn.
			goal: firstSelectedTurn > 0 ? firstRealUserText(messages) : undefined,
			summary: latestCompactionSummary(messages),
			turnsIncluded: selected.length,
			turnsOmitted: firstSelectedTurn,
			messagesIncluded: included,
			chars: used,
		},
	};
}

/** Render the explainer assignment that seeds the new session. */
export function prepareExplainRequest(input: PrepareExplainInput): PrepareExplainResult {
	const result = buildExplainExcerpt(input.messages);
	if (!result.ok) return result;
	const { excerpt } = result;
	if (!excerpt.text.trim()) return { ok: false, reason: "No recent conversation to explain yet." };
	const rendered = prompt.render(explainCommandTemplate, {
		sourceSessionId: input.sourceSessionId,
		sourceSessionTitle: input.sourceSessionTitle
			? oneLineLabel(input.sourceSessionTitle, EXPLAIN_EXCERPT_LIMITS.titleChars)
			: undefined,
		sourceSessionFile: input.sourceSessionFile,
		focus: input.focus?.trim() ? clip(input.focus.trim(), EXPLAIN_EXCERPT_LIMITS.focusChars) : undefined,
		role: input.role.trim(),
		excerpt: excerpt.text,
		goal: excerpt.goal,
		sessionSummary: excerpt.summary,
		omittedTurns: excerpt.turnsOmitted > 0 ? excerpt.turnsOmitted : undefined,
	});
	return { ok: true, prompt: rendered, excerpt };
}

/** Session title for the explainer transcript; stable and picker-friendly. */
export function explainSessionTitle(sourceTitle: string | undefined, sourceSessionId: string): string {
	const source = sourceTitle?.trim()
		? oneLineLabel(sourceTitle, EXPLAIN_EXCERPT_LIMITS.titleChars)
		: sourceSessionId.slice(0, 13);
	return `Explain · ${source}`;
}
