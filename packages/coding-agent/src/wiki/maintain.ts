import { type } from "@oh-my-pi/omptype";
import { prompt, tryParseJson, untilAborted } from "@oh-my-pi/pi-utils";
import maintainInput from "../prompts/wiki/maintain-input.md" with { type: "text" };
import maintainSelectSystem from "../prompts/wiki/maintain-select-system.md" with { type: "text" };
import maintainSystem from "../prompts/wiki/maintain-system.md" with { type: "text" };
import type { WikiComplete, WikiMaintenance, WikiPage, WikiPageDraft, WikiSnapshot, WikiSource } from "./types";

const MAX_INPUT_CHARS = 48_000;
const MAX_CATALOG_CHARS = 20_000;
const MAX_SOURCE_CHARS = 16_000;
const MAX_AFFECTED_PAGES = 8;
const PAGE_ID = /^w-[a-z0-9][a-z0-9-]{0,119}$/;
const SOURCE_ID = /^e-[a-z0-9][a-z0-9-]{0,119}$/;
const sourceRefSchema = type({ id: "string", revision: "number" });
const quotationSchema = type({ id: "string", revision: "number", quote: "string" });
const selectionSchema = type({ pages: sourceRefSchema.array() });
const maintenanceSchema = type({
	pages: type({
		id: "string",
		expectedRevision: "number | null",
		title: "string",
		summary: "string",
		body: "string",
		kind: "'knowledge' | 'preference' | 'pattern'",
		status: "'active' | 'conflicted'",
		sources: sourceRefSchema.array(),
		links: "string[]",
		evidence: quotationSchema.array(),
		"correction?": quotationSchema,
	}).array(),
	processed: sourceRefSchema.array(),
});

export class WikiMaintenanceError extends Error {
	constructor(
		readonly code: "provider" | "response" | "budget" | "snapshot",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WikiMaintenanceError";
	}
}

