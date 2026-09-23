/**
 * OpenAI Codex Web Search Provider
 *
 * Uses the configured Codex Responses transport for proxy/API-key setups and
 * the official ChatGPT backend for OAuth logins.
 */
import { type Api, type AuthStorage, type FetchImpl, type Model, withAuth, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { resolveCodexResponsesUrl } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { readSseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { RequestPacer } from "../utils";
import type { SearchParams, SearchProviderAvailabilityContext } from "./base";
import { SearchProvider } from "./base";
import { isCodexSearchAffinityModel } from "./codex-affinity";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

interface CodexSearchTransport {
	provider: string;
	baseUrl: string;
	url: string;
	headers: Record<string, string>;
	protocol: "codex" | "responses";
	authMode: "api-key" | "codex-oauth";
	rejectOfficialOAuth: boolean;
	searchDelayMs: number;
}

interface CodexSearchResult {
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Codex API response structure */
interface CodexWebSearchSource {
	url?: string;
	source_website_url?: string;
	title?: string;
	caption?: string;
}

interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
	action?: { sources?: CodexWebSearchSource[] };
	sources?: CodexWebSearchSource[];
	results?: CodexWebSearchSource[];
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

/**
 * Known Codex "image placeholder" answers — short prose the assistant emits in
 * place of a real answer when it produced a screenshot instead of text. These
 * carry no information, so callers treat them as non-answers and advance the
 * chain to a provider that returns text. Extend by adding the normalized
 * literal below; no regex tuning required.
 */
const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	// Strip surrounding brackets/quotes and trailing punctuation, lowercase,
	// then match against the known-placeholder set.
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") {
			url.searchParams.delete("utm_source");
		}
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/u, "");
	}
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	const normalizedSource = { ...source, url: cleanSourceUrl(source.url) };
	const existing = sources.find(candidate => candidate.url === normalizedSource.url);
	if (!existing) {
		sources.push(normalizedSource);
		return;
	}
	if (existing.title === existing.url && normalizedSource.title !== normalizedSource.url) {
		existing.title = normalizedSource.title;
	}
	if (!existing.snippet && normalizedSource.snippet) {
		existing.snippet = normalizedSource.snippet;
	}
}

function extractCitationSnippet(text: string, start: number | undefined, end: number | undefined): string | undefined {
	if (start === undefined || end === undefined || !text) return undefined;
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	if (!snippet) return undefined;
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Codex often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the Codex response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

async function resolveCodexSearchTransport(params: SearchParams): Promise<CodexSearchTransport> {
	const baseUrl = params.model.baseUrl;
	const url = resolveCodexResponsesUrl(baseUrl);
	const headers = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
	return {
		provider: "openai-codex",
		baseUrl,
		url,
		headers: { ...headers },
		protocol: "codex",
		authMode: customEndpoint ? "api-key" : "codex-oauth",
		rejectOfficialOAuth: customEndpoint,
		searchDelayMs: modelRegistry?.getProviderWebSearchDelayMs?.("openai-codex") ?? 0,
	};
}

/**
 * Builds HTTP headers for Codex API requests.
 */
function buildCodexHeaders(
	accessToken: string,
	accountId: string | undefined,
	configuredHeaders: Record<string, string>,
	protocol: CodexSearchTransport["protocol"],
): Headers {
	const headers = new Headers(configuredHeaders);
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (protocol === "codex") {
		if (accountId) {
			headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
		} else {
			headers.delete(OPENAI_HEADERS.ACCOUNT_ID);
		}
		headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
		headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		headers.set(OPENAI_HEADERS.VERSION, CODEX_CLIENT_VERSION);
	}
	applyCodexResidencyHeader(headers, accessToken);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, CODEX_CLIENT_VERSION);
	// Relay User-Agent whitelists: keep a provider-configured UA intact; only
	// stamp the default when none is present.
	if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	return headers;
}

/**
 * Extracts a backend error `{code, message}` from a Codex SSE event, tolerating
 * the envelope shapes the ChatGPT Codex backend emits: top-level `{code,message}`,
 * a nested `error` object, and a `response.error` object (as in `response.failed`).
 * Without this the nested shapes collapse to `Codex error (): Unknown error`,
 * discarding the backend diagnostic — e.g. a regional/model-snapshot rejection (#7200).
 */
