import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	EXPLAIN_EXCERPT_LIMITS,
	buildExplainExcerpt,
	explainSessionTitle,
	prepareExplainRequest,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/explain";

let timestamp = 0;

function nextTimestamp(): number {
	timestamp += 1;
	return timestamp;
}

function user(text: string, synthetic = false): UserMessage {
	return { role: "user", content: text, timestamp: nextTimestamp(), synthetic };
}

function assistant(content: AssistantMessage["content"], stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: nextTimestamp(),
	};
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id: `call-${nextTimestamp()}`, name, arguments: args };
}

function toolResult(toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${nextTimestamp()}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: nextTimestamp(),
	};
}

function turn(text: string, reply: string): AgentMessage[] {
	return [user(text), assistant([{ type: "text", text: reply }])];
}

describe("/explain registration", () => {
	it("is a discoverable builtin that accepts an optional focus", () => {
		const command = lookupBuiltinSlashCommand("explain");
		expect(command?.name).toBe("explain");
		expect(command?.allowArgs).toBe(true);
		expect(command?.inlineHint).toBe("[focus]");
		expect(command?.description).toContain("new session");
	});

	it("surfaces a dedicated Explainer model role in /model", () => {
		const settings = Settings.isolated({});
		expect(getKnownRoleIds(settings)).toContain("explainer");
		expect(getRoleInfo("explainer", settings)).toMatchObject({ tag: "EXPLAIN", name: "Explainer" });
		expect(roleDefaultModels().explainer?.[0]).toBe("aistudio/gemini-3.8-flash");
	});
});

describe("buildExplainExcerpt", () => {
	it("keeps the newest three complete turns and reports the omitted older ones", () => {
		const messages = [
			...turn("goal one", "reply one"),
			...turn("goal two", "reply two"),
			...turn("goal three", "reply three"),
			...turn("goal four", "reply four"),
			...turn("goal five", "reply five"),
		] as AgentMessage[];
		const result = buildExplainExcerpt(messages);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.excerpt.text).toContain("goal three");
		expect(result.excerpt.text).toContain("goal four");
		expect(result.excerpt.text).toContain("goal five");
		expect(result.excerpt.text).not.toContain("goal one");
		expect(result.excerpt.text).not.toContain("goal two");
		expect(result.excerpt.turnsIncluded).toBe(3);
		expect(result.excerpt.turnsOmitted).toBe(2);
		expect(result.excerpt.goal).toBe("goal one");
	});

	it("drops a trailing user turn that has no reply yet", () => {
		const messages = [...turn("the real work", "it is done"), user("next request")] as AgentMessage[];
		const result = buildExplainExcerpt(messages);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.excerpt.text).toContain("the real work");
		expect(result.excerpt.text).not.toContain("next request");
		expect(result.excerpt.turnsOmitted).toBe(0);
		expect(result.excerpt.goal).toBeUndefined();
	});

	it("reports no completed work before the first reply", () => {
		const result = buildExplainExcerpt([user("only a request")]);
		expect(result).toEqual({ ok: false, reason: "The latest turn has no reply to explain yet." });
	});

	it("keeps the opening ask and the final conclusion when one turn exceeds the budget", () => {
		const steps: AgentMessage[] = [];
		for (let index = 0; index < 30; index++) {
			steps.push(assistant([toolCall("bash", { command: `step ${index}` })]));
			steps.push(toolResult("bash", `step output ${index} ${"y".repeat(1_500)}`));
		}
		const messages = [
			user("the root question"),
			...steps,
			assistant([{ type: "text", text: "the final conclusion" }]),
		] as AgentMessage[];
		const result = buildExplainExcerpt(messages);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.excerpt.chars).toBe(EXPLAIN_EXCERPT_LIMITS.maxChars);
		expect(result.excerpt.text.length).toBeLessThanOrEqual(EXPLAIN_EXCERPT_LIMITS.maxChars + 200);
		expect(result.excerpt.text).toContain("the root question");
		expect(result.excerpt.text).toContain("the final conclusion");
		expect(result.excerpt.text).toContain("characters omitted");
	});

	it("omits thinking but keeps tool calls and error results", () => {
		const messages = [
			user("debug it"),
			assistant([{ type: "thinking", thinking: "secret chain of thought" }, toolCall("bash", { command: "false" })]),
			toolResult("bash", "command failed", true),
			assistant([{ type: "text", text: "fixed the guard" }]),
		] as AgentMessage[];
		const result = buildExplainExcerpt(messages);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.excerpt.text).not.toContain("secret chain of thought");
		expect(result.excerpt.text).toContain("tool call `bash`");
		expect(result.excerpt.text).toContain("Tool result: bash (error)");
		expect(result.excerpt.text).toContain("fixed the guard");
	});

	it("ignores synthetic user prompts as turn boundaries", () => {
		const messages = [
			user("real request"),
			user("auto-continue", true),
			assistant([{ type: "text", text: "real reply" }]),
		] as AgentMessage[];
		const result = buildExplainExcerpt(messages);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.excerpt.text).toContain("real request");
		expect(result.excerpt.text).toContain("real reply");
		expect(result.excerpt.turnsIncluded).toBe(1);
	});
});

