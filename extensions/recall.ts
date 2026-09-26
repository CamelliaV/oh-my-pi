/**
 * recall — exact, on-demand search over the full session history.
 *
 * omp compaction never deletes data: old messages stay in the session tree and
 * remain reachable through SessionManager.getBranch() even after they fall out
 * of the live context window. This extension gives the model a tool to query
 * that invisible-but-present history:
 *
 *   - corpus     active branch (root→leaf), including pre-compaction and
 *                pre-/clear entries; no JSONL parsing, zero I/O — entries are
 *                already resident in memory
 *   - ranking    BM25 with tier weights (user > assistant > tool I/O >
 *                thinking) plus CJK bigram tokenization so Chinese sessions
 *                rank correctly; regex mode for exact patterns
 *   - output     turn-grouped view: hits marked `>` inside their conversational
 *                segment, char-budgeted and paginated
 *   - expand     entry ids (or unique id prefixes) render full original
 *                content; include_images re-attaches image blobs (screenshots)
 *                that the model saw earlier but lost to compaction
 *
 * Stateless by design: every execute() reads the current ctx.sessionManager,
 * so resume, mid-process session switches, and branching all work unchanged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { collectForeignJsonRecords } from "@oh-my-pi/pi-coding-agent/session/foreign-session-jsonl";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getSessionsDir, isRecord } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Structural types (kept local so the extension stays decoupled from core)
// ---------------------------------------------------------------------------

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}
interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

interface MessageLike {
	role: string;
	content: string | ContentBlock[];
	synthetic?: boolean;
	toolName?: string;
	isError?: boolean;
}

interface BranchEntryLike {
	type: string;
	id: string;
	timestamp: string;
	message?: MessageLike;
	summary?: string;
	task?: string;
	customType?: string;
	content?: string | ContentBlock[];
}

/** Source tiers: multiplier applied to terms matched in each class. */
const TIERS = {
	user: 1.0,
	task: 1.0,
	assistant: 0.9,
	compaction: 0.85,
	custom: 0.8,
	branch_summary: 0.85,
	tool_call: 0.8,
	tool_result: 0.7,
	thinking: 0.45,
} as const;
type Tier = keyof typeof TIERS;

interface Token {
	term: string;
	tier: Tier;
}

interface Doc {
	entryId: string;
	seq: number;
	kind: Tier;
	label: string;
	/** Raw single-line-ish preview source; rendered through oneLine() later. */
	preview: string;
	tokens: Token[];
	length: number;
	turn: number;
	error: boolean;
}

interface Corpus {
	docs: Doc[];
	/** docs grouped by branch seq (an entry may yield several docs). */
	bySeq: Doc[][];
	/** First/last branch seq per turn number. */
	turnBounds: Map<number, [number, number]>;
}

// ---------------------------------------------------------------------------
// Tokenizer: ASCII words (symbol-friendly) + CJK bigrams
// ---------------------------------------------------------------------------

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9_+.#/-]*/g;
// Han + kana + hangul ranges.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function tokenizeCjkRun(run: string, out: string[]): void {
	const chars: string[] = [];
	for (const ch of run) if (CJK_RE.test(ch)) chars.push(ch);
	if (chars.length === 1) {
		out.push(chars[0]);
		return;
	}
	for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
}

/** ASCII words kept whole (TS2304, session-manager.ts); CJK runs become overlapping bigrams. */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const match of text.matchAll(WORD_RE)) terms.push(match[0].toLowerCase());
	let cjkRun = "";
	for (const ch of text.replace(WORD_RE, " ")) {
		if (CJK_RE.test(ch)) {
			cjkRun += ch;
		} else if (cjkRun) {
			tokenizeCjkRun(cjkRun, terms);
			cjkRun = "";
		}
	}
	if (cjkRun) tokenizeCjkRun(cjkRun, terms);
	return terms;
}

function toTokens(text: string, tier: Tier): Token[] {
	return tokenize(text).map(term => ({ term, tier }));
}

// ---------------------------------------------------------------------------
// Corpus extraction
// ---------------------------------------------------------------------------

interface Blocks {
	text: string;
	thinking: string;
	toolCalls: ToolCallBlock[];
	images: ImageBlock[];
}

function extractBlocks(content: string | ContentBlock[] | undefined): Blocks {
	const blocks: Blocks = { text: "", thinking: "", toolCalls: [], images: [] };
	if (!content) return blocks;
	if (typeof content === "string") {
		blocks.text = content;
		return blocks;
	}
	for (const block of content) {
		if (block.type === "text") blocks.text += `${block.text}\n`;
		else if (block.type === "thinking") blocks.thinking += `${block.thinking}\n`;
		else if (block.type === "toolCall") blocks.toolCalls.push(block);
		else if (block.type === "image") blocks.images.push(block);
	}
	return blocks;
}

function makeDoc(
	entry: BranchEntryLike,
	seq: number,
	turn: number,
	kind: Tier,
	label: string,
	preview: string,
	tokens: Token[],
): Doc {
	return { entryId: entry.id, seq, kind, label, preview, tokens, length: tokens.length, turn, error: false };
}

