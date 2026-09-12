import { describe, expect, it } from "bun:test";
import { wikiBatches } from "@oh-my-pi/pi-coding-agent/wiki/batches";
import { wikiSourceEvidence, wikiSourcePassages } from "@oh-my-pi/pi-coding-agent/wiki/evidence";
import { maintainWiki } from "@oh-my-pi/pi-coding-agent/wiki/maintain";
import type {
	WikiComplete,
	WikiCompletionRequest,
	WikiPage,
	WikiPageDraft,
	WikiSource,
	WikiSourceRef,
} from "@oh-my-pi/pi-coding-agent/wiki/types";

const timestamp = "2026-09-12T10:00:00.000Z";
const correction = "更正：不要采用助手先前的开窗建议。\n以后只用隐藏窗口验证，不要抢焦点。";

function source(records: Array<{ role: string; content: string; tool?: string }>): WikiSource {
	return {
		id: "e-correction",
		revision: 1,
		content: JSON.stringify(records),
		source: "task-observations",
		cursor: "test-session:native-turn",
		createdAt: timestamp,
		updatedAt: timestamp,
		status: "active",
	};
}

function page(id = "w-verification"): WikiPage {
	return {
		id,
		revision: 2,
		title: "UI verification",
		summary: "Earlier assistant recommended visible windows.",
		body: "Assistant recommended opening a window; the user has not approved that recommendation.",
		kind: "knowledge",
		status: "conflicted",
		sources: [{ id: "e-earlier-assistant", revision: 1 }],
		links: [],
		updatedAt: "2026-09-11T10:00:00.000Z",
	};
}

type PassageRef = WikiSourceRef & { passage: number; role?: string };
interface Proposal {
	pages: Array<Omit<WikiPageDraft, "evidence"> & { evidence: PassageRef[]; correction?: PassageRef }>;
	processed: WikiSourceRef[];
}

function proposal(captured: WikiSource, passage: number, previous?: WikiPage): Proposal {
	const ref = { id: captured.id, revision: captured.revision };
	return {
		pages: [
			{
				id: previous?.id ?? "w-verification",
				expectedRevision: previous?.revision ?? null,
				title: "Hidden verification",
				summary: "Use hidden windows without stealing focus.",
				body: "The user requires hidden verification. Earlier assistant advice is superseded.",
				kind: "preference",
				status: "active",
				sources: [...(previous?.sources ?? []), ref],
				links: [],
				evidence: [{ ...ref, passage }],
			},
		],
		processed: [ref],
	};
}

function input(request: WikiCompletionRequest): {
	catalog: Array<{ id: string; revision: number }>;
	pages?: WikiPage[];
} {
	const encoded = request.prompt.match(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/)?.[1];
	if (!encoded) throw new Error("Missing maintenance input");
	return JSON.parse(encoded);
}

function replies(...values: object[]): WikiComplete {
	let index = 0;
	return async () => {
		const value = values[index++];
		if (!value) throw new Error("Unexpected maintenance request");
		return JSON.stringify(value);
	};
}

