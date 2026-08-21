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
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

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

interface Hit {
	doc: Doc;
	score: number;
}

export function rankBm25(docs: Doc[], queryTerms: string[], regex: RegExp | undefined): Hit[] {
	if (docs.length === 0) return [];

	if (regex) {
		const hits: Hit[] = [];
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

	const df = new Map<string, number>();
	for (const doc of docs) {
		const seen = new Set<string>();
		for (const token of doc.tokens) {
			if (seen.has(token.term)) continue;
			seen.add(token.term);
			df.set(token.term, (df.get(token.term) ?? 0) + 1);
		}
	}
	const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0);
	const avgdl = totalLength / docs.length || 1;

	const hits: Hit[] = [];
	for (const doc of docs) {
		const tf = new Map<string, { count: number }>();
		for (const token of doc.tokens) tf.set(token.term, { count: (tf.get(token.term)?.count ?? 0) + 1 });
		let score = 0;
		for (const term of queryTerms) {
			const stats = tf.get(term);
			if (!stats) continue;
			const n = df.get(term) ?? 0;
			const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
			const norm = (stats.count * (BM25_K1 + 1)) / (stats.count + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl)));
			score += TIERS[doc.kind] * idf * norm;
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

		const blocks =
			entry.type === "message"
				? extractBlocks(entry.message?.content)
				: extractBlocks(entry.content);
		const parts: string[] = [];
		if (blocks.text.trim()) parts.push(blocks.text.trimEnd());
		if (blocks.thinking.trim()) parts.push(`<thinking>\n${blocks.thinking.trimEnd()}\n</thinking>`);
		for (const call of blocks.toolCalls) parts.push(`${call.name} ${JSON.stringify(call.arguments ?? {}, null, 1)}`);
		if (parts.length === 0 && entry.summary) parts.push(entry.summary);
		if (parts.length === 0 && entry.task) parts.push(entry.task);
		let body = parts.join("\n\n");
		if (body.length > EXPAND_CAP_CHARS) body = `${body.slice(0, EXPAND_CAP_CHARS)}\n…[truncated at ${EXPAND_CAP_CHARS} chars]`;
		lines.push(replaceTabs(body));
		if (includeImages) images.push(...blocks.images);
		lines.push("");
	}
	return { text: lines.join("\n").trimEnd(), images };
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
}
