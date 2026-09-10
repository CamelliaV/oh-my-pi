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
import { CodexProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
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
			isExplicitlyAvailable: () => true,
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

	it("skips standalone Codex without credentials for a non-GPT session and continues to Exa", async () => {
		const activeModel = {
			provider: "z-ai",
			id: "glm-5.3",
			api: "openai-responses",
			baseUrl: "https://glm.example/v1",
		} as unknown as Model;
		const codexProvider = new CodexProvider();
		const exaProvider: provider.SearchProvider = {
			id: "exa",
			label: "exa",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => ({ provider: "exa", sources: SOURCES }),
		};
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([
			{ id: "codex", explicit: false },
			{ id: "exa", explicit: false },
		]);
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id =>
			id === "codex" ? codexProvider : exaProvider,
		);

		const result = await runSearchQuery(
			{ query: "non-GPT fallback" },
			{ authStorage: { hasAuth: () => false } as unknown as AuthStorage, activeModel },
		);

		expect(result.details.response.provider).toBe("exa");
		expect(result.details.response.sources).toEqual(SOURCES);
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

	it("measures the elapsed time of the provider chain and carries it into the result details", async () => {
		stubProvider("brave", async () => ({ provider: "brave", sources: SOURCES }));

		const result = await runSearchQuery({ query: "timed", provider: "brave" }, { authStorage: {} as AuthStorage });

		// Measured, not defaulted: a finite millisecond count on every result so
		// a resumed transcript can still render the card's elapsed row.
		expect(Number.isFinite(result.details.durationMs)).toBe(true);
		expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("attributes every provider attempt with its own elapsed time", async () => {
		// Each attempt is timed separately, so the card can explain which leg ate
		// the wall clock instead of showing only the chain's total.
		const failing: provider.SearchProvider = {
			id: "brave",
			label: "Brave",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => {
				throw new Error("upstream 502");
			},
		};
		const fallback: provider.SearchProvider = {
			id: "kagi",
			label: "Kagi",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => ({
				provider: "kagi",
				sources: SOURCES,
				usage: { inputTokens: 10, outputTokens: 300 },
			}),
		};
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([
			{ id: "brave", explicit: false },
			{ id: "kagi", explicit: false },
		]);
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => (id === "brave" ? failing : fallback));

		const result = await runSearchQuery({ query: "fallback timing" }, { authStorage: {} as AuthStorage });

		expect(result.details.response.provider).toBe("kagi");
		const failedAttempt = result.details.providerFailures?.[0];
		expect(Number.isFinite(failedAttempt?.durationMs)).toBe(true);
		expect(failedAttempt?.durationMs).toBeGreaterThanOrEqual(0);
		// The chain's total can never be shorter than one of its legs.
		expect(result.details.durationMs).toBeGreaterThanOrEqual(failedAttempt!.durationMs!);
	});

	it("measures duration even when every provider fails", async () => {
		stubProvider("brave", async () => {
			throw new Error("all downstream");
		});

		const result = await runSearchQuery({ query: "doomed", provider: "brave" }, { authStorage: {} as AuthStorage });

		expect(result.details.error).toContain("all downstream");
		expect(Number.isFinite(result.details.durationMs)).toBe(true);
	});
});
