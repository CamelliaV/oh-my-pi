import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
	buildCompactionV2Request,
	getCompactionV2Endpoint,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const nativeInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "remember fixture" }] }];

function model(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6-astra",
		name: "Proxy compaction fixture",
		provider: "codex-proxy-fixture",
		api: "openai-codex-responses",
		baseUrl: "https://relay.example.test/v1/responses",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		preferWebsockets: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function response(streaming: boolean): Response {
	const item = { type: "compaction", encrypted_content: "fixture-encrypted" };
	if (!streaming) return Response.json({ output: [item] });
	return new Response(
		[
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { status: "completed" } },
		]
			.map(event => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Codex proxy compaction", () => {
	// A relay accepts normal turns but rejects compaction if the lazily configured
	// client identity disappears. V1, native V2 and an explicit V2 route must agree.
	for (const route of ["v1", "v2-native", "v2-explicit"] as const) {
		test(`${route} resolves custom identity and fresh routing headers before dispatch`, async () => {
			let resolutions = 0;
			const subject = {
				...model(),
				resolveHeaders: async () => ({
					"User-Agent": "codex_cli_rs/0.159.0",
					Originator: "codex_cli_rs",
					"X-Relay-Route": `route-${++resolutions}`,
				}),
				...(route === "v2-explicit"
					? { remoteCompaction: { v2Endpoint: "https://relay.example.test/v1/responses" } }
					: {}),
			};
			const observed: Array<{ url: string; ua: string | null; originator: string | null; routing: string | null }> =
				[];
			const fetch: FetchImpl = async (input, init) => {
				const h = new Headers(init?.headers);
				observed.push({
					url: String(input),
					ua: h.get("user-agent"),
					originator: h.get("originator"),
					routing: h.get("x-relay-route"),
				});
				return response(route !== "v1");
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				if (route === "v1") {
					await requestOpenAiRemoteCompaction(subject, "fixture-key", nativeInput, "instructions", undefined, {
						fetch,
					});
				} else {
					await requestCompactionV2Streaming(
						subject,
						"fixture-key",
						buildCompactionV2Request(subject, nativeInput, "instructions"),
						undefined,
						{ fetch, preferWebsockets: false },
					);
				}
			}
			expect(observed).toEqual(
				[1, 2].map(index => ({
					url: `https://relay.example.test/v1/responses${route === "v1" ? "/compact" : ""}`,
					ua: "codex_cli_rs/0.159.0",
					originator: "codex_cli_rs",
					routing: `route-${index}`,
				})),
			);
		});
	}

	for (const route of ["v1", "v2-native", "v2-explicit"] as const) {
		test(`${route} awaits the payload hook with the actual compaction model and endpoint`, async () => {
			const subject = {
				...model(),
				remoteCompaction: {
					model: "group/compaction-target",
					...(route === "v2-explicit" ? { v2Endpoint: "https://other-relay.example.test/responses" } : {}),
				},
			};
			const identity = { version: 1, session_id: "session-fixture", run_id: "run-fixture" };
			let hookCalls = 0;
			let hookModel: Model | undefined;
			const onPayload: SimpleStreamOptions["onPayload"] = async (payload, requestModel) => {
				await Promise.resolve();
				hookCalls++;
				hookModel = requestModel;
				assert.ok(payload && typeof payload === "object");
				return { ...payload, magpie_session_route: identity };
			};
			let sent = 0;
			const fetch: FetchImpl = async (input, init) => {
				sent++;
				expect(hookCalls).toBe(1);
				expect(hookModel).toMatchObject({ id: "group/compaction-target", baseUrl: String(input) });
				const body = JSON.parse(String(init?.body));
				expect(body.magpie_session_route).toEqual(identity);
				expect(body.prompt_cache_key).toBe("cache-fixture");
				return response(route !== "v1");
			};
			if (route === "v1") {
				await requestOpenAiRemoteCompaction(subject, "fixture-key", nativeInput, "instructions", undefined, {
					fetch, onPayload, sessionId: "session-fixture", promptCacheKey: "cache-fixture",
				});
			} else {
				await requestCompactionV2Streaming(
					subject, "fixture-key",
					buildCompactionV2Request(subject, nativeInput, "instructions", {
						sessionId: "session-fixture", promptCacheKey: "cache-fixture",
					}),
					undefined, { fetch, onPayload, preferWebsockets: false },
				);
			}
			expect(sent).toBe(1);
		});

		test(`${route} propagates payload-hook rejection before any fetch`, async () => {
			const subject = {
				...model(),
				...(route === "v2-explicit" ? { remoteCompaction: { v2Endpoint: "https://relay.example.test/responses" } } : {}),
			};
			let sent = 0;
			const fetch: FetchImpl = async () => { sent++; return response(route !== "v1"); };
			const onPayload: SimpleStreamOptions["onPayload"] = async () => {
				await Promise.resolve();
				throw new Error("invalid session activation");
			};
			const pending = route === "v1"
				? requestOpenAiRemoteCompaction(subject, "fixture-key", nativeInput, "instructions", undefined, { fetch, onPayload })
				: requestCompactionV2Streaming(subject, "fixture-key", buildCompactionV2Request(subject, nativeInput, "instructions"), undefined, {
						fetch, onPayload, preferWebsockets: false,
					});
			await expect(pending).rejects.toThrow("invalid session activation");
			expect(sent).toBe(0);
		});
	}

	test("V2 treats a complete Responses URL as the endpoint instead of appending a Codex path", () => {
		expect(getCompactionV2Endpoint(model())).toBe("https://relay.example.test/v1/responses");
	});

	test("per-model Lite keeps V1 and both V2 bodies and headers consistent, including an explicit opt-out", async () => {
		for (const route of ["v1", "v2-native", "v2-explicit"] as const) {
			for (const enabled of [true, false]) {
				const subject = {
					...model(),
					useResponsesLite: true,
					responsesLite: enabled,
					...(route === "v2-explicit"
						? { remoteCompaction: { v2Endpoint: "https://relay.example.test/v1/responses" } }
						: {}),
				};
				const captured: Array<{ lite: string | null; instructions: unknown; context: unknown }> = [];
				const fetch: FetchImpl = async (_input, init) => {
					const raw = init?.body;
					if (typeof raw !== "string" && !(raw instanceof Uint8Array)) throw new Error("Missing compaction body");
					const body = JSON.parse(
						typeof raw === "string" ? raw : new TextDecoder().decode(Bun.zstdDecompressSync(raw)),
					);
					captured.push({
						lite: new Headers(init?.headers).get("x-openai-internal-codex-responses-lite"),
						instructions: body.instructions,
						context: body.reasoning?.context,
					});
					return response(route !== "v1");
				};
				if (route === "v1") {
					await requestOpenAiRemoteCompaction(subject, "fixture-key", nativeInput, "instructions", undefined, {
						fetch,
					});
				} else {
					await requestCompactionV2Streaming(
						subject,
						"fixture-key",
						buildCompactionV2Request(subject, nativeInput, "instructions"),
						undefined,
						{ fetch, preferWebsockets: false },
					);
				}
				expect(captured).toEqual([
					{
						lite: enabled ? "true" : null,
						instructions: enabled ? undefined : "instructions",
						context: enabled ? "all_turns" : undefined,
					},
				]);
			}
		}
	});

	test("aborting asynchronous header resolution sends no compaction request", async () => {
		const controller = new AbortController();
		const subject = {
			...model(),
			resolveHeaders: async () => {
				controller.abort();
				return { "User-Agent": "codex_cli_rs/0.159.0" };
			},
		};
		let sent = 0;
		const fetch: FetchImpl = async () => {
			sent++;
			return response(false);
		};
		await expect(
			requestOpenAiRemoteCompaction(subject, "fixture-key", nativeInput, "instructions", controller.signal, {
				fetch,
			}),
		).rejects.toThrow();
		expect(sent).toBe(0);
	});
});
