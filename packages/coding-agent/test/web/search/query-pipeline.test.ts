/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the provider, then lenient-filters the returned sources
 * — enforcing constraints the provider ignored and relaxing (with a note)
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

function stubProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	const stub: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([{ id, explicit: true }]);
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== id) throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
}

describe("web search directive pipeline", () => {
	afterEach(() => vi.restoreAllMocks());

	it("passes the parsed query to the provider and post-filters sources it did not constrain", async () => {
		let seen: SearchParams | undefined;
		stubProvider("brave", async params => {
			seen = params;
			return { provider: "brave", sources: SOURCES };
		});

		const result = await runSearchQuery(
			{ query: "guide site:docs.example.com", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(s => s.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("passes the active agent model into provider search and availability", async () => {
		const activeModel = {
			provider: "current-gpt",
			id: "gpt-5.6-sol",
			api: "openai-responses",
			baseUrl: "https://current.example/v1",
		} as unknown as Model;
		let seenSearchParams: SearchParams | undefined;
		let seenAvailabilityModel: Model | undefined;
		const searchProvider: provider.SearchProvider = {
			id: "codex",
			label: "codex",
			isAvailable: (_authStorage, context) => {
				seenAvailabilityModel = context?.activeModel;
				return true;
			},
			search: async params => {
				seenSearchParams = params;
				return { provider: "codex", sources: SOURCES };
			},
		};
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([{ id: "codex", explicit: false }]);
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(searchProvider);

		await runSearchQuery({ query: "active provider" }, { authStorage: {} as AuthStorage, activeModel });

		expect(seenAvailabilityModel).toBe(activeModel);
		expect(seenSearchParams?.activeModel).toBe(activeModel);
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		stubProvider("brave", async () => ({ provider: "brave", sources: SOURCES }));

		const result = await runSearchQuery(
			{ query: "guide site:nowhere.example", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		// Leniency: nothing matched site:nowhere.example, so all sources survive
		// and the model is told the constraint was relaxed.
		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});
});