function describeEntry(entry: BranchEntryLike, seq: number, turn: number): Doc[] {
	if (entry.type !== "message" || !entry.message) return describeNonMessage(entry, seq, turn);
	const msg = entry.message;
	const stringContent = typeof msg.content === "string" ? msg.content : undefined;
	const blocks = stringContent !== undefined
		? { text: stringContent, thinking: "", toolCalls: [] as ToolCallBlock[], images: [] as ImageBlock[] }
		: extractBlocks(msg.content);
		const docs: Doc[] = [];
		if (msg.role === "user" || msg.role === "developer") {
			const text = blocks.text || blocks.images.map(img => `[image ${img.mimeType}]`).join(" ");
			docs.push(makeDoc(entry, seq, turn, "user", "[user]", text, toTokens(text, "user")));
		} else if (msg.role === "assistant") {
			if (blocks.text.trim()) {
				docs.push(makeDoc(entry, seq, turn, "assistant", "[assistant]", blocks.text, toTokens(blocks.text, "assistant")));
			}
			if (blocks.thinking.trim()) {
				docs.push(makeDoc(entry, seq, turn, "thinking", "[thinking]", blocks.thinking, toTokens(blocks.thinking, "thinking")));
			}
			for (const call of blocks.toolCalls) {
				const preview = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
				docs.push(makeDoc(entry, seq, turn, "tool_call", `[call:${call.name}]`, preview, toTokens(preview, "tool_call")));
			}
		} else if (msg.role === "toolResult") {
			const label = `[result:${msg.toolName}]${msg.isError ? " !" : ""}`;
			const doc = makeDoc(entry, seq, turn, "tool_result", label, `${msg.toolName ?? ""} ${blocks.text}`, toTokens(`${msg.toolName ?? ""} ${blocks.text}`, "tool_result"));
			doc.error = msg.isError === true;
			docs.push(doc);
		}
		return docs;
}

function describeNonMessage(entry: BranchEntryLike, seq: number, turn: number): Doc[] {
	if (entry.type === "compaction" && entry.summary) {
		return [makeDoc(entry, seq, turn, "compaction", "[compaction]", entry.summary, toTokens(entry.summary, "compaction"))];
	}
	if (entry.type === "custom_message") {
		const text = typeof entry.content === "string" ? entry.content : extractBlocks(entry.content).text;
		return [makeDoc(entry, seq, turn, "custom", `[custom:${entry.customType ?? "?"}]`, text, toTokens(text, "custom"))];
	}
	if (entry.type === "session_init" && entry.task) {
		return [makeDoc(entry, seq, turn, "task", "[task]", entry.task, toTokens(entry.task, "task"))];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [makeDoc(entry, seq, turn, "branch_summary", "[summary]", entry.summary, toTokens(entry.summary, "branch_summary"))];
	}
	return [];
}

