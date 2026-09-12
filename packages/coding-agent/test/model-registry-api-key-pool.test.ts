import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function stdoutCommand(value: string): string {
	if (process.platform !== "win32") return `printf %s ${shellQuote(value)}`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

/**
 * models.yml `providers.<name>.apiKeys` wiring: the schema accepts a key pool
 * plus an optional rotation policy, the registry syncs it into AuthStorage as
 * config-sourced rows, and key resolution rotates away from usage-limited keys.
 */
describe("ModelRegistry models.yml apiKeys pools", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-key-pool-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	function writeConfig(providers: Record<string, unknown>): void {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
	}

	function poolProvider(extra: Record<string, unknown>): Record<string, unknown> {
		return {
			baseUrl: "https://relay.example.com/v1",
			api: "openai-completions",
			models: [{ id: "pooled-model" }],
			...extra,
		};
	}

	test("first-fill serves the first key and rotates on usage limit", async () => {
		writeConfig({
			relay: poolProvider({ apiKeys: ["sk-alpha", "sk-beta"] }),
		});
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()).toBeUndefined();

		const model = registry.find("relay", "pooled-model");
		expect(model).toBeDefined();
		if (!model) throw new Error("model missing");
		expect(await registry.getApiKey(model)).toBe("sk-alpha");
		// Same result for a second caller — first-fill, not round-robin.
		expect(await registry.getApiKey(model)).toBe("sk-alpha");

		const mark = await authStorage.markUsageLimitReached("relay", undefined, { apiKey: "sk-alpha" });
		expect(mark.switched).toBe(true);
		expect(await registry.getApiKey(model)).toBe("sk-beta");
	});

	test("round-robin alternates keys per resolve", async () => {
		writeConfig({
			relay: poolProvider({ apiKeys: ["sk-a", "sk-b"], apiKeyRotation: "round-robin" }),
		});
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("relay", "pooled-model");
		if (!model) throw new Error("model missing");

		const seen = [await registry.getApiKey(model), await registry.getApiKey(model)];
		expect(seen).toEqual(["sk-a", "sk-b"]);
	});

	test("command-backed pool entries resolve before landing in the pool", async () => {
		writeConfig({
			relay: poolProvider({ apiKeys: [`!${stdoutCommand("sk-from-command")}`, "sk-static"] }),
		});
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("relay", "pooled-model");
		if (!model) throw new Error("model missing");
		expect(registry.hasCommandBackedApiKey("relay")).toBe(true);
		expect(await registry.getApiKey(model)).toBe("sk-from-command");
	});

	test("apiKey and apiKeys together are rejected", () => {
		writeConfig({
			relay: poolProvider({ apiKey: "sk-one", apiKeys: ["sk-two"] }),
		});
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()?.message).toContain("either apiKey or apiKeys");
	});

	test("apiKeyRotation without apiKeys is rejected", () => {
		writeConfig({
			relay: poolProvider({ apiKey: "sk-one", apiKeyRotation: "first-fill" }),
		});
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()?.message).toContain("apiKeyRotation requires apiKeys");
	});
});
