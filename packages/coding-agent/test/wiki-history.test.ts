import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { WikiStore } from "../src/wiki/store";
import type { WikiPageDraft, WikiSource } from "../src/wiki/types";

function page(id: string, source: WikiSource, body: string, expectedRevision: number | null = null): WikiPageDraft {
	return {
		id,
		expectedRevision,
		title: "Deployment",
		summary: body,
		body,
		kind: "knowledge",
		status: "active",
		sources: [{ id: source.id, revision: source.revision }],
		links: [],
	};
}

async function publish(store: WikiStore, pages: WikiPageDraft[], sources: WikiSource[]): Promise<void> {
	await store.publish(await store.snapshot(), {
		pages,
		processed: sources.map(source => ({ id: source.id, revision: source.revision })),
	});
}

describe("Wiki immutable revision history", () => {
	it("persists page revisions, produces deterministic diffs, and restores as a new revision", async () => {
		using temp = TempDir.createSync("wiki-history-");
		const root = path.join(temp.path(), "wiki");
		let store = new WikiStore({ root });
		await store.open();
		const source = await store.capture({ content: "Deployment region is west." });
		await publish(store, [page("w-deployment", source, "The deployment uses west.")], [source]);
		const firstHistory = await store.history("w-deployment");
		expect(firstHistory).toHaveLength(1);
		expect(firstHistory[0]).toMatchObject({ revision: 1, current: true, change: { operation: "publish" } });
		await store.mutate("w-deployment", { op: "invalidate" });
		expect((await store.history("w-deployment")).map(item => item.revision)).toEqual([1, 2]);
		const restored = await store.restore("w-deployment", 1);
		expect(restored).toMatchObject({ id: "w-deployment", restoredFrom: 1, revision: 3 });
		expect((await store.history("w-deployment")).map(item => item.revision)).toEqual([1, 2, 3]);
		expect((await store.history("w-deployment")).at(-1)?.change).toMatchObject({
			operation: "restore",
			restoredFrom: 1,
		});
		const current = await store.read("w-deployment");
		expect(current && "body" in current ? current.body : undefined).toBe("The deployment uses west.");
		const diff = await store.diff("w-deployment", 2, 3);
		expect(diff).toContain("--- memory://w-deployment@2");
		expect(diff).toContain("+++ memory://w-deployment@3");
		expect(diff).toContain("-status: invalidated");
		expect(diff).toContain("+status: active");
		store.close();
		store = new WikiStore({ root });
		await store.open();
		expect((await store.readRevision("w-deployment", 1))?.record).toMatchObject({
			body: "The deployment uses west.",
		});
		store.close();
	});

	it("does not create history for processing acknowledgements and restores a changed source explicitly", async () => {
		using temp = TempDir.createSync("wiki-history-source-");
		const store = new WikiStore({ root: temp.path() });
		await store.open();
		const source = await store.capture({ content: "The old deployment region is west." });
		const before = await store.history(source.id);
		await publish(store, [], [source]);
		expect((await store.history(source.id)).map(item => item.revision)).toEqual(before.map(item => item.revision));
		await store.publish(await store.snapshot(), { pages: [], processed: [] });
		const stale = await store.snapshot();
		await store.mutate(source.id, { op: "update", content: "The new deployment region is east." });
		await expect(store.publish(stale, { pages: [], processed: [{ id: source.id, revision: 1 }] })).rejects.toThrow(
			/stale|match/i,
		);
		const sourceHistory = await store.history(source.id);
		expect(sourceHistory.map(item => item.revision)).toEqual([1, 2]);
		expect((await store.readRevision(source.id, 1))?.record).toMatchObject({
			content: "The old deployment region is west.",
		});
		const restored = await store.restore(source.id, 1);
		expect(restored).toMatchObject({ id: source.id, restoredFrom: 1, revision: 3 });
		expect((await store.read(source.id))?.id).toBe(source.id);
		store.close();
	});

	it("purges every historical revision when a record is forgotten", async () => {
		using temp = TempDir.createSync("wiki-history-forget-");
		const root = temp.path();
		const store = new WikiStore({ root });
		await store.open();
		const source = await store.capture({ content: "Sensitive historical deployment detail" });
		await store.mutate(source.id, { op: "update", content: "Updated deployment detail" });
		expect((await store.history(source.id)).length).toBe(2);
		await store.mutate(source.id, { op: "forget" });
		expect(await store.history(source.id)).toEqual([]);
		expect(await store.readRevision(source.id, 1)).toBeNull();
		const files: string[] = [];
		for (const entry of await fs.readdir(path.join(root, "history", "sources"), { withFileTypes: true })) {
			if (entry.isDirectory()) files.push(entry.name);
		}
		expect(files).toEqual([]);
		store.close();
	});
});