export function buildCorpus(entries: readonly BranchEntryLike[]): Corpus {
	const docs: Doc[] = [];
	const bySeq: Doc[][] = [];
	const turnBounds = new Map<number, [number, number]>();
	let turn = 0;
	for (let seq = 0; seq < entries.length; seq++) {
		const entry = entries[seq];
		if (entry.type === "message" && entry.message?.role === "user" && !entry.message.synthetic) turn++;
		const entryDocs = describeEntry(entry, seq, turn);
		bySeq.push(entryDocs);
		docs.push(...entryDocs);
		if (entryDocs.length > 0) {
			const bounds = turnBounds.get(turn);
			turnBounds.set(turn, [bounds?.[0] ?? seq, seq]);
		}
	}
	return { docs, bySeq, turnBounds };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface Hit<TDoc extends Doc = Doc> {
	doc: TDoc;
	score: number;
}

export function rankBm25<TDoc extends Doc>(docs: TDoc[], queryTerms: string[], regex: RegExp | undefined): Hit<TDoc>[] {
	if (docs.length === 0) return [];

	if (regex) {
		const hits: Hit<TDoc>[] = [];
		for (const doc of docs) {
			let matches = 0;
			for (const token of doc.tokens) {
				if (regex.test(token.term)) matches++;
				regex.lastIndex = 0;
			}
			if (matches > 0) hits.push({ doc, score: TIERS[doc.kind] * Math.min(matches, 20) });
		}
		hits.sort((a, b) => b.score - a.score || a.doc.seq - b.doc.seq);
		return hits;
	}

	// Term slots plus reusable count arrays: cross-session corpora reach tens of
	// thousands of documents, where a Map and a counter object per document were
	// the whole cost of the call.
	const slotOf = new Map<string, number>();
	const slots: string[] = [];
	for (const term of queryTerms) {
		if (slotOf.has(term)) continue;
		slotOf.set(term, slots.length);
		slots.push(term);
	}
	const width = slots.length;
	const df = new Int32Array(width);
	const lastDoc = new Int32Array(width).fill(-1);
	let totalLength = 0;
	for (let d = 0; d < docs.length; d++) {
		const doc = docs[d];
		totalLength += doc.length;
		for (const token of doc.tokens) {
			const slot = slotOf.get(token.term);
			if (slot === undefined || lastDoc[slot] === d) continue;
			lastDoc[slot] = d;
			df[slot]++;
		}
	}
	const avgdl = totalLength / docs.length || 1;
	const idf = new Float64Array(width);
	for (let slot = 0; slot < width; slot++) {
		const n = df[slot];
		idf[slot] = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
	}

	const tf = new Int32Array(width);
	const hits: Hit<TDoc>[] = [];
	for (const doc of docs) {
		tf.fill(0);
		let matched = false;
		for (const token of doc.tokens) {
			const slot = slotOf.get(token.term);
			if (slot === undefined) continue;
			tf[slot]++;
			matched = true;
		}
		if (!matched) continue;
		const tier = TIERS[doc.kind];
		const lengthNorm = BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
		let score = 0;
		for (let slot = 0; slot < width; slot++) {
			const count = tf[slot];
			if (count === 0) continue;
			score += tier * idf[slot] * ((count * (BM25_K1 + 1)) / (count + lengthNorm));
		}
		if (score > 0) hits.push({ doc, score });
	}
	hits.sort((a, b) => b.score - a.score || a.doc.seq - b.doc.seq);
	return hits;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const PAGE_TURNS = 5;
const OUTPUT_BUDGET_CHARS = 8000;
const PREVIEW_WIDTH = 150;
const EXPAND_CAP_CHARS = 24000;
const BROWSE_COUNT = 25;

function oneLine(text: string): string {
	return truncateToWidth(replaceTabs(text.replace(/\s+/g, " ").trim()), PREVIEW_WIDTH);
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

function renderBrowse(corpus: Corpus): string {
	const tail = corpus.docs.slice(-BROWSE_COUNT);
	const lines = [`history_search — last ${tail.length} entries (no query; pass query to search)`];
	for (const doc of tail) {
		lines.push(`#${shortId(doc.entryId)} ${doc.label}${doc.error ? " [error]" : ""} ${oneLine(doc.preview)}`);
	}
	return lines.join("\n");
}

function renderSegments(hits: Hit[], corpus: Corpus, page: number): string {
	const hitDocSet = new Set(hits.map(hit => hit.doc));
	const hitTurns = [...new Set(hits.map(hit => hit.doc.turn))].sort((a, b) => a - b);
	const totalPages = Math.max(1, Math.ceil(hitTurns.length / PAGE_TURNS));
	const pageTurns = hitTurns.slice((page - 1) * PAGE_TURNS, page * PAGE_TURNS);

	const lines: string[] = [
		`history_search — ${hits.length} matching entries across ${hitTurns.length} turns` +
			(totalPages > 1 ? ` — page ${page}/${totalPages}` : ""),
	];

	let budget = OUTPUT_BUDGET_CHARS;
	let truncated = false;
	for (const turn of pageTurns) {
		const turnHits = hits.filter(hit => hit.doc.turn === turn);
		const bounds = corpus.turnBounds.get(turn);
		const first = bounds ? shortId(corpus.bySeq[bounds[0]][0]?.entryId ?? "?") : "?";
		const last = bounds ? shortId(corpus.bySeq[bounds[1]][0]?.entryId ?? "?") : "?";
		const header = `--- turn ${turn} (#${first}..#${last}, ${turnHits.length} match${turnHits.length === 1 ? "" : "es"}) ---`;
		if (budget - header.length < 0) {
			truncated = true;
			break;
		}
		lines.push(header);
		budget -= header.length;

		// Window: hits ±2 same-turn entries, branch order, bounded to 40 rows.
		const minSeq = Math.min(...turnHits.map(hit => hit.doc.seq));
		const maxSeq = Math.max(...turnHits.map(hit => hit.doc.seq));
		const wanted = new Set<number>();
		for (const hit of turnHits) {
			for (let seq = Math.max(minSeq, hit.doc.seq - 2); seq <= Math.min(maxSeq, hit.doc.seq + 2); seq++) {
				wanted.add(seq);
			}
		}
		const rows: string[] = [];
		for (const seq of [...wanted].sort((a, b) => a - b).slice(0, 40)) {
			const docsOfSeq = corpus.bySeq[seq];
			if (!docsOfSeq || docsOfSeq.length === 0) continue;
			const hitDocs = docsOfSeq.filter(doc => hitDocSet.has(doc));
			const shown = hitDocs.length > 0 ? hitDocs : [docsOfSeq[0]];
			for (const doc of shown) {
				rows.push(`${hitDocs.length > 0 ? "> " : "  "}#${shortId(doc.entryId)} ${doc.label}${doc.error ? " [error]" : ""} ${oneLine(doc.preview)}`);
			}
		}
		for (const row of rows) {
			if (budget - row.length < 0) {
				truncated = true;
				break;
			}
			lines.push(row);
			budget -= row.length;
		}
	}

	if (truncated) lines.push("…[output budget reached — refine the query or raise page]");
	if (totalPages > page) lines.push(`more turns: page:${page + 1}`);
	if (hits[0]) lines.push(`full content: expand:["${shortId(hits[0].doc.entryId)}"]`);
	return lines.join("\n");
}

interface Expanded {
	text: string;
	images: ImageBlock[];
}

function renderExpand(requested: string[], corpus: Corpus, entries: readonly BranchEntryLike[], includeImages: boolean): Expanded {
	const lines: string[] = [];
	const images: ImageBlock[] = [];
	for (const req of requested) {
		const matching = corpus.docs.filter(doc => doc.entryId === req || doc.entryId.startsWith(req));
		if (matching.length === 0) {
			lines.push(`#${req}: no matching entry on the active branch`);
			continue;
		}
		const entryIds = [...new Set(matching.map(doc => doc.entryId))];
		if (entryIds.length > 1) {
			lines.push(`#${req}: ambiguous prefix — candidates: ${entryIds.map(shortId).join(", ")}`);
			continue;
		}
		const entryId = entryIds[0];
		const doc = matching[0];
		const entry = entries[doc.seq];
		if (!entry) continue;
		lines.push(`#${shortId(entryId)} ${doc.label} — ${entry.timestamp}`);
		lines.push(renderEntryBody(entry));
		if (includeImages) images.push(...entryBlocks(entry).images);
		lines.push("");
	}
	return { text: lines.join("\n").trimEnd(), images };
}

/** Blocks of a message entry (text/thinking/tool calls/images) or of a non-message entry. */
function entryBlocks(entry: BranchEntryLike): Blocks {
	return entry.type === "message" ? extractBlocks(entry.message?.content) : extractBlocks(entry.content);
}

/** Full original content of one entry, tab-sanitized and length-capped. */
function renderEntryBody(entry: BranchEntryLike): string {
	const blocks = entryBlocks(entry);
	const parts: string[] = [];
	if (blocks.text.trim()) parts.push(blocks.text.trimEnd());
	if (blocks.thinking.trim()) parts.push(`<thinking>\n${blocks.thinking.trimEnd()}\n</thinking>`);
	for (const call of blocks.toolCalls) parts.push(`${call.name} ${JSON.stringify(call.arguments ?? {}, null, 1)}`);
	if (parts.length === 0 && entry.summary) parts.push(entry.summary);
	if (parts.length === 0 && entry.task) parts.push(entry.task);
	let body = parts.join("\n\n");
	if (body.length > EXPAND_CAP_CHARS) body = `${body.slice(0, EXPAND_CAP_CHARS)}\n…[truncated at ${EXPAND_CAP_CHARS} chars]`;
	return replaceTabs(body);
}

// ---------------------------------------------------------------------------
// Cross-session search: byte prefilter over transcript JSONL, then the same rank
// ---------------------------------------------------------------------------

/** Hard stops, because a common term otherwise turns one call into a full-corpus parse. */
const SCAN_BUDGET_MS = 5000;
const MAX_MATCHED_LINES = 6000;
/** Largest transcript read into memory; bigger files are reported as skipped, never silently. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SESSION_GROUPS = 8;
const GROUP_ROWS = 6;
const DAY_MS = 86_400_000;

/**
 * A parsed transcript line as an entry, or undefined when the line is not one.
 * `type` and `id` gate the entry shape; describeEntry reads the rest
 * defensively, tolerating missing message/summary/task fields.
 */
function asBranchEntry(value: unknown): BranchEntryLike | undefined {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") return undefined;
	return value as unknown as BranchEntryLike;
}

interface SessionFile {
	/** Absolute transcript path. */
	file: string;
	/** Transcript basename without `.jsonl` — the left half of `sessionId#entryId`. */
	sessionId: string;
	project: string;
	size: number;
	mtimeMs: number;
}

interface SessionDoc extends Doc {
	session: SessionFile;
}

interface ScanStats {
	files: number;
	bytes: number;
	matchedLines: number;
	offBranch: number;
	/** Files whose active branch could not be reconstructed, so nothing was filtered out. */
	unfiltered: number;
	skipped: string[];
	/** Transcripts the time budget cut before they were read. */
	timedOut: boolean;
	/** The matched-line parse cap was hit. */
	parseCapped: boolean;
	/** Candidate transcripts found before scanning started. */
	candidates: number;
	elapsedMs: number;
}
/** Byte needles: multi-char tokens and CJK runs, lowercased to match JSONL casing. */
function buildNeedles(query: string): Buffer[] {
	const needles = new Set<string>();
	for (const term of new Set(tokenize(query))) {
		if (term.length >= 2) needles.add(term.toLowerCase());
	}
	// A contiguous CJK run is a strictly better prefilter than the bigrams cut from it.
	for (const run of query.match(/[぀-ヿ㐀-䶿一-鿿가-힯]{2,}/g) ?? []) needles.add(run);
	return [...needles].map(term => Buffer.from(term, "utf8"));
}


/**
 * Needles for a regex query. The byte prefilter is literal, so a pattern is
 * approximated by its literal character runs: any line the regex matches must
 * contain them, so this can only under-select, never miss. A pattern with no
 * literal run of 3+ characters (char classes, quantifiers, anchors) yields no
 * needles and the caller refuses the query rather than scanning everything.
 */
function regexNeedles(source: string): Buffer[] {
	const runs: string[] = [];
	let current = "";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "\\") {
			i++;
			current += source[i] ?? "";
			continue;
		}
		if (".*+?()[]{}|^$".includes(char)) {
			if (current.length >= 3) runs.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.length >= 3) runs.push(current);
	runs.sort((a, b) => b.length - a.length);
	return runs.slice(0, 3).map(run => Buffer.from(run, "utf8"));
}
/** Byte offsets of every line that contains a needle, merged and in file order. */
function needleLineSpans(bytes: Uint8Array, needles: Buffer[]): [number, number][] {
	// Buffer#indexOf takes a byte needle; plain Uint8Array#indexOf does not.
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const spans: [number, number][] = [];
	for (const needle of needles) {
		if (needle.length === 0 || needle.length > buf.length) continue;
		let from = 0;
		for (;;) {
			const at = buf.indexOf(needle, from);
			if (at < 0) break;
			let start = at;
			while (start > 0 && buf[start - 1] !== 0x0a) start--;
			let end = at + needle.length;
			while (end < buf.length && buf[end] !== 0x0a) end++;
			spans.push([start, end]);
			from = at + needle.length;
		}
	}
	spans.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
		else merged.push([span[0], span[1]]);
	}
	return merged;
}

/**
 * Read a JSON string starting at `start`; returns its unescaped value and the
 * index just past the closing quote, or undefined when the text is not a
 * well-formed string there.
 */
function readJsonString(text: string, start: number): { value: string; next: number } | undefined {
	if (text[start] !== '"') return undefined;
	let value = "";
	let i = start + 1;
	while (i < text.length) {
		const char = text[i];
		if (char === '"') return { value, next: i + 1 };
		if (char === "\\") {
			const escape = text[i + 1];
			if (escape === undefined) return undefined;
			if (escape === "u") {
				const hex = text.slice(i + 2, i + 6);
				if (hex.length < 4) return undefined;
				value += String.fromCharCode(Number.parseInt(hex, 16));
				i += 6;
				continue;
			}
			value += escape === "n" ? "\n" : escape === "t" ? "\t" : escape === "r" ? "\r" : escape;
			i += 2;
			continue;
		}
		value += char;
		i++;
	}
	return undefined;
}

/** Index just past the JSON value at `start` (string, number, literal, or balanced container). */
function skipJsonValue(text: string, start: number): number {
	if (text[start] === '"') return readJsonString(text, start)?.next ?? text.length;
	if (text[start] === "{" || text[start] === "[") {
		const open = text[start];
		const close = open === "{" ? "}" : "]";
		let depth = 0;
		let i = start;
		while (i < text.length) {
			const char = text[i];
			if (char === '"') {
				const str = readJsonString(text, i);
				if (!str) return text.length;
				i = str.next;
				continue;
			}
			if (char === open) depth++;
			else if (char === close) {
				depth--;
				if (depth === 0) return i + 1;
			}
			i++;
		}
		return text.length;
	}
	let i = start;
	while (i < text.length && text[i] !== "," && text[i] !== "}" && text[i] !== "\n") i++;
	return i;
}

/**
 * Top-level `id` and `parentId` of one entry, read without parsing the line. Key
 * order is not stable across entry types — a `custom` entry carries `data` before
 * `id` — so this walks top-level key/value pairs instead of matching a prefix.
 */
export function entryLineIds(line: string): { id: string; parentId: string | null } | undefined {
	let i = line.startsWith("{") ? 1 : 0;
	let id: string | undefined;
	let hasParentId = false;
	let parentId: string | null = null;
	for (;;) {
		while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ",")) i++;
		if (i >= line.length || line[i] === "}") break;
		const key = readJsonString(line, i);
		if (!key) return undefined;
		i = key.next;
		while (i < line.length && line[i] !== ":") i++;
		i++;
		if (line[i] === '"') {
			const value = readJsonString(line, i);
			if (!value) return undefined;
			i = value.next;
			if (key.value === "id") id = value.value;
			else if (key.value === "parentId") {
				hasParentId = true;
				parentId = value.value;
			}
		} else {
			if (key.value === "parentId" && line.startsWith("null", i)) {
				hasParentId = true;
				parentId = null;
			}
			i = skipJsonValue(line, i);
		}
		// id and parentId are the first two keys of a message entry; a custom
	// entry puts a nested data object first. Either way, stop once both are read.
		if (id !== undefined && hasParentId) break;
	}
	if (id === undefined || !hasParentId) return undefined;
	return { id, parentId };
}

