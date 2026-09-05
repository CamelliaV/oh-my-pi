/**
 * Shared Grok Responses web-search core.
 *
 * Both search channels that speak the xAI Responses `web_search` tool share
 * this module: the official `xai` channel (api.x.ai credentials, xai-oauth
 * OR plain API key) and the relay-agnostic `grok` channel (custom
 * OpenAI-Responses endpoint + API key, e.g. a wong-style relay fronting
 * grok-4.3). The wire shape, parsing, and domain-filter mapping are
 * identical; only credential/transport resolution differs per channel.
 *
 * Real-search gate: upstreams may accept the tool schema but silently
 * flatten it (wong relay with grok-4.5: `num_server_side_tools_used=0`,
 * answer *claims* a search happened). Parsing rejects that shape as a 502
 * so the provider chain advances instead of surfacing hallucinated
 * citations.
 */
import { type ApiKey, type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import type {
	SearchCitation,
	SearchProviderId,
	SearchResponse,
	SearchSource,
	SearchUsage,
} from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;

interface GrokUrlCitationAnnotation {
	type?: string;
	url?: string | null;
	title?: string | null;
	text?: string | null;
	cited_text?: string | null;
	start_index?: number | null;
	end_index?: number | null;
}

interface GrokResponseContentPart {
	type?: string;
	text?: string | null;
	output_text?: string | null;
	annotations?: GrokUrlCitationAnnotation[] | null;
}

interface GrokWebSearchSource {
	url?: string | null;
	source_website_url?: string | null;
	title?: string | null;
	caption?: string | null;
}

interface GrokResponseOutputItem {
	type?: string;
	content?: GrokResponseContentPart[] | null;
	annotations?: GrokUrlCitationAnnotation[] | null;
	action?: { sources?: GrokWebSearchSource[] | null } | null;
	sources?: GrokWebSearchSource[] | null;
	results?: GrokWebSearchSource[] | null;
}

interface GrokResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface GrokResponsesResponse {
	id?: string;
	model?: string;
	output_text?: string | null;
	output?: GrokResponseOutputItem[] | null;
	annotations?: GrokUrlCitationAnnotation[] | null;
	citations?: string[] | null;
	usage?: GrokResponsesUsage & {
		num_server_side_tools_used?: number | null;
	};
}

/**
 * Query syntax re-emitted for the Grok search agent. `site:`/`-site:` are
 * stripped because hosts map natively onto the web_search domain filters;
 * `before:`/`after:` stay in the query text — the Responses web_search tool
 * has no date parameters (`from_date`/`to_date` exist only on `x_search` and
 * the deprecated Live Search `search_parameters`, which now returns 410) and
 * the agent honors the tokens as natural-language hints.
 */
const GROK_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
	dateRange: true,
};

/** Grok web_search accepts at most 5 allowed or excluded domains per request. */
const MAX_DOMAIN_FILTERS = 5;

/** Bare hosts of `site:` values (`github.com/anthropics` → `github.com`), deduped, capped at 5; path parts are enforced by the central constraint filter. */
function domainFilterList(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const slash = site.indexOf("/");
		hosts.add(slash === -1 ? site : site.slice(0, slash));
		if (hosts.size === MAX_DOMAIN_FILTERS) break;
	}
	return [...hosts];
}

/** Transport for a Grok Responses web-search call. */
export interface GrokResponsesTransport {
	/** POST target base (no trailing path): `${baseURL}/responses` is fetched. */
	baseURL: string;
	/** Extra headers (User-Agent overrides, tenant ids) merged after auth. */
	headers?: Record<string, string>;
}

/** Channel inputs for a shared-core search execution. */
export interface GrokResponsesSearchParams {
	query: string;
	parsedQuery?: StructuredQuery;
	systemPrompt: string;
	limit?: number;
	numSearchResults?: number;
	maxOutputTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: SearchParams["fetch"];
	/** Wire model id, e.g. `grok-4.3`. */
	model: string;
	/** `reasoning.effort` value, or `undefined` to omit the field entirely (upstream default). */
	reasoningEffort?: string;
	transport: GrokResponsesTransport;
	/** Credential: plain key string or AuthStorage-backed resolver. */
	keyOrResolver: ApiKey;
	/** Provider id used for error tagging and availability messages. */
	providerId: SearchProviderId;
	/** Bearer key for the transport (already resolved when `keyOrResolver` is a string). */
	apiKey?: string;
	/** Message shown by withAuth when no credential resolves. */
	missingKeyMessage: string;
}

