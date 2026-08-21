/**
 * Throwaway driver: proves affinity ordering through the REAL search pipeline
 * (executeSearch -> resolveProviderCandidates -> CodexProvider -> SSE parse)
 * against a local mock Codex relay. Run:
 *   bun packages/coding-agent/test/web-search-affinity-driver.ts
 */
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { setExcludedSearchProviders, setSearchProviderOrder } from "@oh-my-pi/pi-coding-agent/web/search/provider";

const hits: Array<{ path: string; body: Record<string, unknown> | null }> = [];

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		hits.push({ path: url.pathname, body: (await req.json().catch(() => null)) as Record<string, unknown> | null });
		const events = [
			{ type: "response.created", response: { id: "resp_mock_search", model: "gpt-5.6-sol" } },
			{ type: "response.web_search_call.in_progress" },
			{
				type: "response.output_text.delta",
				delta: "Node.js 24 'Krypton' is the latest LTS line as of 2026.",
			},
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					action: {
						sources: [
							{ url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Previous Releases" },
						],
					},
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_mock_search",
					model: "gpt-5.6-sol",
					status: "completed",
					usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
				},
			},
		];
		const stream = new ReadableStream({
			start(controller) {
				const enc = new TextEncoder();
				for (const event of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const authStorage = {
	hasAuth: () => false,
	getCredentialOrigin: () => undefined,
} as unknown as AuthStorage;
const modelRegistry = {
	authStorage,
	resolver: () => "test-key",
	hasConfiguredAuth: () => true,
	getProviderHeaders: () => ({}),
	getProviderWebSearchDelayMs: () => 0,
	hasCommandBackedApiKey: () => false,
} as unknown as ModelRegistry;

function affinityModel(): Model {
	return {
		provider: "mockgpt",
		id: "gpt-5.6-sol",
		requestModelId: "gpt-5.6-sol",
		api: "openai-codex-responses",
		baseUrl: `http://127.0.0.1:${server.port}/mock/responses`,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	} as unknown as Model;
}

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`, extra !== undefined ? extra : "");
}

// Case 1: GPT affinity model — duckduckgo is hand-ordered FIRST, codex must still
// run before it and succeed via the affinity transport (mock relay).
setSearchProviderOrder(["duckduckgo"]);
setExcludedSearchProviders([]);
hits.length = 0;
const affinityResult = await runSearchQuery(
	{ query: "latest stable Node.js LTS version" },
	{ authStorage, modelRegistry, activeModel: affinityModel() },
);
const affinityDetails = affinityResult.details;
check("affinity run served by codex", affinityDetails.response.provider === "codex", affinityDetails.response.provider);
check("affinity run has one source", (affinityDetails.response.sources ?? []).length === 1);
check(
	"affinity run hit only the mock relay",
	hits.length === 1,
	hits.map(h => h.path),
);
check("affinity run had no provider failures", !affinityDetails.providerFailures, affinityDetails.providerFailures);
check(
	"codex request forced the web_search tool",
	Array.isArray(hits[0]?.body?.tools) &&
		(hits[0].body.tools as Array<{ type?: string }>).some(t => t?.type === "web_search"),
);

// Case 2 (negative control — the real-world repro): GLM model with
// webSearchOrder=["codex"] (leftover gateway config). Codex must be dropped
// from the chain entirely — not attempted, no failure record — while every
// other provider except exa stays excluded to keep the run hermetic.
setSearchProviderOrder(["codex"]);
setExcludedSearchProviders([
	"perplexity",
	"gemini",
	"xai",
	"zai",
	"tinyfish",
	"jina",
	"kagi",
	"tavily",
	"firecrawl",
	"brave",
	"kimi",
	"parallel",
	"synthetic",
	"searxng",
	"startpage",
	"duckduckgo",
	"ecosia",
	"google",
	"mojeek",
	"public",
]);
hits.length = 0;
const plainModel = {
	provider: "z-ai",
	id: "glm-5.3",
	api: "openai-completions",
	baseUrl: `http://127.0.0.1:${server.port}/mock/responses`,
} as unknown as Model;
const controlResult = await runSearchQuery(
	{ query: "latest stable Node.js LTS version" },
	{ authStorage, modelRegistry, activeModel: plainModel },
);
check(
	"non-affinity control did not reach the mock relay",
	hits.length === 0,
	hits.map(h => h.path),
);
check(
	"non-affinity control attempted nothing (only exa allowed, unauthenticated)",
	controlResult.details.response.provider === "none" &&
		controlResult.details.error === "No web search provider configured.",
	`${controlResult.details.response.provider} / ${controlResult.details.error}`,
);
check(
	"non-affinity control recorded no codex failure",
	!(controlResult.details.providerFailures ?? []).some(f => f.provider === "codex"),
	controlResult.details.providerFailures,
);

server.stop(true);
console.log(failures === 0 ? "DRIVER OK" : `DRIVER FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