/**
 * Ids on the active branch: walk parents up from the last appended entry. A
 * transcript also holds rewound and branched-away turns, and those must not read
 * as things that happened. Undefined disables the filter for that file rather
 * than guessing — including when the final line cannot be read, because then the
 * leaf is unknown and live entries could be dropped.
 */
export function activeChainIds(text: string): Set<string> | undefined {
	const parents = new Map<string, string | undefined>();
	let leaf: string | undefined;
	let lastLineReadable = true;
	let cursor = 0;
	for (;;) {
		const newline = text.indexOf("\n", cursor);
		const end = newline < 0 ? text.length : newline;
		let readable = true;
		if (end > cursor) {
			const ids = entryLineIds(text.slice(cursor, end));
			if (ids) {
				parents.set(ids.id, ids.parentId ?? undefined);
				leaf = ids.id;
			} else {
				readable = false;
			}
		}
		if (newline < 0) break;
		lastLineReadable = readable;
		cursor = newline + 1;
	}
	if (leaf === undefined || !lastLineReadable) return undefined;
	const chain = new Set<string>();
	for (let id: string | undefined = leaf; id !== undefined && !chain.has(id); id = parents.get(id)) chain.add(id);
	return chain;
}

async function listSessionFiles(dirs: readonly string[], sinceMs: number, stats: ScanStats): Promise<SessionFile[]> {
	const files: SessionFile[] = [];
	for (const dir of dirs) {
		const glob = new Bun.Glob("**/*.jsonl");
		try {
			for await (const rel of glob.scan({ cwd: dir, dot: false })) {
				const file = `${dir}/${rel}`;
				const st = await fs.promises.stat(file);
				if (!st.isFile()) continue;
				if (st.size > MAX_FILE_BYTES) {
					stats.skipped.push(`${rel} (${Math.round(st.size / 1024 / 1024)}MB > ${MAX_FILE_BYTES / 1024 / 1024}MB cap)`);
					continue;
				}
				if (st.mtimeMs < sinceMs) continue;
				files.push({ file, sessionId: path.basename(rel, ".jsonl"), project: path.basename(dir), size: st.size, mtimeMs: st.mtimeMs });
			}
		} catch {
			// A project directory that no longer exists is simply not searchable.
		}
	}
	return files;
}

