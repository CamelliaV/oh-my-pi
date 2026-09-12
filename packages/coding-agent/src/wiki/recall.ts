import { type } from "@oh-my-pi/omptype";
import { prompt, tryParseJson, untilAborted } from "@oh-my-pi/pi-utils";
import recallInput from "../prompts/wiki/recall-input.md" with { type: "text" };
import recallSelectSystem from "../prompts/wiki/recall-select-system.md" with { type: "text" };
import recallSystem from "../prompts/wiki/recall-system.md" with { type: "text" };
import { wikiBatches } from "./batches";
import { wikiSourcePassages } from "./evidence";
import type { WikiComplete, WikiPage, WikiRecallItem, WikiRecallResult, WikiSource } from "./types";

const MAX_INPUT_CHARS = 48_000;
const MAX_BATCH_CHARS = 20_000;
const PAGE_ID = /^w-[a-z0-9][a-z0-9-]{0,119}$/;
const SOURCE_ID = /^e-[a-z0-9][a-z0-9-]{0,119}$/;
const selectionSchema = type({ pages: type({ id: "string", revision: "number" }).array() });
const passageSchema = type({ passages: type({ id: "string", revision: "number", quote: "string" }).array() });
const sourcePassageSchema = type({
	passages: type({ id: "string", revision: "number", passage: "number", "+": "reject" }).array(),
	"+": "reject",
});

export class WikiRecallError extends Error {
	constructor(
		readonly code: "provider" | "response" | "budget" | "snapshot",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WikiRecallError";
	}
}

