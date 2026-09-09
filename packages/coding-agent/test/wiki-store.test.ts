import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { WikiStore } from "../src/wiki/store";
import type { WikiPage, WikiPageDraft, WikiSource } from "../src/wiki/types";

function draft(id: string, sources: WikiSource[], body: string, overrides: Partial<WikiPageDraft> = {}): WikiPageDraft {
	return {
		id,
		expectedRevision: null,
		title: id.slice(2),
		summary: body,
		body,
		kind: "knowledge",
		status: "active",
		sources: sources.map(({ id, revision }) => ({ id, revision })),
		links: [],
		...overrides,
	};
}

async function publish(store: WikiStore, pages: WikiPageDraft[], processed: WikiSource[]): Promise<void> {
	await store.publish(await store.snapshot(), {
		pages,
		processed: processed.map(({ id, revision }) => ({ id, revision })),
	});
}

async function diskBytes(root: string): Promise<string> {
	const chunks: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		chunks.push(entry.isDirectory() ? await diskBytes(file) : (await fs.readFile(file)).toString("latin1"));
	}
	return chunks.join("\n");
}

describe("WikiStore", () => {
	it("restarts from sanitized Markdown and rebuilds processing state after loss of its index", async () => {
		using temp = TempDir.createSync("wiki-store-restart-");
		const root = path.join(temp.path(), "wiki");
		const secret = "CUSTOM-WIKI-CREDENTIAL";
		let store = new WikiStore({ root, redact: text => text.replaceAll(secret, "[REDACTED]") });
		await store.open();
		try {
			const input = {
				content: `候选窗口使用九宫格拉伸。 credential ${secret}`,
				context: `capture context ${secret}`,
				source: `transcript ${secret}`,
				cursor: `session/${secret}/message-1`,
			};
			const peer = new WikiStore({ root, redact: text => text.replaceAll(secret, "[REDACTED]") });
			await peer.open();
			let source: WikiSource;
			try {
				const captured = await Promise.all([store.capture(input), peer.capture(input)]);
				source = captured[0]!;
				expect(captured[1]!.id).toBe(source.id);
			} finally {
				peer.close();
			}
			await expect(store.capture({ ...input, content: "Different evidence under the same cursor" })).rejects.toThrow(
				"reused",
			);
			await expect(store.capture({ content: " \n\t " })).rejects.toThrow("empty");
			await expect(store.capture({ content: secret })).rejects.toThrow("empty");
			const pending = await store.capture({
				content: "A second observation has not been maintained yet",
				cursor: "message-2",
			});
			await publish(store, [draft("w-window", [source], source.content, { title: `窗口 ${secret}` })], [source]);
			const sourceMarkdown = await fs.readFile(path.join(root, "sources", `${source.id}.md`), "utf8");
			const pageMarkdown = await fs.readFile(path.join(root, "pages", "w-window.md"), "utf8");
			expect(YAML.parse(sourceMarkdown.split("---\n")[1]!)).toMatchObject({ id: source.id, revision: 1 });
			expect(YAML.parse(pageMarkdown.split("---\n")[1]!)).toMatchObject({
				sources: [{ id: source.id, revision: 1 }],
			});
			expect(await diskBytes(root)).not.toContain(secret);
			store.close();
			await fs.unlink(path.join(root, "index.db"));
			store = new WikiStore({ root });
			await store.open();
			expect((await store.snapshot()).pending.map(item => item.id)).toEqual([pending.id]);
			expect((await store.search("九宫格")).map(page => page.id)).toEqual(["w-window"]);
			expect(((await store.read("w-window")) as WikiPage).body).toBe(source.content);
		} finally {
			store.close();
		}
	});

	it("invalidates all source-derived pages, requeues surviving evidence, and rejects stale publication", async () => {
		using temp = TempDir.createSync("wiki-store-source-update-");
		const store = new WikiStore({ root: temp.path() });
		await store.open();
		try {
			const old = await store.capture({ content: "Window cap is 100 pixels" });
			const other = await store.capture({ content: "Keep the border uniform" });
			await publish(
				store,
				[draft("w-geometry", [old, other], "Window cap is 100 pixels; keep the border uniform")],
				[old, other],
			);
			const stale = await store.snapshot();
			const result = await store.mutate(old.id, { op: "update", content: "Window cap is now 140 pixels" });
			expect(result).toEqual({ status: "updated", affectedPages: ["w-geometry"] });
			expect(await store.read("w-geometry")).toBeNull();
			expect(await store.search("100 pixels")).toEqual([]);
			const current = await store.snapshot();
			expect(current.pending.map(source => source.id).sort()).toEqual([old.id, other.id].sort());
			await expect(store.publish(stale, { pages: [], processed: [] })).rejects.toThrow("Stale");
			const updated = current.pending.find(source => source.id === old.id)!;
			expect(updated.revision).toBe(old.revision + 1);
			await store.publish(current, {
				pages: [draft("w-geometry", [updated, other], "Window cap is 140 pixels; keep the border uniform")],
				processed: current.pending,
			});
			expect(((await store.read("w-geometry")) as WikiPage).body).toContain("140 pixels");
			expect((await store.snapshot()).pending).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("purges forgotten source text and every derived copy without resurrecting its capture cursor", async () => {
		using temp = TempDir.createSync("wiki-store-forget-");
		let store = new WikiStore({ root: temp.path() });
		await store.open();
		try {
			const erased = "EraseThisUniquePersonalDetailForever";
			const source = await store.capture({ content: erased, cursor: "forgotten-message" });
			const survivor = await store.capture({ content: "Keep the unrelated font preference" });
			await publish(
				store,
				[draft("w-sensitive", [source, survivor], `${erased}; unrelated font preference`)],
				[source, survivor],
			);
			const stale = await store.snapshot();
			expect((await store.mutate(source.id, { op: "forget" })).affectedPages).toEqual(["w-sensitive"]);
			expect(await store.read(source.id)).toBeNull();
			expect(await store.read("w-sensitive")).toBeNull();
			expect(await diskBytes(temp.path())).not.toContain(erased);
			store.close();
			store = new WikiStore({ root: temp.path() });
			await store.open();
			expect((await store.snapshot()).pending.map(item => item.id)).toEqual([survivor.id]);
			await expect(
				store.publish(stale, { pages: [draft("w-resurrected", [source], erased)], processed: [] }),
			).rejects.toThrow("Stale");
			await expect(store.capture({ content: erased, cursor: "forgotten-message" })).rejects.toThrow("retired");
			expect(await store.search(erased)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("preserves shared evidence and unrelated navigational neighbors when forgetting one page", async () => {
		using temp = TempDir.createSync("wiki-store-page-forget-");
		const store = new WikiStore({ root: temp.path() });
		await store.open();
		try {
			const shared = await store.capture({ content: "Window preferences include borders and fonts" });
			const unique = await store.capture({ content: "RemoveThisUnsharedDetail" });
			await publish(
				store,
				[
					draft("w-borders", [shared, unique], "RemoveThisUnsharedDetail", { links: ["w-fonts"] }),
					draft("w-fonts", [shared], "Use a monospace font", { links: ["w-borders"] }),
				],
				[shared, unique],
			);
			expect(await store.mutate("w-borders", { op: "forget" })).toEqual({
				status: "deleted",
				affectedPages: ["w-borders"],
			});
			expect(await store.read(unique.id)).toBeNull();
			expect((await store.read(shared.id))?.id).toBe(shared.id);
			expect(((await store.read("w-fonts")) as WikiPage).links).toEqual([]);
			expect((await store.search("monospace")).map(page => page.id)).toEqual(["w-fonts"]);
			expect((await store.snapshot()).pending).toEqual([]);
			expect(await diskBytes(temp.path())).not.toContain("RemoveThisUnsharedDetail");
		} finally {
			store.close();
		}
	});

	it("records explicit page corrections as new evidence without changing unrelated shared claims", async () => {
		using temp = TempDir.createSync("wiki-store-page-correction-");
		const store = new WikiStore({ root: temp.path() });
		await store.open();
		try {
			const shared = await store.capture({ content: "Use tabs and set width to four" });
			await publish(
				store,
				[draft("w-tabs", [shared], "Use tabs"), draft("w-width", [shared], "Set width to four")],
				[shared],
			);
			const original = (await store.read("w-width")) as WikiPage;
			expect(await store.mutate("w-tabs", { op: "update", content: "Prefer spaces in this project" })).toEqual({
				status: "updated",
				affectedPages: ["w-tabs"],
			});
			const correction = (await store.read("w-tabs")) as WikiPage;
			expect(correction.body).toBe("Prefer spaces in this project");
			const evidence = (await store.read(correction.sources[0]!.id)) as WikiSource;
			expect(evidence.content).toBe(correction.body);
			expect(evidence.source).toBe("manual-correction");
			expect(evidence.context).toContain("w-tabs revision 1");
			expect(await store.read("w-width")).toEqual(original);
			expect((await store.snapshot()).pending).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("rejects invented or outdated references and cannot silently drop a page's prior evidence", async () => {
		using temp = TempDir.createSync("wiki-store-citations-");
		const store = new WikiStore({ root: temp.path() });
		await store.open();
		try {
			const first = await store.capture({ content: "Enable borders" });
			const second = await store.capture({ content: "Use one pixel borders" });
			const snap = await store.snapshot();
			await expect(
				store.publish(snap, {
					pages: [draft("w-invented", [{ ...first, id: "e-invented" }], "Invented")],
					processed: [],
				}),
			).rejects.toThrow("evidence");
			await expect(
				store.publish(snap, {
					pages: [draft("w-outdated", [{ ...first, revision: 999 }], "Outdated")],
					processed: [],
				}),
			).rejects.toThrow("evidence");
			await expect(
				store.publish(snap, {
					pages: [draft("w-bad-link", [first], "Bad link", { links: ["w-missing"] })],
					processed: [],
				}),
			).rejects.toThrow("unknown");
			await expect(
				store.publish(snap, {
					pages: [draft("w-inline", [first], "See [missing](memory://e-invented)")],
					processed: [],
				}),
			).rejects.toThrow("citation");
			await publish(store, [draft("w-borders", [first, second], "Enable one pixel borders")], [first, second]);
			const current = await store.snapshot();
			await expect(
				store.publish(current, {
					pages: [draft("w-borders", [first], "Enable borders", { expectedRevision: 1 })],
					processed: [],
				}),
			).rejects.toThrow("discard");
			await expect(
				store.publish(current, {
					pages: [draft("w-borders", [first, second], "Enable borders", { expectedRevision: 2 })],
					processed: [],
				}),
			).rejects.toThrow("revision");
			expect(((await store.read("w-borders")) as WikiPage).body).toBe("Enable one pixel borders");
			expect((await store.mutate(second.id, { op: "invalidate" })).status).toBe("invalidated");
			const invalidated = await store.snapshot();
			expect(invalidated.pages).toEqual([]);
			expect(invalidated.pending.map(source => source.id)).toEqual([first.id]);
			await expect(
				store.publish(invalidated, { pages: [draft("w-retired", [second], "Retired evidence")], processed: [] }),
			).rejects.toThrow("evidence");
		} finally {
			store.close();
		}
	});

	it("fails closed on an interrupted publication and replays its durable intent after restart", async () => {
		using temp = TempDir.createSync("wiki-store-recovery-");
		const root = temp.path();
		let store = new WikiStore({ root });
		await store.open();
		try {
			const source = await store.capture({ content: "Both related facts must publish together" });
			await publish(store, [draft("w-first", [source], "First related fact"), draft("w-second", [source], "Second related fact")], [source]);
			const directory = `.wiki-txn-${crypto.randomUUID()}`;
			await fs.mkdir(path.join(root, directory));
			const entries = [];
			for (const id of ["w-first", "w-second"]) {
				const content = await Bun.file(path.join(root, "pages", `${id}.md`)).text();
				await Bun.write(path.join(root, directory, `${id}.md`), content);
				entries.push({ target: `pages/${id}.md`, staged: `${id}.md`, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") });
			}
			await Bun.write(path.join(root, ".wiki-transaction.json"), JSON.stringify({ format: 1, directory, entries }));
			const blocked = path.join(root, "pages", "w-second.md");
			await fs.unlink(blocked);
			await fs.mkdir(blocked);
			await expect(store.read("w-first")).rejects.toThrow("Unsafe Wiki file");
			store.close();
			await fs.rmdir(blocked);
			store = new WikiStore({ root });
			await store.open();
			expect((await store.snapshot()).pages.map(page => page.id)).toEqual(["w-first", "w-second"]);
			expect((await store.snapshot()).pending).toEqual([]);
			expect((await store.search("related fact")).map(page => page.id).sort()).toEqual(["w-first", "w-second"]);
		} finally { store.close(); }
	});

	it("rejects root and record escapes and isolates read, publication, mutation, and clear by root", async () => {
		using temp = TempDir.createSync("wiki-store-isolation-");
		const rootA = path.join(temp.path(), "a");
		const rootB = path.join(temp.path(), "b");
		const a = new WikiStore({ root: rootA });
		const b = new WikiStore({ root: rootB });
		await Promise.all([a.open(), b.open()]);
		try {
			await expect(a.publish(await b.snapshot(), { pages: [], processed: [] })).rejects.toThrow("Stale");
			const sourceA = await a.capture({ content: "Alpha only evidence" });
			const sourceB = await b.capture({ content: "Beta only evidence" });
			await publish(a, [draft("w-alpha", [sourceA], "Alpha only evidence")], [sourceA]);
			await publish(b, [draft("w-beta", [sourceB], "Beta only evidence")], [sourceB]);
			expect(await a.read(sourceB.id)).toBeNull();
			expect(await a.mutate(sourceB.id, { op: "forget" })).toEqual({ status: "not_found", affectedPages: [] });
			await expect(a.read("../b/pages/w-beta")).rejects.toThrow("identifier");
			await expect(a.publish(await b.snapshot(), { pages: [], processed: [] })).rejects.toThrow("Stale");
			const alias = path.join(temp.path(), "alias");
			await fs.symlink(rootB, alias);
			await expect(new WikiStore({ root: alias }).open()).rejects.toThrow("Unsafe");
			const injected = path.join(rootA, "sources", "e-symlink.md");
			await fs.symlink(path.join(rootB, "sources", `${sourceB.id}.md`), injected);
			await expect(a.clear()).rejects.toThrow("Unsafe");
			await fs.unlink(injected);
			await a.clear();
			expect(await a.snapshot()).toMatchObject({ pages: [], pending: [] });
			expect(await a.read(sourceA.id)).toBeNull();
			expect((await b.search("Beta")).map(page => page.id)).toEqual(["w-beta"]);
		} finally {
			a.close();
			b.close();
		}
	});
});
