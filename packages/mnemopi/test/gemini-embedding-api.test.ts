import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import {
	embed,
	embeddingDimFor,
	embedQuery,
	isApiModel,
	resetEmbeddingProviderForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";

interface CapturedCall {
	url: string;
	init: RequestInit;
}

const ORIGINAL_FETCH = globalThis.fetch;
const calls: CapturedCall[] = [];

function stubFetch(respond: () => Response): void {
	calls.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return respond();
	}) as typeof fetch;
}

function geminiResponse(values: number[]): Response {
	return new Response(JSON.stringify({ embedding: { values } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function openAiResponse(values: number[]): Response {
	return new Response(JSON.stringify({ data: [{ embedding: values }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const GEMINI_ENV = {
	MNEMOPI_EMBEDDING_MODEL: "google/gemini-embedding-2",
	MNEMOPI_EMBEDDING_API_URL: "https://generativelanguage.googleapis.com/v1beta",
	MNEMOPI_EMBEDDING_API_KEY: "test-gemini-key",
	MNEMOPI_NO_EMBEDDINGS: undefined,
	MNEMOPI_EMBEDDINGS_VIA_API: undefined,
} as Record<string, string | undefined>;

const GATEWAY_ENV = {
	...GEMINI_ENV,
	MNEMOPI_EMBEDDING_API_URL: "https://relay.example.com/v1",
} as Record<string, string | undefined>;

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
	const previous: Record<string, string | undefined> = {};
	for (const key in updates) {
		previous[key] = process.env[key];
		if (updates[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = updates[key];
		}
	}
	try {
		return fn();
	} finally {
		for (const key in previous) {
			if (previous[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous[key];
			}
		}
	}
}

function bodyOf(call: CapturedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterAll(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
	resetEmbeddingProviderForTests();
});

describe("gemini embedding model metadata", () => {
	it("routes google/ models to the API", () => {
		expect(isApiModel("google/gemini-embedding-2")).toBe(true);
		expect(isApiModel("google/gemini-embedding-001")).toBe(true);
	});

	it("resolves the 3072-dimensional output", () => {
		expect(embeddingDimFor("google/gemini-embedding-2")).toBe(3072);
		expect(embeddingDimFor("google/gemini-embedding-001")).toBe(3072);
	});
});

describe("gemini native embedContent wire", () => {
	it("recovers from a 429 by honoring the body retryDelay and refetching", async () => {
		let fetched = 0;
		calls.length = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			fetched += 1;
			if (fetched === 1) {
				return new Response(JSON.stringify({ error: { code: 429, retryDelay: "0.5s" } }), { status: 429 });
			}
			return geminiResponse([0.5]);
		}) as typeof fetch;
		const result = await withEnv(GEMINI_ENV, () => embed(["被限流的文档"]));
		expect(result).not.toBeNull();
		expect(Array.from(result?.[0] ?? [])).toEqual([0.5]);
		expect(calls.length).toBe(2);
		const first = bodyOf(calls[0]!);
		const second = bodyOf(calls[1]!);
		expect(first.content).toEqual({ parts: [{ text: "被限流的文档" }] });
		expect(second.content).toEqual({ parts: [{ text: "被限流的文档" }] });
	});

	it("embeds documents with RETRIEVAL_DOCUMENT per text", async () => {
		stubFetch(() => geminiResponse([0.25, 0.5]));
		const result = await withEnv(GEMINI_ENV, () => embed(["记忆文档一", "记忆文档二"]));
		expect(result).not.toBeNull();
		expect(result?.length).toBe(2);
		expect(Array.from(result?.[1] ?? [])).toEqual([0.25, 0.5]);
		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(call.url).toBe(
				"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
			);
			const headers = call.init.headers as Record<string, string>;
			expect(headers["x-goog-api-key"]).toBe("test-gemini-key");
			const body = bodyOf(call);
			expect(body.model).toBe("models/gemini-embedding-2");
			expect(body.taskType).toBe("RETRIEVAL_DOCUMENT");
		}
		expect(bodyOf(calls[0]!).content).toEqual({ parts: [{ text: "记忆文档一" }] });
		expect(bodyOf(calls[1]!).content).toEqual({ parts: [{ text: "记忆文档二" }] });
	});

	it("embeds recall queries with RETRIEVAL_QUERY", async () => {
		stubFetch(() => geminiResponse([0.75]));
		const vector = await withEnv(GEMINI_ENV, () => embedQuery("为什么只有两个应用有磨砂背景"));
		expect(vector).not.toBeNull();
		expect(Array.from(vector ?? [])).toEqual([0.75]);
		expect(calls.length).toBe(1);
		expect(bodyOf(calls[0]!).taskType).toBe("RETRIEVAL_QUERY");
		expect(bodyOf(calls[0]!).content).toEqual({ parts: [{ text: "为什么只有两个应用有磨砂背景" }] });
	});

	it("returns null without throwing when a text fails non-recoverably", async () => {
		// 403 is non-retryable, so fetchWithRetry returns it immediately instead of
		// sleeping through a 5xx backoff ladder that would blow the test timeout.
		stubFetch(() => new Response("forbidden", { status: 403 }));
		const result = await withEnv(GEMINI_ENV, () => embed(["失败的文档"]));
		expect(result).toBeNull();
		expect(calls.length).toBe(1);
	});

	it("requires a configured key", async () => {
		stubFetch(() => geminiResponse([1]));
		const result = await withEnv({ ...GEMINI_ENV, MNEMOPI_EMBEDDING_API_KEY: undefined }, () =>
			embed(["无钥匙文档"]),
		);
		expect(result).toBeNull();
		expect(calls.length).toBe(0);
	});
});

describe("google/ model behind an OpenAI-compatible gateway", () => {
	it("keeps the /embeddings wire shape on a non-Google base URL", async () => {
		stubFetch(() => openAiResponse([0.5, 0.125]));
		const result = await withEnv(GATEWAY_ENV, () => embed(["中转文档"]));
		expect(result).not.toBeNull();
		expect(Array.from(result?.[0] ?? [])).toEqual([0.5, 0.125]);
		expect(calls.length).toBe(1);
		expect(calls[0]!.url).toBe("https://relay.example.com/v1/embeddings");
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-gemini-key");
		const body = bodyOf(calls[0]!);
		expect(body.model).toBe("google/gemini-embedding-2");
		expect(body.input).toEqual(["中转文档"]);
	});
});
