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
