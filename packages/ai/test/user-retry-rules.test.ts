import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	codexMaxRetries,
	isProviderRetryableError,
	loadUserRetryRules,
	openaiHttpMaxAttempts,
	providerStreamMaxRetries,
	resetUserRetryRulesCache,
} from "@oh-my-pi/pi-ai/error";
import { isRetryableCodexFailureEvent } from "../src/providers/openai-codex-responses";
import { postOpenAIStream } from "../src/utils/openai-http";
import * as utils from "@oh-my-pi/pi-utils";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-retry-rules-"));
const rulesPath = path.join(tempDir, "retry-rules.json");

function writeRules(content: unknown): void {
	// Distinct sizes across writes keep the stat cache honest even within one
	// mtime tick.
	fs.writeFileSync(rulesPath, typeof content === "string" ? content : JSON.stringify(content));
	resetUserRetryRulesCache();
}

beforeEach(() => {
	vi.spyOn(utils, "getAgentDir").mockReturnValue(tempDir);
	resetUserRetryRulesCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetUserRetryRulesCache();
});

afterAll(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	resetUserRetryRulesCache();
});

describe("user retry rules file", () => {
	it("rescues an otherwise-terminal relay error via retryablePatterns", () => {
		writeRules({ retryablePatterns: ["No active API keys available"] });
		// Without user rules this exact wording (no status attached) is terminal.
		expect(
			isProviderRetryableError(new Error('503 {"error":{"message":"No active API keys available for this group"}}')),
		).toBe(true);
	});

	it("kills a default-retryable error via nonRetryablePatterns, and the kill switch outranks the opt-in", () => {
		writeRules({ nonRetryablePatterns: ["overloaded"] });
		// "overloaded" is built-in retryable wording; the user kill switch wins.
		expect(isProviderRetryableError(new Error("provider is overloaded"))).toBe(false);
		writeRules({ retryablePatterns: ["overloaded"], nonRetryablePatterns: ["overloaded"] });
		expect(isProviderRetryableError(new Error("provider is overloaded"))).toBe(false);
	});

	it("treats a missing file as no rules", () => {
		fs.rmSync(rulesPath, { force: true });
		resetUserRetryRulesCache();
		expect(loadUserRetryRules().retryablePatterns.length).toBe(0);
		expect(isProviderRetryableError(new Error("provider is overloaded"))).toBe(true);
	});

	it("degrades a malformed file to no rules instead of breaking classification", () => {
		writeRules("{ not json");
		expect(isProviderRetryableError(new Error("provider is overloaded"))).toBe(true);
		expect(providerStreamMaxRetries()).toBe(10);
	});

	it("ignores invalid entries but keeps the valid ones", () => {
		writeRules({
			retryablePatterns: ["valid pattern", "(unclosed", 42],
			maxRetries: { providerStream: "seven", codex: -3, openaiHttp: 9 },
		});
		expect(isProviderRetryableError(new Error("hits valid pattern"))).toBe(true);
		expect(isProviderRetryableError(new Error("hits (unclosed"))).toBe(false);
		expect(providerStreamMaxRetries()).toBe(10);
		expect(codexMaxRetries()).toBe(5);
		expect(openaiHttpMaxAttempts()).toBe(9);
	});

	it("applies budgets from the file with defaults absent keys", () => {
		writeRules({ maxRetries: { providerStream: 20, codex: 8 } });
		expect(providerStreamMaxRetries()).toBe(20);
		expect(codexMaxRetries()).toBe(8);
		expect(openaiHttpMaxAttempts()).toBe(6);
	});

	it("re-reads the file when it changes on disk (no process restart)", () => {
		writeRules({ retryablePatterns: ["flake alpha"] });
		expect(isProviderRetryableError(new Error("flake alpha"))).toBe(true);
		expect(isProviderRetryableError(new Error("flake beta"))).toBe(false);
		fs.writeFileSync(rulesPath, JSON.stringify({ retryablePatterns: ["flake beta"] }));
		expect(isProviderRetryableError(new Error("flake alpha"))).toBe(false);
		expect(isProviderRetryableError(new Error("flake beta"))).toBe(true);
	});

	it("uses the active profile's rules even when both files have identical size and modification time", () => {
		const second = path.join(tempDir, "other-profile");
		fs.mkdirSync(second, { recursive: true });
		const secondPath = path.join(second, "retry-rules.json");
		writeRules({ retryablePatterns: ["profile-one"] });
		fs.writeFileSync(secondPath, JSON.stringify({ retryablePatterns: ["profile-two"] }));
		fs.utimesSync(rulesPath, 1, 1);
		fs.utimesSync(secondPath, 1, 1);
		expect(isProviderRetryableError(new Error("profile-one"))).toBe(true);
		vi.spyOn(utils, "getAgentDir").mockReturnValue(second);
		expect(isProviderRetryableError(new Error("profile-one"))).toBe(false);
		expect(isProviderRetryableError(new Error("profile-two"))).toBe(true);
	});

	it("feeds codex failure-event classification with user codes and patterns", () => {
		writeRules({
			codexRetryableCodes: ["relay_specific_code"],
			retryablePatterns: ["relay flake message"],
		});
		expect(isRetryableCodexFailureEvent({ error: { code: "RELAY_SPECIFIC_CODE" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ error: { code: "bad_request", message: "relay flake message" } })).toBe(
			true,
		);
		writeRules({ nonRetryablePatterns: ["please retry your request"] });
		// Built-in retryable message wording, suppressed by the kill switch.
		expect(isRetryableCodexFailureEvent({ message: "Please retry your request shortly" })).toBe(false);
	});
});

describe("user retry rules on OpenAI HTTP responses", () => {
	const denied = (status = 403, headers?: Record<string, string>) =>
		new Response('{"error":{"message":"API access from your region is not available","type":"region_blocked"}}', {
			status,
			headers: { "retry-after-ms": "1", ...headers },
		});

	async function request(response: () => Response, gate?: () => boolean) {
		let attempts = 0;
		const result = await postOpenAIStream<{ recovered: boolean }>({
			url: "https://retry-fixture.invalid/v1/chat/completions",
			headers: {},
			body: {},
			signal: AbortSignal.timeout(3000),
			maxAttempts: 3,
			shouldRetryResponse: gate,
			fetch: async () =>
				++attempts === 1 ? response() : new Response('data: {"recovered":true}\n\ndata: [DONE]\n\n'),
		}).then(
			async handle => {
				const events: unknown[] = [];
				for await (const event of handle.events) events.push(event);
				return { events };
			},
			error => ({ error }),
		);
		return { attempts, ...result };
	}

	it("retries a matched 403 and yields the subsequent successful stream even with a negative server hint", async () => {
		writeRules({ retryablePatterns: ["region_blocked"] });
		expect(await request(() => denied(403, { "x-should-retry": "false" }))).toEqual({
			attempts: 2,
			events: [{ recovered: true }],
		});
	});

	it("matches decoded escaped messages rather than requiring raw JSON spelling", async () => {
		writeRules({ retryablePatterns: ["^403 区域拒绝"] });
		expect(
			await request(
				() =>
					new Response('{"error":{"message":"\\u533a\\u57df\\u62d2\\u7edd"}}', {
						status: 403,
						headers: { "retry-after-ms": "1" },
					}),
			),
		).toEqual({ attempts: 2, events: [{ recovered: true }] });
	});

	it.each([403, 503])("does not retry a %i when a negative user rule also matches", async status => {
		writeRules({ retryablePatterns: ["region_blocked"], nonRetryablePatterns: ["region_blocked"] });
		expect(await request(() => denied(status))).toMatchObject({ attempts: 1, error: { status } });
	});

	it("leaves an unmatched 403 terminal", async () => {
		writeRules({ retryablePatterns: ["another_error"] });
		expect(await request(() => denied())).toMatchObject({ attempts: 1, error: { status: 403 } });
	});

	it("keeps the caller's retry veto even when a user pattern matches", async () => {
		writeRules({ retryablePatterns: ["region_blocked"] });
		expect(
			await request(
				() => denied(),
				() => false,
			),
		).toMatchObject({ attempts: 1, error: { status: 403 } });
	});

	it("stops on a negative rule added while a sequence of retryable responses is arriving", async () => {
		writeRules({ retryablePatterns: ["region_blocked"] });
		let attempts = 0;
		await expect(
			postOpenAIStream({
				url: "https://retry-fixture.invalid",
				headers: {},
				body: {},
				maxAttempts: 3,
				signal: AbortSignal.timeout(3000),
				fetch: async () => {
					if (++attempts === 2)
						fs.writeFileSync(rulesPath, JSON.stringify({ nonRetryablePatterns: ["region_blocked"] }));
					return denied();
				},
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(attempts).toBe(2);
	});

	it("bounds persistent matched responses by the configured HTTP attempt budget", async () => {
		writeRules({ retryablePatterns: ["region_blocked"], maxRetries: { openaiHttp: 2 } });
		let attempts = 0;
		await expect(
			postOpenAIStream({
				url: "https://retry-fixture.invalid",
				headers: {},
				body: {},
				signal: AbortSignal.timeout(3000),
				fetch: async () => {
					attempts++;
					return denied();
				},
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(attempts).toBe(2);
	});
});
