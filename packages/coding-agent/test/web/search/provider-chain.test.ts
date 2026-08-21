import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import {
	resolveProviderCandidates,
	resolveProviderChain,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = {
	hasAuth(provider: string): boolean {
		return provider === "jina" && Boolean(process.env.JINA_API_KEY);
	},
} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setExcludedSearchProviders([]);
	setSearchProviderOrder([]);
	restoreEnv();
});

describe("resolveProviderCandidates", () => {
	it("orders the forced provider before configured and built-in fallbacks", () => {
		setSearchProviderOrder(["gemini", "exa"]);

		const candidates = resolveProviderCandidates("perplexity");

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual([
			"gemini",
			"exa",
			...SEARCH_PROVIDER_ORDER.filter(id => id !== "perplexity" && id !== "gemini" && id !== "exa"),
		]);
	});

	it("marks configured-order entries explicit so hand-listed providers keep explicit-selection semantics", () => {
		setSearchProviderOrder(["perplexity"]);

		const candidates = resolveProviderCandidates();

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates[1]?.explicit).toBe(false);
	});

	it("omits excluded providers without resolving them", () => {
		setExcludedSearchProviders(["duckduckgo", "google"]);

		const candidates = resolveProviderCandidates("exa");

		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
		expect(candidates.map(candidate => candidate.id)).not.toContain("google");
	});

	it("applies live settings edits, filtering invalid and duplicate provider IDs", () => {
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("providers.webSearchOrder", ["exa", "not-a-provider", "exa", "gemini"]);

		const candidates = resolveProviderCandidates();
		expect(candidates.slice(0, 2).map(candidate => candidate.id)).toEqual(["exa", "gemini"]);
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length);
	});
});

const codexAffinityModel = {
	provider: "zzzcoding",
	id: "gpt-5.6-sol",
	api: "openai-codex-responses",
	baseUrl: "https://relay.example/responses",
} as unknown as Model;
const nonAffinityModel = {
	provider: "z-ai",
	id: "glm-5.3",
	api: "openai-completions",
	baseUrl: "https://glm.example/v1",
} as unknown as Model;

describe("resolveProviderCandidates with an active Codex-affinity model", () => {
	it("promotes codex ahead of the default chain without duplicating it", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: codexAffinityModel });

		expect(candidates[0]).toEqual({ id: "codex", explicit: false });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual(
			SEARCH_PROVIDER_ORDER.filter(id => id !== "codex"),
		);
	});

	it("keeps hand-listed codex explicit when promoting it", () => {
		setSearchProviderOrder(["exa", "codex"]);

		const candidates = resolveProviderCandidates(undefined, { activeModel: codexAffinityModel });

		expect(candidates[0]).toEqual({ id: "codex", explicit: true });
		expect(candidates[1]).toEqual({ id: "exa", explicit: true });
	});

	it("promotes a codex-only order to a single explicit codex candidate", () => {
		setSearchProviderOrder(["codex"]);

		const candidates = resolveProviderCandidates(undefined, { activeModel: codexAffinityModel });

		expect(candidates.filter(candidate => candidate.id === "codex")).toEqual([{ id: "codex", explicit: true }]);
		expect(candidates[0]).toEqual({ id: "codex", explicit: true });
	});

	it("drops codex from the default chain for a non-affinity active model", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: nonAffinityModel });

		expect(candidates.map(candidate => candidate.id)).toEqual(SEARCH_PROVIDER_ORDER.filter(id => id !== "codex"));
	});

	it("drops configured-order codex for a non-affinity active model", () => {
		setSearchProviderOrder(["codex"]);

		const candidates = resolveProviderCandidates(undefined, { activeModel: nonAffinityModel });

		expect(candidates.map(candidate => candidate.id)).not.toContain("codex");
		expect(candidates[0]).toEqual({ id: SEARCH_PROVIDER_ORDER[0], explicit: false });
	});

	it("keeps forced codex selectable for a non-affinity active model", () => {
		const candidates = resolveProviderCandidates("codex", { activeModel: nonAffinityModel });

		expect(candidates[0]).toEqual({ id: "codex", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual(
			SEARCH_PROVIDER_ORDER.filter(id => id !== "codex"),
		);
	});

	it("never promotes past a per-request forced provider", () => {
		const candidates = resolveProviderCandidates("perplexity", { activeModel: codexAffinityModel });

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual(
			SEARCH_PROVIDER_ORDER.filter(id => id !== "perplexity"),
		);
	});

	it("drops codex entirely when the user excluded it", () => {
		setExcludedSearchProviders(["codex"]);

		const candidates = resolveProviderCandidates(undefined, { activeModel: codexAffinityModel });

		expect(candidates.map(candidate => candidate.id)).not.toContain("codex");
		expect(candidates.map(candidate => candidate.id)).toEqual(SEARCH_PROVIDER_ORDER.filter(id => id !== "codex"));
	});
});

describe("resolveProviderChain", () => {
	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("ignores the forced provider when it is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("applies live settings edits to the exclusion chain", async () => {
		enableKeyBackedProviders();
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange(
			"providers.webSearchExclude",
			SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"),
		);

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("admits the affinity-promoted codex provider ahead of the chain for a GPT session", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "codex" && id !== "jina"));
		const modelRegistry = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;

		const providers = await resolveProviderChain(authStorage, undefined, {
			activeModel: codexAffinityModel,
			modelRegistry,
		});

		expect(providers.map(provider => provider.id)).toEqual(["codex", "jina"]);
	});
});
