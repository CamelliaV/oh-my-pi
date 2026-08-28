/**
 * Regression driver for the Chinese always-thinking 400 rejection:
 * `400 [1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。]`
 * (z-ai GLM via runanytime gateway, openai-completions API).
 *
 * Real failures arrive as OpenAIHttpError (status=400, captured envelope);
 * plain-message fake errors never pass the status gate, so mimic the shape.
 *
 * Run: bun packages/ai/test/reasoning-fallback-zh.ts
 * Transport-level cases exercise postOpenAIStream's retry gates: a [1210] 400
 * enters the transport retry loop, ordinary 400s surface immediately for the
 * resolver above, and a 200 is never re-fetched.
 *
 * Exits non-zero when a case fails.
 */

import { resolveOpenAIReasoningEffortFallback } from "../src/providers/openai-reasoning-fallback";
import { postOpenAIStream } from "../src/utils/openai-http";

function httpError(status: number, message: string): Error & { status: number } {
	const err = new Error(message) as Error & { status: number };
	err.status = status;
	return err;
}

const cases: Array<{
	name: string;
	error: Error;
	params: Record<string, unknown>;
	expect: string | null | undefined;
}> = [
	{
		name: "zh always-thinking rejection, effort=max (max allowed, only off banned)",
		error: httpError(
			400,
			"400 [1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。][20260815140541968eb5e484394089]",
		),
		params: { reasoning_effort: "max" },
		// max IS in the relay's allowed list, but the relay still rejects the
		// request on thinking semantics. Retrying identical params loops, so the
		// resolver drops the effort field (null) and lets the relay pick a default.
		expect: null,
	},
	{
		name: "zh rejection naming rejected value (minimal not supported)",
		error: httpError(400, "400 [1210][不支持 minimal，请使用 low、high 或 max。]"),
		params: { reasoning_effort: "minimal" },
		expect: "low",
	},
	{
		name: "english baseline still works",
		error: httpError(400, "Unsupported value: 'none' for reasoning_effort. Supported values: low, high."),
		params: { reasoning_effort: "none" },
		expect: null,
	},
];

let failed = 0;
for (const c of cases) {
	const got = resolveOpenAIReasoningEffortFallback(c.error, undefined, c.params);
	const ok = got === c.expect;
	console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: got=${JSON.stringify(got)} want=${JSON.stringify(c.expect)}`);
	if (!ok) failed++;
}

function sseOk(): Response {
	return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function transportCase(
	name: string,
	responses: Response[],
	expect: { calls: number; status?: number; throws?: boolean },
): Promise<boolean> {
	let calls = 0;
	const fetchMock = Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			calls += 1;
			return responses[Math.min(calls - 1, responses.length - 1)];
		},
		{ preconnect: fetch.preconnect },
	);
	let status: number | undefined;
	let threw = false;
	try {
		const handle = await postOpenAIStream({
			url: "https://relay.example.test/v1/chat/completions",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			fetch: fetchMock,
		});
		status = handle.response.status;
	} catch {
		threw = true;
	}
	const ok = calls === expect.calls && threw === !!expect.throws && status === expect.status;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}: calls=${calls} want=${expect.calls}, threw=${threw} want=${!!expect.throws}` +
			(expect.status === undefined ? "" : `, status=${status} want=${expect.status}`),
	);
	return ok;
}

const transportOk =
	(await transportCase(
		"[1210] 400 retries at transport then succeeds",
		[jsonError(400, "[1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。]"), sseOk()],
		{ calls: 2, status: 200 },
	)) &&
	(await transportCase(
		"plain 400 surfaces immediately without transport retry",
		[jsonError(400, "invalid reasoning value: 'xhigh'")],
		{
			calls: 1,
			throws: true,
		},
	)) &&
	(await transportCase("200 is never re-fetched", [sseOk()], { calls: 1, status: 200 }));
if (!transportOk) failed++;

process.exit(failed > 0 ? 1 : 0);
