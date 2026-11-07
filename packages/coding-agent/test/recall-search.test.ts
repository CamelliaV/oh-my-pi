import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionSearch } from "../../../extensions/recall/session-search";
import type { SearchDetails, SearchResult, SessionSearchParams } from "../../../extensions/recall/session-search";
let temp = "";
beforeAll(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-search-contract-"));
});
afterAll(async () => {
	await fs.rm(temp, { recursive: true, force: true });
});
const stamp = "2026-11-07T08:00:00.000Z";
function msg(id: string, parentId: string | null, text: string, role = "user", toolName?: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: stamp,
		message: { role, content: [{ type: "text", text }], ...(toolName ? { toolName } : {}) },
	};
}
async function file(project: string, name: string, entries: object[], escaped = false) {
	const target = path.join(path.join(temp, "sessions"), project, name + ".jsonl");
	let text =
		[{ type: "session", id: name, version: 3, timestamp: stamp, title: name, cwd: "/fixture" }, ...entries]
			.map(x => JSON.stringify(x))
			.join("\n") + "\n";
	if (escaped) text = text.replace(/TS2304/g, "\\u0054\\u00532304").replace(/浏览器/g, "\\u6d4f\\u89c8\\u5668");
	await Bun.write(target, text);
	return target;
}
const current = (project: string) => path.join(path.join(temp, "sessions"), project, "current.jsonl");
function info(result: SearchResult): SearchDetails {
	if (!result.details || "error" in result.details || "kind" in result.details)
		throw new Error(JSON.stringify(result));
	return result.details;
}
function text(result: SearchResult): string {
	return result.content
		.filter(b => b.type === "text")
		.map(b => b.text)
		.join("\n");
}
async function search(
	project: string,
	params: SessionSearchParams,
	engine = new SessionSearch(() => path.join(temp, "sessions")),
) {
	return engine.execute({ days: 0, ...params }, current(project));
}

