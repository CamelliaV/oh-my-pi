import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { renderSearchResult, type SearchRenderDetails } from "@oh-my-pi/pi-tui/tools/web-search";
import type { SearchResponse } from "@oh-my-pi/pi-tui/tools/web-search";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const ANSWER = [
	"## Overview Heading",
	"This is the **first** paragraph with bold text.",
	"",
	"Para two line here.",
	"Para three line here.",
	"Para four line here.",
	"Para five line here.",
	"Para six line here.",
	"Para seven line here.",
	"Para eight line here.",
	"The FINAL_UNIQUE_MARKER paragraph at the very end.",
].join("\n");

function buildResult(answer: string): {
	content: Array<{ type: string; text?: string }>;
	details: SearchRenderDetails;
} {
	const response: SearchResponse = {
		provider: "perplexity",
		answer,
		sources: [
			{ title: "Src One", url: "https://example.com/a", snippet: "snip a" },
			{ title: "Src Two", url: "https://example.com/b", snippet: "snip b" },
		],
	};
	return { content: [{ type: "text", text: answer }], details: { response } };
}

function renderPlain(result: ReturnType<typeof buildResult>, theme: Theme, args?: { query?: string }): string {
	return renderSearchResult(result, { expanded: true, isPartial: false }, theme, args)
		.render(120)
		.map(line => sanitizeText(line))
		.join("\n");
}

/** Slice the sanitized lines belonging to the framed "Answer" section. */
function answerSection(lines: string[]): string {
	const start = lines.findIndex(l => / Answer /.test(l));
	const end = lines.findIndex((l, i) => i > start && / Sources /.test(l));
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

describe("renderSearchResult", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the answer as markdown (strips ## and ** markers)", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// Heading hashes and bold asterisks are consumed by the markdown renderer.
		expect(answer).not.toContain("##");
		expect(answer).not.toContain("**");
		// The text content survives.
		expect(answer.toLowerCase()).toContain("overview heading");
		expect(answer).toContain("first");
	});

	it("shows the fallback route and provider failure cause", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = buildResult("Fallback answer");
		result.details.providerFailures = [
			{
				provider: "codex",
				label: "OpenAI",
				message: "Codex web search rate limited.",
				status: 429,
			},
		];
		const component = renderSearchResult(result, { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const rendered = component
			.render(120)
			.map(line => sanitizeText(line))
			.join("\n");

		expect(rendered).toContain("fallback");
		expect(rendered).toContain("Route: OpenAI → Perplexity (fallback)");
		expect(rendered).toContain("Fallback: OpenAI: Codex web search rate limited. (HTTP 429)");
	});

	it("shows the full answer when expanded — no answer truncation summary", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// The final paragraph is present and there is no "… N more lines" cap inside the Answer section.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("shows the full answer when collapsed by default", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// TUI collapsed view keeps the answer intact; only explicit compact mode caps it.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("truncates the answer only when compact mode provides maxAnswerLines", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
			maxAnswerLines: 3,
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));

		expect(answer).toMatch(/more line/);
		expect(answer).not.toContain("FINAL_UNIQUE_MARKER");
	});

	it("reports answer throughput and elapsed time in the header meta and Metadata section", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = buildResult("Fast answer");
		result.details.response.usage = { inputTokens: 900, outputTokens: 420 };
		result.details.durationMs = 4200;

		const rendered = renderPlain(result, uiTheme, { query: "throughput" });

		// 420 tokens / 4.2s = 100 tok/s; the header carries the compact pair.
		expect(rendered).toContain("100.0 tok/s");
		expect(rendered).toContain("4.2s");
		expect(rendered).toContain("Throughput: 100.0 tok/s (420 tokens in 4.2s)");
		expect(rendered).toContain("Duration: 4.2s");
	});

	it("omits throughput for a provider that reports no output tokens", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = buildResult("Scraped answer");
		// Credential-free scrapes report no usage at all — only the searchRequests
		// style counters are absent too, so nothing is derivable.
		result.details.response.usage = { inputTokens: 0 };
		result.details.durationMs = 52_600;

		const rendered = renderPlain(result, uiTheme, { query: "scrape" });

		expect(rendered).not.toContain("Throughput:");
		expect(rendered).not.toContain("tok/s");
		// The wall clock is still a measured fact and still renders.
		expect(rendered).toContain("52.6s");
	});

	it("omits throughput rather than reporting a rate from a sub-100ms call", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = buildResult("Instant answer");
		result.details.response.usage = { outputTokens: 5 };
		// Below the timing floor: the quotient would be clock noise, not a rate.
		result.details.durationMs = 12;

		const rendered = renderPlain(result, uiTheme, { query: "instant" });

		expect(rendered).not.toContain("Throughput:");
		expect(rendered).toContain("Duration: 12ms");
	});

	it("times a failed attempt on the error panel and omits the elapsed row when unmeasured", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = buildResult("unused");
		result.details.response = { provider: "perplexity", sources: [] };
		result.details.error = "All web search providers failed";
		result.details.durationMs = 9000;
		result.details.providerFailures = [
			{
				provider: "codex",
				label: "OpenAI",
				message: "Codex web search rate limited.",
				status: 429,
				durationMs: 2500,
			},
		];

		const rendered = renderPlain(result, uiTheme);

		expect(rendered).toContain("Web Search: Perplexity 9.0s");
		expect(rendered).toContain("Attempt: OpenAI: Codex web search rate limited. (HTTP 429) (2.5s)");

		const legacy = buildResult("unused");
		legacy.details.response = { provider: "perplexity", sources: [] };
		legacy.details.error = "All web search providers failed";
		// No durationMs — a result persisted before timing existed.
		const legacyRendered = renderPlain(legacy, uiTheme);
		expect(legacyRendered).not.toMatch(/Duration:|tok\/s/);
	});
});
