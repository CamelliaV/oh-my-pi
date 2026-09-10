import * as fs from "node:fs";
import * as path from "node:path";
import { $env, getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

/**
 * User-editable retry rules, loaded from `<agentDir>/retry-rules.json`
 * (override with `OMP_RETRY_RULES_FILE`).
 *
 * The file is re-read lazily whenever its mtime+size change, so edits apply to
 * the next retry decision without restarting the process. Every key is
 * optional; a missing or malformed file silently means "no user rules".
 *
 * Shape:
 * ```json
 * {
 *   "$comment": "free-form notes",
 *   "retryablePatterns": ["No active API keys available"],
 *   "nonRetryablePatterns": ["some terminal wording"],
 *   "codexRetryableCodes": ["some_event_code"],
 *   "maxRetries": { "providerStream": 20, "codex": 5, "openaiHttp": 6 }
 * }
 * ```
 *
 * Patterns are case-insensitive regex sources tested against the error
 * message. `retryablePatterns` mark an error retryable even when the built-in
 * classification would reject it (e.g. a misleading 4xx from a relay);
 * `nonRetryablePatterns` mark it terminal even when the status alone looks
 * transient (checked first — the kill switch wins over the opt-in).
 * `maxRetries` keys map to the retry budgets documented on their resolvers.
 */

export interface UserRetryRules {
	retryablePatterns: RegExp[];
	nonRetryablePatterns: RegExp[];
	codexRetryableCodes: Set<string>;
	providerStreamMaxRetries: number | undefined;
	codexMaxRetries: number | undefined;
	openaiHttpMaxAttempts: number | undefined;
}

const EMPTY_RULES: UserRetryRules = {
	retryablePatterns: [],
	nonRetryablePatterns: [],
	codexRetryableCodes: new Set<string>(),
	providerStreamMaxRetries: undefined,
	codexMaxRetries: undefined,
	openaiHttpMaxAttempts: undefined,
};

/** Guards against runaway user files compiling hundreds of regexes per read. */
const MAX_PATTERNS = 64;
const MAX_CODES = 64;
const MAX_RETRY_BUDGET = 100;
const MAX_FILE_BYTES = 64 * 1024;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	rules: UserRetryRules;
}

let cache: CacheEntry | undefined;

function retryRulesPath(): string {
	return $env.OMP_RETRY_RULES_FILE?.trim() || path.join(getAgentDir(), "retry-rules.json");
}

function compilePattern(source: unknown, problems: string[]): RegExp | undefined {
	if (typeof source !== "string" || source.length === 0) {
		problems.push(`skipping non-string/empty pattern: ${JSON.stringify(source)}`);
		return undefined;
	}
	try {
		return new RegExp(source, "i");
	} catch (err) {
		problems.push(`invalid pattern ${JSON.stringify(source)}: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

function compilePatternList(value: unknown, problems: string[]): RegExp[] {
	if (!Array.isArray(value)) return [];
	const sources = value.slice(0, MAX_PATTERNS);
	if (value.length > MAX_PATTERNS) {
		problems.push(`too many patterns (${value.length}); using first ${MAX_PATTERNS}`);
	}
	return sources
		.map(source => compilePattern(source, problems))
		.filter((re): re is RegExp => re !== undefined);
}

function compileCodeList(value: unknown, problems: string[]): Set<string> {
	if (!Array.isArray(value)) return new Set<string>();
	if (value.length > MAX_CODES) {
		problems.push(`too many codes (${value.length}); using first ${MAX_CODES}`);
	}
	const codes = new Set<string>();
	for (const code of value.slice(0, MAX_CODES)) {
		if (typeof code !== "string" || code.length === 0) {
			problems.push(`skipping non-string/empty code: ${JSON.stringify(code)}`);
			continue;
		}
		codes.add(code.toLowerCase());
	}
	return codes;
}

function resolveBudget(value: unknown, problems: string[], key: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_RETRY_BUDGET) {
		problems.push(`maxRetries.${key} must be an integer in [0, ${MAX_RETRY_BUDGET}]; got ${JSON.stringify(value)}`);
		return undefined;
	}
	return value;
}

function parseRules(text: string): UserRetryRules {
	const problems: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		// Malformed file: warn and behave as absent — never break classification.
		logger.warn("retry-rules.json is not valid JSON; ignoring user retry rules", {
			error: err instanceof Error ? err.message : String(err),
		});
		return EMPTY_RULES;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		logger.warn("retry-rules.json must be a JSON object; ignoring user retry rules");
		return EMPTY_RULES;
	}
	const root = parsed as Record<string, unknown>;
	const maxRetries =
		root.maxRetries !== undefined && root.maxRetries !== null && typeof root.maxRetries === "object" && !Array.isArray(root.maxRetries)
			? (root.maxRetries as Record<string, unknown>)
			: {};
	const rules: UserRetryRules = {
		retryablePatterns: compilePatternList(root.retryablePatterns, problems),
		nonRetryablePatterns: compilePatternList(root.nonRetryablePatterns, problems),
		codexRetryableCodes: compileCodeList(root.codexRetryableCodes, problems),
		providerStreamMaxRetries: resolveBudget(maxRetries.providerStream, problems, "providerStream"),
		codexMaxRetries: resolveBudget(maxRetries.codex, problems, "codex"),
		openaiHttpMaxAttempts: resolveBudget(maxRetries.openaiHttp, problems, "openaiHttp"),
	};
	if (problems.length > 0) {
		logger.warn("retry-rules.json entries ignored", { problems: problems.slice(0, 8) });
	}
	return rules;
}

/** Test hook: drop the mtime cache so the next load re-reads the file. */
export function resetUserRetryRulesCache(): void {
	cache = undefined;
}

export function loadUserRetryRules(): UserRetryRules {
	const filePath = retryRulesPath();
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
		cache = undefined;
		return EMPTY_RULES;
	}
	if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
		return cache.rules;
	}
	let text: string;
	try {
		// stat-then-read race on a mid-write file surfaces as a parse error,
		// which parseRules already degrades to EMPTY_RULES.
		text = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) throw err;
		cache = undefined;
		return EMPTY_RULES;
	}
	const rules =
		text.length > MAX_FILE_BYTES
			? (logger.warn("retry-rules.json exceeds size cap; ignoring user retry rules", {
					bytes: text.length,
					cap: MAX_FILE_BYTES,
				}),
				EMPTY_RULES)
			: parseRules(text);
	cache = { mtimeMs: stat.mtimeMs, size: stat.size, rules };
	return rules;
}

/**
 * Retry budgets. File values win; defaults preserve the pre-config behavior.
 * `providerStream` counts provider-layer stream retries (Anthropic-style),
 * `codex` the Codex provider loop, and `openaiHttp` total HTTP attempts
 * (initial + retries) of the OpenAI-compatible transport.
 */
export function providerStreamMaxRetries(): number {
	return loadUserRetryRules().providerStreamMaxRetries ?? 10;
}

export function codexMaxRetries(): number {
	return loadUserRetryRules().codexMaxRetries ?? 5;
}

export function openaiHttpMaxAttempts(): number {
	return loadUserRetryRules().openaiHttpMaxAttempts ?? 6;
}