test("uppercase, lowercase and JSON-escaped content remain searchable", async () => {
	await file("case", "plain", [msg("case0001", null, "构建报错 TS2304，需要补充类型声明。")]);
	await file("case", "escaped", [msg("case0002", null, "浏览器 TS2304")], true);
	for (const query of ["TS2304", "ts2304"]) expect(info(await search("case", { query })).matchingSessions).toBe(2);
	expect(info(await search("case", { query: "浏览器" })).matchingSessions).toBe(1);
});
test("best later evidence determines session rank and appears before earlier weak hits", async () => {
	await file("ranking", "A", [
		msg("a0000001", null, "isolation " + "background ".repeat(100)),
		msg("a0000002", "a0000001", "profile isolation 已完成"),
	]);
	await file("ranking", "B", [msg("b0000001", null, "isolation 检查状态")]);
	const d = info(await search("ranking", { query: "profile isolation" }));
	expect(d.results[0].sessionRef).toBe("ranking/A");
	expect(d.results[0].entries[0].ref).toEndWith("#a0000002");
	expect(d.results[0].score).toBeGreaterThan(d.results[1].score);
});
test("snippet shows the tail match while expand preserves original text and neighboring entries", async () => {
	await file("snippet", "long", [
		msg("s0000000", null, "先前问题"),
		msg("s0000001", "s0000000", "背景".repeat(500) + "最终结论：needleq 根因是旧状态缓存，清空后恢复。", "assistant"),
		msg("s0000002", "s0000001", "后续确认"),
	]);
	const engine = new SessionSearch(() => path.join(temp, "sessions"));
	const d = info(await search("snippet", { query: "needleq" }, engine));
	expect(d.results[0].entries[0].snippet).toMatch(/【needleq】\s*根因是旧状态缓存/);
	const expanded = await engine.execute({ expand: [d.results[0].entries[0].ref], context: 1 }, current("snippet"));
	expect(text(expanded)).toContain("背景".repeat(500));
	expect(text(expanded)).toContain("先前问题");
	expect(text(expanded)).toContain("后续确认");
});
test("same-named nested sessions stay distinct and both new and legacy unambiguous refs expand", async () => {
	await file("nested", "p1/Worker", [msg("nested01", null, "deepneedle first task")]);
	await file("nested", "p2/Worker", [msg("nested02", null, "deepneedle second task")]);
	const engine = new SessionSearch(() => path.join(temp, "sessions"));
	const d = info(await search("nested", { query: "deepneedle" }, engine));
	expect(d.matchingSessions).toBe(2);
	for (const result of d.results)
		expect(text(await engine.execute({ expand: [result.entries[0].ref] }, current("nested")))).toContain(
			result.sessionRef.includes("p1") ? "first task" : "second task",
		);
	expect(text(await engine.execute({ expand: ["Worker#nested01"] }, current("nested")))).toContain("first task");
	expect(text(await engine.execute({ expand: ["Worker#nested0"] }, current("nested")))).toContain("ambiguous");
	expect(text(await engine.execute({ expand: ["../../elsewhere#nested01"] }, current("nested")))).toContain(
		"outside requested scope",
	);
});
test("all is within one fragment, CJK runs are literal units, phrase is contiguous", async () => {
	await file("modes", "both", [msg("m0000001", null, "Zen Profile 主浏览器")]);
	await file("modes", "apart", [msg("m0000002", null, "Zen 提示"), msg("m0000003", "m0000002", "profile 耳机")]);
	await file("modes", "reversed", [msg("m0000004", null, "profile and zen")]);
	await file("modes", "cjk", [
		msg("m0000005", null, "浏览器配置 已恢复"),
		msg("m0000006", "m0000005", "浏览 手册 器配 配置"),
	]);
	expect(info(await search("modes", { query: "Zen Profile", match: "all" })).matchingSessions).toBe(2);
	expect(info(await search("modes", { query: "Zen Profile", match: "phrase" })).matchingSessions).toBe(1);
	expect(info(await search("modes", { query: "浏览器配置", match: "all" })).matchingFragments).toBe(1);
});
test("regex alternatives, classes, optional literals and ignore-case cannot be rejected by an unsafe prefilter", async () => {
	await file("regex", "data", [
		msg("r0000001", null, "TS2304"),
		msg("r0000002", "r0000001", "abcxyz"),
		msg("r0000003", "r0000002", "xxx"),
	]);
	expect(info(await search("regex", { query: "/TS\\d+/i" })).matchingFragments).toBe(1);
	expect(info(await search("regex", { query: "/missing|abcxyz/" })).matchingFragments).toBe(1);
	expect(info(await search("regex", { query: "/(optional)?xxx/" })).matchingFragments).toBe(1);
	expect(info(await search("regex", { query: "/^[a-z]+$/" })).matchingFragments).toBe(2);
});
test("direct search echoes are optional and conversation source filtering retains original statements", async () => {
	await file("echo", "data", [
		msg("e0000001", null, "echoquery 用户"),
		msg("e0000002", "e0000001", "echoquery 搜索回包", "toolResult", "session_search"),
		msg("e0000003", "e0000002", "echoquery 程序输出", "toolResult", "bash"),
	]);
	expect(info(await search("echo", { query: "echoquery" })).matchingFragments).toBe(2);
	expect(info(await search("echo", { query: "echoquery", include_search_results: true })).matchingFragments).toBe(3);
	expect(info(await search("echo", { query: "echoquery", sources: "conversation" })).matchingFragments).toBe(1);
});
test("pages enumerate every session once and replay returns the same page", async () => {
	for (let i = 0; i < 10; i++) await file("pages", String(i), [msg(`page000${i}`, null, "pageprobe 记录")]);
	const engine = new SessionSearch(() => path.join(temp, "sessions")),
		first = info(await search("pages", { query: "pageprobe" }, engine));
	expect(first.results).toHaveLength(8);
	expect(first.nextPageCursor).not.toBeNull();
	const next = { nextPageCursor: first.nextPageCursor! };
	const second = info(await engine.execute(next, current("pages")));
	expect(second.results).toHaveLength(2);
	expect(second.nextPageCursor).toBeNull();
	expect(new Set([...first.results, ...second.results].map(r => r.sessionRef)).size).toBe(10);
	expect(info(await engine.execute(next, current("pages"))).results).toEqual(second.results);
});
test("a file-internal continuation reaches entry 6002 without duplicates and invalidates old cursors", async () => {
	const entries = Array.from({ length: 6002 }, (_, i) =>
		msg(
			`cap${String(i).padStart(5, "0")}`,
			i ? `cap${String(i - 1).padStart(5, "0")}` : null,
			i === 6001 ? "scanprobe needletail 最终结论" : "scanprobe 常规记录",
		),
	);
	await file("cap", "large", entries);
	const engine = new SessionSearch(() => path.join(temp, "sessions")),
		first = info(await search("cap", { query: "scanprobe needletail" }, engine));
	expect(first.matchedLinesProcessed).toBe(6000);
	expect(first.complete).toBe(false);
	expect(first.continueScanCursor).not.toBeNull();
	const request = { continueScanCursor: first.continueScanCursor! };
	const second = info(await engine.execute(request, current("cap")));
	expect(second.matchedLinesProcessed).toBe(6002);
	expect(second.matchingFragments).toBe(6002);
	expect(second.complete).toBe(true);
	expect(second.results[0].entries[0].ref).toEndWith("#cap06001");
	expect(text(await engine.execute(request, current("cap")))).toContain("expired");
});
test("rewound entries are absent from live expand while pagination preserves its labeled snapshot", async () => {
	const p = await file("branch", "tree", [
		msg("branch01", null, "needle root"),
		msg("branch02", "branch01", "needle abandoned"),
		msg("branch03", "branch01", "needle active"),
	]);
	for (let i = 0; i < 8; i++) await file("branch", `other${i}`, [msg(`other00${i}`, null, "needle other")]);
	const engine = new SessionSearch(() => path.join(temp, "sessions")),
		first = info(await search("branch", { query: "needle" }, engine));
	expect(first.offBranch).toBe(1);
	expect(text(await engine.execute({ expand: ["branch/tree#branch02"] }, current("branch")))).toContain(
		"no matching entry",
	);
	await fs.appendFile(p, JSON.stringify(msg("branch04", "branch01", "needle replacement")) + "\n");
	expect(info(await engine.execute({ nextPageCursor: first.nextPageCursor! }, current("branch"))).evidenceState).toBe(
		"captured-snapshot",
	);
});
test("zero hits after cancellation and corrupt tails report incomplete, never a definitive absence", async () => {
	await file("partial", "ok", [msg("partial1", null, "unrelated")]);
	const abort = new AbortController();
	abort.abort();
	const cancelled = await new SessionSearch(() => path.join(temp, "sessions")).execute(
		{ query: "absent", days: 0 },
		current("partial"),
		abort.signal,
	);
	expect(info(cancelled).complete).toBe(false);
	expect(text(cancelled)).toContain("No matches found so far");
	const p = await file("corrupt", "tail", [msg("partial2", null, "needle")]);
	await fs.appendFile(p, '{"id":"broken"');
	expect(info(await search("corrupt", { query: "needle" })).complete).toBe(false);
});
test("cursor cannot change query or cross project", async () => {
	for (let i = 0; i < 9; i++) await file("binding", String(i), [msg(`bound00${i}`, null, "needle")]);
	const engine = new SessionSearch(() => path.join(temp, "sessions")),
		d = info(await search("binding", { query: "needle" }, engine));
	expect(
		text(await engine.execute({ nextPageCursor: d.nextPageCursor!, query: "different" }, current("binding"))),
	).toContain("options changed");
	expect(text(await engine.execute({ nextPageCursor: d.nextPageCursor! }, current("another")))).toContain("expired");
});
test("large neighboring context cannot consume the target's expansion budget", async () => {
	await file("context-budget", "long", [
		msg("context1", null, "large ".repeat(6000)),
		msg("context2", "context1", "actual target evidence"),
		msg("context3", "context2", "later confirmation"),
	]);
	const engine = new SessionSearch(() => path.join(temp, "sessions"));
	const expanded = await engine.execute(
		{ expand: ["context-budget/long#context2"], context: 1 },
		current("context-budget"),
	);
	expect(text(expanded)).toContain("actual target evidence");
	expect(text(expanded)).toContain("later confirmation");
	expect(text(expanded).length).toBeLessThanOrEqual(24000);
});

test("preview marks a matching token, not an earlier substring in another word", async () => {
	await file("token-snippet", "words", [msg("token001", null, "hunks ".repeat(60) + "hunk fix")]);
	const d = info(await search("token-snippet", { query: "hunk" }));
	expect(d.results[0].entries[0].snippet).toContain("【hunk】 fix");
	expect(d.results[0].entries[0].snippet).not.toContain("【hunk】s");
});