export function buildGrokResponsesBody(params: GrokResponsesSearchParams): Record<string, unknown> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const webSearchTool: Record<string, unknown> = { type: "web_search" };
	let query = params.query;
	if (parsed.hasDirectives) {
		query = formatQuery(parsed, GROK_QUERY_SYNTAX);
		// allowed_domains and excluded_domains are mutually exclusive per
		// request; prefer the allow list, the central filter enforces exclusions.
		if (parsed.sites.length > 0) {
			webSearchTool.filters = { allowed_domains: domainFilterList(parsed.sites) };
		} else if (parsed.excludedSites.length > 0) {
			webSearchTool.filters = { excluded_domains: domainFilterList(parsed.excludedSites) };
		}
	}

	const body: Record<string, unknown> = {
		model: params.model,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: query },
		],
		tools: [webSearchTool],
	};

	// The official Grok reasoning docs mark effort as optional; the omitted
	// default is model-specific (grok-4.3 ≈ high). Channels pin their own value.
	if (params.reasoningEffort !== undefined) {
		body.reasoning = { effort: params.reasoningEffort };
	}

	if (params.maxOutputTokens !== undefined) {
		body.max_output_tokens = params.maxOutputTokens;
	}
	if (params.temperature !== undefined) {
		body.temperature = params.temperature;
	}

	return body;
}

async function postGrokResponses(
	apiKey: string,
	params: GrokResponsesSearchParams,
	body: Record<string, unknown>,
): Promise<Response> {
	return (params.fetch ?? fetch)(`${params.transport.baseURL.replace(/\/+$/, "")}/responses`, {
		method: "POST",
		headers: {
			...params.transport.headers,
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
}

function throwGrokResponsesError(provider: SearchProviderId, status: number, errorText: string): never {
	const classified = classifyProviderHttpError(provider, status, errorText);
	if (classified) throw classified;
	const providerLabel = provider === "xai" ? "xAI" : "Grok";
	throw new SearchProviderError(provider, `${providerLabel} Responses API error (${status}): ${errorText}`, status);
}

async function callGrokResponses(apiKey: string, params: GrokResponsesSearchParams): Promise<GrokResponsesResponse> {
	const requestBody = buildGrokResponsesBody(params);
	const response = await postGrokResponses(apiKey, params, requestBody);

	if (!response.ok) {
		throwGrokResponsesError(params.providerId, response.status, await response.text());
	}

	try {
		return (await response.json()) as GrokResponsesResponse;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError(
			params.providerId,
			`Grok Responses API returned invalid JSON: ${message}`,
			response.status,
		);
	}
}

function addCitationSource(
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
	url: string,
	title?: string | null,
	citedText?: string | null,
): void {
	const trimmedUrl = url.trim();
	if (!trimmedUrl || seenUrls.has(trimmedUrl)) return;
	seenUrls.add(trimmedUrl);
	const sourceTitle = title?.trim() || trimmedUrl;
	const sourceSnippet = citedText?.trim() || undefined;

	sources.push({
		title: sourceTitle,
		url: trimmedUrl,
		snippet: sourceSnippet,
	});
	citations.push({
		title: sourceTitle,
		url: trimmedUrl,
		citedText: sourceSnippet,
	});
}

function extractSnippetAround(
	text: string | null | undefined,
	start: number | null | undefined,
	end: number | null | undefined,
): string | undefined {
	if (!text || typeof start !== "number" || typeof end !== "number") return undefined;
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	if (!snippet) return undefined;
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function collectAnnotationSources(
	annotations: readonly GrokUrlCitationAnnotation[] | null | undefined,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
	contentText?: string | null,
): void {
	if (!Array.isArray(annotations)) return;
	for (const annotation of annotations) {
		if (!annotation || typeof annotation !== "object") continue;
		if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
		addCitationSource(
			sources,
			citations,
			seenUrls,
			annotation.url,
			annotation.title,
			annotation.cited_text ??
				annotation.text ??
				extractSnippetAround(contentText, annotation.start_index, annotation.end_index),
		);
	}
}

function collectWebSearchSources(
	item: GrokResponseOutputItem,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
): void {
	if (item.type !== "web_search_call") return;
	for (const group of [item.action?.sources, item.sources, item.results]) {
		if (!Array.isArray(group)) continue;
		for (const source of group) {
			if (!source || typeof source !== "object") continue;
			const url = source.url ?? source.source_website_url;
			if (typeof url !== "string") continue;
			addCitationSource(sources, citations, seenUrls, url, source.title ?? source.caption);
		}
	}
}

function parseAnswer(response: GrokResponsesResponse): string | undefined {
	const topLevelText = response.output_text?.trim();
	if (topLevelText) return topLevelText;

	const answerParts: string[] = [];
	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = part.output_text ?? part.text;
			if (text?.trim()) answerParts.push(text.trim());
		}
	}

	const answer = answerParts.join("\n").trim();
	return answer ? answer : undefined;
}

function parseUsage(usage: GrokResponsesUsage | null | undefined): SearchUsage | undefined {
	if (!usage) return undefined;
	const parsed: SearchUsage = {};
	const inputTokens = usage.input_tokens ?? usage.inputTokens;
	const outputTokens = usage.output_tokens ?? usage.outputTokens;
	const totalTokens = usage.total_tokens ?? usage.totalTokens;

	if (typeof inputTokens === "number") parsed.inputTokens = inputTokens;
	if (typeof outputTokens === "number") parsed.outputTokens = outputTokens;
	if (typeof totalTokens === "number") parsed.totalTokens = totalTokens;

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function applyResultCap(
	sources: SearchSource[],
	citations: SearchCitation[],
	resultCap: number,
): { sources: SearchSource[]; citations: SearchCitation[] } {
	return {
		sources: sources.slice(0, resultCap),
		citations: citations.slice(0, resultCap),
	};
}

function parseGrokResponses(
	response: GrokResponsesResponse,
	resultCap: number,
	providerId: SearchProviderId,
): SearchResponse {
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const seenUrls = new Set<string>();

	collectAnnotationSources(response.annotations, sources, citations, seenUrls);
	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		collectAnnotationSources(item.annotations, sources, citations, seenUrls);
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			collectAnnotationSources(part.annotations, sources, citations, seenUrls, part.output_text ?? part.text);
		}
	}
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		collectWebSearchSources(item, sources, citations, seenUrls);
	}
	const topLevelCitations = Array.isArray(response.citations) ? response.citations : [];
	for (const url of topLevelCitations) {
		if (typeof url !== "string") continue;
		addCitationSource(sources, citations, seenUrls, url);
	}
	const limited = applyResultCap(sources, citations, resultCap);

	return {
		provider: providerId,
		answer: parseAnswer(response),
		sources: limited.sources,
		citations: limited.citations.length > 0 ? limited.citations : undefined,
		usage: parseUsage(response.usage),
		model: response.model,
		requestId: response.id,
		authMode: "api_key",
	};
}

