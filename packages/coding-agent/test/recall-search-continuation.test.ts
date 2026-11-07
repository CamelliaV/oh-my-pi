import { beforeAll, afterAll, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionSearch } from "../../../extensions/recall/session-search";
import type { SearchResult, SearchDetails, ExpandDetails } from "../../../extensions/recall/session-search";
import { entryBodyText } from "../../../extensions/recall/core";
import type { BranchEntryLike } from "../../../extensions/recall/core";
let temp = "";
beforeAll(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "recall-v3-test-"));
});
afterAll(async () => {
	await fs.rm(temp, { recursive: true, force: true });
});
const root = () => path.join(temp, "sessions");
const current = (p: string) => path.join(root(), p, "current.jsonl");
const message = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-07T13:00:00Z",
	message: { role: "user", content: [{ type: "text" as const, text }] },
});
async function fixture(p: string, name: string, rows: object[]) {
	const f = path.join(root(), p, name + ".jsonl");
	await Bun.write(
		f,
		[{ type: "session", id: name, version: 3, timestamp: "2026-11-07T13:00:00Z" }, ...rows]
			.map(r => JSON.stringify(r))
			.join("\n") + "\n",
	);
	return f;
}
function info(r: SearchResult): SearchDetails {
	if (!r.details || "error" in r.details || "kind" in r.details) throw new Error(JSON.stringify(r));
	return r.details;
}
function expanded(r: SearchResult): ExpandDetails {
	if (!r.details || !("kind" in r.details)) throw new Error(JSON.stringify(r));
	return r.details;
}
const text = (r: SearchResult) =>
	r.content
		.filter(b => b.type === "text")
		.map(b => b.text)
		.join("\n");
const longRows = (query: string) =>
	Array.from({ length: 6002 }, (_, i) =>
		message(
			`n${String(i).padStart(7, "0")}`,
			i ? `n${String(i - 1).padStart(7, "0")}` : null,
			query + ` evidence ${i}`,
		),
	);

