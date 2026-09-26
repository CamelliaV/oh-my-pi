/**
 * Driver for the recall extension (extensions/recall.ts) — the fork patch that
 * ships `history_search` (active branch) and `session_search` (other sessions on
 * disk). Runs the real registered tools against the real transcript corpus.
 *
 *   bun packages/coding-agent/test/recall-extension-driver.ts "wiki compile"
 *   bun packages/coding-agent/test/recall-extension-driver.ts --history "wiki compile"
 *   bun packages/coding-agent/test/recall-extension-driver.ts --session '{"query":"wiki","scope":"all"}'
 *   bun packages/coding-agent/test/recall-extension-driver.ts --lineage [n]
 *
 * `--lineage n` is the differential check: the top-level field scanner behind the
 * cross-session branch filter must agree with JSON.parse on every line of the n
 * most recently modified transcripts, and the reconstructed chain must reach the
 * real leaf without breaking early. A regression there silently drops live turns
 * from cross-session results, so it is checked rather than assumed.
 */
import * as fs from "node:fs/promises";
import { collectForeignJsonRecords } from "@oh-my-pi/pi-coding-agent/session/foreign-session-jsonl";
import * as TypeBox from "@oh-my-pi/omptype/typebox";
import { activeChainIds, entryLineIds } from "../../../extensions/recall";
import recallExtension from "../../../extensions/recall";

const SESSIONS = `${process.env.HOME}/.omp/agent/sessions`;
// A real, already-ended session from the wiki-compile investigation.
const FOREIGN_SESSION = `${SESSIONS}/-code-oh-my-pi/2026-09-26T06-22-15-219Z_01a0dc60-eeb3-7007-a721-a4babca7930e.jsonl`;

interface RegisteredTool {
	name: string;
	description: string;
	loadMode?: string;
	approval?: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
}

const tools = new Map<string, RegisteredTool>();
recallExtension({
	typebox: TypeBox,
	registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
} as never);

// Real active branch of a real transcript, root→leaf, so history_search runs the
// same rendering path it runs in a live session (including the refactored expand).
const records = (await collectForeignJsonRecords(FOREIGN_SESSION)).map(record => record.value);
const byId = new Map<string, Record<string, unknown>>();
for (const record of records) if (typeof record.id === "string") byId.set(record.id, record);
const branch: Record<string, unknown>[] = [];
let cursor = records[records.length - 1]?.id as string | undefined;
while (cursor) {
	const record: Record<string, unknown> | undefined = byId.get(cursor);
	if (!record) break;
	branch.push(record);
	cursor = typeof record.parentId === "string" ? record.parentId : undefined;
}
branch.reverse();

const ctx = {
	sessionManager: {
		getSessionFile: () => FOREIGN_SESSION,
		getBranch: () => branch,
	},
};

async function run(name: string, params: Record<string, unknown>): Promise<void> {
	const target = tools.get(name);
	if (!target) throw new Error(`${name} was not registered`);
	console.log(`--- ${name} (loadMode=${target.loadMode} approval=${target.approval}) params=${JSON.stringify(params)}`);
	const started = performance.now();
	const result = await target.execute("driver", params, undefined, undefined, ctx);
	const text = result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const images = result.content.filter(block => block.type === "image");
	console.log(text);
	console.log(
		`--- wall ${(performance.now() - started).toFixed(0)}ms · ${text.length} chars · ${images.length} image blocks · ` +
			`text blocks: ${result.content.length - images.length}`,
	);
}

function parseArgs(argv: string[]): { tool: string; params: Record<string, unknown> } {
	const flag = argv[0];
	if (flag === "--history" || flag === "--session") {
		const rest = argv.slice(1);
		return { tool: flag === "--history" ? "history_search" : "session_search", params: buildParams(rest) };
	}
	return { tool: "session_search", params: buildParams(argv) };
}

