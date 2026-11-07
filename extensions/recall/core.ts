import { replaceTabs } from "@oh-my-pi/pi-tui";

export const EXPAND_CAP_CHARS = 24000;
export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export interface MessageLike {
	role: string;
	content: string | ContentBlock[];
	synthetic?: boolean;
	toolName?: string;
	isError?: boolean;
}

export interface BranchEntryLike {
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
export type Tier = keyof typeof TIERS;

export interface Token {
	term: string;
	tier: Tier;
}

export interface Doc {
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

export interface Corpus {
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
	return {
		entryId: entry.id,
		seq,
		kind,
		label,
		preview,
		tokens,
		length: tokens.length,
		turn,
		error: false,
	};
}

export function describeEntry(entry: BranchEntryLike, seq: number, turn: number): Doc[] {
	if (entry.type !== "message" || !entry.message) return describeNonMessage(entry, seq, turn);
	const msg = entry.message;
	const stringContent = typeof msg.content === "string" ? msg.content : undefined;
	const blocks =
		stringContent !== undefined
			? {
					text: stringContent,
					thinking: "",
					toolCalls: [] as ToolCallBlock[],
					images: [] as ImageBlock[],
				}
			: extractBlocks(msg.content);
	const docs: Doc[] = [];
	if (msg.role === "user" || msg.role === "developer") {
		const text = blocks.text || blocks.images.map(img => `[image ${img.mimeType}]`).join(" ");
		docs.push(makeDoc(entry, seq, turn, "user", "[user]", text, toTokens(text, "user")));
	} else if (msg.role === "assistant") {
		if (blocks.text.trim()) {
			docs.push(
				makeDoc(entry, seq, turn, "assistant", "[assistant]", blocks.text, toTokens(blocks.text, "assistant")),
			);
		}
		if (blocks.thinking.trim()) {
			docs.push(
				makeDoc(entry, seq, turn, "thinking", "[thinking]", blocks.thinking, toTokens(blocks.thinking, "thinking")),
			);
		}
		for (const call of blocks.toolCalls) {
			const preview = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
			docs.push(
				makeDoc(entry, seq, turn, "tool_call", `[call:${call.name}]`, preview, toTokens(preview, "tool_call")),
			);
		}
	} else if (msg.role === "toolResult") {
		const label = `[result:${msg.toolName}]${msg.isError ? " !" : ""}`;
		const doc = makeDoc(
			entry,
			seq,
			turn,
			"tool_result",
			label,
			`${msg.toolName ?? ""} ${blocks.text}`,
			toTokens(`${msg.toolName ?? ""} ${blocks.text}`, "tool_result"),
		);
		doc.error = msg.isError === true;
		docs.push(doc);
	}
	return docs;
}

function describeNonMessage(entry: BranchEntryLike, seq: number, turn: number): Doc[] {
	if (entry.type === "compaction" && entry.summary) {
		return [
			makeDoc(entry, seq, turn, "compaction", "[compaction]", entry.summary, toTokens(entry.summary, "compaction")),
		];
	}
	if (entry.type === "custom_message") {
		const text = typeof entry.content === "string" ? entry.content : extractBlocks(entry.content).text;
		return [
			makeDoc(entry, seq, turn, "custom", `[custom:${entry.customType ?? "?"}]`, text, toTokens(text, "custom")),
		];
	}
	if (entry.type === "session_init" && entry.task) {
		return [makeDoc(entry, seq, turn, "task", "[task]", entry.task, toTokens(entry.task, "task"))];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [
			makeDoc(
				entry,
				seq,
				turn,
				"branch_summary",
				"[summary]",
				entry.summary,
				toTokens(entry.summary, "branch_summary"),
			),
		];
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

export interface Hit<TDoc extends Doc = Doc> {
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
		while (/\s/.test(line[i] ?? "") && i < line.length) i++;
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
		if (newline < 0) {
			if (end > cursor) lastLineReadable = readable;
			break;
		}
		lastLineReadable = readable;
		cursor = newline + 1;
	}
	if (leaf === undefined || !lastLineReadable) return undefined;
	const chain = new Set<string>();
	for (let id: string | undefined = leaf; id !== undefined; id = parents.get(id)) {
		if (chain.has(id) || !parents.has(id)) return undefined;
		chain.add(id);
	}
	return chain;
}

export function entryBlocks(entry: BranchEntryLike): Blocks {
	return entry.type === "message" ? extractBlocks(entry.message?.content) : extractBlocks(entry.content);
}

/** Full original content of one entry, tab-sanitized and length-capped. */
function rawEntryBody(entry: BranchEntryLike): string {
	const blocks = entryBlocks(entry);
	const parts: string[] = [];
	if (blocks.text.trim()) parts.push(blocks.text.trimEnd());
	if (blocks.thinking.trim()) parts.push(`<thinking>\n${blocks.thinking.trimEnd()}\n</thinking>`);
	for (const call of blocks.toolCalls) parts.push(`${call.name} ${JSON.stringify(call.arguments ?? {}, null, 1)}`);
	if (parts.length === 0 && entry.summary) parts.push(entry.summary);
	if (parts.length === 0 && entry.task) parts.push(entry.task);
	return parts.join("\n\n");
}

/** Uncapped display text; expansion offsets are UTF-16 positions in this text. */
export function entryBodyText(entry: BranchEntryLike): string {
	return replaceTabs(rawEntryBody(entry));
}

/** Preserve the existing bounded history_search expansion. */
export function renderEntryBody(entry: BranchEntryLike): string {
	let body = rawEntryBody(entry);
	if (body.length > EXPAND_CAP_CHARS)
		body = `${body.slice(0, EXPAND_CAP_CHARS)}\n…[truncated at ${EXPAND_CAP_CHARS} chars]`;
	return replaceTabs(body);
}
