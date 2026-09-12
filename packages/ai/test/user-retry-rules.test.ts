import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-retry-rules-"));
const rulesPath = path.join(tempDir, "retry-rules.json");

function writeRules(content: unknown): void {
	// Distinct sizes across writes keep the stat cache honest even within one
	// mtime tick.
	fs.writeFileSync(rulesPath, typeof content === "string" ? content : JSON.stringify(content));
	resetUserRetryRulesCache();
}

beforeAll(() => {
	process.env.OMP_RETRY_RULES_FILE = rulesPath;
});

afterAll(() => {
	delete process.env.OMP_RETRY_RULES_FILE;
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
		writeRules({ retryablePatterns: ["flake beta"] });
		expect(isProviderRetryableError(new Error("flake alpha"))).toBe(false);
		expect(isProviderRetryableError(new Error("flake beta"))).toBe(true);
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
