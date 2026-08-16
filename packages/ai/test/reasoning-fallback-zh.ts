/**
 * Regression driver for the Chinese always-thinking 400 rejection:
 * `400 [1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。]`
 * (z-ai GLM via runanytime gateway, openai-completions API).
 *
 * Real failures arrive as OpenAIHttpError (status=400, captured envelope);
 * plain-message fake errors never pass the status gate, so mimic the shape.
 *
 * Run: bun packages/ai/test/reasoning-fallback-zh.ts
 * Exits non-zero when a case fails.
 */
import { resolveOpenAIReasoningEffortFallback } from "../src/providers/openai-reasoning-fallback";

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
process.exit(failed > 0 ? 1 : 0);