/**
 * Execute one Grok Responses web search through the shared core.
 *
 * Runs the real-search gate after parsing: a completed response whose
 * `usage.num_server_side_tools_used` is present and zero, or that carries
 * neither `web_search_call` output items nor top-level `citations`, is
 * rejected as a flattened/fabricated search so the chain advances.
 */
export async function searchGrokResponses(params: GrokResponsesSearchParams): Promise<SearchResponse> {
	const resultCap = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const credential: ApiKey = params.keyOrResolver;
	const response = await withAuth(credential, (key: string) => callGrokResponses(key, params), {
		signal: params.signal,
		missingKeyMessage: params.missingKeyMessage,
	});
	const parsed = parseGrokResponses(response, resultCap, params.providerId);

	// Real-search gate. `usage.num_server_side_tools_used` is authoritative
	// upstream telemetry: present-and-zero is definitive flattening (wong relay
	// + grok-4.5/4.6 emit exactly this while the answer *claims* a search
	// happened), present-and-positive is definitive execution. When usage omits
	// the counter, fall back to structural evidence: `web_search_call` output
	// items, a top-level `citations` array, or URL citation annotations
	// (official api.x.ai shapes may carry only annotations). A response with
	// neither signal is treated as never-executed so the chain advances instead
	// of surfacing ungrounded text.
	const serverToolsUsed = response.usage?.num_server_side_tools_used;
	const hasSearchCalls = Array.isArray(response.output) && response.output.some(i => i?.type === "web_search_call");
	const hasTopLevelCitations = Array.isArray(response.citations) && response.citations.length > 0;
	const hasCitationAnnotations = parsed.citations !== undefined && parsed.citations.length > 0;
	const searchExecuted =
		(typeof serverToolsUsed === "number" && serverToolsUsed > 0) ||
		(serverToolsUsed !== 0 && (hasSearchCalls || hasTopLevelCitations || hasCitationAnnotations));
	if (!searchExecuted) {
		throw new SearchProviderError(
			params.providerId,
			`Grok web_search was not executed upstream (num_server_side_tools_used=${serverToolsUsed ?? "absent"}, no search calls, citations, or annotations); the endpoint or model flattens the tool — answer text would be ungrounded.`,
			502,
		);
	}

	if (!parsed.answer && parsed.sources.length === 0) {
		const providerLabel = params.providerId === "xai" ? "xAI" : "Grok";
		throw new SearchProviderError(params.providerId, `${providerLabel} web_search returned no answer or sources`, 502);
	}
	return parsed;
}

/** Reusable auth-storage credential accessor for shared-core channels. */
export function grokAuthStorageKey(authStorage: AuthStorage, provider: string, sessionId: string | undefined): ApiKey {
	return authStorage.resolver(provider, { sessionId });
}