test("unrelated writer cannot invalidate pages or continuation", async () => {
	const engine = new SessionSearch(root);
	for (let i = 0; i < 10; i++)
		await fixture("append-page", String(i), [message(`p000000${i}`, null, "pageprobe evidence")]);
	const busy = await fixture("append-page", "busy", [message("busy0001", null, "unrelated work")]);
	const first = info(await engine.execute({ query: "pageprobe", days: 0 }, current("append-page")));
	await fs.appendFile(busy, JSON.stringify(message("busy0002", "busy0001", "another unrelated message")) + "\n");
	const second = info(await engine.execute({ nextPageCursor: first.nextPageCursor! }, current("append-page")));
	expect([...first.results, ...second.results]).toHaveLength(10);
	await fixture("append-scan", "long", longRows("scanprobe"));
	const writer = await fixture("append-scan", "busy", [message("busy0001", null, "unrelated")]);
	const partial = info(await engine.execute({ query: "scanprobe", days: 0 }, current("append-scan")));
	await fs.appendFile(writer, JSON.stringify(message("busy0002", "busy0001", "append")) + "\n");
	const done = info(await engine.execute({ continueScanCursor: partial.continueScanCursor! }, current("append-scan")));
	expect(done.matchingFragments).toBe(6002);
	expect(done.complete).toBe(true);
});
test("append to the partial file is excluded from its captured prefix and later branch changes are checked by expand", async () => {
	const engine = new SessionSearch(root),
		rows = longRows("captureprobe");
	const file = await fixture("capture", "long", rows);
	const first = info(await engine.execute({ query: "captureprobe", days: 0 }, current("capture")));
	await fs.appendFile(file, JSON.stringify(message("newbranch", null, "captureprobe new branch")) + "\n");
	const done = info(await engine.execute({ continueScanCursor: first.continueScanCursor! }, current("capture")));
	expect(done.matchingFragments).toBe(6002);
	expect(done.evidenceState).toBe("captured-snapshot");
	expect(text(await engine.execute(done.results[0].entries[0].expandArgs, current("capture")))).toContain(
		"no matching entry on the current active branch",
	);
	const fresh = info(await engine.execute({ query: "captureprobe", days: 0 }, current("capture")));
	expect(fresh.matchingFragments).toBe(1);
	expect(fresh.results[0].entries[0].ref).toEndWith("#newbranch");
});
test("rewriting a partial file rescans only that file and removes its old fragments", async () => {
	const engine = new SessionSearch(root);
	await fixture("rewrite", "long", longRows("rewriteprobe"));
	const first = info(await engine.execute({ query: "rewriteprobe", days: 0 }, current("rewrite")));
	expect(first.matchingFragments).toBe(6000);
	await fixture("rewrite", "long", [message("new00001", null, "rewriteprobe replacement evidence")]);
	const done = info(await engine.execute({ continueScanCursor: first.continueScanCursor! }, current("rewrite")));
	expect(done.matchingFragments).toBe(1);
	expect(done.changedFiles).toEqual(["rewrite/long"]);
	expect(done.results[0].entries[0].ref).toEndWith("#new00001");
	expect(text(await engine.execute({ continueScanCursor: first.continueScanCursor! }, current("rewrite")))).toContain(
		"expired",
	);
});
test("within-session cursor enumerates all 12 separated hits once and replays stably", async () => {
	const rows = [];
	let parent: string | null = null;
	for (let i = 0; i < 12; i++) {
		const id = `hit${String(i).padStart(5, "0")}`;
		rows.push(message(id, parent, `hitprobe evidence ${i}`));
		parent = id;
		for (let j = 0; j < 10; j++) {
			const id = `fill${i}-${j}`;
			rows.push(message(id, parent, "unrelated filler"));
			parent = id;
		}
	}
	await fixture("matches", "long", rows);
	const engine = new SessionSearch(root);
	const first = info(await engine.execute({ query: "hitprobe", days: 0 }, current("matches")));
	expect(first.results[0].entries).toHaveLength(6);
	expect(first.results[0].nextMatchCursor).not.toBeNull();
	const args = { nextMatchCursor: first.results[0].nextMatchCursor! };
	const second = info(await engine.execute(args, current("matches")));
	expect(second.results[0].entries).toHaveLength(6);
	expect(second.nextMatchCursor).toBeNull();
	expect(new Set([...first.results[0].entries, ...second.results[0].entries].map(e => e.ref)).size).toBe(12);
	expect(info(await engine.execute(args, current("matches"))).results).toEqual(second.results);
	expect(text(await engine.execute({ ...args, query: "different" }, current("matches")))).toContain("options changed");
});
test("generated cross-project expand args reach the long tail and content pages reconstruct the full original", async () => {
	const body = "😀background ".repeat(3000) + "最终结论：tailprobe 原因明确";
	const entry = message("tail0001", null, body);
	await fixture("remote", "long", [entry]);
	const engine = new SessionSearch(root);
	const found = info(await engine.execute({ query: "tailprobe", scope: "all", days: 0 }, current("caller")));
	const args = found.results[0].entries[0].expandArgs;
	expect(args.scope).toBe("all");
	const window = expanded(await engine.execute(args, current("caller"))).entries[0];
	expect(window.text).toContain("tailprobe");
	expect(window.start).toBeGreaterThan(24000);
	expect(window.hasBefore).toBe(true);
	const result = await engine.execute({ ...args, offset: 0, limit: 7001 }, current("caller"));
	let piece = expanded(result).entries[0],
		all = piece.text;
	let previousEnd = piece.end;
	while (piece.nextArgs) {
		piece = expanded(await engine.execute(piece.nextArgs, current("caller"))).entries[0];
		expect(piece.start).toBe(previousEnd);
		all += piece.text;
		previousEnd = piece.end;
	}
	expect(all).toBe(entryBodyText(entry as BranchEntryLike));
});
test("content replacement invalidates text paging even when entry id remains on branch", async () => {
	const engine = new SessionSearch(root);
	await fixture("content-version", "long", [message("body0001", null, "data ".repeat(4000))]);
	const first = expanded(
		await engine.execute({ expand: ["content-version/long#body0001"], limit: 1000 }, current("content-version")),
	).entries[0];
	expect(first.nextArgs).not.toBeNull();
	await fixture("content-version", "long", [message("body0001", null, "changed ".repeat(4000))]);
	expect(text(await engine.execute(first.nextArgs!, current("content-version")))).toContain("content changed");
});
test("a corrupt branch cannot be expanded as current verified evidence", async () => {
	const file = await fixture("unverified", "broken", [message("live0001", null, "evidence")]);
	await fs.appendFile(file, '{"id":"unfinished"');
	const r = await new SessionSearch(root).execute({ expand: ["unverified/broken#live0001"] }, current("unverified"));
	expect(expanded(r).entries).toHaveLength(0);
	expect(text(r)).toContain("cannot verify");
});
