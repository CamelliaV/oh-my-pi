/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../../modes/theme/theme";
import {
	formatAge,
	formatCount,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { renderStatusLine, renderTreeList, urlHyperlink } from "../../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../../tui/output-block";
import { formatSearchProviderFailureRecord, getSearchProviderLabel } from "./provider";
import { searchThroughput, type SearchProviderFailure, type SearchResponse } from "./types";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/**
 * Header meta for a search card: elapsed wall clock and answer throughput.
 *
 * A search is a one-shot call, so there is no prompt reuse to report — the
 * numbers that inform a decision are how long it took and how fast the answer
 * came back. Both are omitted rather than zero-filled when unmeasured.
 */
function searchMetaFragments(usage: SearchResponse["usage"], durationMs: number | undefined): string[] {
	const fragments: string[] = [];
	const throughput = searchThroughput(usage, durationMs);
	if (throughput) fragments.push(`${throughput.tokensPerSecond.toFixed(1)} tok/s`);
	if (durationMs !== undefined && Number.isFinite(durationMs)) fragments.push(formatDuration(durationMs));
	return fragments;
}

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const lines = contentText.split("\n").filter(line => line.trim());
	const maxLines = expanded ? lines.length : 6;
	const displayLines = lines.slice(0, maxLines).map(line => truncateToWidth(line.trim(), 110));
	const remaining = lines.length - displayLines.length;

	const headerIcon = formatStatusIcon("warning", theme);
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let text = `${headerIcon} ${theme.fg("dim", "Response")}${expandHint}`;

	if (displayLines.length === 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "No response data")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < displayLines.length; i++) {
		const isLast = i === displayLines.length - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", displayLines[i])}`;
	}

	if (!expanded && remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line"))}`;
	}

	return new Text(text, 0, 0);
}

export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
	/** Failed attempts retained from the provider chain. */
	providerFailures?: readonly SearchProviderFailure[];
	/** Wall-clock cost of the provider chain, in milliseconds. */
	durationMs?: number;
}

