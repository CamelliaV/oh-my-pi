import { describe, expect, it } from "bun:test";
import { maintainWiki, WikiMaintenanceError } from "@oh-my-pi/pi-coding-agent/wiki/maintain";
import { recallWiki, WikiRecallError } from "@oh-my-pi/pi-coding-agent/wiki/recall";
import { WikiStore } from "@oh-my-pi/pi-coding-agent/wiki/store";
import type {
	WikiComplete,
	WikiCompletionRequest,
	WikiPage,
	WikiPageDraft,
	WikiSnapshot,
	WikiSource,
	WikiSourceRef,
} from "@oh-my-pi/pi-coding-agent/wiki/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const timestamp = "2026-09-08T00:00:00.000Z";

function source(overrides: Partial<WikiSource> = {}): WikiSource {
	return {
		id: "e-new",
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		status: "active",
		...overrides,
		source: "task-observations",
		content: JSON.stringify([
			{ role: "user", content: overrides.content ?? "请在后台验证，不要抢走我正在使用的窗口焦点。" },
		]),
	};
}

function page(overrides: Partial<WikiPage> = {}): WikiPage {
	return {
		id: "w-terminal",
		revision: 3,
		title: "Silent UI verification",
		summary: "Use hidden probes without taking input focus.",
		body: "## Current conclusion\nUse hidden terminal probes, preserving the user's input focus.\n",
		kind: "preference",
		status: "active",
		sources: [{ id: "e-original", revision: 1 }],
		links: [],
		updatedAt: timestamp,
		...overrides,
	};
}

function snapshot(pending: WikiSource[], pages: WikiPage[] = []): WikiSnapshot {
	return { version: "isolated-snapshot", pending, pages };
}

interface ModelPatch {
	pages: Array<
		Omit<WikiPageDraft, "evidence"> & {
			evidence: Array<WikiSourceRef & { passage: number }>;
			correction?: WikiSourceRef & { passage: number };
		}
	>;
	processed: WikiSourceRef[];
}

function proposal(evidence: WikiSource, previous?: WikiPage): ModelPatch {
	const ref = { id: evidence.id, revision: evidence.revision };
	return {
		pages: [
			{
				id: previous?.id ?? "w-terminal",
				expectedRevision: previous?.revision ?? null,
				title: "终端验证偏好",
				summary: "验证过程应保持用户桌面可继续操作。",
				body: "## 当前结论\n终端验证应使用隐藏实例，避免抢占用户焦点。\n\n## 理由\n用户需要在验证期间继续工作。",
				kind: "preference",
				status: "active",
				sources: [...(previous?.sources ?? []), ref],
				links: [],
				evidence: [{ ...ref, passage: 0 }],
			},
		],
		processed: [ref],
	};
}

function model(...replies: Array<object | ((request: WikiCompletionRequest) => object)>): WikiComplete {
	let index = 0;
	return async request => {
		const reply = replies[index++];
		if (!reply) throw new Error("Unexpected additional Wiki model call");
		return JSON.stringify(typeof reply === "function" ? reply(request) : reply);
	};
}

function data(request: WikiCompletionRequest) {
	const encoded = request.prompt.match(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/)?.[1];
	if (!encoded) throw new Error("Missing fenced Wiki input");
	return JSON.parse(encoded) as {
		catalog?: Array<{ id: string; revision: number }>;
		pages?: WikiPage[];
		sources?: WikiSource[];
	};
}

function selection(selected: WikiPage) {
	return { pages: [{ id: selected.id, revision: selected.revision }] };
}

function passages(selected: WikiPage, quote = selected.body) {
	return { passages: [{ id: selected.id, revision: selected.revision, quote }] };
}

