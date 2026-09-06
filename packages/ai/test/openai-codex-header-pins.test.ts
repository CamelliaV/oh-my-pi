/**
 * Provider-pinned Codex identity headers survive to the wire. Contract:
 * a models.yml `headers:` entry (e.g. `User-Agent: codex_cli_rs/0.45.0` for
 * `codex_cli_only` relays that 403 non-official UAs) is authoritative —
 * `createCodexHeaders` fills `originator`/`User-Agent` only when the caller
 * did not supply them, the same caller-wins rule `withInferenceUserAgent`
 * applies at the transport layer and `applyCodexResidencyHeader` applies a
 * few lines up. Unpinned providers keep omp's own Codex client identity.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "bun:test";
import { OPENAI_HEADER_VALUES } from "@oh-my-pi/pi-catalog/wire/codex";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";

beforeEach(() => {
	__resetProxyCache();
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(headers?: Record<string, string>): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
		headers,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

async function captureRequestHeaders(model: Model<"openai-codex-responses">): Promise<Headers> {
	const captured: Headers[] = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.push(init?.headers instanceof Headers ? new Headers(init.headers) : new Headers(init?.headers));
		return new Response(createCompletedCodexSse("Hello"), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
		apiKey: createCodexTestToken(),
		fetch: fetchMock as FetchImpl,
	}).result();
	expect(result.stopReason).toBe("stop");
	const [headers] = captured;
	if (headers === undefined) throw new Error("expected the SSE request to reach fetch");
	return headers;
}

describe("codex identity header pins", () => {
	it("keeps a model-pinned User-Agent and originator on the wire", async () => {
		// models.yml shape: mixed-case keys, official-client values.
		const headers = await captureRequestHeaders(
			createCodexTestModel({
				"User-Agent": "codex_cli_rs/0.45.0",
				originator: "codex_cli_rs/0.45.0",
			}),
		);
		expect(headers.get("user-agent")).toBe("codex_cli_rs/0.45.0");
		expect(headers.get("originator")).toBe("codex_cli_rs/0.45.0");
		expect(headers.get("user-agent")).not.toBe(USER_AGENT);
	});

	it("fills omp's own originator and User-Agent when the provider pins none", async () => {
		const headers = await captureRequestHeaders(createCodexTestModel());
		expect(headers.get("originator")).toBe(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		expect(headers.get("user-agent")).toBe(USER_AGENT);
	});

	it("lets a pin override only the pinned header", async () => {
		const headers = await captureRequestHeaders(createCodexTestModel({ originator: "codex_cli_rs/0.45.0" }));
		expect(headers.get("originator")).toBe("codex_cli_rs/0.45.0");
		expect(headers.get("user-agent")).toBe(USER_AGENT);
	});
});
