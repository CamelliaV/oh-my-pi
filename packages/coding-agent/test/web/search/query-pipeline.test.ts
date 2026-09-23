/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the role-selected provider, then lenient-filters the
 * returned sources — enforcing constraints the provider ignored and relaxing
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { CodexProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

const openAuthStorages: AuthStorage[] = [];

async function stubRoleProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	const settings = await Settings.init({ inMemory: true });
	settings.setModelRole("web", `web/${id}`);
	settings.set("retry.fallbackChains", { web: [] });
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const stub: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== id) throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
	return { authStorage, modelRegistry, getProvider };
}

describe("web search directive pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("passes the parsed query to the role-selected provider and post-filters ignored constraints", async () => {
		let seen: SearchParams | undefined;
		const context = await stubRoleProvider("brave", async params => {
			seen = params;
			return { provider: "brave", sources: SOURCES };
		});

		const result = await runSearchQuery({ query: "guide site:docs.example.com" }, context);

		expect(seen?.model.provider).toBe("web");
		expect(seen?.model.id).toBe("brave");
		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(source => source.url)).toEqual(["https://docs.example.com/guide"]);
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
		const context = await stubRoleProvider("brave", async () => ({ provider: "brave", sources: SOURCES }));

		const result = await runSearchQuery({ query: "guide site:nowhere.example" }, context);

		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});

	it("uses a request model override instead of modelRoles.web", async () => {
		const context = await stubRoleProvider("jina", async params => ({
			provider: "jina",
			sources: [{ title: params.model.id, url: "https://jina.example" }],
		}));
		const exaProvider: provider.SearchProvider = {
			id: "exa",
			label: "exa",
			isAvailable: () => false,
			isExplicitlyAvailable: () => true,
			search: async params => ({
				provider: "exa",
				sources: [{ title: params.model.id, url: "https://exa.example" }],
			}),
		};
		context.getProvider.mockImplementation(async requested => {
			if (requested === "exa") return exaProvider;
			throw new Error(`Unexpected provider: ${requested}`);
		});

		const result = await runSearchQuery({ query: "override", model: "web/exa" }, context);

		expect(result.details.response.provider).toBe("exa");
		expect(result.details.response.sources[0]?.title).toBe("exa");
	});
});
