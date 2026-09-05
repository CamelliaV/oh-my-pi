import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GrokProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/grok";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const wongBaseUrl = "https://wzw.pp.ua/v1";

const GROK_ENV_KEYS = ["GROK_SEARCH_BASE_URL", "GROK_SEARCH_MODEL", "GROK_SEARCH_PROVIDER", "GROK_SEARCH_API_KEY"] as const;

function makeAuthStorage(credentials: Record<string, string> = {}): AuthStorage {
	return {
		resolver(provider: string) {
			return async () => credentials[provider];
		},
		hasAuth(provider: string) {
			return provider in credentials;
		},
		getCredentialOrigin(provider: string) {
			return provider in credentials ? { kind: "api_key" } : undefined;
		},
	} as unknown as AuthStorage;
}

function captureFetch(responseBody: Record<string, unknown> | string, status = 200) {
	const capturedRequests: CapturedRequest[] = [];
	const fetchMock: FetchImpl = (input, init) => {
		capturedRequests.push({
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method,
			headers: init?.headers,
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		});
		return Promise.resolve(
			new Response(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
	return {
		fetchMock,
		capturedRequests,
		get capturedRequest() {
			return capturedRequests.at(-1) ?? null;
		},
	};
}

/** A response whose usage counter proves executed hosted search (wong grok-4.3 shape). */
function realSearchResponse(): Record<string, unknown> {
	return {
		id: "resp_grok_real",
		model: "grok-4.3",
		output: [
			{ type: "reasoning" },
			{
				type: "web_search_call",
				action: { sources: [{ url: "https://example.com/real", title: "Real result" }] },
			},
			{
				type: "message",
				content: [{ type: "output_text", text: "Grounded answer [[1]](https://example.com/real)" }],
			},
		],
		usage: { num_server_side_tools_used: 2, input_tokens: 400, output_tokens: 120, total_tokens: 520 },
	};
}

type GrokSearchParams = Parameters<GrokProvider["search"]>[0];

function baseParams(overrides: Partial<GrokSearchParams> = {}): GrokSearchParams {
	return {
		query: "q",
		systemPrompt: "s",
		authStorage: makeAuthStorage(),
		...overrides,
	} as GrokSearchParams;
}

describe("Grok relay search provider", () => {
	let agentDir: string | undefined;
	const originalEnv: Partial<Record<(typeof GROK_ENV_KEYS)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const key of GROK_ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(async () => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSettingsForTest();
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = undefined;
		}
		vi.restoreAllMocks();
	});

	async function withConfigYaml(lines: string[]): Promise<void> {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-search-"));
		await Bun.write(path.join(agentDir, "config.yml"), `${lines.join("\n")}\n`);
		await Settings.init({ agentDir });
	}

	it("is unavailable without a declared endpoint", () => {
		const provider = new GrokProvider();

		expect(provider.isAvailable(makeAuthStorage({ wong: "sk-wong" }))).toBe(false);
	});

	it("is available with an endpoint and a credential for the declared provider", async () => {
		await withConfigYaml([
			"providers:",
			`  webSearchGrokBaseUrl: ${wongBaseUrl}`,
			"  webSearchGrokProvider: wong",
		]);
		const provider = new GrokProvider();

		expect(provider.isAvailable(makeAuthStorage({ wong: "sk-wong" }))).toBe(true);
	});

	it("is available with an endpoint and a GROK_SEARCH_API_KEY env credential", async () => {
		await withConfigYaml(["providers:", `  webSearchGrokBaseUrl: ${wongBaseUrl}`]);
		process.env.GROK_SEARCH_API_KEY = "sk-grok-search";
		const provider = new GrokProvider();

		expect(provider.isAvailable(makeAuthStorage())).toBe(true);
	});

	it("POSTs the declared relay /responses with the configured model and bearer key", async () => {
		await withConfigYaml([
			"providers:",
			`  webSearchGrokBaseUrl: ${wongBaseUrl}`,
			"  webSearchGrokProvider: wong",
			"  webSearchGrokModel: grok-4.3",
		]);
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		const response = await provider.search(
			baseParams({ authStorage: makeAuthStorage({ wong: "sk-wong-key" }), fetch: capture.fetchMock }),
		);

		expect(capture.capturedRequest?.url).toBe("https://wzw.pp.ua/v1/responses");
		expect(capture.capturedRequest?.method).toBe("POST");
		expect(capture.capturedRequest?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer sk-wong-key",
		});
		expect(capture.capturedRequest?.body).toMatchObject({
			model: "grok-4.3",
			input: [
				{ role: "system", content: "s" },
				{ role: "user", content: "q" },
			],
			tools: [{ type: "web_search" }],
			reasoning: { effort: "low" },
		});
		expect(response.provider).toBe("grok");
		expect(response.model).toBe("grok-4.3");
		expect(response.answer).toContain("Grounded answer");
		expect(response.sources[0]?.url).toBe("https://example.com/real");
		expect(response.usage).toMatchObject({ inputTokens: 400, outputTokens: 120, totalTokens: 520 });
	});

	it("sends the declared provider's transport headers (relay UA gates) and resolves its key", async () => {
		await withConfigYaml([
			"providers:",
			`  webSearchGrokBaseUrl: ${wongBaseUrl}`,
			"  webSearchGrokProvider: wong",
		]);
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		await provider.search(
			baseParams({
				authStorage: makeAuthStorage({ wong: "sk-headered" }),
				modelRegistry: {
					getProviderHeaders: (provider: string) =>
						provider === "wong" ? { "User-Agent": "claude-cli/2.1.217" } : undefined,
				} as never,
				fetch: capture.fetchMock,
			}),
		);

		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer sk-headered",
			"User-Agent": "claude-cli/2.1.217",
		});
	});

	it("rejects a flattened fake search (used=0) so the chain advances instead of hallucinating", async () => {
		await withConfigYaml([
			"providers:",
			`  webSearchGrokBaseUrl: ${wongBaseUrl}`,
			"  webSearchGrokProvider: wong",
			"  webSearchGrokModel: grok-4.5",
		]);
		const flattened = {
			id: "resp_flattened",
			model: "grok-4.5",
			output: [
				{ type: "reasoning" },
				{ type: "message", content: [{ type: "output_text", text: "I searched the web and found X." }] },
			],
			usage: { num_server_side_tools_used: 0, total_tokens: 50 },
		};
		const capture = captureFetch(flattened);
		const provider = new GrokProvider();

		const search = provider.search(
			baseParams({ authStorage: makeAuthStorage({ wong: "sk-wong" }), fetch: capture.fetchMock }),
		);

		const error = (await search.then(
			() => undefined,
			(e: unknown) => e,
		)) as SearchProviderError;
		expect(error).toBeInstanceOf(SearchProviderError);
		expect(error.provider).toBe("grok");
		expect(error.status).toBe(502);
		// The fabricated answer text must NOT surface as a successful search.
		expect(error.message).toContain("num_server_side_tools_used=0");
		expect(error.message).toContain("ungrounded");
	});

	it("rejects when no credential resolves for the declared provider", async () => {
		await withConfigYaml([
			"providers:",
			`  webSearchGrokBaseUrl: ${wongBaseUrl}`,
			"  webSearchGrokProvider: wong",
		]);
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		const search = provider.search(baseParams({ fetch: capture.fetchMock }));

		await expect(search).rejects.toThrow(/Grok relay search needs an API key/);
		expect(capture.capturedRequests).toHaveLength(0);
	});

	it("env overrides slot in per setting: base URL, model, and dedicated key", async () => {
		await withConfigYaml([]);
		process.env.GROK_SEARCH_BASE_URL = "https://relay.example/v1";
		process.env.GROK_SEARCH_MODEL = "grok-4.20-0309-reasoning";
		process.env.GROK_SEARCH_API_KEY = "sk-env-grok";
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		await provider.search(baseParams({ fetch: capture.fetchMock }));

		expect(capture.capturedRequest?.url).toBe("https://relay.example/v1/responses");
		expect(capture.capturedRequest?.body).toMatchObject({ model: "grok-4.20-0309-reasoning" });
		expect(capture.capturedRequest?.headers).toMatchObject({ Authorization: "Bearer sk-env-grok" });
	});

	it("settings win over env for base URL and model", async () => {
		await withConfigYaml([
			"providers:",
			"  webSearchGrokBaseUrl: https://settings-win.example/v1",
			"  webSearchGrokModel: settings-model",
		]);
		process.env.GROK_SEARCH_BASE_URL = "https://env-loses.example/v1";
		process.env.GROK_SEARCH_MODEL = "env-model";
		process.env.GROK_SEARCH_API_KEY = "sk-grok-search";
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		await provider.search(baseParams({ fetch: capture.fetchMock }));

		expect(capture.capturedRequest?.url).toBe("https://settings-win.example/v1/responses");
		expect(capture.capturedRequest?.body).toMatchObject({ model: "settings-model" });
	});

	it("maps site: onto web_search allowed_domains through the relay", async () => {
		await withConfigYaml(["providers:", `  webSearchGrokBaseUrl: ${wongBaseUrl}`]);
		process.env.GROK_SEARCH_API_KEY = "sk-grok-search";
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		await provider.search(
			baseParams({ query: "grok changelog site:docs.x.ai", fetch: capture.fetchMock }),
		);

		expect(capture.capturedRequest?.body?.tools).toEqual([
			{ type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } },
		]);
		const input = capture.capturedRequest?.body?.input as { role: string; content: string }[];
		expect(input[1]?.content).toBe("grok changelog");
	});

	it("rejects search attempts before fetch when no endpoint is configured", async () => {
		const capture = captureFetch(realSearchResponse());
		const provider = new GrokProvider();

		const search = provider.search(
			baseParams({ authStorage: makeAuthStorage({ wong: "sk-wong" }), fetch: capture.fetchMock }),
		);

		const error = (await search.then(
			() => undefined,
			(e: unknown) => e,
		)) as SearchProviderError;
		expect(error).toBeInstanceOf(SearchProviderError);
		expect(error.message).toContain("providers.webSearchGrokBaseUrl");
		expect(capture.capturedRequests).toHaveLength(0);
	});

	it("caps results locally to the requested numSearchResults", async () => {
		await withConfigYaml(["providers:", `  webSearchGrokBaseUrl: ${wongBaseUrl}`]);
		process.env.GROK_SEARCH_API_KEY = "sk-grok-search";
		const response = realSearchResponse();
		const manyUrls = Array.from({ length: 15 }, (_, i) => `https://example.com/r-${i + 1}`);
		(response.output as unknown[]).push({
			type: "web_search_call",
			action: { sources: manyUrls.map((url, i) => ({ url, title: `R${i + 1}` })) },
		});
		const capture = captureFetch(response);
		const provider = new GrokProvider();

		const result = await provider.search(
			baseParams({ numSearchResults: 5, fetch: capture.fetchMock }),
		);

		expect(result.sources).toHaveLength(5);
	});
});

describe("Grok channel in the provider chain", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it("lists grok among the built-in provider ids with its label", async () => {
		const { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_ORDER, isSearchProviderId } = await import(
			"@oh-my-pi/pi-coding-agent/web/search/types"
		);

		expect(isSearchProviderId("grok")).toBe(true);
		expect(SEARCH_PROVIDER_ORDER).toContain("grok");
		expect(SEARCH_PROVIDER_LABELS.grok).toBe("Grok");
	});

	it("resolves a lazy provider instance for the grok id", async () => {
		const { getSearchProvider } = await import("@oh-my-pi/pi-coding-agent/web/search/provider");

		const provider = await getSearchProvider("grok");
		expect(provider.id).toBe("grok");
		expect(provider.label).toBe("Grok");
	});

	it("excluded grok drops from the chain and from forced selection", async () => {
		const module = await import("@oh-my-pi/pi-coding-agent/web/search/provider");
		try {
			module.setExcludedSearchProviders(["grok"]);

			expect(module.resolveProviderCandidates("grok").map(c => c.id)).not.toContain("grok");
			expect(module.resolveProviderCandidates().map(c => c.id)).not.toContain("grok");
		} finally {
			module.setExcludedSearchProviders([]);
		}
	});
});
