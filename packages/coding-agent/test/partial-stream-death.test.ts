/**
 * A mid-stream transport death — idle stall, HTTP/2 reset, premature gateway
 * close, Bun socket closure — that arrives AFTER the turn committed visible
 * output.
 *
 * Contract under test: the streamed partial is real, user-visible history, so
 * replaying the turn would print the delivered text twice. The session must
 * instead KEEP the partial turn, append a hidden resume directive, and continue
 * — producing the completion the dead stream owed, with no auto-retry attempt
 * (there is nothing to wait for) and no duplicated output.
 *
 * The sibling tool-call case is deliberately excluded: when every emitted call
 * has a result the turn resumes by re-issuing those calls
 * (`classifyResolvedInterruptedToolTurn`), which is asserted separately in
 * turn-recovery-replay-unsafe.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The exact Bun wording from the live failure that motivated this path. */
const SOCKET_CLOSE =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function baseMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Streams `text`, then terminates with a transport error carrying `errorMessage`. */
function dyingStream(model: Model, text: string, errorMessage: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const partial = baseMessage(model);
	stream.push({ type: "start", partial });
	partial.content.push({ type: "text", text });
	stream.push({ type: "text_start", contentIndex: 0, partial });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
	partial.stopReason = "error";
	partial.errorMessage = errorMessage;
	stream.push({ type: "error", reason: "error", error: partial });
	return stream;
}

/** Streams `text` to a clean `stop`. */
function successStream(model: Model, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const done = baseMessage(model);
	done.content.push({ type: "text", text });
	stream.push({ type: "start", partial: done });
	stream.push({ type: "text_start", contentIndex: 0, partial: done });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: done });
	stream.push({ type: "done", reason: "stop", message: done });
	return stream;
}

describe("partial-stream death continuation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager | undefined;

	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	beforeAll(async () => {
		authStorage = await AuthStorage.create(
			path.join(TempDir.createSync("@pi-partial-death-fixture-").path(), "a.db"),
		);
		modelRegistry = new ModelRegistry(
			authStorage,
			path.join(TempDir.createSync("@pi-partial-death-fixture-").path(), "m.yml"),
		);
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-partial-death-");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		await sessionManager?.close();
		session = undefined;
		sessionManager = undefined;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * Drive one prompt where the first `dyingCount` attempts die mid-stream with
	 * committed text, then stream a clean completion. Returns the recorded wire
	 * requests, so a test can assert what the model was actually sent.
	 */
	async function run(dyingCount: number, errorMessage = SOCKET_CLOSE) {
		const requests: Context[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (requestedModel: Model, context: Context, _options?: SimpleStreamOptions) => {
				requests.push(context);
				return requests.length <= dyingCount
					? dyingStream(requestedModel, `partial part ${requests.length}`, errorMessage)
					: successStream(requestedModel, "completed the interrupted answer");
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const events: string[] = [];
		session.subscribe((event: AgentSessionEvent) => events.push(event.type));
		await session.prompt("Explain the divergence");
		await session.waitForIdle();
		return { agent, requests, events, session };
	}

	it("continues a socket death after committed text instead of pinning the error", async () => {
		const { agent, requests, events } = await run(1);

		// The continuation is a fresh provider call whose input ends in the hidden
		// resume directive — never a retry of the same request.
		expect(requests).toHaveLength(2);
		expect(events).not.toContain("auto_retry_start");
		expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "developer" });

		// The partial turn survives as real history: it is what the user already saw.
		const partials = agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
		);
		expect(partials).toHaveLength(1);
		expect(partials[0]!.content).toEqual([{ type: "text", text: "partial part 1" }]);

		// The run ends on the continued completion, not on the error.
		const tail = agent.state.messages.at(-1);
		expect(tail?.role).toBe("assistant");
		if (tail?.role !== "assistant") throw new Error("Expected assistant tail");
		expect(tail.stopReason).toBe("stop");
		expect(tail.content).toEqual([{ type: "text", text: "completed the interrupted answer" }]);
	});

	it("keeps the partial turn so the resumed request never replays the delivered text", async () => {
		const { requests } = await run(1);
		const resumed = requests[1]!.messages;

		// The partial turn is present exactly once — a replay would reissue the
		// prompt without it, and a naive retry would re-run it from scratch.
		const partialTurns = resumed.filter(
			message =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "text" && block.text === "partial part 1"),
		);
		expect(partialTurns).toHaveLength(1);
		// Exactly one directive exists — the cap must not accumulate notices.
		expect(resumed.filter(message => message.role === "developer")).toHaveLength(1);
	});

	it("stops after the resume cap instead of looping on a route that keeps dying", async () => {
		const { requests, agent } = await run(Number.POSITIVE_INFINITY);
		// Initial attempt + one per bounded resume.
		expect(requests.length).toBe(4);
		const tail = agent.state.messages.at(-1);
		expect(tail?.role).toBe("assistant");
		if (tail?.role !== "assistant") throw new Error("Expected assistant tail");
		// Capped: the error is surfaced rather than retried forever.
		expect(tail.stopReason).toBe("error");
	});

	it("does not continue a death that arrived before any output committed", async () => {
		// No committed text ⇒ nothing to preserve, so the ordinary retry path owns
		// the turn and this branch must stay out of the way.
		const requests: Context[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (requestedModel: Model, context: Context) => {
				requests.push(context);
				const stream = new AssistantMessageEventStream();
				const failed = baseMessage(requestedModel);
				failed.stopReason = "error";
				failed.errorMessage = SOCKET_CLOSE;
				stream.push({ type: "start", partial: failed });
				stream.push({ type: "error", reason: "error", error: failed });
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 0,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Explain the divergence");
		await session.waitForIdle();

		// No directive was appended: the empty death produced no developer tail.
		expect(agent.state.messages.some(message => message.role === "developer")).toBe(false);
	});
});
