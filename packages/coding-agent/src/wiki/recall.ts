import { type } from "@oh-my-pi/omptype";
import { prompt, tryParseJson, untilAborted } from "@oh-my-pi/pi-utils";
import recallInput from "../prompts/wiki/recall-input.md" with { type: "text" };
import recallSelectSystem from "../prompts/wiki/recall-select-system.md" with { type: "text" };
import recallSystem from "../prompts/wiki/recall-system.md" with { type: "text" };
import type { WikiComplete, WikiPage, WikiRecallItem, WikiRecallResult } from "./types";

const MAX_INPUT_CHARS = 48_000;
const MAX_CATALOG_CHARS = 20_000;
const PAGE_ID = /^w-[a-z0-9][a-z0-9-]{0,119}$/;
const SOURCE_ID = /^e-[a-z0-9][a-z0-9-]{0,119}$/;
const selectionSchema = type({ pages: type({ id: "string", revision: "number" }).array() });
const passageSchema = type({
	passages: type({ id: "string", revision: "number", quote: "string" }).array(),
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

/** Two read-only librarian calls: semantic catalog selection, then exact current-page extraction. */
export async function recallWiki(
	query: string,
	pages: readonly WikiPage[],
	complete: WikiComplete,
	options: { signal?: AbortSignal; limit?: number; maxChars?: number } = {},
): Promise<WikiRecallResult> {
	const { signal } = options;
	signal?.throwIfAborted();
	const limit = options.limit ?? 6;
	const maxChars = options.maxChars ?? 6000;
	if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxChars) || maxChars < 0) {
		throw new WikiRecallError("budget", "Wiki recall limits must be nonnegative safe integers");
	}
	if (!query.trim() || limit === 0 || maxChars === 0) return { status: "not_found", items: [] };
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
		current.set(page.id, page);
	}
	if (current.size === 0) return { status: "not_found", items: [] };

	// Every eligible page participates, including zero lexical matches and Chinese paraphrases.
	const catalog = [...current.values()].map(page => ({
		id: page.id,
		revision: page.revision,
		title: page.title.slice(0, 160),
		summary: page.summary.slice(0, 240),
		kind: page.kind,
		status: page.status,
	}));
	if (JSON.stringify(catalog).length > MAX_CATALOG_CHARS) {
		throw new WikiRecallError("budget", "Wiki catalog exceeds the bounded recall context");
	}

	async function ask(system: string, data: object, maxTokens: number) {
		signal?.throwIfAborted();
		const input = prompt.render(recallInput, { data: JSON.stringify(data).replaceAll("<", "\\u003c") });
		if (input.length + system.length > MAX_INPUT_CHARS) {
			throw new WikiRecallError("budget", "Selected Wiki pages exceed the bounded recall context");
		}
		let response: string;
		try {
			response = await untilAborted(signal, () =>
				complete({ task: "recall", system, prompt: input, maxTokens, signal }),
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

	const selected = selectionSchema(
		await ask(prompt.render(recallSelectSystem), { query, catalog, limit: selectionLimit }, 1024),
	);
	if (selected instanceof type.errors || selected.pages.length > selectionLimit) {
		throw new WikiRecallError("response", "Wiki recall page selection has an invalid shape");
	}
	const inspected = new Map<string, WikiPage>();
	for (const ref of selected.pages) {
		const page = current.get(ref.id);
		if (!page || page.revision !== ref.revision || inspected.has(ref.id)) {
			throw new WikiRecallError("response", "Wiki recall selected an unknown, stale, or repeated page");
		}
		inspected.set(page.id, { ...page, sources: page.sources.map(source => ({ ...source })) });
	}
	if (inspected.size === 0) return { status: "not_found", items: [] };

	const evidence = passageSchema(
		await ask(
			prompt.render(recallSystem),
			{ query, pages: [...inspected.values()], limit: selectionLimit, maxChars },
			Math.min(12_000, Math.max(512, maxChars + 512)),
		),
	);
	if (evidence instanceof type.errors || evidence.passages.length > selectionLimit) {
		throw new WikiRecallError("response", "Wiki recall passage selection has an invalid shape");
	}
	const items: WikiRecallItem[] = [];
	const returned = new Set<string>();
	let contentChars = 0;
	// Validate the entire response before applying output limits; unsupported trailing claims also fail closed.
	for (const passage of evidence.passages) {
		const page = inspected.get(passage.id);
		if (!page || page.revision !== passage.revision || returned.has(passage.id)) {
			throw new WikiRecallError("response", "Wiki recall cited an uninspected, stale, or repeated page");
		}
		const offset = page.body.indexOf(passage.quote);
		if (!passage.quote.trim() || offset < 0) {
			throw new WikiRecallError("response", "Wiki recall cited a passage absent from the current page body");
		}
		returned.add(page.id);
		const content = page.body.slice(offset, offset + passage.quote.length);
		if (contentChars + content.length > maxChars) continue;
		contentChars += content.length;
		items.push({
			id: page.id,
			revision: page.revision,
			title: page.title,
			content,
			sources: page.sources.map(ref => ({ id: ref.id, revision: ref.revision })),
			conflicted: page.status === "conflicted",
			updatedAt: page.updatedAt,
		});
	}
	for (const page of inspected.values()) {
		const latest = pages.find(candidate => candidate.id === page.id);
		if (
			!latest ||
			latest.revision !== page.revision ||
			latest.body !== page.body ||
			latest.status !== page.status ||
			latest.sources.length !== page.sources.length ||
			latest.sources.some(
				(ref, index) => ref.id !== page.sources[index].id || ref.revision !== page.sources[index].revision,
			)
		) {
			throw new WikiRecallError("snapshot", "Wiki recall evidence changed during model inspection");
		}
	}
	if (evidence.passages.length > 0 && items.length === 0) {
		throw new WikiRecallError("budget", "No complete supporting passage fits Wiki recall maxChars");
	}
	signal?.throwIfAborted();
	return { status: items.length > 0 ? "found" : "not_found", items };
}