function buildParams(argv: string[]): Record<string, unknown> {
	const params: Record<string, unknown> = argv[0]?.startsWith("{") ? JSON.parse(argv[0]) : { query: argv.join(" ") };
	for (const arg of argv.slice(1)) {
		const eq = arg.indexOf("=");
		if (eq < 0) continue;
		const key = arg.slice(0, eq);
		const value = arg.slice(eq + 1);
		params[key] = /^\d+$/.test(value) ? Number(value) : value;
	}
	return params;
}

async function checkLineage(sampleSize: number): Promise<void> {
	const candidates: { file: string; mtimeMs: number }[] = [];
	const glob = new Bun.Glob("**/*.jsonl");
	for await (const rel of glob.scan({ cwd: SESSIONS, dot: false })) {
		const file = `${SESSIONS}/${rel}`;
		const st = await fs.stat(file);
		if (st.isFile()) candidates.push({ file, mtimeMs: st.mtimeMs });
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const files = candidates.slice(0, sampleSize);
	let lines = 0;
	let unreadable = 0;
	let chains = 0;
	let mismatches = 0;
	let unfiltered = 0;
	for (const { file } of files) {
		const text = await Bun.file(file).text();
		const truth: { id?: unknown; parentId?: unknown }[] = [];
		for (const line of text.split("\n")) {
			if (line.length === 0) continue;
			lines++;
			let parsed: { id?: unknown; parentId?: unknown };
			try {
				parsed = JSON.parse(line) as { id?: unknown; parentId?: unknown };
			} catch {
				continue; // Truncated tail line.
			}
			truth.push(parsed);
			const got = entryLineIds(line);
			if (!got) {
				unreadable++;
				if (typeof parsed.id === "string" && parsed.parentId !== undefined) {
					mismatches++;
					console.log(`UNREADABLE but parseable: ${file}\n  ${line.slice(0, 140)}`);
				}
				continue;
			}
			const expected = typeof parsed.parentId === "string" ? parsed.parentId : null;
			if (got.id !== parsed.id || got.parentId !== expected) {
				mismatches++;
				console.log(
					`MISMATCH ${file}\n  got   ${JSON.stringify(got)}\n  truth ${JSON.stringify({ id: parsed.id, parentId: expected })}`,
				);
			}
		}
		const chain = activeChainIds(text);
		if (!chain) {
			unfiltered++;
			continue;
		}
		chains++;
		const leaf = truth[truth.length - 1]?.id;
		if (typeof leaf === "string" && !chain.has(leaf)) {
			mismatches++;
			console.log(`CHAIN MISSING LEAF: ${file} leaf=${leaf}`);
		}
		const parents = new Map<string, string | null>();
		for (const entry of truth) {
			if (typeof entry.id === "string") parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
		}
		let link: string | undefined = typeof leaf === "string" ? leaf : undefined;
		let depth = 0;
		while (link !== undefined && link !== null && !chain.has(link)) {
			if (!parents.has(link)) break;
			link = parents.get(link) ?? undefined;
			depth++;
		}
		if (depth > 0) {
			mismatches++;
			console.log(`CHAIN BREAKS EARLY: ${file} after ${depth} links (chain=${chain.size})`);
		}
	}
	console.log(
		`lineage: files=${files.length} lines=${lines} unreadable=${unreadable} chains=${chains} ` +
			`unfiltered=${unfiltered} mismatches=${mismatches}`,
	);
	if (mismatches > 0) process.exitCode = 1;
}

const argv = process.argv.slice(2);
if (argv[0] === "--lineage") {
	await checkLineage(Number(argv[1] ?? 300));
} else {
	const { tool, params } = parseArgs(argv);
	await run(tool, params);
	if (tool === "history_search" && params.expand === undefined) {
		const firstUser = branch.find(entry => (entry.message as { role?: string } | undefined)?.role === "user");
		if (typeof firstUser?.id === "string") await run("history_search", { expand: [firstUser.id], include_images: true });
	}
	if (tool === "session_search" && params.expand === undefined) {
		const hits = await tools.get("session_search")?.execute("driver", { query: String(params.query ?? "") }, undefined, undefined, ctx);
		const first = hits?.content
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n")
			.match(/expand:\["([^"]+)"\]/)?.[1];
		if (first) await run("session_search", { expand: [first] });
	}
}

