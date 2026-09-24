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
		await authStorage.keys.setConfigPool("relay-pool", ["sk-first", "sk-second", "sk-third"]);

		// Default policy is first-fill: every session lands on the front key.
		expect(authStorage.keys.describe("relay-pool")).toContain("first-fill");
		expect(await authStorage.keys.get("relay-pool", "session-a")).toBe("sk-first");
		expect(await authStorage.keys.get("relay-pool", "session-b")).toBe("sk-first");
		expect(await authStorage.keys.get("relay-pool")).toBe("sk-first");

		// Exhaust the first key: the pool rotates to the next unblocked key.
		const mark = await authStorage.limits.markReached("relay-pool", "session-a", { apiKey: "sk-first" });
		expect(mark.switched).toBe(true);
		expect(await authStorage.keys.get("relay-pool", "session-a")).toBe("sk-second");
		expect(await authStorage.keys.get("relay-pool", "session-c")).toBe("sk-second");

		// The block is persisted: a fresh AuthStorage over the same store still
		// skips the exhausted key.
		const reloaded = new AuthStorage(store);
		await reloaded.credentials.reload();
		expect(await reloaded.keys.get("relay-pool", "session-d")).toBe("sk-second");
		await reloaded.limits.markReached("relay-pool", "session-d", { apiKey: "sk-second" });
		expect(await reloaded.keys.get("relay-pool", "session-d")).toBe("sk-third");
	});

	it("round-robin spreads successive resolves across the pool", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-pool", ["sk-a", "sk-b"], "round-robin");

		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const key = await authStorage.keys.get("relay-pool");
			if (!key) throw new Error("expected a pooled key");
			seen.push(key);
		}
		expect(seen).toEqual(["sk-a", "sk-b", "sk-a", "sk-b"]);
	});

	it("re-sync keeps row identity for retained keys and soft-deletes dropped keys", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-pool", ["sk-old", "sk-kept"]);
		const before = store.listAuthCredentials("relay-pool");
		const keptId = before.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === "sk-kept",
		)?.id;
		expect(keptId).toBeDefined();

		// A persisted block bound to the retained row id must survive re-sync.
		await authStorage.limits.markReached("relay-pool", undefined, { apiKey: "sk-kept" });

		await authStorage.keys.setConfigPool("relay-pool", ["sk-kept", "sk-new"]);
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
		expect(await authStorage.keys.get("relay-pool")).toBe("sk-new");
	});

	it("config pool outranks stored OAuth and login keys, matching single-key config precedence", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await store.upsertAuthCredential("relay-pool", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 3_600_000,
		});
		await store.upsertAuthCredential("relay-pool", { type: "api_key", key: "sk-login", source: "login" });
		await authStorage.keys.setConfigPool("relay-pool", ["sk-pool"]);

		expect(await authStorage.keys.get("relay-pool", "session-a")).toBe("sk-pool");
		expect(authStorage.keys.source("relay-pool")).toEqual({ kind: "config", concrete: true });
		// OAuth identity stays suppressed for config-owned providers.
		expect(await authStorage.oauth.access("relay-pool", "session-a")).toBeUndefined();
	});

	it("a single config apiKey still beats the pool", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-pool", ["sk-pool-1", "sk-pool-2"]);
		authStorage.keys.setConfig("relay-pool", "sk-single");
		expect(await authStorage.keys.get("relay-pool", "session-a")).toBe("sk-single");
	});

	it("pruneConfigApiKeyPools tears down pools for providers removed from the config", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-keep", ["sk-keep"]);
		await authStorage.keys.setConfigPool("relay-drop", ["sk-drop"]);

		await authStorage.keys.pruneConfigPools(new Set(["relay-keep"]));

		expect(store.listAuthCredentials("relay-drop")).toEqual([]);
		expect(await authStorage.keys.get("relay-drop", "session-a")).toBeUndefined();
		expect(authStorage.keys.describe("relay-drop")).toBeUndefined();
		expect(await authStorage.keys.get("relay-keep", "session-a")).toBe("sk-keep");
	});

	it("prune removes pools synced before a process restart", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-pool", ["sk-restored"]);

		// Fresh instance: the in-memory policy map is empty; only the store rows
		// prove a pool existed. Prune with an empty active set must still delete.
		const reloaded = new AuthStorage(store);
		await reloaded.credentials.reload();
		await reloaded.keys.pruneConfigPools(new Set());
		expect(store.listAuthCredentials("relay-pool")).toEqual([]);
	});

	it("an empty key list tears the pool back down", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await authStorage.keys.setConfigPool("relay-pool", ["sk-a", "sk-b"]);
		await authStorage.keys.setConfigPool("relay-pool", []);
		expect(store.listAuthCredentials("relay-pool")).toEqual([]);
		expect(await authStorage.keys.get("relay-pool", "session-a")).toBeUndefined();
	});
});
