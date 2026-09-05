/**
 * Grok Relay Web Search Provider
 *
 * Grok hosted web search (`web_search` tool on the Responses API) through a
 * user-declared OpenAI-Responses-compatible endpoint — a relay fronting
 * Grok, e.g. wong (`https://wzw.pp.ua/v1`) serving `grok-4.3`.
 *
 * This is the relay counterpart of the `xai` channel: `xai` resolves
 * api.x.ai credentials through the xai/xai-oauth auth stack and pins
 * `grok-4.5`; `grok` takes a fully declarable triple — base URL, API key,
 * and model. Configuration precedence per slot:
 *
 *   - endpoint: `providers.webSearchGrokBaseUrl` setting, `GROK_SEARCH_BASE_URL` env
 *   - model: `providers.webSearchGrokModel` setting, `GROK_SEARCH_MODEL` env (default `grok-4.3`)
 *   - credential: `GROK_SEARCH_API_KEY` env, else the models.yml provider
 *     named by `providers.webSearchGrokProvider` (or `GROK_SEARCH_PROVIDER`
 *     env) — the relay key already used for chat (e.g. `providers.wong.apiKey`)
 *     can serve search — else a stored `grok-search` credential.
 *
 * Transport headers come from the declared models.yml provider when one is
 * named, so relays that gate on a `User-Agent` (claude-cli) fingerprint
 * work unchanged.
 *
 * Real-search evidence (wong relay, 2026-09): grok-4.3 executes hosted
 * search (`web_search_call` items, `num_server_side_tools_used>0`, real
 * URLs, `url_citation` annotations, honored `allowed_domains`); grok-4.5
 * and grok-4.6 on the same relay accept the tool schema but flatten it
 * (`used=0`) while the answer claims a search happened — the shared core's
 * real-search gate rejects that shape so this channel never surfaces
 * fabricated citations.
 */
import { type AuthStorage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { settings } from "../../../config/settings";
import type { SearchProviderAvailabilityContext } from "./base";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchGrokResponses } from "./grok-responses";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";

/** Auth provider id under which a dedicated Grok search key may be stored. */
const GROK_SEARCH_AUTH_PROVIDER = "grok-search";

/** Default search model on the Responses wire. grok-4.3 = verified real search; 4.5/4.6 flatten on relays. */
const DEFAULT_GROK_SEARCH_MODEL = "grok-4.3";

/** grok-4.3's upstream-default effort ≈ high (1.1K reasoning tokens); pin low for latency-sensitive search. */
const GROK_WEB_SEARCH_REASONING_EFFORT = "low";

const GROK_SEARCH_MISSING_KEY_HINT =
	'Grok relay search needs an API key. Set GROK_SEARCH_API_KEY, store one for provider "grok-search", or declare the models.yml provider holding it via providers.webSearchGrokProvider.';

function readSetting(
	path: "providers.webSearchGrokBaseUrl" | "providers.webSearchGrokModel" | "providers.webSearchGrokProvider",
): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Declared models.yml provider name whose apiKey/headers the channel borrows (e.g. `wong`). */
function resolveGrokProviderName(): string | undefined {
	return readSetting("providers.webSearchGrokProvider") ?? ($env.GROK_SEARCH_PROVIDER?.trim() || undefined);
}

/** Declared relay base URL (OpenAI-Responses-compatible, `/responses` is appended). */
export function resolveGrokBaseUrl(): string | undefined {
	return readSetting("providers.webSearchGrokBaseUrl") ?? ($env.GROK_SEARCH_BASE_URL?.trim() || undefined);
}

/** Declared wire model id. */
export function resolveGrokSearchModel(): string {
	const configured = readSetting("providers.webSearchGrokModel") ?? $env.GROK_SEARCH_MODEL?.trim();
	return configured || DEFAULT_GROK_SEARCH_MODEL;
}

interface GrokSearchCredentialParams {
	authStorage: AuthStorage;
	sessionId?: string;
	modelRegistry?: ModelRegistry;
}

/** Resolve the credential resolver for the declared provider triple. */
function resolveGrokSearchKey(params: GrokSearchCredentialParams) {
	const envKey = $env.GROK_SEARCH_API_KEY?.trim();
	if (envKey) return envKey;

	const declaredProvider = resolveGrokProviderName();
	const resolverProvider = declaredProvider ?? GROK_SEARCH_AUTH_PROVIDER;
	const resolverOptions = { sessionId: params.sessionId };
	// Registry resolver consults models.yml config overrides
	// (providers.<name>.apiKey), runtime overrides, and stored credentials.
	return (
		params.modelRegistry?.resolver?.(resolverProvider, resolverOptions) ??
		params.authStorage.resolver(resolverProvider, resolverOptions)
	);
}

/** Channel availability: an endpoint plus at least one credential source. */
function hasGrokSearchCredential(authStorage: AuthStorage, _modelRegistry: ModelRegistry | undefined): boolean {
	if ($env.GROK_SEARCH_API_KEY?.trim()) return true;
	const declaredProvider = resolveGrokProviderName();
	if (declaredProvider) {
		return authStorage.hasAuth(declaredProvider);
	}
	return authStorage.hasAuth(GROK_SEARCH_AUTH_PROVIDER);
}

/** Search provider for Grok hosted search through a declared relay endpoint. */
export class GrokProvider extends SearchProvider {
	readonly id = "grok";
	readonly label = "Grok";

	isAvailable(authStorage: AuthStorage, context?: SearchProviderAvailabilityContext): boolean {
		if (!resolveGrokBaseUrl()) return false;
		return hasGrokSearchCredential(authStorage, context?.modelRegistry);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const baseURL = resolveGrokBaseUrl();
		if (!baseURL) {
			return Promise.reject(
				new SearchProviderError(
					"grok",
					"Grok relay search is not configured. Set providers.webSearchGrokBaseUrl (or GROK_SEARCH_BASE_URL) to an OpenAI-Responses-compatible endpoint.",
				),
			);
		}
		const declaredProvider = resolveGrokProviderName();
		const transportHeaders = declaredProvider
			? params.modelRegistry?.getProviderHeaders?.(declaredProvider)
			: undefined;

		const keyOrResolver = resolveGrokSearchKey({
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			modelRegistry: params.modelRegistry,
		});

		return searchGrokResponses({
			query: params.query,
			parsedQuery: params.parsedQuery,
			systemPrompt: params.systemPrompt,
			limit: params.limit,
			numSearchResults: params.numSearchResults,
			maxOutputTokens: params.maxOutputTokens,
			temperature: params.temperature,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
			model: resolveGrokSearchModel(),
			reasoningEffort: GROK_WEB_SEARCH_REASONING_EFFORT,
			transport: { baseURL, headers: transportHeaders },
			keyOrResolver,
			providerId: "grok",
			missingKeyMessage: GROK_SEARCH_MISSING_KEY_HINT,
		});
	}
}