function extractCodexSseError(rawEvent: unknown): { code: string; message: string } {
	const candidates: unknown[] = [rawEvent];
	if (rawEvent && typeof rawEvent === "object") {
		if ("error" in rawEvent) candidates.push(rawEvent.error);
		if ("response" in rawEvent && rawEvent.response && typeof rawEvent.response === "object") {
			if ("error" in rawEvent.response) candidates.push(rawEvent.response.error);
		}
	}

	let code = "";
	let message = "";
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		if (!code && "code" in candidate && typeof candidate.code === "string" && candidate.code) {
			code = candidate.code;
		}
		if (!message && "message" in candidate && typeof candidate.message === "string" && candidate.message) {
			message = candidate.message;
		}
	}
	return { code, message };
}

function classifyCodexSseErrorStatus(code: string, message: string): number {
	const detail = `${code} ${message}`.toLowerCase();
	if (/rate[- ]?limit|too many requests|quota|\b429\b/u.test(detail)) return 429;
	if (/unauthori[sz]ed|\b401\b/u.test(detail)) return 401;
	if (/forbidden|\b403\b/u.test(detail)) return 403;
	if (/timeout|timed out/u.test(detail)) return 504;
	return 500;
}

/**
 * Calls the Codex Responses API with web search enabled for the exact selected model.
 */
interface CodexSearchEventState {
	answerParts: string[];
	streamedAnswerParts: string[];
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
	webSearchInvoked: boolean;
}

function addCodexWebSearchSources(target: SearchSource[], value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const source of value) {
		if (!source || typeof source !== "object") continue;
		const primaryUrl = "url" in source && typeof source.url === "string" ? source.url : undefined;
		const fallbackUrl =
			"source_website_url" in source && typeof source.source_website_url === "string"
				? source.source_website_url
				: undefined;
		const url = primaryUrl ?? fallbackUrl;
		if (!url) continue;
		const title = "title" in source && typeof source.title === "string" ? source.title : undefined;
		const caption = "caption" in source && typeof source.caption === "string" ? source.caption : undefined;
		addSource(target, { title: title ?? caption ?? url, url });
	}
}

