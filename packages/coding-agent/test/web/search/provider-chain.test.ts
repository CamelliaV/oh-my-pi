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
import { resolveAnthropicSearchTransport } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic-affinity";
import { SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = {
	hasAuth(provider: string): boolean {
		return provider === "jina" && Boolean(process.env.JINA_API_KEY);
	},
} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;
const originalAnthropicSearchKey = process.env.ANTHROPIC_SEARCH_API_KEY;

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

	if (originalAnthropicSearchKey === undefined) {
		delete process.env.ANTHROPIC_SEARCH_API_KEY;
	} else {
		process.env.ANTHROPIC_SEARCH_API_KEY = originalAnthropicSearchKey;
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

const anthropicRelayModel = {
	provider: "zzzcoding-claude",
	id: "claude-opus-5",
	api: "anthropic-messages",
	baseUrl: "https://api.zzzcoding.org",
	isOAuth: true,
	headers: { "X-Relay-Group": "cc" },
} as unknown as Model;
const bedrockClaudeModel = {
	provider: "amazon-bedrock",
	id: "claude-opus-5",
	api: "bedrock-converse-stream",
	baseUrl: "https://bedrock.example",
} as unknown as Model;
const officialAnthropicModel = {
	provider: "anthropic",
	id: "claude-opus-5",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	isOAuth: true,
} as unknown as Model;

describe("resolveProviderCandidates with an active Anthropic-Messages model", () => {
	it("promotes anthropic ahead of the default chain without duplicating it", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: anthropicRelayModel });

		expect(candidates[0]).toEqual({ id: "anthropic", explicit: false });
		expect(candidates.filter(candidate => candidate.id === "anthropic")).toHaveLength(1);
	});

	it("still drops codex, whose standalone config does not serve a Claude session", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: anthropicRelayModel });

		expect(candidates.map(candidate => candidate.id)).not.toContain("codex");
	});

	it("keeps anthropic in the chain for a non-Anthropic active model instead of suppressing it", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: nonAffinityModel });

		expect(candidates.map(candidate => candidate.id)).toContain("anthropic");
		expect(candidates[0]).not.toEqual({ id: "anthropic", explicit: false });
	});

	it("leaves codex affinity in charge when the active model is GPT-on-codex", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: codexAffinityModel });

		expect(candidates[0]).toEqual({ id: "codex", explicit: false });
		expect(candidates.map(candidate => candidate.id)).toContain("anthropic");
	});

	it("does not promote a Claude model reached over a non-Messages transport", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: bedrockClaudeModel });

		expect(candidates[0]).not.toEqual({ id: "anthropic", explicit: false });
	});

	it("drops anthropic entirely when the user excluded it", () => {
		setExcludedSearchProviders(["anthropic"]);

		const candidates = resolveProviderCandidates(undefined, { activeModel: anthropicRelayModel });

		expect(candidates.map(candidate => candidate.id)).not.toContain("anthropic");
	});

	it("never promotes past a per-request forced provider", () => {
		const candidates = resolveProviderCandidates("perplexity", { activeModel: anthropicRelayModel });

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
	});

	it("leaves an official api.anthropic.com model on the standalone cheap-model path", () => {
		const candidates = resolveProviderCandidates(undefined, { activeModel: officialAnthropicModel });

		expect(candidates[0]).not.toEqual({ id: "anthropic", explicit: false });
		expect(candidates.map(candidate => candidate.id)).toContain("anthropic");
	});

	it("yields to an explicit ANTHROPIC_SEARCH_API_KEY instead of promoting", () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "test-anthropic-search-key";

		const candidates = resolveProviderCandidates(undefined, { activeModel: anthropicRelayModel });

		expect(candidates[0]).not.toEqual({ id: "anthropic", explicit: false });
	});
});

describe("resolveAnthropicSearchTransport", () => {
	const modelRegistry = {
		getProviderHeaders(provider: string): Record<string, string> | undefined {
			return provider === "zzzcoding-claude" ? { "X-Provider-Level": "1" } : undefined;
		},
	} as unknown as ModelRegistry;

	it("reuses the active model's relay endpoint, request id, cloak state and headers", () => {
		const transport = resolveAnthropicSearchTransport(anthropicRelayModel, modelRegistry);

		expect(transport).toEqual({
			provider: "zzzcoding-claude",
			baseUrl: "https://api.zzzcoding.org",
			model: "claude-opus-5",
			isOAuth: true,
			modelHeaders: { "X-Provider-Level": "1", "X-Relay-Group": "cc" },
			extraBetas: undefined,
		});
	});

	it("carries provider-declared betas so a beta-gated relay accepts the search request", () => {
		const gated = {
			...anthropicRelayModel,
			compat: { extraBetas: ["context-1m-2025-08-07"] },
		} as unknown as Model;

		expect(resolveAnthropicSearchTransport(gated, modelRegistry)?.extraBetas).toEqual(["context-1m-2025-08-07"]);
	});

	it("prefers the wire request id over the catalog id", () => {
		const aliased = { ...anthropicRelayModel, requestModelId: "claude-opus-5-20260801" } as unknown as Model;

		expect(resolveAnthropicSearchTransport(aliased, modelRegistry)?.model).toBe("claude-opus-5-20260801");
	});

	it("reports no cloak for an api-key relay model", () => {
		const apiKeyModel = { ...anthropicRelayModel, isOAuth: undefined } as unknown as Model;

		expect(resolveAnthropicSearchTransport(apiKeyModel, modelRegistry)?.isOAuth).toBe(false);
	});

	it("yields no transport for a non-Messages model, leaving the official path in charge", () => {
		expect(resolveAnthropicSearchTransport(codexAffinityModel, modelRegistry)).toBeUndefined();
		expect(resolveAnthropicSearchTransport(bedrockClaudeModel, modelRegistry)).toBeUndefined();
		expect(resolveAnthropicSearchTransport(undefined, modelRegistry)).toBeUndefined();
	});

	it("yields no transport for an official endpoint, so search keeps the cheap default model", () => {
		expect(resolveAnthropicSearchTransport(officialAnthropicModel, modelRegistry)).toBeUndefined();
	});

	it("yields no transport when an explicit search endpoint is configured", () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "test-anthropic-search-key";

		expect(resolveAnthropicSearchTransport(anthropicRelayModel, modelRegistry)).toBeUndefined();
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