/** Render a web search failure as a framed error panel, matching the success layout. */
function renderSearchErrorPanel(
	message: string,
	providerLabel: string | undefined,
	theme: Theme,
	providerFailures: readonly SearchProviderFailure[] = [],
	durationMs?: number,
): Component {
	const timingMeta =
		durationMs !== undefined && Number.isFinite(durationMs) ? [formatDuration(durationMs)] : undefined;
	const header = renderStatusLine(
		{ icon: "error", title: "Web Search", description: providerLabel, meta: timingMeta },
		theme,
	);
	const body = theme.fg("error", `Error: ${truncateToWidth(replaceTabs(message), TRUNCATE_LENGTHS.LINE)}`);
	const failureLines = providerFailures.map(failure => {
		const attemptDuration =
			failure.durationMs !== undefined && Number.isFinite(failure.durationMs)
				? ` ${theme.fg("dim", `(${formatDuration(failure.durationMs)})`)}`
				: "";
		const text = truncateToWidth(replaceTabs(formatSearchProviderFailureRecord(failure)), TRUNCATE_LENGTHS.LINE);
		return `${theme.fg("warning", "Attempt:")} ${theme.fg("text", text)}${attemptDuration}`;
	});
	const outputBlock = new CachedOutputBlock();
	return markFramedBlockComponent({
		render(width: number): readonly string[] {
			return outputBlock.render(
				{ header, state: "error", sections: [{ lines: [body, ...failureLines] }], width },
				theme,
			);
		},
		invalidate() {
			outputBlock.invalidate();
		},
	});
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	// Handle error case as a framed panel, matching the success layout.
	if (details?.error) {
		const errorProvider = details.response?.provider;
		const errorProviderLabel =
			errorProvider && errorProvider !== "none" ? getSearchProviderLabel(errorProvider) : undefined;
		return renderSearchErrorPanel(
			details.error,
			errorProviderLabel,
			theme,
			details.providerFailures,
			details.durationMs,
		);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const response = details?.response;
	if (!response) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	// Get answer text
	const answerText = typeof response.answer === "string" ? response.answer.trim() : "";
	const contentText = answerText || rawText;

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const providerFailures = details?.providerFailures ?? [];
	const usedFallback = providerFailures.length > 0;
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;
	const success = sourceCount > 0;
	const timingMeta = searchMetaFragments(response.usage, details?.durationMs);
	const header = renderStatusLine(
		success
			? {
					iconOverride: usedFallback ? undefined : theme.styledSymbol("tool.webSearch", "accent"),
					icon: usedFallback ? "warning" : undefined,
					title: "Web Search",
					description: providerLabel,
					meta: [...(usedFallback ? ["fallback"] : []), formatCount("source", sourceCount), ...timingMeta],
				}
			: {
					icon: "warning",
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount), ...timingMeta],
				},
		theme,
	);
	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const metaLines: string[] = [`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerInfo)}`];
	if (providerFailures.length > 0) {
		const route = truncateToWidth(
			`${[...providerFailures.map(failure => failure.label), providerLabel].join(" → ")} (fallback)`,
			TRUNCATE_LENGTHS.LINE,
		);
		metaLines.push(`${theme.fg("warning", "Route:")} ${theme.fg("text", route)}`);
		for (const failure of providerFailures) {
			const attemptDuration =
				failure.durationMs !== undefined && Number.isFinite(failure.durationMs)
					? ` ${theme.fg("dim", `(${formatDuration(failure.durationMs)})`)}`
					: "";
			const text = truncateToWidth(replaceTabs(formatSearchProviderFailureRecord(failure)), TRUNCATE_LENGTHS.LINE);
			metaLines.push(`${theme.fg("warning", "Fallback:")} ${theme.fg("text", text)}${attemptDuration}`);
		}
	}
	const usage = response.usage;
	if (usage) {
		const usageParts: string[] = [];
		if (usage.inputTokens !== undefined) usageParts.push(`in ${usage.inputTokens}`);
		if (usage.outputTokens !== undefined) usageParts.push(`out ${usage.outputTokens}`);
		if (usage.totalTokens !== undefined) usageParts.push(`total ${usage.totalTokens}`);
		if (usage.searchRequests !== undefined) usageParts.push(`search ${usage.searchRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}
	const throughput = searchThroughput(usage, details?.durationMs);
	if (throughput) {
		metaLines.push(
			`${theme.fg("muted", "Throughput:")} ${theme.fg("text", `${throughput.tokensPerSecond.toFixed(1)} tok/s`)} ${theme.fg("dim", `(${throughput.outputTokens} tokens in ${formatDuration(throughput.durationMs)})`)}`,
		);
	}
	if (details?.durationMs !== undefined && Number.isFinite(details.durationMs)) {
		metaLines.push(`${theme.fg("muted", "Duration:")} ${theme.fg("text", formatDuration(details.durationMs))}`);
	}

	const answerMarkdown = contentText ? new Markdown(contentText, 0, 0, getMarkdownTheme()) : undefined;
	const outputBlock = new CachedOutputBlock();

	return markFramedBlockComponent({
		render(width: number): readonly string[] {
			// Read mutable state at render time
			const { expanded } = options;

			// Answer lines: full markdown when expanded, capped markdown preview when collapsed.
			const answerWidth = outputBlockContentWidth(width);
			const renderedAnswer = answerMarkdown ? answerMarkdown.render(answerWidth) : [];
			let answerLines: readonly string[];
			if (renderedAnswer.length === 0) {
				answerLines = [theme.fg("muted", "No answer text returned")];
			} else if (args?.maxAnswerLines !== undefined && !expanded) {
				// CLI compact mode (`omp q`) caps the answer; the TUI passes no cap and shows it in full.
				// `renderedAnswer` is the Markdown component's shared cache — slice copies before appending.
				const capped = renderedAnswer.slice(0, args.maxAnswerLines);
				const remaining = renderedAnswer.length - capped.length;
				if (remaining > 0) {
					capped.push(theme.fg("muted", formatMoreItems(remaining, "line")));
				}
				answerLines = capped;
			} else {
				answerLines = renderedAnswer;
			}

			const sourceTree = renderTreeList(
				{
					items: sources,
					expanded,
					maxCollapsed: MAX_COLLAPSED_ITEMS,
					itemType: "source",
					renderItem: src => {
						const titleText =
							typeof src.title === "string" && src.title.trim()
								? src.title
								: typeof src.url === "string" && src.url.trim()
									? src.url
									: "Untitled";
						const url = typeof src.url === "string" ? src.url : "";
						const domain = url ? getDomain(url) : "";
						const age =
							formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
						const metaParts: string[] = [];
						if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
						if (age) metaParts.push(theme.fg("muted", age));
						const metaSep = theme.fg("dim", theme.sep.dot);
						const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
						// One line per source: the title links to its URL, followed by domain · age.
						// Reserve room for the box borders, the tree branch, and the meta suffix.
						const lineBudget = Math.max(24, width - 6);
						const titleBudget = Math.max(12, lineBudget - Bun.stringWidth(metaSuffix));
						const title = theme.fg("accent", truncateToWidth(titleText, titleBudget));
						const linkedTitle = url ? urlHyperlink(url, title) : title;
						return [`${linkedTitle}${metaSuffix}`];
					},
				},
				theme,
			);

			return outputBlock.render(
				{
					header,
					state: sourceCount > 0 ? "success" : "warning",
					sections: [
						...(queryPreview
							? [
									{
										lines: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
									},
								]
							: []),
						{
							label: theme.fg("toolTitle", "Answer"),
							lines: answerLines,
						},
						{
							label: theme.fg("toolTitle", "Sources"),
							lines: sourceTree.length > 0 ? sourceTree : [theme.fg("muted", "No sources returned")],
						},
						{ label: theme.fg("toolTitle", "Metadata"), lines: metaLines },
					],
					width,
				},
				theme,
			);
		},
		invalidate() {
			outputBlock.invalidate();
		},
	});
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	mergeCallAndResult: true,
};
