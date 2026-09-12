import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * Contract coverage for models.yml `apiKeys` config pools: first-fill vs
 * round-robin selection, usage-limit rotation with persisted blocks, and
 * load-cycle reconcile (row identity survives re-sync; dropped keys leave).
 */
describe("AuthStorage config api-key pools", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		// Neutralize env keys so only stored credentials participate.
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-pool-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("first-fill serves the first key for every session until it is usage-blocked, then rotates and persists", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-first", "sk-second", "sk-third"]);

		// Default policy is first-fill: every session lands on the front key.
		expect(authStorage.describeCredentialSource("relay-pool")).toContain("first-fill");
		expect(await authStorage.getApiKey("relay-pool", "session-a")).toBe("sk-first");
		expect(await authStorage.getApiKey("relay-pool", "session-b")).toBe("sk-first");
		expect(await authStorage.getApiKey("relay-pool")).toBe("sk-first");

		// Exhaust the first key: the pool rotates to the next unblocked key.
		const mark = await authStorage.markUsageLimitReached("relay-pool", "session-a", { apiKey: "sk-first" });
		expect(mark.switched).toBe(true);
		expect(await authStorage.getApiKey("relay-pool", "session-a")).toBe("sk-second");
		expect(await authStorage.getApiKey("relay-pool", "session-c")).toBe("sk-second");

		// The block is persisted: a fresh AuthStorage over the same store still
		// skips the exhausted key.
		const reloaded = new AuthStorage(store);
		await reloaded.reload();
		expect(await reloaded.getApiKey("relay-pool", "session-d")).toBe("sk-second");
		await reloaded.markUsageLimitReached("relay-pool", "session-d", { apiKey: "sk-second" });
		expect(await reloaded.getApiKey("relay-pool", "session-d")).toBe("sk-third");
	});

	it("round-robin spreads successive resolves across the pool", async () => {
		if (!authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-a", "sk-b"], "round-robin");

		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const key = await authStorage.getApiKey("relay-pool");
			if (!key) throw new Error("expected a pooled key");
			seen.push(key);
		}
		expect(seen).toEqual(["sk-a", "sk-b", "sk-a", "sk-b"]);
	});

	it("re-sync keeps row identity for retained keys and soft-deletes dropped keys", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-old", "sk-kept"]);
		const before = store.listAuthCredentials("relay-pool");
		const keptId = before.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === "sk-kept",
		)?.id;
		expect(keptId).toBeDefined();

		// A persisted block bound to the retained row id must survive re-sync.
		await authStorage.markUsageLimitReached("relay-pool", undefined, { apiKey: "sk-kept" });

		authStorage.setConfigApiKeys("relay-pool", ["sk-kept", "sk-new"]);
		const after = store.listAuthCredentials("relay-pool");
		expect(after.map(entry => (entry.credential.type === "api_key" ? entry.credential.key : undefined))).toEqual([
			"sk-kept",
			"sk-new",
		]);
		const keptAfter = after.find(entry => entry.credential.type === "api_key" && entry.credential.key === "sk-kept");
		expect(keptAfter?.id).toBe(keptId);
		expect(keptAfter?.credential.type === "api_key" && keptAfter.credential.source).toBe("config");

		// sk-kept is still blocked (block persisted against the same row id), so
		// first-fill now serves the newly added key.
		expect(await authStorage.getApiKey("relay-pool")).toBe("sk-new");
	});

	it("config pool outranks stored OAuth and login keys, matching single-key config precedence", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		store.upsertAuthCredentialForProvider("relay-pool", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 3_600_000,
		});
		store.upsertAuthCredentialForProvider("relay-pool", { type: "api_key", key: "sk-login", source: "login" });
		authStorage.setConfigApiKeys("relay-pool", ["sk-pool"]);

		expect(await authStorage.getApiKey("relay-pool", "session-a")).toBe("sk-pool");
		expect(authStorage.getCredentialOrigin("relay-pool")).toEqual({ kind: "config" });
		// OAuth identity stays suppressed for config-owned providers.
		expect(await authStorage.getOAuthAccess("relay-pool", "session-a")).toBeUndefined();
	});

	it("a single config apiKey still beats the pool", async () => {
		if (!authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-pool-1", "sk-pool-2"]);
		authStorage.setConfigApiKey("relay-pool", "sk-single");
		expect(await authStorage.getApiKey("relay-pool", "session-a")).toBe("sk-single");
	});

	it("pruneConfigApiKeyPools tears down pools for providers removed from the config", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-keep", ["sk-keep"]);
		authStorage.setConfigApiKeys("relay-drop", ["sk-drop"]);

		authStorage.pruneConfigApiKeyPools(new Set(["relay-keep"]));

		expect(store.listAuthCredentials("relay-drop")).toEqual([]);
		expect(await authStorage.getApiKey("relay-drop", "session-a")).toBeUndefined();
		expect(authStorage.describeCredentialSource("relay-drop")).toBeUndefined();
		expect(await authStorage.getApiKey("relay-keep", "session-a")).toBe("sk-keep");
	});

	it("prune removes pools synced before a process restart", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-restored"]);

		// Fresh instance: the in-memory policy map is empty; only the store rows
		// prove a pool existed. Prune with an empty active set must still delete.
		const reloaded = new AuthStorage(store);
		await reloaded.reload();
		reloaded.pruneConfigApiKeyPools(new Set());
		expect(store.listAuthCredentials("relay-pool")).toEqual([]);
	});

	it("an empty key list tears the pool back down", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		authStorage.setConfigApiKeys("relay-pool", ["sk-a", "sk-b"]);
		authStorage.setConfigApiKeys("relay-pool", []);
		expect(store.listAuthCredentials("relay-pool")).toEqual([]);
		expect(await authStorage.getApiKey("relay-pool", "session-a")).toBeUndefined();
	});
});
