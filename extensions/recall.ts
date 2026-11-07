/** On-demand active-branch and cross-session transcript search. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { buildCorpus, rankBm25, tokenize, entryBlocks, renderEntryBody } from "./recall/core";
import type { BranchEntryLike, Corpus, Hit, ImageBlock } from "./recall/core";
import { registerSessionSearch } from "./recall/session-search";
export * from "./recall/core";

interface RecallParams {
	query?: string;
	regex?: boolean;
	page?: number;
	expand?: string[];
	include_images?: boolean;
}
type ResultBlock = { type: "text"; text: string } | ImageBlock;

const PAGE_TURNS = 5;
const OUTPUT_BUDGET_CHARS = 8000;
const PREVIEW_WIDTH = 150;
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
				rows.push(
					`${hitDocs.length > 0 ? "> " : "  "}#${shortId(doc.entryId)} ${doc.label}${doc.error ? " [error]" : ""} ${oneLine(doc.preview)}`,
				);
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

function renderExpand(
	requested: string[],
	corpus: Corpus,
	entries: readonly BranchEntryLike[],
	includeImages: boolean,
): Expanded {
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
					description:
						"Search terms (OR-ranked), or /pattern/ for regex. CJK-aware. Empty = browse the last 25 entries.",
				}),
			),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression over tokens." })),
			page: Type.Optional(Type.Number({ description: "1-based page of turn groups (5 per page)." })),
			expand: Type.Optional(
				Type.Array(Type.String(), {
					description: "Entry ids (or unique prefixes) to render in full instead of searching.",
				}),
			),
			include_images: Type.Optional(
				Type.Boolean({
					description: "With expand: re-attach image content (screenshots) found on those entries.",
				}),
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
					return {
						content: [
							{
								type: "text",
								text: `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
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

	registerSessionSearch(pi);
}