describe("prepareExplainRequest", () => {
	const messages = [
		...turn("first goal", "first reply"),
		...turn("second goal", "second reply"),
		...turn("third goal", "third reply"),
		...turn("fourth goal", "fourth reply"),
		...turn("fifth goal", "fifth reply"),
	] as AgentMessage[];

	it("embeds the source id, tail excerpt, focus, and role contract", () => {
		const result = prepareExplainRequest({
			sourceSessionId: "session-123",
			sourceSessionTitle: "Fix the cache",
			sourceSessionFile: "/tmp/session-123.jsonl",
			messages,
			focus: "why the cache key changed",
			role: "ROLE CONTRACT",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.prompt).toContain("Session id: session-123");
		expect(result.prompt).toContain("Session title: Fix the cache");
		expect(result.prompt).toContain("/tmp/session-123.jsonl");
		expect(result.prompt).toContain("why the cache key changed");
		expect(result.prompt).toContain("ROLE CONTRACT");
		expect(result.prompt).toContain("### User");
		expect(result.prompt).toContain("third goal");
		expect(result.prompt).toContain("### Assistant");
		expect(result.prompt).toContain("third reply");
		expect(result.prompt).not.toContain("second goal");
		expect(result.prompt).toContain("<session-goal>");
		expect(result.prompt).toContain("first goal");
		expect(result.prompt).toContain("2 earlier completed turn(s) are omitted");
	});

	it("omits the redundant goal and coverage block when the whole session fits", () => {
		const result = prepareExplainRequest({
			sourceSessionId: "short",
			messages: turn("only goal", "only reply"),
			role: "ROLE CONTRACT",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.prompt).not.toContain("<session-goal>");
		expect(result.prompt).not.toContain("<coverage>");
	});

	it("caps a pasted focus argument", () => {
		const result = prepareExplainRequest({
			sourceSessionId: "focus-cap",
			messages: turn("goal", "reply"),
			focus: "z".repeat(EXPLAIN_EXCERPT_LIMITS.focusChars + 2_000),
			role: "ROLE CONTRACT",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.prompt).not.toContain("z".repeat(EXPLAIN_EXCERPT_LIMITS.focusChars + 1));
		expect(result.prompt).toContain("characters omitted");
	});

	it("returns the no-reply reason instead of rendering an empty assignment", () => {
		const result = prepareExplainRequest({
			sourceSessionId: "pending",
			messages: [user("still waiting")],
			role: "ROLE CONTRACT",
		});
		expect(result).toEqual({ ok: false, reason: "The latest turn has no reply to explain yet." });
	});
});

describe("explainSessionTitle", () => {
	it("names the explainer after the source title or id prefix", () => {
		expect(explainSessionTitle("Fix the cache", "abcdef")).toBe("Explain · Fix the cache");
		expect(explainSessionTitle(undefined, "abcdef1234567890")).toBe("Explain · abcdef1234567");
	});
});
