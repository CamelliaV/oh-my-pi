/** Bounded transcript search with stable references, evidence snippets and resumable scans. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getSessionsDir, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { activeChainIds, describeEntry, entryBlocks, rankBm25, entryBodyText, tokenize } from "./core";
import type { BranchEntryLike, Doc, Hit, ImageBlock } from "./core";

const SCAN_MS = 5000;
const PARSE_LIMIT = 6000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const PAGE_SESSIONS = 8;
const GROUP_ROWS = 6;
const OUTPUT_CHARS = 8000;
const PREVIEW_WIDTH = 150;
const EXPAND_CHARS = 24000;
const MAX_DOCS = 100000;
const CACHE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86400000;
const ECHO_LABEL = /^\[(?:call|result):(?:session_search|history_search)\]/;

type MatchMode = "any" | "all" | "phrase";
type Sources = "all" | "conversation";
export interface SessionSearchParams {
	query?: string;
	regex?: boolean;
	scope?: string;
	days?: number;
	match?: MatchMode;
	sources?: Sources;
	include_search_results?: boolean;
	expand?: string[];
	context?: number;
	include_images?: boolean;
	nextPageCursor?: string;
	continueScanCursor?: string;
	nextMatchCursor?: string;
	offset?: number;
	limit?: number;
	contentRevision?: string;
}
interface Query {
	raw: string;
	terms: string[];
	groups: string[];
	regex?: RegExp;
	mode: MatchMode;
	sources: Sources;
	includeSearchResults: boolean;
	scope: string;
	days: number;
}
interface SessionFile {
	file: string;
	ref: string;
	basename: string;
	title: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	captureBytes?: number;
	captureHash?: string;
	captureAt?: string;
}
interface SearchDoc extends Doc {
	session: SessionFile;
	timestamp: string;
	matchedTerms: string[];
}
interface Stats {
	filesRead: number;
	filesCompleted: number;
	bytesRead: number;
	matchedLinesProcessed: number;
	offBranch: number;
	unfiltered: number;
	echoesExcluded: number;
	skipped: string[];
	errors: string[];
	stopReason: string | null;
	changedFiles: string[];
}
interface Snapshot {
	id: string;
	root: string;
	project: string | undefined;
	query: Query;
	files: SessionFile[];
	fileIndex: number;
	offset: number;
	docs: SearchDoc[];
	stats: Stats;
	revision: number;
	busy: boolean;
	exhausted: boolean;
	retainedBytes: number;
	groups?: Hit<SearchDoc>[][];
}
export interface SearchDetails {
	query: string;
	match: MatchMode;
	sources: Sources;
	scope: string;
	days: number;
	snapshotId: string;
	candidateFiles: number;
	filesRead: number;
	filesCompleted: number;
	bytesRead: number;
	matchedLinesProcessed: number;
	scanComplete: boolean;
	parseComplete: boolean;
	complete: boolean;
	ranking: "provisional" | "final-for-snapshot";
	reason: string | null;
	skipped: string[];
	errors: string[];
	offBranch: number;
	unfiltered: number;
	echoesExcluded: number;
	matchingFragments: number;
	matchingSessions: number;
	elapsedMs: number;
	nextPageCursor: string | null;
	continueScanCursor: string | null;
	nextMatchCursor: string | null;
	evidenceState: "captured-snapshot";
	changedFiles: string[];
	results: {
		sessionRef: string;
		title: string;
		capturedAt: string | null;
		score: number;
		matches: number;
		nextMatchCursor: string | null;
		entries: {
			ref: string;
			role: string;
			timestamp: string;
			snippet: string;
			score: number;
			matchedTerms: string[];
			expandArgs: SessionSearchParams;
		}[];
	}[];
}
export interface SearchResult {
	content: ({ type: "text"; text: string } | ImageBlock)[];
	details?: SearchDetails | ExpandDetails | { error: string };
}
function resultError(error: string): SearchResult {
	return { content: [{ type: "text", text: error }], details: { error } };
}
function asEntry(value: unknown): BranchEntryLike | undefined {
	return isRecord(value) && typeof value.id === "string" && typeof value.type === "string"
		? (value as unknown as BranchEntryLike)
		: undefined;
}
function parseQuery(params: SessionSearchParams): Query | string {
	const raw = params.query?.trim() ?? "";
	if (!raw) return "session_search needs query, expand, nextPageCursor, or continueScanCursor.";
	const mode = params.match ?? "any";
	if (!["any", "all", "phrase"].includes(mode)) return "match must be any, all, or phrase.";
	const sources = params.sources ?? "all";
	if (!["all", "conversation"].includes(sources)) return "sources must be all or conversation.";
	if (params.scope !== undefined && !["all", "project"].includes(params.scope)) return "scope must be project or all.";
	if (params.days !== undefined && (!Number.isFinite(params.days) || params.days < 0))
		return "days must be a non-negative number.";
	let regex: RegExp | undefined;
	const slash = mode === "phrase" ? null : /^\/(.+)\/([gimsuy]*)$/.exec(raw);
	if (params.regex || slash) {
		if (mode !== "any") return "regex searches tokens and cannot be combined with all or phrase mode.";
		try {
			regex = new RegExp(slash?.[1] ?? raw, slash?.[2]?.replace(/[gy]/g, "") ?? "");
		} catch (error) {
			return `Invalid regex: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const terms = [...new Set(tokenize(raw))];
	if (!regex && !terms.length && mode !== "phrase")
		return "Query produced no searchable tokens; use match:phrase for literal text.";
	// In all mode a contiguous CJK run is one literal unit, not a bag of bigrams.
	const groups = [
		...raw.matchAll(
			/[A-Za-z0-9][A-Za-z0-9_+.#/-]*|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g,
		),
	].map(m => m[0].toLowerCase());
	return {
		raw,
		terms,
		groups,
		regex,
		mode,
		sources,
		includeSearchResults: params.include_search_results === true,
		scope: params.scope ?? "project",
		days: Math.floor(params.days ?? 30),
	};
}
function candidateLine(line: string, query: Query): boolean {
	// Escaped JSON may encode letters/CJK as \uXXXX. Parse those lines to avoid
	// false negatives. Regex has no guessed literal prefilter: optional branches,
	// classes and escapes make such guesses unsafe.
	if (
		query.regex ||
		line.includes("\\u") ||
		line.includes("\\/") ||
		(query.mode === "phrase" && /[\\"\n\r\t]/.test(query.raw))
	)
		return true;
	const lower = line.toLowerCase();
	return query.mode === "phrase"
		? lower.includes(query.raw.toLowerCase())
		: query.terms.some(term => lower.includes(term));
}
function matches(doc: Doc, query: Query): string[] {
	if (query.regex) return [...new Set(doc.tokens.filter(t => query.regex!.test(t.term)).map(t => t.term))];
	const terms = new Set(doc.tokens.map(t => t.term));
	if (query.mode === "phrase") return doc.preview.toLowerCase().includes(query.raw.toLowerCase()) ? [query.raw] : [];
	if (
		query.mode === "all" &&
		!query.groups.every(g =>
			/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(g)
				? doc.preview.toLowerCase().includes(g)
				: terms.has(g),
		)
	)
		return [];
	return query.terms.filter(t => terms.has(t));
}
function snippet(text: string, terms: string[], phrase = false): string {
	const flat = replaceTabs(sanitizeText(text).replace(/\s+/g, " ").trim());
	const ranges: [number, number][] = [];
	if (!phrase) {
		const wanted = new Set(terms);
		for (const match of flat.matchAll(/[A-Za-z0-9][A-Za-z0-9_+.#/-]*/g)) {
			if (wanted.has(match[0].toLowerCase())) ranges.push([match.index, match.index + match[0].length]);
		}
	}
	for (const term of terms) {
		if (!phrase && /^[A-Za-z0-9]/.test(term)) continue;
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const match of flat.matchAll(new RegExp(escaped, "gi"))) {
			if (match[0]) ranges.push([match.index, match.index + match[0].length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: [number, number][] = [];
	for (const range of ranges) {
		const previous = merged[merged.length - 1];
		if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
		else merged.push([...range]);
	}
	let start = Math.max(0, (merged[0]?.[0] ?? 0) - 32);
	if (start && /[\uDC00-\uDFFF]/.test(flat[start])) start--;
	const end = Math.min(flat.length, start + 250);
	let output = start ? "…" : "",
		pos = start;
	for (const [from, to] of merged) {
		if (from < start || from >= end) continue;
		output += flat.slice(pos, from) + "【" + flat.slice(from, Math.min(to, end)) + "】";
		pos = Math.min(to, end);
	}
	output += flat.slice(pos, end) + (end < flat.length ? "…" : "");
	return truncateToWidth(output, PREVIEW_WIDTH);
}
async function searchDirs(root: string, project: string | undefined, scope: string): Promise<string[]> {
	if (scope !== "all") return project ? [path.join(root, project)] : [];
	return (await fs.readdir(root, { withFileTypes: true }))
		.filter(e => e.isDirectory())
		.map(e => path.join(root, e.name));
}
async function listFiles(
	root: string,
	dirs: string[],
	since: number,
	currentFile?: string,
): Promise<{ files: SessionFile[]; skipped: string[]; errors: string[] }> {
	const files: SessionFile[] = [],
		skipped: string[] = [],
		errors: string[] = [];
	for (const dir of dirs) {
		try {
			for await (const rel of new Bun.Glob("**/*.jsonl").scan({
				cwd: dir,
				onlyFiles: true,
				followSymlinks: false,
			})) {
				const file = path.join(dir, rel);
				if (file === currentFile) continue; // This tool searches OTHER sessions; its own writes must not invalidate cursors.
				try {
					const st = await fs.stat(file);
					if (st.mtimeMs < since) continue;
					const ref = path.relative(root, file).slice(0, -6).split(path.sep).map(encodeURIComponent).join("/");
					if (st.size > MAX_FILE_BYTES) {
						skipped.push(`${ref}: exceeds 64 MiB`);
						continue;
					}
					files.push({
						file,
						ref,
						basename: path.basename(file, ".jsonl"),
						title: "",
						size: st.size,
						mtimeMs: st.mtimeMs,
						ctimeMs: st.ctimeMs,
						ino: st.ino,
					});
				} catch {
					errors.push(`${path.relative(root, file)}: stat failed`);
				}
			}
		} catch {
			errors.push(`${path.relative(root, dir)}: directory unreadable`);
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.ref.localeCompare(b.ref));
	return { files, skipped, errors };
}
function digest(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Capture one file prefix. Appends are outside an already captured version. */
async function readCaptured(file: SessionFile): Promise<{ text: string; restarted: boolean; bytes: number }> {
	const before = await fs.stat(file.file);
	if (before.size > MAX_FILE_BYTES && file.captureBytes === undefined) throw new Error("file grew beyond 64 MiB");
	const size = file.captureBytes ?? before.size;
	const bytes = new Uint8Array(await Bun.file(file.file).slice(0, size).arrayBuffer());
	const after = await fs.stat(file.file);
	const hash = digest(bytes);
	if (
		file.captureHash !== undefined &&
		(bytes.length !== size || hash !== file.captureHash || before.ino !== file.ino)
	) {
		// Only this partially scanned file changed: discard its previous fragments
		// and capture the new generation. Completed files remain historical snapshots.
		file.captureBytes = undefined;
		file.captureHash = undefined;
		const fresh = await readCaptured(file);
		return { ...fresh, restarted: true };
	}
	if (file.captureHash === undefined) {
		if (bytes.length !== size || before.ino !== after.ino || after.size < size)
			throw new Error("file changed while capturing");
		if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
			const verify = new Uint8Array(await Bun.file(file.file).slice(0, size).arrayBuffer());
			const stable = await fs.stat(file.file);
			if (stable.ino !== before.ino || verify.length !== size || digest(verify) !== hash)
				throw new Error("file changed while capturing");
		}
		file.captureBytes = size;
		file.captureHash = hash;
		file.captureAt = new Date().toISOString();
		file.ino = before.ino;
	}
	return { text: new TextDecoder().decode(bytes), restarted: false, bytes: bytes.length };
}
function titleFrom(text: string, fallback: string): string {
	const first = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
	try {
		const row = JSON.parse(first);
		if (typeof row.title === "string" && row.title.trim()) return row.title;
	} catch {
		/* optional metadata */
	}
	return fallback;
}
async function scan(state: Snapshot, signal?: AbortSignal): Promise<void> {
	const started = performance.now();
	state.groups = undefined;
	let parsed = 0;
	state.stats.stopReason = null;
	while (state.fileIndex < state.files.length) {
		if (signal?.aborted) {
			state.stats.stopReason = "cancelled";
			return;
		}
		if (performance.now() - started >= SCAN_MS) {
			state.stats.stopReason = "time-budget";
			return;
		}
		const file = state.files[state.fileIndex];
		let text: string;
		try {
			const captured = await readCaptured(file);
			text = captured.text;
			state.stats.bytesRead += captured.bytes;
			if (captured.restarted) {
				state.docs = state.docs.filter(doc => doc.session !== file);
				state.retainedBytes = state.docs.reduce(
					(n, doc) => n + doc.preview.length * 2 + doc.tokens.length * 64 + 512,
					0,
				);
				state.offset = 0;
				if (!state.stats.changedFiles.includes(file.ref)) state.stats.changedFiles.push(file.ref);
			}
		} catch (error) {
			state.stats.errors.push(`${file.ref}: ${error instanceof Error ? error.message : "capture failed"}`);
			state.fileIndex++;
			state.offset = 0;
			continue;
		}
		if (state.offset === 0) state.stats.filesRead++;
		file.title = titleFrom(text, file.basename);
		const chain = activeChainIds(text);
		if (!chain && state.offset === 0) state.stats.unfiltered++;
		let pos = state.offset;
		while (pos < text.length) {
			if (signal?.aborted || performance.now() - started >= SCAN_MS || parsed >= PARSE_LIMIT) {
				state.offset = pos;
				state.stats.stopReason = signal?.aborted
					? "cancelled"
					: parsed >= PARSE_LIMIT
						? "parse-budget"
						: "time-budget";
				return;
			}
			const end = text.indexOf("\n", pos),
				next = end < 0 ? text.length : end + 1;
			const line = text.slice(pos, end < 0 ? text.length : end);
			const seq = pos;
			pos = next;
			if (!candidateLine(line, state.query)) continue;
			let entry: BranchEntryLike | undefined;
			try {
				entry = asEntry(JSON.parse(line));
			} catch {
				if (line.trim()) state.stats.errors.push(`${file.ref}: malformed JSON at offset ${seq}`);
				continue;
			}
			if (!entry) continue;
			if (chain && !chain.has(entry.id)) {
				state.stats.offBranch++;
				continue;
			}
			parsed++;
			state.stats.matchedLinesProcessed++;
			for (const doc of describeEntry(entry, seq, 0)) {
				if (!state.query.includeSearchResults && ECHO_LABEL.test(doc.label)) {
					state.stats.echoesExcluded++;
					continue;
				}
				if (state.query.sources === "conversation" && !["user", "assistant"].includes(doc.kind)) continue;
				const matchedTerms = matches(doc, state.query);
				if (!matchedTerms.length) continue;
				const preview = snippet(doc.preview, matchedTerms, state.query.mode === "phrase");
				// Keep only query term frequencies; doc.length still measures the original
				// content for BM25. Full text is read on demand through the stable ref.
				const selected = new Set(state.query.regex ? matchedTerms : state.query.terms);
				const tokens = doc.tokens.filter(t => selected.has(t.term));
				const compact: SearchDoc = {
					...doc,
					preview,
					tokens,
					session: file,
					timestamp: entry.timestamp,
					matchedTerms,
				};
				const retained = preview.length * 2 + tokens.length * 64 + 512;
				if (state.docs.length >= MAX_DOCS || state.retainedBytes + retained > CACHE_BYTES / 2) {
					state.exhausted = true;
					state.stats.stopReason = "memory-budget; narrow query";
					return;
				}
				state.docs.push(compact);
				state.retainedBytes += retained;
			}
		}
		state.offset = 0;
		state.fileIndex++;
		state.stats.filesCompleted++;
	}
}
function rankedGroups(state: Snapshot): Hit<SearchDoc>[][] {
	if (state.groups) return state.groups;
	let hits = rankBm25(state.docs, state.query.terms, state.query.regex);
	if (state.query.mode === "phrase") {
		// Punctuation-only phrases have no BM25 tokens, but remain literal matches.
		const scores = new Map(hits.map(h => [h.doc, h.score]));
		hits = state.docs.map(doc => ({ doc, score: scores.get(doc) ?? 1 }));
	}
	hits.sort(
		(a, b) =>
			b.score - a.score ||
			b.doc.session.mtimeMs - a.doc.session.mtimeMs ||
			a.doc.session.ref.localeCompare(b.doc.session.ref) ||
			a.doc.seq - b.doc.seq,
	);
	const groups = new Map<string, Hit<SearchDoc>[]>();
	for (const hit of hits) {
		const existing = groups.get(hit.doc.session.ref);
		if (existing) existing.push(hit);
		else groups.set(hit.doc.session.ref, [hit]);
	}
	state.groups = [...groups.values()];
	return state.groups;
}
function cursor(state: Snapshot, kind: "page" | "scan" | "matches", offset = 0, matchOffset?: number): string {
	return `${state.id}:${state.revision}:${kind}:${offset}${matchOffset === undefined ? "" : `:${matchOffset}`}`;
}
function render(
	state: Snapshot,
	pageOffset: number,
	elapsedMs: number,
	cached: boolean,
	matchOffset?: number,
): SearchResult {
	const groups = rankedGroups(state);
	const done = state.fileIndex >= state.files.length;
	const complete = done && !state.stats.skipped.length && !state.stats.errors.length && state.stats.unfiltered === 0;
	const details: SearchDetails = {
		query: state.query.raw,
		match: state.query.mode,
		sources: state.query.sources,
		scope: state.query.scope,
		days: state.query.days,
		snapshotId: state.id,
		candidateFiles: state.files.length,
		...state.stats,
		scanComplete: done,
		parseComplete: done && !state.stats.errors.length && !state.stats.skipped.length,
		complete,
		ranking: done ? "final-for-snapshot" : "provisional",
		reason: state.stats.stopReason,
		matchingFragments: groups.reduce((n, g) => n + g.length, 0),
		matchingSessions: groups.length,
		elapsedMs,
		nextPageCursor: null,
		nextMatchCursor: null,
		evidenceState: "captured-snapshot",
		continueScanCursor: !done && !state.exhausted && cached ? cursor(state, "scan") : null,
		results: [],
	};
	const lines = [
		`session_search — ${details.matchingFragments} matching fragments across ${groups.length} sessions (scope=${state.query.scope}, ${state.query.days ? `last ${state.query.days}d` : "all time"}, match=${state.query.mode}, sources=${state.query.sources})`,
		`status: ${complete ? "complete" : "partial"}; ranking=${details.ranking}; processed ${state.stats.matchedLinesProcessed} candidate entries; completed ${state.stats.filesCompleted}/${state.files.length} transcripts`,
		"Evidence is a snapshot captured per file; later appends are excluded. Expand rechecks the current active branch.",
	];
	let budget = OUTPUT_CHARS - lines.join("\n").length,
		groupIndex = pageOffset;
	for (
		;
		groupIndex < groups.length && groupIndex < pageOffset + (matchOffset === undefined ? PAGE_SESSIONS : 1);
		groupIndex++
	) {
		const group = groups[groupIndex],
			best = group[0],
			session = best.doc.session;
		const header = `--- ${truncateToWidth(replaceTabs(sanitizeText(session.title)).replace(/\s+/g, " "), 100)} · ${session.ref} · ${group.length} fragments ---`;
		const rowStart = matchOffset ?? 0;
		const rows = group.slice(rowStart, rowStart + GROUP_ROWS).map(hit => ({
			ref: `${session.ref}#${hit.doc.entryId}`,
			role: hit.doc.label,
			timestamp: hit.doc.timestamp,
			snippet: hit.doc.preview,
			score: hit.score,
			matchedTerms: hit.doc.matchedTerms,
			expandArgs: {
				expand: [`${session.ref}#${hit.doc.entryId}`],
				scope: state.query.scope,
				query: state.query.raw,
				match: state.query.mode,
				...(state.query.regex ? { regex: true } : {}),
			},
		}));
		// Reserve one evidence line and its reference before advancing the group
		// cursor. Pages never skip a group merely because the output budget ran out.
		const extra = JSON.stringify(rows[0].expandArgs).length + state.id.length + 190;
		if (budget < header.length + extra + 500 && details.results.length) break;
		lines.push(header);
		budget -= header.length;
		const shown: typeof rows = [];
		for (const row of rows) {
			const display = `> #${row.ref.slice(row.ref.lastIndexOf("#") + 1)} ${row.role} ${row.timestamp ?? ""} ${row.snippet}`;
			if (budget < display.length + extra && shown.length) break;
			shown.push(row);
			lines.push(display);
			budget -= display.length;
		}
		lines.push(`expand: ${JSON.stringify(rows[0].expandArgs)}`);
		budget -= extra;
		const matchCursor =
			rowStart + shown.length < group.length && cached
				? cursor(state, "matches", groupIndex, rowStart + shown.length)
				: null;
		if (matchCursor)
			lines.push(
				`nextMatchCursor:"${matchCursor}" (${group.length - rowStart - shown.length} more fragments in this session)`,
			);
		if (matchOffset !== undefined) details.nextMatchCursor = matchCursor;
		details.results.push({
			sessionRef: session.ref,
			title: session.title,
			capturedAt: session.captureAt ?? null,
			score: best.score,
			matches: group.length,
			nextMatchCursor: matchCursor,
			entries: shown,
		});
	}
	if (matchOffset === undefined && groupIndex < groups.length && cached)
		details.nextPageCursor = cursor(state, "page", groupIndex);
	if (state.stats.changedFiles.length)
		lines.push(`Rescanned changed partial files: ${state.stats.changedFiles.join(", ")}`);
	if (details.reason) lines.push(`limit: ${details.reason}`);
	if (!cached) lines.push("Continuation cache unavailable; repeat a narrower search.");
	if (state.stats.offBranch) lines.push(`${state.stats.offBranch} rewound/branched entries dropped`);
	if (state.stats.echoesExcluded)
		lines.push(
			`${state.stats.echoesExcluded} direct search call/result fragments excluded (include_search_results:true to include)`,
		);
	if (state.stats.unfiltered) lines.push(`${state.stats.unfiltered} transcripts unfiltered: active branch unreadable`);
	for (const kind of ["skipped", "errors"] as const)
		if (state.stats[kind].length)
			lines.push(`${kind}: ${state.stats[kind].slice(0, 3).join("; ")} (${state.stats[kind].length} total)`);
	if (details.nextPageCursor) lines.push(`nextPageCursor:"${details.nextPageCursor}"`);
	if (details.continueScanCursor)
		lines.push(
			`continueScanCursor:"${details.continueScanCursor}" (continues scanning and reranks; previous page cursors expire)`,
		);
	if (!groups.length)
		lines.push(
			complete
				? "No matches in this snapshot. Try scope:all, days:0, or broader terms."
				: "No matches found so far; search is incomplete.",
		);
	return { content: [{ type: "text", text: lines.join("\n") }], details };
}

export interface ExpandDetails {
	kind: "expand";
	entries: {
		ref: string;
		timestamp: string;
		currentBranchVerified: boolean;
		totalChars: number;
		start: number;
		end: number;
		text: string;
		contentRevision: string;
		hasBefore: boolean;
		hasAfter: boolean;
		nextArgs: SessionSearchParams | null;
		previousArgs: SessionSearchParams | null;
	}[];
}

function utf16Boundary(text: string, offset: number): number {
	const n = Math.min(text.length, Math.max(0, offset));
	return n > 0 && /[\uDC00-\uDFFF]/.test(text[n] ?? "") ? n - 1 : n;
}

function matchStart(text: string, params: SessionSearchParams): number {
	if (!params.query) return 0;
	const query = parseQuery({ ...params, scope: params.scope ?? "project" });
	if (typeof query === "string") return 0;
	if (query.mode === "phrase") return Math.max(0, text.toLowerCase().indexOf(query.raw.toLowerCase()) - 160);
	const candidates = describeEntry(
		{ type: "message", id: "expand", timestamp: "", message: { role: "user", content: text } },
		0,
		0,
	);
	const terms = candidates.flatMap(doc => matches(doc, query));
	const wanted = new Set(terms);
	let start = Infinity;
	for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_+.#/-]*/g))
		if (wanted.has(match[0].toLowerCase())) start = Math.min(start, match.index);
	for (const term of terms)
		if (!/^[A-Za-z0-9]/.test(term)) {
			const at = text.indexOf(term);
			if (at >= 0) start = Math.min(start, at);
		}
	return Number.isFinite(start) ? Math.max(0, start - 160) : 0;
}

async function expandEntries(root: string, dirs: string[], params: SessionSearchParams): Promise<SearchResult> {
	const requests = params.expand ?? [];
	if (requests.length > 12) return resultError("Expand accepts at most 12 references at once.");
	if (params.context !== undefined && (!Number.isInteger(params.context) || params.context < 0 || params.context > 5))
		return resultError("context must be an integer from 0 to 5.");
	if (params.scope !== undefined && !["project", "all"].includes(params.scope))
		return resultError("scope must be project or all.");
	if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0))
		return resultError("offset must be a non-negative UTF-16 position.");
	if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 2 || params.limit > 12000))
		return resultError("limit must be 2–12000 UTF-16 characters.");
	if (requests.length !== 1 && (params.offset !== undefined || params.contentRevision))
		return resultError("Read a content page from one entry at a time.");
	const context = Math.max(0, Math.min(5, Math.floor(params.context ?? 0)));
	const lines: string[] = [],
		images: ImageBlock[] = [];
	const details: ExpandDetails = { kind: "expand", entries: [] };
	let budget = EXPAND_CHARS - 1000;
	for (const request of requests) {
		const separator = request.lastIndexOf("#"),
			sessionRef = separator < 0 ? "" : request.slice(0, separator),
			prefix = separator < 0 ? request : request.slice(separator + 1);
		if (!prefix || (!sessionRef && prefix.length < 6)) {
			lines.push(`${request}: use sessionRef#entryId (bare IDs need 6 characters).`);
			continue;
		}
		const candidates: string[] = [];
		if (sessionRef.includes("/")) {
			let decoded: string;
			try {
				decoded = sessionRef.split("/").map(decodeURIComponent).join(path.sep);
			} catch {
				lines.push(`${request}: invalid reference encoding`);
				continue;
			}
			const file = path.resolve(root, decoded + ".jsonl");
			if (!dirs.some(dir => file.startsWith(dir + path.sep)) || path.relative(root, file).startsWith("..")) {
				lines.push(`${request}: outside requested scope; cross-project evidence requires scope:all`);
				continue;
			}
			candidates.push(file);
		} else {
			for (const dir of dirs)
				try {
					for await (const rel of new Bun.Glob("**/*.jsonl").scan({
						cwd: dir,
						onlyFiles: true,
						followSymlinks: false,
					}))
						if (!sessionRef || path.basename(rel, ".jsonl") === sessionRef) candidates.push(path.join(dir, rel));
				} catch {
					/* unavailable directory */
				}
		}
		const found: { file: string; entry: BranchEntryLike; entries: BranchEntryLike[] }[] = [];
		for (const file of candidates) {
			try {
				const real = await fs.realpath(file);
				if (!dirs.some(dir => real.startsWith(dir + path.sep))) continue;
				const before = await fs.stat(file);
				if (before.size > MAX_FILE_BYTES) {
					lines.push(`${request}: transcript exceeds 64 MiB expand limit`);
					continue;
				}
				const text = await Bun.file(file).text(),
					after = await fs.stat(file);
				if (
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.ctimeMs !== after.ctimeMs ||
					before.ino !== after.ino
				) {
					lines.push(`${request}: transcript changed while expanding; retry`);
					continue;
				}
				const chain = activeChainIds(text);
				if (!chain) {
					lines.push(`${request}: cannot verify the current active branch; retry after transcript settles`);
					continue;
				}
				const entries = (Bun.JSONL.parse(text) as unknown[])
					.map(asEntry)
					.filter((e): e is BranchEntryLike => !!e && chain.has(e.id));
				for (const entry of entries.filter(e => e.id.startsWith(prefix))) found.push({ file, entry, entries });
			} catch {
				/* malformed/inaccessible candidate */
			}
			if (found.length > 1) break;
		}
		if (found.length !== 1) {
			lines.push(
				`${request}: ${found.length ? "ambiguous; use full sessionRef and entryId" : "no matching entry on the current active branch"}`,
			);
			continue;
		}
		const hit = found[0],
			at = hit.entries.indexOf(hit.entry);
		const ref =
			path.relative(root, hit.file).slice(0, -6).split(path.sep).map(encodeURIComponent).join("/") +
			"#" +
			hit.entry.id;
		const targetBody = entryBodyText(hit.entry),
			revision = digest(targetBody);
		if (params.contentRevision && revision !== params.contentRevision) {
			lines.push(`${ref}: content changed; restart expansion`);
			continue;
		}
		const selected = hit.entries.slice(Math.max(0, at - context), at + context + 1);
		const allowance = Math.max(0, Math.floor((budget - 1500) / selected.length));
		for (const entry of selected) {
			const target = entry === hit.entry,
				body = target ? targetBody : entryBodyText(entry);
			const start = utf16Boundary(body, target ? (params.offset ?? matchStart(body, params)) : 0);
			const count = Math.min(params.limit ?? (context ? 4000 : 12000), allowance);
			const end = utf16Boundary(body, Math.min(body.length, start + count));
			if (end <= start && body.length > start) {
				lines.push("…[expand output budget reached; expand entries separately]");
				break;
			}
			const piece = body.slice(start, end);
			const header = `${target ? ">" : " "} #${entry.id} — ${entry.timestamp} [${start}:${end}/${body.length} UTF-16 chars; current branch verified]`;
			lines.push(header, piece);
			budget -= header.length + piece.length + 2;
			if (target) {
				const common: SessionSearchParams = {
					expand: [ref],
					scope: params.scope ?? "project",
					limit: params.limit ?? 12000,
					contentRevision: revision,
				};
				const nextArgs = end < body.length ? { ...common, offset: end } : null;
				const previousArgs =
					start > 0
						? {
								...common,
								offset: utf16Boundary(body, Math.max(0, start - (params.limit ?? 12000))),
								limit: Math.max(2, Math.min(start, params.limit ?? 12000)),
							}
						: null;
				details.entries.push({
					ref,
					timestamp: entry.timestamp,
					currentBranchVerified: true,
					totalChars: body.length,
					start,
					end,
					text: piece,
					contentRevision: revision,
					hasBefore: start > 0,
					hasAfter: end < body.length,
					nextArgs,
					previousArgs,
				});
				if (previousArgs) {
					const hint = `previousContent: ${JSON.stringify(previousArgs)}`;
					lines.push(hint);
					budget -= hint.length + 1;
				}
				if (nextArgs) {
					const hint = `nextContent: ${JSON.stringify(nextArgs)}`;
					lines.push(hint);
					budget -= hint.length + 1;
				}
				if (params.include_images) images.push(...entryBlocks(entry).images);
			} else if (end < body.length) lines.push("…[neighbor clipped]");
		}
		if (budget < 1500) break;
	}
	return { content: [{ type: "text", text: lines.join("\n") }, ...images], details };
}