/** Semantic navigation is derived; production recall quotes the original, role-preserving sources. */
export async function recallWiki(
	query: string,
	pages: readonly WikiPage[],
	complete: WikiComplete,
	options: {
		signal?: AbortSignal;
		limit?: number;
		maxChars?: number;
		sources?: readonly WikiSource[];
		pending?: readonly WikiSource[];
	} = {},
): Promise<WikiRecallResult> {
	const { signal } = options;
	signal?.throwIfAborted();
	const limit = options.limit ?? 6;
	const maxChars = options.maxChars ?? 6000;
	if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxChars) || maxChars < 0) {
		throw new WikiRecallError("budget", "Wiki recall limits must be nonnegative safe integers");
	}
	const sourceMode = options.sources !== undefined || options.pending !== undefined;
	const pending = new Map<string, WikiSource>();
	const sources = new Map<string, WikiSource>();
	for (const source of options.sources ?? []) {
		if (source.status === "invalidated") continue;
		if (
			!SOURCE_ID.test(source.id) ||
			!Number.isSafeInteger(source.revision) ||
			source.revision < 1 ||
			sources.has(source.id)
		) {
			throw new WikiRecallError("snapshot", "Wiki recall received an invalid or repeated source");
		}
		sources.set(source.id, { ...source });
	}
	function sameSource(left: WikiSource | undefined, right: WikiSource): boolean {
		return (
			left !== undefined &&
			left.id === right.id &&
			left.revision === right.revision &&
			left.content === right.content &&
			left.status === right.status &&
			left.source === right.source &&
			left.cursor === right.cursor &&
			left.context === right.context &&
			left.createdAt === right.createdAt &&
			left.updatedAt === right.updatedAt
		);
	}
	for (const source of options.pending ?? []) {
		if (source.status === "invalidated") continue;
		const existing = sources.get(source.id);
		if (
			!SOURCE_ID.test(source.id) ||
			!Number.isSafeInteger(source.revision) ||
			source.revision < 1 ||
			pending.has(source.id) ||
			(existing && !sameSource(existing, source))
		) {
			throw new WikiRecallError("snapshot", "Wiki recall received an inconsistent pending source");
		}
		pending.set(source.id, { ...source });
		sources.set(source.id, { ...source });
	}
	function result(items: WikiRecallItem[]): WikiRecallResult {
		return { status: items.length ? "found" : "not_found", items, ...(sourceMode ? { pending: pending.size } : {}) };
	}
	if (!query.trim() || limit === 0 || maxChars === 0) return result([]);
	if (query.length > 8000) throw new WikiRecallError("budget", "Wiki recall query exceeds the bounded context");
	const selectionLimit = Math.min(limit, 20);
	const current = new Map<string, WikiPage>();
	for (const page of pages) {
		if (page.status === "invalidated" || page.sources.length === 0 || !page.body.trim()) continue;
		if (
			!PAGE_ID.test(page.id) ||
			!Number.isSafeInteger(page.revision) ||
			page.revision < 1 ||
			current.has(page.id) ||
			page.sources.some(ref => !SOURCE_ID.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1)
		) {
			throw new WikiRecallError("snapshot", "Wiki recall received an invalid or repeated evidence-backed page");
		}
		current.set(page.id, { ...page, sources: page.sources.map(ref => ({ ...ref })) });
	}
	if (sourceMode ? sources.size === 0 : current.size === 0) return result([]);

	function renderUntrustedInput(data: object): string {
		return prompt.render(recallInput, { data: JSON.stringify(data).replaceAll("<", "\\u003c") });
	}
	async function ask(system: string, data: object, maxTokens: number) {
		signal?.throwIfAborted();
		const rendered = renderUntrustedInput(data);
		if (rendered.length + system.length > MAX_INPUT_CHARS) {
			throw new WikiRecallError("budget", "Wiki recall request exceeds the bounded context");
		}
		let response: string;
		try {
			response = await untilAborted(signal, () =>
				complete({ task: "recall", system, prompt: rendered, maxTokens, signal }),
			);
		} catch (error) {
			signal?.throwIfAborted();
			throw new WikiRecallError("provider", "Wiki recall model request failed", { cause: error });
		}
		signal?.throwIfAborted();
		if (response.length > 131_072) throw new WikiRecallError("response", "Wiki recall response is oversized");
		const parsed = tryParseJson(response);
		if (parsed === null) throw new WikiRecallError("response", "Wiki recall model returned invalid JSON");
		return parsed;
	}
	const selectSystem = prompt.render(recallSelectSystem);
	const extractSystem = prompt.render(recallSystem);
	const base = { query, limit: selectionLimit, maxChars };
	const batchChars = Math.min(
		MAX_BATCH_CHARS,
		MAX_INPUT_CHARS - Math.max(selectSystem.length, extractSystem.length) - renderUntrustedInput(base).length - 256,
	);
	if (batchChars < 2048) throw new WikiRecallError("budget", "Wiki recall query leaves no evidence context");
	function batches<T>(records: readonly T[]): T[][] {
		try {
			return wikiBatches(records, batchChars);
		} catch (error) {
			if (error instanceof RangeError)
				throw new WikiRecallError("budget", "One Wiki recall record exceeds the request context", { cause: error });
			throw error;
		}
	}
	function* fragments(content: string): Generator<string> {
		// Overlap preserves context at chunk boundaries; every character remains inspectable.
		const size = Math.min(sourceMode ? maxChars : 4096, 4096, Math.floor((batchChars - 1536) / 6));
		const overlap = Math.min(256, Math.floor(size / 4));
		for (let offset = 0; offset < content.length; offset += size - overlap) {
			yield content.slice(offset, offset + size);
			if (offset + size >= content.length) break;
		}
	}
	const catalog = [...current.values()].map(page => ({
		id: page.id,
		revision: page.revision,
		title: page.title.slice(0, 160),
		summary: page.summary.slice(0, 240),
		kind: page.kind,
		status: page.status,
		updatedAt: page.updatedAt,
	}));
	const inspected = new Map<string, WikiPage>();
	for (const batch of batches(catalog)) {
		const selected = selectionSchema(await ask(selectSystem, { ...base, catalog: batch }, 2048));
		if (selected instanceof type.errors || selected.pages.length > selectionLimit) {
			throw new WikiRecallError("response", "Wiki recall page selection has an invalid shape");
		}
		const allowed = new Map(batch.map(page => [page.id, page.revision]));
		for (const ref of selected.pages) {
			const page = current.get(ref.id);
			if (!page || allowed.get(ref.id) !== ref.revision || inspected.has(ref.id)) {
				throw new WikiRecallError("response", "Wiki recall selected an unknown, stale, or repeated page");
			}
			inspected.set(page.id, page);
		}
	}

	const candidates: WikiRecallItem[] = [];
	const returned = new Set<string>();
	const outputTokens = Math.min(12_000, Math.max(512, maxChars + 512));
	if (sourceMode) {
		const guided = new Set(
			[...inspected.values()].flatMap(page => page.sources.map(ref => `${ref.id}@${ref.revision}`)),
		);
		const scanUncompiled = current.size === 0 && options.pending === undefined;
		const ordered = [...sources.values()]
			.filter(source => scanUncompiled || pending.has(source.id) || guided.has(`${source.id}@${source.revision}`))
			.sort(
				(a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)) || b.updatedAt.localeCompare(a.updatedAt),
			);
		const conflicts = new Set(
			[...current.values()]
				.filter(page => page.status === "conflicted")
				.flatMap(page => page.sources.map(ref => `${ref.id}@${ref.revision}`)),
		);
		const records = ordered.flatMap(source => {
			let passage = 0;
			return wikiSourcePassages(source).flatMap(original =>
				[...fragments(original.content)].map(content => ({
					id: source.id,
					revision: source.revision,
					passage: passage++,
					role: original.role,
					content,
					pending: pending.has(source.id),
					updatedAt: source.updatedAt,
				})),
			);
		});
		for (const batch of batches(records)) {
			const evidence = sourcePassageSchema(await ask(extractSystem, { ...base, sources: batch }, 2048));
			if (evidence instanceof type.errors || evidence.passages.length > selectionLimit) {
				throw new WikiRecallError("response", "Wiki recall source passage selection has an invalid shape");
			}
			const seen = new Set<string>();
			for (const passage of evidence.passages) {
				const key = `${passage.id}@${passage.revision}:${passage.passage}`;
				const original = batch.find(
					record =>
						record.id === passage.id &&
						record.revision === passage.revision &&
						record.passage === passage.passage,
				);
				const source = sources.get(passage.id);
				if (
					!source ||
					!original ||
					seen.has(key) ||
					!Number.isSafeInteger(passage.passage) ||
					passage.passage < 0 ||
					!original.content.trim()
				) {
					throw new WikiRecallError(
						"response",
						"Wiki recall cited an unknown, stale, repeated, or unsupported source passage",
					);
				}
				seen.add(key);
				const identity = JSON.stringify([source.id, source.revision, original.role, original.content]);
				if (returned.has(identity)) continue;
				returned.add(identity);
				candidates.push({
					id: source.id,
					revision: source.revision,
					title: source.context?.slice(0, 160) || source.source || source.id,
					content: original.content,
					kind: "source",
					role: original.role,
					pending: pending.has(source.id),
					sources: [{ id: source.id, revision: source.revision }],
					updatedAt: source.updatedAt,
					conflicted: conflicts.has(`${source.id}@${source.revision}`),
				});
			}
		}
	} else {
		const records = [...inspected.values()].flatMap(page =>
			[...fragments(page.body)].map(body => ({
				id: page.id,
				revision: page.revision,
				title: page.title.slice(0, 160),
				body,
				status: page.status,
			})),
		);
		for (const batch of batches(records)) {
			const evidence = passageSchema(await ask(extractSystem, { ...base, pages: batch }, outputTokens));
			if (evidence instanceof type.errors || evidence.passages.length > selectionLimit) {
				throw new WikiRecallError("response", "Wiki recall passage selection has an invalid shape");
			}
			const seen = new Set<string>();
			for (const passage of evidence.passages) {
				const page = inspected.get(passage.id);
				if (
					!page ||
					page.revision !== passage.revision ||
					seen.has(page.id) ||
					!passage.quote.trim() ||
					!batch.some(
						record =>
							record.id === passage.id &&
							record.revision === passage.revision &&
							record.body.includes(passage.quote),
					)
				) {
					throw new WikiRecallError(
						"response",
						"Wiki recall cited an uninspected, stale, repeated, or unsupported page passage",
					);
				}
				seen.add(page.id);
				if (returned.has(page.id)) continue;
				returned.add(page.id);
				candidates.push({
					id: page.id,
					revision: page.revision,
					title: page.title,
					content: passage.quote,
					kind: "page",
					sources: page.sources.map(ref => ({ ...ref })),
					conflicted: page.status === "conflicted",
					updatedAt: page.updatedAt,
				});
			}
		}
	}
	// No partially validated result escapes, even after enough passages fit the output budget.
	const latestPages = new Map(pages.map(page => [page.id, page]));
	for (const page of current.values()) {
		const latest = latestPages.get(page.id);
		if (
			!latest ||
			latest.revision !== page.revision ||
			latest.body !== page.body ||
			latest.status !== page.status ||
			latest.title !== page.title ||
			latest.summary !== page.summary ||
			latest.kind !== page.kind ||
			latest.updatedAt !== page.updatedAt ||
			latest.sources.length !== page.sources.length ||
			latest.sources.some(
				(ref, index) => ref.id !== page.sources[index].id || ref.revision !== page.sources[index].revision,
			)
		) {
			throw new WikiRecallError("snapshot", "Wiki recall evidence changed during model inspection");
		}
	}
	const latestSources = new Map(options.sources?.map(source => [source.id, source]));
	const latestPending = new Map(options.pending?.map(source => [source.id, source]));
	for (const source of sources.values()) {
		const latest = latestSources.get(source.id) ?? latestPending.get(source.id);
		if (
			!sameSource(latest, source) ||
			(pending.has(source.id) && !sameSource(latestPending.get(source.id), source))
		) {
			throw new WikiRecallError("snapshot", "Wiki recall source changed during model inspection");
		}
	}
	if (sourceMode)
		candidates.sort(
			(a, b) => Number(b.role === "user") - Number(a.role === "user") || b.updatedAt.localeCompare(a.updatedAt),
		);
	const items: WikiRecallItem[] = [];
	let contentChars = 0;
	for (const item of candidates) {
		if (items.length >= limit || contentChars + item.content.length > maxChars) continue;
		items.push(item);
		contentChars += item.content.length;
	}
	if (candidates.length && !items.length)
		throw new WikiRecallError("budget", "No complete supporting passage fits Wiki recall maxChars");
	signal?.throwIfAborted();
	return result(items);
}