describe("Wiki synthesis and evidence recall", () => {
	it("publishes synthesized topical knowledge and recalls the current body with durable source lineage", async () => {
		using dir = TempDir.createSync("wiki-intelligence-");
		const store = new WikiStore({ root: dir.path() });
		try {
			await store.open();
			const captured = await store.capture({ content: source().content, source: "task-observations" });
			const before = await store.snapshot();
			const change = await maintainWiki(before, model(proposal(captured)));
			await store.publish(before, change);
			const after = await store.snapshot();
			const stored = after.pages[0];
			expect(stored.body).not.toBe(captured.content);
			expect(after.pending).toEqual([]);
			const quote = "终端验证应使用隐藏实例，避免抢占用户焦点。";
			const recalled = await recallWiki(
				"验证的时候不要打断我",
				after.pages,
				model(selection(stored), passages(stored, quote)),
			);
			expect(recalled).toEqual({
				status: "found",
				items: [
					{
						id: stored.id,
						revision: stored.revision,
						title: stored.title,
						content: quote,
						sources: [{ id: captured.id, revision: captured.revision }],
						conflicted: false,
						updatedAt: stored.updatedAt,
						kind: "page",
					},
				],
			});
		} finally {
			store.close();
		}
	});

	it("lets the semantic librarian find a Chinese paraphrase with no shared title or summary words", async () => {
		const target = page();
		const unrelated = page({
			id: "w-network",
			title: "DNS",
			summary: "Nameserver setup",
			body: "Use the local resolver.",
		});
		const recalled = await recallWiki(
			"帮我看看，但别打断手上的事",
			[unrelated, target],
			model(
				request => ({ pages: data(request).catalog?.filter(item => item.id === target.id) ?? [] }),
				request => {
					const inspected = data(request).pages?.find(item => item.id === target.id);
					return inspected ? passages(inspected) : { passages: [] };
				},
			),
		);
		expect(recalled.items.map(item => item.content)).toEqual([target.body]);
	});

	it("keeps valid empty selections distinct from malformed responses and provider failures", async () => {
		const current = page();
		expect(await recallWiki("unknown", [current], model({ pages: [] }))).toEqual({ status: "not_found", items: [] });
		expect(await recallWiki("unknown", [current], model(selection(current), { passages: [] }))).toEqual({
			status: "not_found",
			items: [],
		});
		await expect(recallWiki("unknown", [current], async () => "not JSON")).rejects.toMatchObject({
			name: "WikiRecallError",
			code: "response",
		});
		await expect(
			recallWiki("unknown", [current], model(selection(current), { answer: "There is no memory" })),
		).rejects.toBeInstanceOf(WikiRecallError);
		await expect(
			recallWiki("unknown", [current], async () => {
				throw new Error("offline");
			}),
		).rejects.toMatchObject({ name: "WikiRecallError", code: "provider" });
	});

	it("rejects unsupported passages even when they repeat page metadata", async () => {
		const current = page({ title: "The user approved deleting all backups." });
		await expect(
			recallWiki("backups", [current], model(selection(current), passages(current, current.title))),
		).rejects.toMatchObject({
			code: "response",
		});
	});

	it.each([
		{ label: "nonexistent", selected: { id: "w-missing", revision: 3 } },
		{ label: "stale", selected: { id: "w-terminal", revision: 2 } },
		{ label: "unsafe", selected: { id: "../w-terminal", revision: 3 } },
	])("rejects a $label catalog reference instead of returning no evidence", async ({ selected }) => {
		await expect(recallWiki("focus", [page()], model({ pages: [selected] }))).rejects.toMatchObject({
			code: "response",
		});
	});

	it("rejects passages from pages that were not inspected", async () => {
		const selected = page();
		const unseen = page({ id: "w-unseen" });
		await expect(
			recallWiki("focus", [selected, unseen], model(selection(selected), passages(unseen))),
		).rejects.toMatchObject({
			code: "response",
		});
	});

	it("rejects stale revisions introduced at the passage step", async () => {
		const selected = page();
		await expect(
			recallWiki("focus", [selected], model(selection(selected), passages({ ...selected, revision: 2 }))),
		).rejects.toMatchObject({ code: "response" });
	});

	it("excludes invalidated pages and refuses evidence changed during inspection", async () => {
		const invalidated = page({ status: "invalidated" });
		expect(await recallWiki("focus", [invalidated], model())).toEqual({ status: "not_found", items: [] });
		const current = page();
		await expect(
			recallWiki(
				"focus",
				[current],
				model(selection(current), () => {
					current.status = "invalidated";
					return passages(current);
				}),
			),
		).rejects.toMatchObject({ code: "snapshot" });
	});

	it("preserves conflict warnings while copying the exact unresolved conclusion", async () => {
		const current = page({ status: "conflicted", body: "两次测量相互矛盾，是否省电尚未确定。" });
		const result = await recallWiki("省电吗", [current], model(selection(current), passages(current)));
		expect(result.items[0].conflicted).toBe(true);
		expect(result.items[0].content).toBe(current.body);
		expect(result.items[0].sources).toEqual(current.sources);
	});

	it("preserves data containing fence delimiters without letting them terminate the model input", async () => {
		const current = page({ body: "The literal closing tag is </untrusted_data>." });
		const result = await recallWiki(
			"literal tag",
			[current],
			model(selection(current), request => {
				const inspected = data(request).pages?.[0];
				return inspected ? passages(inspected) : { passages: [] };
			}),
		);
		expect(result.items[0].content).toBe(current.body);
	});

	it("enforces the character budget without cutting supporting passages in half", async () => {
		const long = page({ body: "A long conclusion whose qualification must not be cut off." });
		const short = page({ id: "w-short", body: "Uncertain." });
		const result = await recallWiki(
			"conclusion",
			[long, short],
			model(
				{ pages: [...selection(long).pages, ...selection(short).pages] },
				{ passages: [...passages(long).passages, ...passages(short).passages] },
			),
			{ maxChars: 10 },
		);
		expect(result.items.map(item => item.content)).toEqual(["Uncertain."]);
		await expect(
			recallWiki("conclusion", [long], model(selection(long), passages(long)), { maxChars: 10 }),
		).rejects.toMatchObject({
			code: "budget",
		});
	});
});