/** Parse and describe only the lines that contain a needle; the rest is never decoded. */
async function scanSessionFile(
	session: SessionFile,
	needles: Buffer[],
	stats: ScanStats,
): Promise<SessionDoc[]> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await Bun.file(session.file).arrayBuffer());
	} catch {
		return [];
	}
	stats.bytes += bytes.byteLength;
	stats.files++;
	const spans = needleLineSpans(bytes, needles);
	if (spans.length === 0) return [];
	const chain = activeChainIds(new TextDecoder().decode(bytes));
	if (!chain) stats.unfiltered++;
	const decoder = new TextDecoder();
	const matched: BranchEntryLike[] = [];
	for (const [start, end] of spans) {
		if (stats.matchedLines >= MAX_MATCHED_LINES) {
			stats.parseCapped = true;
			break;
		}
		let value: unknown;
		try {
			value = JSON.parse(decoder.decode(bytes.subarray(start, end)));
		} catch {
			continue; // Truncated tail line, or a line too large to be an entry.
		}
		const entry = asBranchEntry(value);
		if (!entry) continue;
		if (chain && !chain.has(entry.id)) {
			stats.offBranch++;
			continue;
		}
		stats.matchedLines++;
		matched.push(entry);
	}
	if (matched.length === 0) return [];
	// matched is already in file order, so buildCorpus' seq doubles as file order.
	return buildCorpus(matched).docs.map(doc => ({ ...doc, session }));
}