function processCodexSearchEvent(state: CodexSearchEventState, rawEvent: unknown): void {
	if (!rawEvent || typeof rawEvent !== "object" || !("type" in rawEvent) || typeof rawEvent.type !== "string") {
		return;
	}
	const eventType = rawEvent.type;
	if (eventType.startsWith("response.web_search_call")) state.webSearchInvoked = true;

	if (eventType === "response.created") {
		if (!("response" in rawEvent) || !rawEvent.response || typeof rawEvent.response !== "object") return;
		const response = rawEvent.response;
		if ("id" in response && typeof response.id === "string") state.requestId = response.id;
		if ("model" in response && typeof response.model === "string") state.model = response.model;
		return;
	}

	if (eventType === "response.output_text.delta") {
		if ("delta" in rawEvent && typeof rawEvent.delta === "string" && rawEvent.delta) {
			state.streamedAnswerParts.push(rawEvent.delta);
		}
		return;
	}

	if (eventType === "response.output_item.done") {
		if (!("item" in rawEvent) || !rawEvent.item || typeof rawEvent.item !== "object") return;
		const item = rawEvent.item;
		if (!("type" in item) || typeof item.type !== "string") return;

		if (item.type === "web_search_call") {
			state.webSearchInvoked = true;
			if ("action" in item && item.action && typeof item.action === "object" && "sources" in item.action) {
				addCodexWebSearchSources(state.sources, item.action.sources);
			}
			if ("sources" in item) addCodexWebSearchSources(state.sources, item.sources);
			if ("results" in item) addCodexWebSearchSources(state.sources, item.results);
		}

		if (item.type === "message" && "content" in item && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (!part || typeof part !== "object") continue;
				if (!("type" in part) || part.type !== "output_text") continue;
				if (!("text" in part) || typeof part.text !== "string" || !part.text) continue;
				state.answerParts.push(part.text);
				if (!("annotations" in part) || !Array.isArray(part.annotations)) continue;
				for (const annotation of part.annotations) {
					if (!annotation || typeof annotation !== "object") continue;
					if (!("type" in annotation) || annotation.type !== "url_citation") continue;
					if (!("url" in annotation) || typeof annotation.url !== "string" || !annotation.url) continue;
					const title =
						"title" in annotation && typeof annotation.title === "string" ? annotation.title : annotation.url;
					const startIndex =
						"start_index" in annotation && typeof annotation.start_index === "number"
							? annotation.start_index
							: undefined;
					const endIndex =
						"end_index" in annotation && typeof annotation.end_index === "number"
							? annotation.end_index
							: undefined;
					addSource(state.sources, {
						title,
						url: annotation.url,
						snippet: extractCitationSnippet(part.text, startIndex, endIndex),
					});
				}
			}
		}

		if (item.type === "reasoning" && "summary" in item && Array.isArray(item.summary)) {
			for (const part of item.summary) {
				if (!part || typeof part !== "object") continue;
				if (!("type" in part) || part.type !== "summary_text") continue;
				if ("text" in part && typeof part.text === "string" && part.text) state.answerParts.push(part.text);
			}
		}
		return;
	}

	if (eventType === "response.completed" || eventType === "response.done") {
		if (!("response" in rawEvent) || !rawEvent.response || typeof rawEvent.response !== "object") return;
		const response = rawEvent.response;
		if ("model" in response && typeof response.model === "string") state.model = response.model;
		if ("id" in response && typeof response.id === "string") state.requestId = response.id;
		if ("usage" in response && response.usage && typeof response.usage === "object") {
			const usage = response.usage;
			const inputTokens = "input_tokens" in usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
			const outputTokens =
				"output_tokens" in usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
			const totalTokens = "total_tokens" in usage && typeof usage.total_tokens === "number" ? usage.total_tokens : 0;
			let cachedTokens = 0;
			if (
				"input_tokens_details" in usage &&
				usage.input_tokens_details &&
				typeof usage.input_tokens_details === "object" &&
				"cached_tokens" in usage.input_tokens_details &&
				typeof usage.input_tokens_details.cached_tokens === "number"
			) {
				cachedTokens = usage.input_tokens_details.cached_tokens;
			}
			state.usage = {
				inputTokens: inputTokens - cachedTokens,
				outputTokens,
				totalTokens,
			};
		}
		return;
	}

	if (eventType === "error") {
		const { code, message } = extractCodexSseError(rawEvent);
		throw new SearchProviderError(
			"codex",
			`Codex error (${code}): ${message || "Unknown error"}`,
			classifyCodexSseErrorStatus(code, message),
		);
	}

	if (eventType === "response.failed") {
		const { code, message } = extractCodexSseError(rawEvent);
		const detail = code
			? `Codex request failed (${code}): ${message || "Request failed"}`
			: `Codex request failed: ${message || "Request failed"}`;
		throw new SearchProviderError("codex", detail, classifyCodexSseErrorStatus(code, message));
	}
}

function finalizeCodexSearchEventState(state: CodexSearchEventState): CodexSearchResult {
	if (!state.webSearchInvoked) {
		throw new CodexNoWebSearchError();
	}
	const finalAnswer = state.answerParts.join("\n\n").trim();
	const streamedAnswer = state.streamedAnswerParts.join("").trim();
	const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
	const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
	const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
	const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
	if (!hasFinalText && !hasStreamedText && state.sources.length === 0) {
		throw new SearchProviderError("codex", "Codex returned image-only response", 502);
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";
	if (state.sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(state.sources, source);
		}
	}
	return {
		answer,
		sources: state.sources,
		model: state.model,
		requestId: state.requestId,
		usage: state.usage,
	};
}

function parseObservedCodexSseEvent(event: RawSseEvent): unknown {
	if (!event.data || event.data === "[DONE]") return undefined;
	try {
		return JSON.parse(event.data) as unknown;
	} catch {
		return undefined;
	}
}