export class SessionSearch {
	constructor(readonly sessionsDir: () => string = getSessionsDir) {}
	readonly #snapshots = new LRUCache<string, Snapshot>({
		max: 4,
		maxSize: CACHE_BYTES,
		ttl: 10 * 60 * 1000,
		sizeCalculation: s => s.retainedBytes + s.files.length * 1024 + 4096,
	});
	async execute(params: SessionSearchParams, currentFile?: string, signal?: AbortSignal): Promise<SearchResult> {
		const started = performance.now(),
			root = this.sessionsDir();
		const relative = currentFile ? path.relative(root, currentFile) : undefined;
		const project = relative && !relative.startsWith("..") ? relative.split(path.sep)[0] : undefined;
		if (params.expand?.length) {
			if (params.query) {
				const parsed = parseQuery(params);
				if (typeof parsed === "string") return resultError(parsed);
			}
			if (params.nextPageCursor || params.continueScanCursor || params.nextMatchCursor)
				return resultError("Expand cannot be combined with a cursor.");
			try {
				return await expandEntries(root, await searchDirs(root, project, params.scope ?? "project"), params);
			} catch {
				return resultError("Session directory is unreadable.");
			}
		}
		const token = params.nextPageCursor ?? params.continueScanCursor ?? params.nextMatchCursor;
		if (token) {
			if ([params.nextPageCursor, params.continueScanCursor, params.nextMatchCursor].filter(Boolean).length > 1)
				return resultError("Use one cursor operation per call.");
			const parts = /^([a-f0-9-]+):(\d+):(page|scan|matches):(\d+)(?::(\d+))?$/.exec(token);
			if (!parts) return resultError("Invalid cursor; start a new search.");
			const state = this.#snapshots.get(parts[1]);
			if (!state || state.root !== root || state.project !== project || state.revision !== Number(parts[2]))
				return resultError("Cursor expired or superseded; start a new search.");
			if (parts[3] !== (params.nextPageCursor ? "page" : params.nextMatchCursor ? "matches" : "scan"))
				return resultError("Cursor kind does not match the requested operation.");
			if (state.busy) return resultError("This search is already continuing; retry after it finishes.");
			if ((parts[3] === "matches") !== (parts[5] !== undefined)) return resultError("Invalid match cursor.");
			if (
				parts[3] !== "scan" &&
				(!rankedGroups(state)[Number(parts[4])] ||
					(parts[3] === "matches" && Number(parts[5]) >= rankedGroups(state)[Number(parts[4])].length))
			)
				return resultError("Cursor position is outside results.");
			const constraints: [unknown, unknown][] = [
				[params.query, state.query.raw],
				[params.scope, state.query.scope],
				[params.days, state.query.days],
				[params.match, state.query.mode],
				[params.sources, state.query.sources],
				[params.include_search_results, state.query.includeSearchResults],
				[params.regex, !!state.query.regex],
			];
			if (constraints.some(([given, expected]) => given !== undefined && given !== expected))
				return resultError("Cursor query/scope/options changed; start a new search.");
			state.busy = true;
			try {
				if (parts[3] === "scan") {
					if (state.exhausted || state.fileIndex >= state.files.length)
						return resultError("This snapshot cannot continue; start a narrower search.");
					await scan(state, signal);
					state.revision++;
					this.#snapshots.set(state.id, state);
				}
				return render(
					state,
					parts[3] === "scan" ? 0 : Number(parts[4]),
					performance.now() - started,
					this.#snapshots.has(state.id),
					parts[3] === "matches" ? Number(parts[5]) : undefined,
				);
			} finally {
				state.busy = false;
			}
		}
		const query = parseQuery(params);
		if (typeof query === "string") return resultError(query);
		let dirs: string[];
		try {
			dirs = await searchDirs(root, project, query.scope);
		} catch {
			return resultError("Session directory is unreadable.");
		}
		if (!dirs.length) return resultError("Current project directory unknown; use scope:all.");
		const manifest = await listFiles(root, dirs, query.days ? Date.now() - query.days * DAY_MS : 0, currentFile);
		const state: Snapshot = {
			id: crypto.randomUUID(),
			root,
			project,
			query,
			files: manifest.files,
			fileIndex: 0,
			offset: 0,
			docs: [],
			revision: 0,
			busy: false,
			exhausted: false,
			retainedBytes: 0,
			stats: {
				filesRead: 0,
				filesCompleted: 0,
				bytesRead: 0,
				matchedLinesProcessed: 0,
				offBranch: 0,
				unfiltered: 0,
				echoesExcluded: 0,
				skipped: manifest.skipped,
				errors: manifest.errors,
				stopReason: null,
				changedFiles: [],
			},
		};
		await scan(state, signal);
		this.#snapshots.set(state.id, state);
		return render(state, 0, performance.now() - started, this.#snapshots.has(state.id));
	}
}