function renderSessionHits(hits: Hit<SessionDoc>[], stats: ScanStats, scope: string, days: number): string {
	const groups = new Map<string, Hit<SessionDoc>[]>();
	for (const hit of hits) {
		const bucket = groups.get(hit.doc.session.sessionId);
		if (bucket) bucket.push(hit);
		else groups.set(hit.doc.session.sessionId, [hit]);
	}
	const ordered = [...groups.values()]
		.map(bucket => bucket.sort((a, b) => a.doc.seq - b.doc.seq))
		.sort((a, b) => b[0].score - a[0].score)
		.slice(0, SESSION_GROUPS);
	const window = `${days === 0 ? "all time" : `last ${days}d`}`;
	const lines = [
		`session_search — ${hits.length} matching entries across ${groups.size} sessions ` +
			`(scope=${scope}, ${window}, ${stats.elapsedMs.toFixed(0)}ms)`,
	];
	let budget = OUTPUT_BUDGET_CHARS;
	let truncated = false;
	for (const bucket of ordered) {
		const best = bucket[0].doc;
		const date = new Date(best.session.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
		const header = `--- ${best.session.project}/${best.session.sessionId} (${date}) · ${bucket.length} match${bucket.length === 1 ? "" : "es"} ---`;
		if (budget - header.length < 0) {
			truncated = true;
			break;
		}
		lines.push(header);
		budget -= header.length;
		for (const hit of bucket.slice(0, GROUP_ROWS)) {
			const row = `> #${shortId(hit.doc.entryId)} ${hit.doc.label}${hit.doc.error ? " [error]" : ""} ${oneLine(hit.doc.preview)}`;
			if (budget - row.length < 0) {
				truncated = true;
				break;
			}
			lines.push(row);
			budget -= row.length;
		}
		if (bucket.length > GROUP_ROWS) {
			const more = `  … ${bucket.length - GROUP_ROWS} more matches in this session`;
			if (budget - more.length < 0) {
				truncated = true;
				break;
			}
			lines.push(more);
			budget -= more.length;
		}
	}
	if (truncated) lines.push("…[output budget reached — add terms or narrow with days]");
	if (groups.size > ordered.length) lines.push(`more sessions: refine the query, or scope:"all" with days:0`);
	if (stats.timedOut) {
		lines.push(
			`…[scan budget reached after ${stats.files} of ${stats.candidates} candidate transcripts — results are partial; narrow with days or a rarer term]`,
		);
	}
	if (stats.parseCapped) lines.push(`…[parse budget reached at ${MAX_MATCHED_LINES} matched lines — results are partial]`);
	const coverage = [
		`scanned ${stats.files} of ${stats.candidates} candidate transcripts (${(stats.bytes / 1024 / 1024).toFixed(0)}MB)`,
		stats.offBranch > 0 ? `${stats.offBranch} rewound/branched entries dropped` : null,
		stats.unfiltered > 0 ? `${stats.unfiltered} files unfiltered (branch unreadable)` : null,
		stats.skipped.length > 0 ? `skipped: ${stats.skipped.slice(0, 3).join(", ")}` : null,
	]
		.filter(line => line !== null)
		.join(" · ");
	lines.push(coverage);
	if (hits[0]) lines.push(`full content: expand:["${hits[0].doc.session.sessionId}#${shortId(hits[0].doc.entryId)}"]`);
	return lines.join("\n");
}

/**
 * Locate a transcript entry by `sessionId#entryId`. A bare entry id is accepted
 * but only when it is long enough to be discriminating, and the walk stops as
 * soon as two transcripts claim it — otherwise a 1-character prefix reads every
 * transcript on the machine to learn what the caller should have qualified.
 */
async function resolveForeignEntry(
	requested: string,
	dirs: readonly string[],
): Promise<
	| { kind: "ok"; sessionId: string; entry: BranchEntryLike }
	| { kind: "none" }
	| { kind: "ambiguous"; sessionIds: string[] }
	| { kind: "needsSession"; minLength: number }
> {
	const [maybeSession, ...rest] = requested.split("#");
	const qualified = rest.length > 0 && maybeSession.length > 0;
	const entryPrefix = qualified ? rest.join("#") : requested;
	if (!qualified && entryPrefix.length < 6) {
		return { kind: "needsSession", minLength: 6 };
	}
	const candidates: { file: string; sessionId: string }[] = [];
	if (qualified) {
		for (const dir of dirs) candidates.push({ file: `${dir}/${maybeSession}.jsonl`, sessionId: maybeSession });
	} else {
		const glob = new Bun.Glob("**/*.jsonl");
		for (const dir of dirs) {
			try {
				for await (const rel of glob.scan({ cwd: dir, dot: false })) {
					candidates.push({ file: `${dir}/${rel}`, sessionId: path.basename(rel, ".jsonl") });
				}
			} catch {
				// Unreadable project directory contributes no candidates.
			}
		}
	}
	const hits: { sessionId: string; entry: BranchEntryLike }[] = [];
	for (const candidate of candidates) {
		let records: { value: Record<string, unknown> }[];
		try {
			records = await collectForeignJsonRecords(candidate.file);
		} catch {
			continue;
		}
		for (const record of records) {
			const entry = asBranchEntry(record.value);
			if (!entry) continue;
			if (entry.id !== entryPrefix && !entry.id.startsWith(entryPrefix)) continue;
			const existing = hits.find(hit => hit.sessionId === candidate.sessionId);
			if (existing) {
				existing.entry = entry;
				continue;
			}
			hits.push({ sessionId: candidate.sessionId, entry });
			if (hits.length > 1) return { kind: "ambiguous", sessionIds: hits.map(hit => hit.sessionId) };
		}
	}
	if (hits.length === 0) return { kind: "none" };
	return { kind: "ok", sessionId: hits[0].sessionId, entry: hits[0].entry };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface RecallParams {
	query?: string;
	regex?: boolean;
	page?: number;
	expand?: string[];
	include_images?: boolean;
}

interface SessionSearchParams {
	query?: string;
	regex?: boolean;
	scope?: string;
	days?: number;
	expand?: string[];
	include_images?: boolean;
}

/** Project directories a cross-session scan may read, in the order results are labelled. */
function searchDirs(scope: string, currentProjectDir: string | undefined): string[] {
	const root = getSessionsDir();
	if (scope !== "all") return currentProjectDir ? [currentProjectDir] : [];
	try {
		const dirs = fs
			.readdirSync(root, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.map(entry => `${root}/${entry.name}`);
		if (currentProjectDir) return [currentProjectDir, ...dirs.filter(dir => dir !== currentProjectDir)];
		return dirs;
	} catch {
		return currentProjectDir ? [currentProjectDir] : [];
	}
}

export default function recallExtension(pi: ExtensionAPI): void {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "history_search",
		label: "History Search",
		description:
			"Search the FULL session history on the active branch — including messages that already fell out of your context window through compaction or /clear. " +
			"The history never left memory; this tool queries it directly. Use it whenever you suspect earlier work, decisions, error codes, symbols, file paths, or " +
			"user instructions you can no longer see. Multi-term queries rank OR-wise (rare terms weigh more); wrap a pattern in slashes (/re/) or set regex:true " +
			"for regexp matching. Returns turn-grouped excerpts; use expand:[entryId] for full original content and include_images:true while expanding to " +
			"re-attach screenshots seen earlier.",
		loadMode: "essential",
		approval: "read",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Search terms (OR-ranked), or /pattern/ for regex. CJK-aware. Empty = browse the last 25 entries.",
				}),
			),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression over tokens." })),
			page: Type.Optional(Type.Number({ description: "1-based page of turn groups (5 per page)." })),
			expand: Type.Optional(
				Type.Array(Type.String(), { description: "Entry ids (or unique prefixes) to render in full instead of searching." }),
			),
			include_images: Type.Optional(
				Type.Boolean({ description: "With expand: re-attach image content (screenshots) found on those entries." }),
			),
		}),
		async execute(_toolCallId, params: RecallParams, _signal, _onUpdate, ctx): Promise<{ content: ResultBlock[] }> {
			const entries = ctx.sessionManager.getBranch() as readonly BranchEntryLike[];
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "Session is empty — nothing to search." }] };
			}
			const corpus = buildCorpus(entries);

			if (params.expand && params.expand.length > 0) {
				const expanded = renderExpand(params.expand, corpus, entries, params.include_images === true);
				const content: ResultBlock[] = [{ type: "text", text: expanded.text }];
				for (const img of expanded.images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
				return { content };
			}

			const rawQuery = params.query?.trim() ?? "";
			if (!rawQuery) {
				return { content: [{ type: "text", text: renderBrowse(corpus) }] };
			}

			let regex: RegExp | undefined;
			const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(rawQuery);
			if (params.regex === true || slashMatch) {
				const source = slashMatch ? slashMatch[1] : rawQuery;
				const flags = slashMatch?.[2]?.replace(/[gy]/g, "") ?? "";
				try {
					regex = new RegExp(source, flags);
				} catch (error) {
					return { content: [{ type: "text", text: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` }] };
				}
			}

			const queryTerms = regex ? [] : [...new Set(tokenize(rawQuery))];
			if (!regex && queryTerms.length === 0) {
				return { content: [{ type: "text", text: "Query produced no searchable tokens." }] };
			}

			const hits = rankBm25(corpus.docs, queryTerms, regex);
			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches for "${rawQuery}" in ${corpus.docs.length} entries. Try broader terms, or regex:/pattern/.`,
						},
					],
				};
			}

			const page = Math.max(1, Math.floor(params.page ?? 1));
			return { content: [{ type: "text", text: renderSegments(hits, corpus, page) }] };
		},
	});

	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description:
			"Search OTHER sessions on this machine (the on-disk transcript corpus), not just the active branch — use it when the answer may live in a " +
			"session that already ended, was resumed later, or ran in another session entirely. Scans transcript JSONL with a byte-level prefilter " +
			"and ranks the survivors with the same BM25 tiers as history_search; rewound/branched-away entries are dropped so results read as things " +
			"that actually happened. Default scope is the current project directory; scope:\"all\" widens to every project. Results are grouped per " +
			"session with its date; use expand:[\"sessionId#entryId\"] for the full original text.",
		loadMode: "essential",
		approval: "read",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search terms (OR-ranked), or /pattern/ for regex. CJK-aware." })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression over tokens." })),
			scope: Type.Optional(
				Type.String({ description: "\"project\" (default, current project dir) or \"all\" (every project under the sessions root)." }),
			),
			days: Type.Optional(Type.Number({ description: "Only transcripts modified within N days. Default 30; 0 = all time." })),
			expand: Type.Optional(
				Type.Array(Type.String(), { description: "\"sessionId#entryId\" (or a bare entry id) to render in full instead of searching." }),
			),
			include_images: Type.Optional(
				Type.Boolean({ description: "With expand: re-attach image content found on those entries." }),
			),
		}),
		async execute(_toolCallId, params: SessionSearchParams, signal, _onUpdate, ctx): Promise<{ content: ResultBlock[] }> {
			const currentProjectDir = (() => {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) return undefined;
				const root = getSessionsDir();
				const relative = path.relative(root, sessionFile);
				const [project] = relative.split(path.sep);
				return project ? `${root}/${project}` : undefined;
			})();
			const scope = params.scope === "all" ? "all" : "project";
			const dirs = searchDirs(scope, currentProjectDir);
			if (dirs.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: currentProjectDir
								? `No searchable transcripts under ${currentProjectDir}.`
								: "This session is not file-backed, so its project directory is unknown — pass scope:\"all\" to search every project.",
						},
					],
				};
			}

			if (params.expand && params.expand.length > 0) {
				const lines: string[] = [];
				const images: ImageBlock[] = [];
				for (const request of params.expand) {
					const resolved = await resolveForeignEntry(request, dirs);
					if (resolved.kind === "needsSession") {
						lines.push(
							`#${request}: a bare entry id needs at least ${resolved.minLength} characters to be worth searching every transcript for — ` +
								`pass "sessionId#entryId" (the session id is in the group header above).`,
						);
						continue;
					}
					if (resolved.kind === "none") {
						lines.push(`#${request}: no matching entry in ${dirs.length} searchable transcript director${dirs.length === 1 ? "y" : "ies"}`);
						continue;
					}
					if (resolved.kind === "ambiguous") {
						const shown = resolved.sessionIds.slice(0, 3).join(", ");
						lines.push(
							`#${request}: ambiguous — held by more than one transcript, e.g. ${shown}. Re-request as "sessionId#entryId".`,
						);
						continue;
					}
					lines.push(`#${shortId(resolved.entry.id)} ${resolved.sessionId} — ${resolved.entry.timestamp}`);
					lines.push(renderEntryBody(resolved.entry));
					if (params.include_images === true) images.push(...entryBlocks(resolved.entry).images);
					lines.push("");
				}
				const content: ResultBlock[] = [{ type: "text", text: lines.join("\n").trimEnd() }];
				for (const image of images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
				return { content };
			}

			const rawQuery = params.query?.trim() ?? "";
			if (!rawQuery) {
				return { content: [{ type: "text", text: "session_search needs a query — pass terms to search, or expand:[\"sessionId#entryId\"]." }] };
			}
			let regex: RegExp | undefined;
			const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(rawQuery);
			if (params.regex === true || slashMatch) {
				const source = slashMatch ? slashMatch[1] : rawQuery;
				const flags = slashMatch?.[2]?.replace(/[gy]/g, "") ?? "";
				try {
					regex = new RegExp(source, flags);
				} catch (error) {
					return { content: [{ type: "text", text: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` }] };
				}
			}
			const queryTerms = regex ? [] : [...new Set(tokenize(rawQuery))];
			if (!regex && queryTerms.length === 0) {
				return { content: [{ type: "text", text: "Query produced no searchable tokens." }] };
			}

			const days = params.days === undefined ? 30 : Math.max(0, Math.floor(params.days));
			const startedAt = performance.now();
			const stats: ScanStats = {
				files: 0,
				bytes: 0,
				matchedLines: 0,
				offBranch: 0,
				unfiltered: 0,
				skipped: [],
				timedOut: false,
				parseCapped: false,
				candidates: 0,
				elapsedMs: 0,
			};
			const since = days === 0 ? 0 : Date.now() - days * DAY_MS;
			const needles = regex ? regexNeedles(regex.source) : buildNeedles(rawQuery);
			if (needles.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`Nothing to prefilter on for "${rawQuery}". Cross-session search reads bytes before it parses, so a query needs either a ` +
								`multi-character term or a pattern with a literal run of 3+ characters (e.g. /wiki.*compile/).`,
						},
					],
				};
			}
			const files = await listSessionFiles(dirs, since, stats);
			stats.candidates = files.length;
			const docs: SessionDoc[] = [];
			for (const file of files) {
				if (signal?.aborted) break;
				if (performance.now() - startedAt > SCAN_BUDGET_MS) {
					stats.timedOut = true;
					break;
				}
				docs.push(...(await scanSessionFile(file, needles, stats)));
			}
			stats.elapsedMs = performance.now() - startedAt;
			if (docs.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`No matches for "${rawQuery}" in ${stats.files} transcripts (${(stats.bytes / 1024 / 1024).toFixed(0)}MB, scope=${scope}, ` +
				`${days === 0 ? "all time" : `last ${days}d`}, ${stats.elapsedMs.toFixed(0)}ms). ` +
				`Widen with scope:"all" or days:0, or broaden the terms.`,
						},
					],
				};
			}
			const hits = rankBm25(docs, queryTerms, regex);
			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`${docs.length} transcript entries contained the prefilter terms but none ranked for "${rawQuery}" ` +
				`(likely rewound or branch-only content). Widen with scope:"all" or days:0.`,
						},
					],
				};
			}
			return { content: [{ type: "text", text: renderSessionHits(hits, stats, scope, days) }] };
		},
	});
}
