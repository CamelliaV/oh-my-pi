import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import { redactSecretFields, redactSecrets } from "../src/secrets/redact";

describe("durable memory redaction", () => {
	it("removes configured secrets and reversible placeholders without erasing technical identifiers", () => {
		const secret = "CUSTOMCREDENTIAL123456789";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const text = redactSecrets(`tokenizer_settings=fast; credential ${secret}; saved ${placeholder}`, obfuscator);
		expect(text).toContain("tokenizer_settings=fast");
		expect(text).not.toContain(secret);
		expect(text).not.toContain(placeholder);
		expect(obfuscator.deobfuscate(text)).not.toContain(secret);
	});

	it("redacts credential syntax while preserving the endpoint and neighboring facts", () => {
		const input =
			'Authorization: Bearer opaque-credential\npassword="two secret words"\nhttps://alice:db-credential@example.test/api?api_key=query-credential&mode=fast\nregion=west';
		const redacted = redactSecrets(input);
		for (const secret of ["opaque-credential", "two secret words", "db-credential", "query-credential"]) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted).toContain("example.test/api");
		expect(redacted).toContain("mode=fast");
		expect(redacted).toContain("region=west");
		expect(redactSecrets(redacted)).toBe(redacted);
	});

	it("covers provider tokens and private key blocks outside credential assignments", () => {
		const google = `AIza${"Q".repeat(35)}`;
		const github = `github_pat_${"R".repeat(36)}`;
		const input = `project uses tabs; ${google}; ${github}; -----BEGIN PRIVATE KEY-----\nPRIVATEBODY123\n-----END PRIVATE KEY-----`;
		const redacted = redactSecrets(input);
		expect(redacted).toContain("project uses tabs");
		expect(redacted).not.toContain(google);
		expect(redacted).not.toContain(github);
		expect(redacted).not.toContain("PRIVATEBODY123");
	});

	it("redacts nested credential fields and arrays without mutating input or corrupting dates", () => {
		const timestamp = new Date("2026-08-01T00:00:00Z");
		const input = {
			timestamp,
			metadata: { password: "short", nested: [{ apiKey: "unprefixed-value", region: "west" }] },
		};
		const safe = redactSecretFields(input);
		expect(JSON.stringify(safe)).not.toContain("unprefixed-value");
		expect(JSON.stringify(safe)).not.toContain("short");
		expect(safe.metadata.nested[0]?.region).toBe("west");
		expect(safe.timestamp.toISOString()).toBe("2026-08-01T00:00:00.000Z");
		expect(input.metadata.password).toBe("short");
	});
});

import {
	redactMemorySecrets,
	redactMemoryTextFields,
	redactRememberWrite,
} from "@oh-my-pi/pi-coding-agent/memory-backend/redact";

const NPM_TOKEN = `npm_${"a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy".slice(0, 36)}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("memory secret redaction", () => {
	it("redacts provider token shapes", () => {
		expect(redactMemorySecrets(`token is ${NPM_TOKEN} ok`)).toBe("token is [REDACTED] ok");
		expect(redactMemorySecrets(`id ${AWS_KEY}`)).toBe("id [REDACTED]");
		expect(redactMemorySecrets("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[REDACTED]");
		expect(redactMemorySecrets("xoxb-1234567890-abcdef")).toBe("[REDACTED]");
		expect(redactMemorySecrets("secret_aB3dEfGh1JkLmN0pQ")).toBe("[REDACTED]");
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(24)}.${"b".repeat(20)}`;
		expect(redactMemorySecrets(`bearer ${jwt} sent`)).toBe("bearer [REDACTED] sent");
		expect(redactMemorySecrets("version 1.2.3 released")).toBe("version 1.2.3 released");
	});

	it("leaves ordinary identifiers alone", () => {
		for (const identifier of [
			"passwordAuthenticationMiddleware",
			"tokenizationStrategy",
			"keyboardInterruptHandler",
			"token_bucket_rate_limiter",
			"secret_manager_client",
			"password_authentication",
			"token_authorization",
			"key_configuration",
		]) {
			expect(redactMemorySecrets(`calls ${identifier} twice`), identifier).toBe(`calls ${identifier} twice`);
		}
	});

	it("redacts a credential passed as the source field", () => {
		const scrubbed = redactMemoryTextFields({ content: "safe", source: `agent-${NPM_TOKEN}` });
		expect(scrubbed.source).toBe("agent-[REDACTED]");
	});

	it("redacts a letters-only credential suffix", () => {
		expect(redactMemorySecrets("use password-supersecretvalue here")).toBe("use [REDACTED] here");
		expect(redactMemorySecrets("API token-abcdefghijklmnop leaked")).toBe("API [REDACTED] leaked");
	});

	// 220 KB of one unbroken run. The earlier lookahead form took ~25s on this input and
	// would exceed the per-test timeout; a single pass returns in milliseconds.
	it("scans a large unbroken run without rescanning its tail", () => {
		const input = "token_aaaa-".repeat(20000);
		expect(redactMemorySecrets(input)).toBe(input);
	});

	it("scrubs every text-bearing field, both naming styles", () => {
		const scrubbed = redactMemoryTextFields({
			content: `a ${NPM_TOKEN}`,
			embedText: `b ${NPM_TOKEN}`,
			embed_text: `c ${NPM_TOKEN}`,
			extractText: `d ${NPM_TOKEN}`,
			extract_text: `e ${NPM_TOKEN}`,
			importance: 0.5,
		});
		for (const [key, value] of Object.entries(scrubbed)) {
			if (typeof value !== "string") continue;
			expect(value, key).not.toContain("npm_");
			expect(value, key).toContain("[REDACTED]");
		}
		expect(scrubbed.importance).toBe(0.5);
	});

	it("scrubs nested metadata, which is serialized whole into metadata_json", () => {
		const scrubbed = redactMemoryTextFields({
			content: "safe",
			metadata: { context: `auth uses ${NPM_TOKEN}`, cwd: "/work/app", nested: [`also ${NPM_TOKEN}`] },
		});
		expect(scrubbed.metadata.context).toBe("auth uses [REDACTED]");
		expect(scrubbed.metadata.nested[0]).toBe("also [REDACTED]");
		expect(scrubbed.metadata.cwd).toBe("/work/app");
		expect(scrubbed.content).toBe("safe");
	});

	it("handles a string memory and an absent options bag", () => {
		const [memory, options] = redactRememberWrite(`leak ${NPM_TOKEN}`, undefined);
		expect(memory).toBe("leak [REDACTED]");
		expect(options).toBeUndefined();
	});
});
