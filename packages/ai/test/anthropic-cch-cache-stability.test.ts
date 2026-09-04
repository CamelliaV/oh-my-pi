import { describe, expect, it } from "bun:test";
import { wrapFetchForCch } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { FetchImpl, Message, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Real Claude Code hashes the whole request body into the `cch` attestation that
// rides in `system[0]`. On api.anthropic.com the edge strips that block before
// the prompt reaches the cache layer, so a per-request value is free. A relay
// forwards it verbatim as ordinary system text, where it lands at the very front
// of the cached prefix and invalidates it every turn (measured against a
// CC-fingerprinting relay: 0/6 cache hits, 329k cache-write tokens for one
// six-request session; 3/6 hits and 165k writes once the value held still).
// Upstream declined to fix this (anthropics/claude-code#68900), and omitting the
// block is not an option here because `claude_code_only` relays reject
// CC-scoped credentials that arrive without it.

const BILLING_PLACEHOLDER =
	"x-anthropic-billing-header: cc_version=2.1.246.1cd; cc_entrypoint=claude-desktop; cch=00000;";

function buildBody(options: { userText: string; systemText?: string; toolName?: string }): string {
	const { userText, systemText = "You are a helpful assistant.", toolName = "read_file" } = options;
	// Key order mirrors the Anthropic SDK wire shape: `messages` serializes ahead
	// of `system`, which is what makes the stable region a suffix of the body.
	return JSON.stringify({
		model: "claude-opus-5",
		max_tokens: 64000,
		messages: [{ role: "user", content: userText }],
		system: [
			{ type: "text", text: BILLING_PLACEHOLDER },
			{ type: "text", text: systemText, cache_control: { type: "ephemeral" } },
		],
		tools: [{ name: toolName, description: "Read a file", input_schema: { type: "object" } }],
		metadata: { user_id: '{"session_id":"fixed-session","device_id":"fixed-device"}' },
		stream: true,
	});
}

function captureCch(body: string, stable: boolean): string {
	let sent = "";
	const base: FetchImpl = (_input, init) => {
		sent = new TextDecoder().decode(init?.body as Uint8Array);
		return Promise.resolve(new Response("{}"));
	};
	void wrapFetchForCch(base, stable)("https://relay.example/v1/messages", { method: "POST", body });
	const match = /cch=([0-9a-f]{5})/.exec(sent);
	if (!match?.[1]) throw new Error(`no patched cch in body: ${sent.slice(0, 200)}`);
	return match[1];
}

describe("cch attestation cache stability", () => {
	it("holds cch steady across turns off-official so the cached prefix survives", () => {
		// The regression: only `messages` grew, which is every turn of a tool loop.
		const turn1 = captureCch(buildBody({ userText: "first turn" }), true);
		const turn2 = captureCch(buildBody({ userText: "first turn plus a tool result and more history" }), true);
		expect(turn2).toBe(turn1);
	});

	it("changes cch when the cached prefix itself changes", () => {
		const base = captureCch(buildBody({ userText: "same" }), true);
		const differentSystem = captureCch(buildBody({ userText: "same", systemText: "You are a code reviewer." }), true);
		const differentTools = captureCch(buildBody({ userText: "same", toolName: "write_file" }), true);
		// Over-stabilizing would be its own bug: a stale attestation must not
		// outlive the system prompt or tool catalog it was computed from.
		expect(differentSystem).not.toBe(base);
		expect(differentTools).not.toBe(base);
	});

	it("keeps real CC whole-body hashing on the official endpoint", () => {
		// api.anthropic.com strips the block, so fidelity beats cache stability
		// there; a per-request value is exactly what real Claude Code sends.
		const turn1 = captureCch(buildBody({ userText: "first turn" }), false);
		const turn2 = captureCch(buildBody({ userText: "first turn plus a tool result and more history" }), false);
		expect(turn2).not.toBe(turn1);
	});

	it("always ships a patched 5-hex attestation, never the placeholder", () => {
		// The relay's claude_code_only gate reads this shape; `00000` means unattested.
		for (const stable of [true, false]) {
			const cch = captureCch(buildBody({ userText: "shape check" }), stable);
			expect(cch).toMatch(/^[0-9a-f]{5}$/);
			expect(cch).not.toBe("00000");
		}
	});

	it("passes bodies without the billing placeholder through untouched", () => {
		let sent: unknown;
		const base: FetchImpl = (_input, init) => {
			sent = init?.body;
			return Promise.resolve(new Response("{}"));
		};
		const apiKeyBody = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] });
		void wrapFetchForCch(base, true)("https://relay.example/v1/messages", { method: "POST", body: apiKeyBody });
		// API-key requests never carry the block; they must not be re-encoded.
		expect(sent).toBe(apiKeyBody);
	});
});

// Second, independent prefix breaker found the same way (byte-diffing consecutive
// wire bodies of one tool loop): `applyPromptCaching` can only attach
// `cache_control` to a content block, so a string-content user message was
// rewritten into a single-element block array whenever it held the rolling cache
// anchor - and serialized back as a bare string once the window moved past it.
// Every user turn therefore rewrote a byte in the middle of the cached prefix.
// `convertAnthropicMessages` now always emits block form so the shape no longer
// depends on the anchor position.
describe("wire shape stability of the cached prefix", () => {
	const model: Model<"anthropic-messages"> = buildModel({
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://relay.example",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	});
	const userTurn = (text: string): Message => ({ role: "user", content: text, timestamp: 1 }) as unknown as Message;
	const assistantTurn = (text: string): Message =>
		({
			role: "assistant",
			content: [{ type: "text", text }],
			model: "claude-opus-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			stopReason: "stop",
			timestamp: 1,
		}) as unknown as Message;

	it("serializes a user turn identically whether or not it holds the cache anchor", () => {
		const history: Message[] = [userTurn("Q1"), assistantTurn("A1"), userTurn("Q2")];
		// Turn 1: Q1 is the trailing message, so it owns the rolling anchor.
		const anchored = convertAnthropicMessages([history[0]], model, true);
		// Turn 2: the anchor has moved to Q2; Q1 is now interior cached prefix.
		const interior = convertAnthropicMessages(history, model, true);
		const strip = (message: MessageParam): string =>
			JSON.stringify(message, (key, value) => (key === "cache_control" ? undefined : value));
		expect(strip(interior[0])).toBe(strip(anchored[0]));
	});

	it("keeps every interior turn byte-stable as a tool loop grows", () => {
		const full: Message[] = [
			userTurn("Q1"),
			assistantTurn("A1"),
			userTurn("Q2"),
			assistantTurn("A2"),
			userTurn("Q3"),
		];
		const strip = (message: MessageParam): string =>
			JSON.stringify(message, (key, value) => (key === "cache_control" ? undefined : value));
		// Each turn of a loop re-sends the whole history plus new entries. Any
		// interior message that serializes differently between two consecutive
		// requests truncates the reusable prefix at that point.
		const turns = [1, 3, 5].map(length => convertAnthropicMessages(full.slice(0, length), model, true));
		for (let turn = 1; turn < turns.length; turn++) {
			const previous = turns[turn - 1];
			for (let index = 0; index < previous.length; index++) {
				expect(strip(turns[turn][index])).toBe(strip(previous[index]));
			}
		}
	});
});