async function callCodexSearch(
	auth: { accessToken: string; accountId?: string },
	query: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		modelId: string;
		fetch?: FetchImpl;
		transport: CodexSearchTransport;
	},
): Promise<CodexSearchResult> {
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId, options.transport.headers);

	const requestedModel = options.modelId;

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		include: ["web_search_call.action.sources"],
		parallel_tool_calls: true,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(options.transport.url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal, options.timeoutMs),
	});
	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("codex", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
	}
	if (!response.body) {
		throw new SearchProviderError("codex", "Codex API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = requestedModel;
	let requestId = "";
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
	// A search command must reject a completion that did not invoke the hosted
	// tool rather than returning an answer from the model's own knowledge (#6988).
	let webSearchInvoked = false;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType.startsWith("response.web_search_call")) {
			webSearchInvoked = true;
		}

		if (eventType === "response.created") {
			const resp = (rawEvent as { response?: CodexResponse }).response;
			if (resp?.id) requestId = resp.id;
			if (resp?.model) model = resp.model;
		} else if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) {
				streamedAnswerParts.push(delta);
			}
		} else if (eventType === "response.output_item.done") {
			const item = rawEvent.item as CodexResponseItem | undefined;
			if (!item) continue;
			if (item.type === "web_search_call") {
				webSearchInvoked = true;
				const sourceGroups = [item.action?.sources, item.sources, item.results];
				for (const group of sourceGroups) {
					for (const source of group ?? []) {
						const url = source.url ?? source.source_website_url;
						if (!url) continue;
						addSource(sources, {
							title: source.title ?? source.caption ?? url,
							url,
						});
					}
				}
			}

			// Handle text message content and extract sources from annotations
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);

						// Extract sources from url_citation annotations
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									addSource(sources, {
										title: annotation.title ?? annotation.url,
										url: annotation.url,
										snippet: extractCitationSnippet(part.text, annotation.start_index, annotation.end_index),
									});
								}
							}
						}
					}
				}
			}

			// Handle reasoning summary as part of answer
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) {
						answerParts.push(part.text);
					}
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = (rawEvent as { response?: CodexResponse }).response;
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const { code, message } = extractCodexSseError(rawEvent);
			throw new SearchProviderError(
				"codex",
				`Codex error (${code}): ${message || "Unknown error"}`,
				classifyCodexSseErrorStatus(code, message),
			);
		} else if (eventType === "response.failed") {
			const { code, message } = extractCodexSseError(rawEvent);
			const detail = code
				? `Codex request failed (${code}): ${message || "Request failed"}`
				: `Codex request failed: ${message || "Request failed"}`;
			throw new SearchProviderError("codex", detail, classifyCodexSseErrorStatus(code, message));
		}
	}

	if (!webSearchInvoked) {
		throw new SearchProviderError(
			"codex",
			"Codex returned a completion without running web search (no web_search_call event); refusing to treat a non-search answer as a search result",
			502,
		);
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	// Throw to advance the chain whenever Codex emitted nothing but image
	// placeholder prose — including the case where the streamed delta itself
	// is the placeholder (the model occasionally streams the same text it
	// publishes as the final output_text).
	const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
	const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
	const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
	const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
	if (!hasFinalText && !hasStreamedText && sources.length === 0) {
		throw new SearchProviderError("codex", "Codex returned image-only response", 502);
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";

	// Fallback: when Codex omits url_citation annotations, scrape markdown links
	// and bare URLs from the synthesized answer so callers still receive sources.
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(sources, source);
		}
	}

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		processCodexSearchEvent(state, rawEvent);
	}
	return finalizeCodexSearchEventState(state);
}

/**
 * Run hosted search through the canonical Codex request context used by normal
 * turns. API-key relays depend on its client metadata and compatibility headers;
 * Responses Lite cannot force a hosted tool after moving tools into input.
 */
async function callCodexSearchWithProviderTransport(
	accessToken: string,
	query: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexSearchModel;
		fetch?: FetchImpl;
		headers: Record<string, string>;
		sessionId?: string;
		provider: string;
		searchDelayMs: number;
	},
): Promise<CodexSearchResult> {
	await codexSearchPacer.wait(options.provider, options.searchDelayMs, options.signal);
	const requestedModel = options.model.requestModelId ?? options.model.id;
	const state: CodexSearchEventState = {
		answerParts: [],
		streamedAnswerParts: [],
		sources: [],
		model: requestedModel,
		requestId: "",
		webSearchInvoked: false,
	};
	const requestSignal = withHardTimeout(options.signal, options.timeoutMs);
	let observedError: unknown;
	const response = await streamOpenAICodexResponses(
		options.model,
		{
			systemPrompt: [options.systemPrompt ?? DEFAULT_INSTRUCTIONS],
			messages: [{ role: "user", content: query, timestamp: Date.now() }],
		},
		{
			apiKey: accessToken,
			headers: options.headers,
			sessionId: options.sessionId,
			signal: requestSignal,
			fetch: options.fetch,
			preferWebsockets: false,
			responsesLite: false,
			onPayload(payload) {
				if (!payload || typeof payload !== "object") return payload;
				// The shared payload hook is `unknown`; this callback receives the provider's request body.
				const requestBody = payload as Record<string, unknown>;
				const body = { ...requestBody };
				const include = Array.isArray(body.include)
					? body.include.filter((value): value is string => typeof value === "string")
					: [];
				if (!include.includes("web_search_call.action.sources")) {
					include.push("web_search_call.action.sources");
				}
				body.include = include;
				body.parallel_tool_calls = true;
				body.tools = [
					{
						type: "web_search",
						search_context_size: options.searchContextSize ?? "high",
					},
				];
				body.tool_choice = { type: "web_search" };
				return body;
			},
			onSseEvent(event) {
				const rawEvent = parseObservedCodexSseEvent(event);
				if (!rawEvent) return;
				try {
					processCodexSearchEvent(state, rawEvent);
				} catch (error) {
					observedError = error;
				}
			},
		},
	).result();

	if (requestSignal.aborted) {
		const reason = requestSignal.reason;
		if (reason instanceof Error) throw reason;
		throw new DOMException("Codex web search aborted", "AbortError");
	}
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		if (observedError) throw observedError;
		throw new SearchProviderError(
			"codex",
			response.errorMessage ?? `Codex web search ended with stop reason ${response.stopReason}`,
		);
	}
	return finalizeCodexSearchEventState(state);
}