describe("Wiki maintenance evidence authority", () => {
	it("decodes original user corrections and preserves their provenance when resolving older assistant advice", async () => {
		const captured = source([
			{ role: "user", content: correction },
			{ role: "assistant", content: "I still recommend showing a window." },
			{ role: "toolResult", tool: "bash", content: "Hidden verification succeeded." },
		]);
		const previous = page();
		const patch = proposal(captured, 0, previous);
		patch.pages[0].correction = patch.pages[0].evidence[0];
		expect(captured.content.includes(correction)).toBe(false);
		const result = await maintainWiki(
			{ version: "test", pages: [previous], pending: [captured] },
			replies({ pages: [{ id: previous.id, revision: previous.revision }] }, patch),
		);
		expect(result.pages[0].status).toBe("active");
		expect(result.pages[0].sources).toContainEqual(previous.sources[0]);
		expect(result.pages[0].evidence).toEqual([
			{ id: captured.id, revision: captured.revision, quote: correction, role: "user", passage: 0 },
		]);
		expect(wikiSourcePassages(captured).map(passage => passage.role)).toEqual(["user", "assistant", "observation"]);
	});

	it("rejects assistant quotations as preference authority even when the model labels them user", async () => {
		const captured = source([{ role: "assistant", content: correction }]);
		const patch = proposal(captured, 0);
		patch.pages[0].evidence[0].role = "user";
		await expect(
			maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(patch)),
		).rejects.toMatchObject({ code: "response" });
		patch.pages[0].kind = "knowledge";
		const result = await maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(patch));
		expect(result.pages[0].evidence?.[0].role).toBe("assistant");
	});

	it("does not grant native speaker authority to retained JSON or ambiguous repeated quotations", async () => {
		const retained = { ...source([{ role: "user", content: correction }]), source: "retain" };
		expect(wikiSourceEvidence(retained, "更正")).toMatchObject({ role: "unknown" });
		const patch = proposal(retained, 0);
		await expect(
			maintainWiki({ version: "test", pages: [], pending: [retained] }, replies(patch)),
		).rejects.toMatchObject({ code: "response" });
		const ambiguous = source([
			{ role: "assistant", content: correction },
			{ role: "user", content: correction },
		]);
		expect(wikiSourceEvidence(ambiguous, correction)?.role).toBe("unknown");
		expect(wikiSourceEvidence(ambiguous, correction, 0)?.role).toBe("assistant");
		expect(wikiSourceEvidence(ambiguous, correction, 1)?.role).toBe("user");
	});

	it("keeps plain retained knowledge quoteable without inventing user provenance", async () => {
		const captured = { ...source([]), source: "retain", content: "The observed service port is 4321." };
		const patch = proposal(captured, 0);
		patch.pages[0].kind = "knowledge";
		const result = await maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(patch));
		expect(result.pages[0].evidence).toEqual([
			{ id: captured.id, revision: captured.revision, quote: captured.content, role: "unknown", passage: 0 },
		]);
	});

	it("copies the selected original passage without model quotation drift", async () => {
		const original =
			"不要把原始内容丢给我，给我 human readable 的总结表格，你现在写法甚至不会触发渲染表格\n保留原文空格。";
		const captured = source([
			{ role: "assistant", content: original },
			{ role: "user", content: original },
		]);
		const result = await maintainWiki(
			{ version: "test", pages: [], pending: [captured] },
			replies(proposal(captured, 1)),
		);
		expect(result.pages[0].evidence).toEqual([
			{ id: captured.id, revision: 1, quote: original, role: "user", passage: 1 },
		]);
	});

	it("rejects generated quote-only evidence and invalid passage indices", async () => {
		const captured = source([{ role: "user", content: correction }]);
		const patch = proposal(captured, 0);
		const quoteOnly = {
			...patch,
			pages: [{ ...patch.pages[0], evidence: [{ id: captured.id, revision: 1, quote: correction }] }],
		};
		await expect(
			maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(quoteOnly)),
		).rejects.toMatchObject({ code: "response" });
		const previous = page();
		const update = proposal(captured, 0, previous);
		const quoteOnlyCorrection = {
			...update,
			pages: [{ ...update.pages[0], correction: { id: captured.id, revision: 1, quote: correction } }],
		};
		await expect(
			maintainWiki(
				{ version: "test", pages: [previous], pending: [captured] },
				replies({ pages: [{ id: previous.id, revision: previous.revision }] }, quoteOnlyCorrection),
			),
		).rejects.toMatchObject({ code: "response" });
		for (const passage of [-1, 0.5, 1, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(proposal(captured, passage))),
			).rejects.toMatchObject({ code: "response" });
			expect(wikiSourceEvidence(captured, correction, passage)).toBeUndefined();
		}
	});

	it("can acknowledge a transient user-only conversation without manufacturing pages", async () => {
		const captured = source([{ role: "user", content: "你好" }]);
		const ignored = { pages: [], processed: [{ id: captured.id, revision: captured.revision }] };
		expect(await maintainWiki({ version: "test", pages: [], pending: [captured] }, replies(ignored))).toEqual(
			ignored,
		);
	});

	it("inspects the complete large catalog and can update its late relevant page within request budgets", async () => {
		const pages = Array.from({ length: 240 }, (_, index) => ({
			...page(`w-topic-${index}`),
			summary: `Topic ${index}: ${"unrelated catalog detail ".repeat(12)}`,
		}));
		const target = pages[pages.length - 1];
		target.summary = "Use hidden windows for verification without stealing focus.";
		const captured = source([{ role: "user", content: correction }]);
		const patch = proposal(captured, 0, target);
		patch.pages[0].correction = patch.pages[0].evidence[0];
		const inspected = new Set<string>();
		let patchCatalogSize = 0;
		const result = await maintainWiki({ version: "test", pages, pending: [captured] }, async request => {
			expect(request.prompt.length + request.system.length).toBeLessThanOrEqual(48_000);
			const payload = input(request);
			if (payload.pages) {
				patchCatalogSize = payload.catalog.length;
				if (!payload.pages.some(candidate => candidate.id === target.id)) throw new Error("Late page was omitted");
				return JSON.stringify(patch);
			}
			for (const candidate of payload.catalog) inspected.add(candidate.id);
			const ranked = [...payload.catalog].sort((a, b) => Number(b.id === target.id) - Number(a.id === target.id));
			return JSON.stringify({ pages: ranked.slice(0, 8).map(({ id, revision }) => ({ id, revision })) });
		});
		expect(inspected).toEqual(new Set(pages.map(candidate => candidate.id)));
		expect(patchCatalogSize).toBeLessThanOrEqual(8);
		expect(result.pages.map(draft => [draft.id, draft.expectedRevision])).toEqual([[target.id, target.revision]]);
	});

	it("preserves provider errors as causes rather than losing the actionable failure", async () => {
		const failure = new Error("provider authentication expired");
		await expect(
			maintainWiki(
				{ version: "test", pages: [], pending: [source([{ role: "user", content: correction }])] },
				async () => {
					throw failure;
				},
			),
		).rejects.toMatchObject({ code: "provider", cause: failure });
	});
});

describe("Wiki bounded JSON batches", () => {
	it("includes every item while accounting for escaped delimiters and rejects a single oversized item", () => {
		const records = Array.from({ length: 12 }, (_, index) => ({ id: index, content: "<quoted>" }));
		const batches = wikiBatches(records, 100);
		expect(batches.flat()).toEqual(records);
		for (const batch of batches)
			expect(JSON.stringify(batch).replaceAll("<", "\\u003c").length).toBeLessThanOrEqual(100);
		expect(() => wikiBatches([{ content: "x".repeat(100) }], 100)).toThrow(RangeError);
	});
});