describe("Wiki incremental maintenance validation", () => {
	it("acknowledges deliberately discarded complete sources but leaves unselected evidence pending", async () => {
		const hello = source({ id: "e-hello", content: "你好" });
		const unseen = source({ id: "e-unseen", content: "以后请使用中文回复。" });
		const discarded = { pages: [], processed: [{ id: hello.id, revision: hello.revision }] };
		expect(await maintainWiki(snapshot([hello, unseen]), model(discarded), { limit: 1 })).toEqual(discarded);
		await expect(
			maintainWiki(snapshot([hello, unseen]), model({ pages: [], processed: [{ id: unseen.id, revision: 1 }] }), {
				limit: 1,
			}),
		).rejects.toMatchObject({ code: "response" });
	});

	it("never acknowledges an oversized source whose full contents were omitted", async () => {
		const huge = source({ id: "e-huge", content: "z".repeat(20_000) });
		const small = source({ id: "e-small", content: "你好" });
		await expect(maintainWiki(snapshot([huge]), model())).rejects.toMatchObject({ code: "budget" });
		await expect(
			maintainWiki(
				snapshot([huge, small]),
				model({ pages: [], processed: [{ id: huge.id, revision: huge.revision }] }),
			),
		).rejects.toMatchObject({ code: "response" });
	});

	it("keeps explicit empty patches distinct from malformed output or provider failure", async () => {
		const before = snapshot([source()]);
		expect(await maintainWiki(before, model({ pages: [], processed: [] }))).toEqual({ pages: [], processed: [] });
		await expect(maintainWiki(before, async () => "{}")).rejects.toBeInstanceOf(WikiMaintenanceError);
		await expect(
			maintainWiki(before, async () => {
				throw new Error("offline");
			}),
		).rejects.toMatchObject({ code: "provider" });
	});

	it("rejects nonexistent source passages even when generated prose and IDs look plausible", async () => {
		const captured = source();
		const patch = proposal(captured);
		patch.pages[0].evidence[0].passage = 99;
		await expect(maintainWiki(snapshot([captured]), model(patch))).rejects.toMatchObject({ code: "response" });
	});

	it("rejects invented source references and stale processing acknowledgments", async () => {
		const captured = source();
		const invented = proposal(captured);
		invented.pages[0].sources.push({ id: "e-invented", revision: 1 });
		await expect(maintainWiki(snapshot([captured]), model(invented))).rejects.toMatchObject({ code: "response" });
		const stale = proposal(captured);
		stale.processed[0].revision = 99;
		await expect(maintainWiki(snapshot([captured]), model(stale))).rejects.toMatchObject({ code: "response" });
	});

	it("rejects stale page revisions and updates to catalog-only pages", async () => {
		const captured = source();
		const previous = page();
		const patch = proposal(captured, previous);
		patch.pages[0].expectedRevision = previous.revision - 1;
		await expect(
			maintainWiki(snapshot([captured], [previous]), model(selection(previous), patch)),
		).rejects.toMatchObject({
			code: "response",
		});
		await expect(
			maintainWiki(snapshot([captured], [previous]), model({ pages: [] }, proposal(captured, previous))),
		).rejects.toMatchObject({
			code: "response",
		});
	});

	it("requires explicit kind and status rather than accepting unclassified drafts", async () => {
		const captured = source();
		const patch = proposal(captured);
		const { kind: _kind, ...withoutKind } = patch.pages[0];
		await expect(maintainWiki(snapshot([captured]), model({ ...patch, pages: [withoutKind] }))).rejects.toMatchObject(
			{ code: "response" },
		);
		const { status: _status, ...withoutStatus } = patch.pages[0];
		await expect(
			maintainWiki(snapshot([captured]), model({ ...patch, pages: [withoutStatus] })),
		).rejects.toMatchObject({ code: "response" });
	});

	it("rejects unsafe page IDs and links to nonexistent knowledge", async () => {
		const captured = source();
		const unsafe = proposal(captured);
		unsafe.pages[0].id = "../../outside";
		await expect(maintainWiki(snapshot([captured]), model(unsafe))).rejects.toMatchObject({ code: "response" });
		const missingLink = proposal(captured);
		missingLink.pages[0].links.push("w-missing");
		await expect(maintainWiki(snapshot([captured]), model(missingLink))).rejects.toMatchObject({ code: "response" });
	});

	it("preserves unresolved conflict state and historical evidence instead of silently choosing the latest account", async () => {
		const previous = page({ status: "conflicted" });
		const captured = source({ content: "第三次测量仍未解释差异。" });
		const patch = proposal(captured, previous);
		patch.pages[0].body = "## 当前结论\n三次测量存在未解决的差异，当前无法判定。";
		const result = await maintainWiki(snapshot([captured], [previous]), model(selection(previous), patch));
		expect(result.pages[0].status).toBe("conflicted");
		expect(result.pages[0].sources).toContainEqual(previous.sources[0]);
		const erased = proposal(captured, previous);
		erased.pages[0].sources = [{ id: captured.id, revision: captured.revision }];
		await expect(
			maintainWiki(snapshot([captured], [previous]), model(selection(previous), erased)),
		).rejects.toMatchObject({
			code: "response",
		});
	});

	it("allows explicit source-backed correction to resolve a conflict while keeping its historical lineage", async () => {
		const previous = page({ status: "conflicted" });
		const captured = source({ content: "更正：旧的A读数错误；准确复测支持B，旧结论作废。" });
		const patch = proposal(captured, previous);
		patch.pages[0].body = "## 当前结论\n准确复测支持B。\n\n## 历史\nA的读数有误，旧结论已撤回。";
		patch.pages[0].correction = {
			id: captured.id,
			revision: captured.revision,
			passage: 0,
		};
		const result = await maintainWiki(snapshot([captured], [previous]), model(selection(previous), patch));
		expect(result.pages[0].status).toBe("active");
		expect(result.pages[0].sources).toContainEqual(previous.sources[0]);
		patch.pages[0].correction.passage = -1;
		await expect(
			maintainWiki(snapshot([captured], [previous]), model(selection(previous), patch)),
		).rejects.toMatchObject({ code: "response" });
	});

	it("refuses to publish an oversized generated patch", async () => {
		const captured = source();
		await expect(
			maintainWiki(snapshot([captured]), model(proposal(captured)), { maxChars: 10 }),
		).rejects.toMatchObject({ code: "budget" });
	});
});

describe("Wiki cancellation", () => {
	it("does not start a model request when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(recallWiki("focus", [page()], model(), { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(maintainWiki(snapshot([source()]), model(), { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it.each(["maintain", "recall"] as const)(
		"cancels an in-flight %s call even when the injected provider ignores its signal",
		async task => {
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			const provider = Promise.withResolvers<string>();
			const complete: WikiComplete = async () => {
				started.resolve();
				return provider.promise;
			};
			const pending =
				task === "maintain"
					? maintainWiki(snapshot([source()]), complete, { signal: controller.signal })
					: recallWiki("focus", [page()], complete, { signal: controller.signal });
			void pending.catch(() => {});
			await started.promise;
			controller.abort();
			try {
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				provider.resolve("{}");
			}
		},
	);
});