/** Execute web search through the selected Codex model and transport. */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const transport = await resolveCodexSearchTransport(params);
	// The ChatGPT-backend Codex endpoint speaks the undocumented codex-rs
	// request shape (responses-lite moves tools into an `additional_tools`
	// developer item), so the documented `web_search.filters.allowed_domains`
	// parameter cannot be assumed to survive it. Instead, re-emit directive
	// queries with the full Google-style operator syntax — the backing index
	// parses the classic operator set — and leave directive-free queries
	// byte-identical.
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;
	const modelSelectionWasExplicit = activeModel !== undefined || configuredModel !== undefined;

	let result: CodexSearchResult;
	if (transport.customEndpoint) {
		// The registry resolver and provenance guard must consult the same storage;
		// params.authStorage may be a divergent caller handle. Command-backed keys
		// still outrank lower-priority OAuth credentials in the registry storage.
		const credentialOrigin = params.modelRegistry.authStorage.getCredentialOrigin?.(params.model.provider);
		const hasCommandBackedKey = params.modelRegistry.hasCommandBackedApiKey?.(params.model.provider) === true;
		if (!hasCommandBackedKey && (credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")) {
			throw new SearchProviderError(
				"codex",
				`Refusing to send official Codex OAuth credentials to custom endpoint ${transport.baseUrl}. Configure an API key for provider "${params.model.provider}".`,
			);
		}

		const keyOrResolver = params.modelRegistry.resolver(params.model, params.sessionId);
		result = await withAuth(
			keyOrResolver,
			async accessToken => {
				const requestTransport = await resolveCodexSearchTransport(params);
				return callCodexSearch({ accessToken }, query, {
					signal: params.signal,
					timeoutMs: params.timeoutMs,
					systemPrompt: params.systemPrompt,
					searchContextSize: "high",
					modelId: params.model.id,
					fetch: params.fetch,
					transport: requestTransport,
				});
			},
			{
				signal: params.signal,
				missingKeyMessage: `Codex credentials not found for selected provider "${params.model.provider}".`,
			},
		);
	} else {
		const seed = await params.authStorage.getOAuthAccess(params.model.provider, params.sessionId, {
			signal: params.signal,
		});
		if (!seed) {
			throw new Error(`No Codex OAuth credentials found for selected provider "${params.model.provider}".`);
		}

		result = await withOAuthAccess(
			params.authStorage,
			params.model.provider,
			async access => {
				// A refreshed/rotated credential can carry a different bearer and
				// ChatGPT account id than the seed used to select the first attempt.
				const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
				const requestTransport = await resolveCodexSearchTransport(params);
				return callCodexSearch({ accessToken: access.accessToken, accountId }, query, {
					signal: params.signal,
					timeoutMs: params.timeoutMs,
					systemPrompt: params.systemPrompt,
					searchContextSize: "high",
					modelId: params.model.id,
					fetch: params.fetch,
					transport: requestTransport,
				});
			},
			{ sessionId: params.sessionId, signal: params.signal, seed },
		);
	}

	let sources = result.sources;

	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && sources.length > numResults) {
		sources = sources.slice(0, numResults);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks whether Codex web search has an API key or OAuth credential.
 */
export async function hasCodexSearch(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> {
	return authStorage.hasAuth(model?.provider ?? "openai-codex");
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage, model);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
