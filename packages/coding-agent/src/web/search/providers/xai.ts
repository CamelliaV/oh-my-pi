import { type ApiKeyResolver, type AuthStorage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { resolveXAIHttpTransport, type XAIHttpProvider } from "../../../lib/xai-http";
import { SearchProviderError, type SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchGrokResponses, type GrokResponsesTransport } from "./grok-responses";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_WEB_SEARCH_MODEL = "grok-4.5";
// grok-4.5 defaults reasoning.effort to "high"; xAI documents "low" for
// latency-sensitive agentic use and simple tool calling
// (docs.x.ai/developers/model-capabilities/text/reasoning). Web search is
// latency-sensitive, so pin these calls low regardless of their configured timeout.
const XAI_WEB_SEARCH_REASONING_EFFORT = "low";

/**
 * Prefer `xai-oauth` only when its resolver cannot be shadowed by the shared
 * `XAI_API_KEY` fallback before reaching a lower-priority dedicated source.
 */
function shouldPreferXAIOAuth(authStorage: AuthStorage): boolean {
	if ($env.XAI_OAUTH_TOKEN) return true;

	const origin = authStorage.getCredentialOrigin("xai-oauth");
	if (!origin || origin.kind === "env") return false;
	if ((origin.kind === "api_key" || origin.kind === "fallback") && $env.XAI_API_KEY) return false;
	return true;
}

interface XAIWebSearchAuth {
	provider: XAIHttpProvider;
	keyOrResolver: ApiKeyResolver;
}

function resolveXAIWebSearchAuth(params: SearchParams): XAIWebSearchAuth {
	const xaiResolver = params.authStorage.resolver("xai", {
		sessionId: params.sessionId,
	});
	const xaiOAuthOrigin = params.authStorage.getCredentialOrigin("xai-oauth");
	if (!shouldPreferXAIOAuth(params.authStorage)) {
		return { provider: "xai", keyOrResolver: xaiResolver };
	}

	const xaiOAuthResolver = params.authStorage.resolver("xai-oauth", {
		sessionId: params.sessionId,
	});
	const keyOrResolver: ApiKeyResolver = async ctx => {
		const xaiOAuthKey = await xaiOAuthResolver(ctx);
		if (xaiOAuthKey) {
			const borrowedSharedEnvKey =
				xaiOAuthOrigin?.kind === "oauth" &&
				Boolean($env.XAI_API_KEY) &&
				xaiOAuthKey === $env.XAI_API_KEY &&
				xaiOAuthKey !== $env.XAI_OAUTH_TOKEN;
			if (!borrowedSharedEnvKey) return xaiOAuthKey;
		}
		return xaiResolver(ctx);
	};
	return { provider: "xai-oauth", keyOrResolver };
}

/** Execute xAI Responses API web search. */
export async function searchXAI(params: SearchParams): Promise<SearchResponse> {
	const auth = resolveXAIWebSearchAuth(params);
	const transport = params.modelRegistry
		? resolveXAIHttpTransport(params.modelRegistry, auth.provider, XAI_WEB_SEARCH_MODEL)
		: { baseURL: XAI_DEFAULT_BASE_URL };
	const customEndpoint = transport.baseURL.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL;
	const credentialOrigin = params.authStorage.getCredentialOrigin(auth.provider);
	if (
		customEndpoint &&
		auth.provider === "xai-oauth" &&
		(credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")
	) {
		throw new SearchProviderError(
			"xai",
			`Refusing to send official xAI OAuth credentials to custom endpoint ${transport.baseURL}. Configure an API key for provider "xai-oauth".`,
		);
	}
	const keyOrResolver = customEndpoint
		? params.authStorage.resolver(auth.provider, { sessionId: params.sessionId })
		: auth.keyOrResolver;

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
		model: XAI_WEB_SEARCH_MODEL,
		reasoningEffort: XAI_WEB_SEARCH_REASONING_EFFORT,
		transport: transport as GrokResponsesTransport,
		keyOrResolver,
		providerId: "xai",
		missingKeyMessage: 'xAI credentials not found. Set XAI_API_KEY or configure an API key for provider "xai".',
	});
}

/** Search provider for xAI web search. */
export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return shouldPreferXAIOAuth(authStorage) || authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