export function registerSessionSearch(pi: ExtensionAPI): void {
	const { Type } = pi.typebox;
	const engine = new SessionSearch();
	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		loadMode: "essential",
		approval: "read",
		description:
			"Search other on-disk sessions, including assistant text, tools and thinking, with active-branch filtering. Default: current project, last 30 days, OR-ranked terms. Use match:all for every word/CJK run in one fragment, match:phrase for a case-insensitive literal phrase, sources:conversation for user/assistant text. Direct search calls/results are excluded unless include_search_results:true. Results show best evidence first with stable expand references. nextPageCursor pages already found sessions; continueScanCursor resumes incomplete scanning and reranks. Pages are captured historical snapshots: unrelated appends do not invalidate them. Expand rechecks the current active branch. Use nextMatchCursor to list more hits within a session. Expand arguments include query/scope to center on the match; offset/limit and contentRevision read more original text. Cursors last 10 minutes in this process.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Terms (default OR), literal phrase with match:phrase, or /pattern/flags over lowercase tokens.",
				}),
			),
			regex: Type.Optional(
				Type.Boolean({
					description: "Regex over lowercase tokens. May require more scanning; no unsafe literal prefilter.",
				}),
			),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("all")])),
			days: Type.Optional(
				Type.Number({
					minimum: 0,
					description: "Transcript modification window; default 30, 0 = all time.",
				}),
			),
			match: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all"), Type.Literal("phrase")])),
			sources: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("conversation")])),
			include_search_results: Type.Optional(Type.Boolean()),
			expand: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 12,
					description: "Copy expandArgs from a result (including query and scope) for a window around the hit.",
				}),
			),
			context: Type.Optional(
				Type.Number({
					minimum: 0,
					maximum: 5,
					description: "With expand: neighboring active-branch entries on each side.",
				}),
			),
			include_images: Type.Optional(Type.Boolean()),
			offset: Type.Optional(
				Type.Number({
					minimum: 0,
					description:
						"With expand: explicit UTF-16 position in rendered original content; 0 reads from the beginning.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ minimum: 2, maximum: 12000, description: "With expand: maximum content chars per entry." }),
			),
			contentRevision: Type.Optional(
				Type.String({
					description: "Copy from nextContent/previousContent; rejects content replacement between pages.",
				}),
			),
			nextMatchCursor: Type.Optional(
				Type.String({ description: "Read the next page of matching fragments within one session." }),
			),
			nextPageCursor: Type.Optional(Type.String({ description: "Read the next page of already found sessions." })),
			continueScanCursor: Type.Optional(
				Type.String({
					description: "Continue an incomplete scan, rerank all findings and invalidate old page cursors.",
				}),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			return engine.execute(params, ctx.sessionManager.getSessionFile(), signal);
		},
	});
}