/** Proposes a bounded incremental patch; publishing and revision revalidation belong to the store. */
export async function maintainWiki(
	snapshot: WikiSnapshot,
	complete: WikiComplete,
	options: { signal?: AbortSignal; limit?: number; maxChars?: number } = {},
): Promise<WikiMaintenance> {
	const { signal } = options;
	signal?.throwIfAborted();
	const limit = options.limit ?? 8;
	const maxChars = options.maxChars ?? 16_000;
	if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxChars) || maxChars < 0) {
		throw new WikiMaintenanceError("budget", "Wiki maintenance limits must be nonnegative safe integers");
	}
	if (limit === 0 || maxChars === 0 || snapshot.pending.length === 0) return { pages: [], processed: [] };

	const batch = new Map<string, WikiSource>();
	let sourceChars = 2;
	let hasActiveSource = false;
	for (const source of snapshot.pending) {
		if (source.status !== "active") continue;
		hasActiveSource = true;
		if (!SOURCE_ID.test(source.id) || !Number.isSafeInteger(source.revision) || source.revision < 1) {
			throw new WikiMaintenanceError("snapshot", "Wiki snapshot contains an invalid source reference");
		}
		const size = JSON.stringify(source).length + 1;
		// Only complete sources enter the batch. Oversized records stay pending, including their unseen tails.
		if (sourceChars + size > MAX_SOURCE_CHARS) continue;
		if (batch.has(source.id)) throw new WikiMaintenanceError("snapshot", "Wiki snapshot repeats a source");
		batch.set(source.id, source);
		sourceChars += size;
		if (batch.size >= Math.min(limit, 32)) break;
	}
	if (batch.size === 0) {
		if (hasActiveSource)
			throw new WikiMaintenanceError("budget", "No complete Wiki source fits the maintenance batch");
		return { pages: [], processed: [] };
	}

	const current = new Map<string, WikiPage>();
	const reservedIds = new Set(snapshot.pages.map(page => page.id));
	for (const page of snapshot.pages) {
		if (page.status === "invalidated") continue;
		if (!PAGE_ID.test(page.id) || !Number.isSafeInteger(page.revision) || page.revision < 1 || current.has(page.id)) {
			throw new WikiMaintenanceError("snapshot", "Wiki snapshot contains an invalid or repeated page reference");
		}
		if (
			page.sources.length === 0 ||
			page.sources.some(ref => !SOURCE_ID.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1)
		) {
			throw new WikiMaintenanceError("snapshot", "Wiki snapshot contains a page without valid evidence lineage");
		}
		current.set(page.id, page);
	}
	const catalog = [...current.values()].map(page => ({
		id: page.id,
		revision: page.revision,
		title: page.title.slice(0, 160),
		summary: page.summary.slice(0, 240),
		kind: page.kind,
		status: page.status,
	}));
	if (JSON.stringify(catalog).length > MAX_CATALOG_CHARS) {
		throw new WikiMaintenanceError("budget", "Wiki catalog exceeds the bounded maintenance context");
	}
	const sources = [...batch.values()].map(source => ({
		id: source.id,
		revision: source.revision,
		content: source.content,
		context: source.context,
		source: source.source,
	}));

	async function ask(system: string, data: object, maxTokens: number) {
		signal?.throwIfAborted();
		const input = prompt.render(maintainInput, { data: JSON.stringify(data).replaceAll("<", "\\u003c") });
		if (input.length + system.length > MAX_INPUT_CHARS) {
			throw new WikiMaintenanceError("budget", "Wiki maintenance input exceeds its bounded context");
		}
		let response: string;
		try {
			response = await untilAborted(signal, () =>
				complete({ task: "maintain", system, prompt: input, maxTokens, signal }),
			);
		} catch (error) {
			signal?.throwIfAborted();
			throw new WikiMaintenanceError("provider", "Wiki maintenance model request failed", { cause: error });
		}
		signal?.throwIfAborted();
		if (response.length > 131_072)
			throw new WikiMaintenanceError("response", "Wiki maintenance response is oversized");
		const parsed = tryParseJson(response);
		if (parsed === null) throw new WikiMaintenanceError("response", "Wiki maintenance model returned invalid JSON");
		return parsed;
	}

	const affected = new Map<string, WikiPage>();
	if (current.size > 0) {
		const selection = selectionSchema(
			await ask(prompt.render(maintainSelectSystem), { sources, catalog, limit: MAX_AFFECTED_PAGES }, 1024),
		);
		if (selection instanceof type.errors || selection.pages.length > MAX_AFFECTED_PAGES) {
			throw new WikiMaintenanceError("response", "Wiki maintenance page selection has an invalid shape");
		}
		for (const ref of selection.pages) {
			const page = current.get(ref.id);
			if (!page || ref.revision !== page.revision || affected.has(ref.id)) {
				throw new WikiMaintenanceError("response", "Wiki maintenance selected an unknown, stale, or repeated page");
			}
			affected.set(page.id, page);
		}
	}

	const patch = maintenanceSchema(
		await ask(
			prompt.render(maintainSystem),
			{ sources, catalog, pages: [...affected.values()], limit: Math.min(limit, 32), maxChars },
			Math.min(12_000, Math.max(1024, maxChars + 1024)),
		),
	);
	if (
		patch instanceof type.errors ||
		patch.pages.length > Math.min(limit, 32) ||
		patch.processed.length > batch.size
	) {
		throw new WikiMaintenanceError("response", "Wiki maintenance patch has an invalid shape");
	}
	const processed = new Map<string, number>();
	for (const ref of patch.processed) {
		const source = batch.get(ref.id);
		if (!source || ref.revision !== source.revision || processed.has(ref.id)) {
			throw new WikiMaintenanceError("response", "Wiki maintenance processed an unseen, stale, or repeated source");
		}
		processed.set(ref.id, ref.revision);
	}

	const drafts: WikiPageDraft[] = [];
	const draftIds = new Set<string>();
	let outputChars = 0;
	for (const proposed of patch.pages) {
		if (!PAGE_ID.test(proposed.id) || draftIds.has(proposed.id)) {
			throw new WikiMaintenanceError("response", "Wiki maintenance proposed an unsafe or repeated page ID");
		}
		const previous = affected.get(proposed.id);
		if (
			(previous && proposed.expectedRevision !== previous.revision) ||
			(!previous && (proposed.expectedRevision !== null || reservedIds.has(proposed.id)))
		) {
			throw new WikiMaintenanceError("response", "Wiki maintenance tried to update an unseen or stale page");
		}
		if (
			!proposed.title.trim() ||
			proposed.title.length > 200 ||
			!proposed.summary.trim() ||
			proposed.summary.length > 1000 ||
			!proposed.body.trim()
		) {
			throw new WikiMaintenanceError("response", "Wiki maintenance produced empty or oversized page metadata");
		}
		outputChars += proposed.title.length + proposed.summary.length + proposed.body.length;
		if (outputChars > maxChars) throw new WikiMaintenanceError("budget", "Wiki maintenance patch exceeds maxChars");

		const sourceRefs = new Map<string, number>();
		for (const ref of proposed.sources) {
			if (sourceRefs.has(ref.id))
				throw new WikiMaintenanceError("response", "Wiki maintenance repeats page evidence");
			const known = batch.get(ref.id) ?? previous?.sources.find(source => source.id === ref.id);
			if (!known || known.revision !== ref.revision) {
				throw new WikiMaintenanceError("response", "Wiki maintenance invented or used stale source evidence");
			}
			sourceRefs.set(ref.id, ref.revision);
		}
		if (previous?.sources.some(ref => sourceRefs.get(ref.id) !== ref.revision)) {
			throw new WikiMaintenanceError("response", "Wiki maintenance dropped historical evidence lineage");
		}

		const cited = new Set<string>();
		for (const evidence of proposed.evidence) {
			const source = batch.get(evidence.id);
			if (
				!source ||
				source.revision !== evidence.revision ||
				sourceRefs.get(evidence.id) !== evidence.revision ||
				!evidence.quote.trim() ||
				!source.content.includes(evidence.quote)
			) {
				throw new WikiMaintenanceError("response", "Wiki maintenance supplied an unsupported evidence quotation");
			}
			cited.add(evidence.id);
		}
		let hasNewEvidence = false;
		for (const [id, revision] of sourceRefs) {
			if (!batch.has(id)) continue;
			hasNewEvidence = true;
			if (processed.get(id) !== revision || !cited.has(id)) {
				throw new WikiMaintenanceError("response", "Wiki maintenance must quote and process every added source");
			}
		}
		if (!hasNewEvidence)
			throw new WikiMaintenanceError("response", "Wiki maintenance patch has no supplied new evidence");

		if (proposed.correction) {
			const correction = proposed.correction;
			const source = batch.get(correction.id);
			if (
				!previous ||
				!source ||
				correction.revision !== source.revision ||
				sourceRefs.get(correction.id) !== correction.revision ||
				!correction.quote.trim() ||
				!source.content.includes(correction.quote)
			) {
				throw new WikiMaintenanceError(
					"response",
					"Wiki maintenance conflict resolution lacks a supplied correction quotation",
				);
			}
		}
		// A model may rewrite prose, but cannot quietly erase an established unresolved conflict.
		const status = previous?.status === "conflicted" && !proposed.correction ? "conflicted" : proposed.status;
		drafts.push({
			id: proposed.id,
			expectedRevision: proposed.expectedRevision,
			title: proposed.title,
			summary: proposed.summary,
			body: proposed.body,
			kind: proposed.kind,
			status,
			sources: proposed.sources.map(ref => ({ id: ref.id, revision: ref.revision })),
			links: proposed.links,
		});
		draftIds.add(proposed.id);
	}
	for (const draft of drafts) {
		const links = new Set<string>();
		for (const id of draft.links) {
			if (!PAGE_ID.test(id) || links.has(id) || (!current.has(id) && !draftIds.has(id))) {
				throw new WikiMaintenanceError(
					"response",
					"Wiki maintenance proposed an unknown, unsafe, or repeated page link",
				);
			}
			links.add(id);
		}
	}
	signal?.throwIfAborted();
	return { pages: drafts, processed: patch.processed.map(ref => ({ id: ref.id, revision: ref.revision })) };
}
