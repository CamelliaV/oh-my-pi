import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	vi.restoreAllMocks();
});
function renderDiagnosticText(text: string, expanded: boolean): string {
	const component = renderResult(
		{
			content: [{ type: "text", text }],
			details: { action: "diagnostics", success: true },
		},
		{ expanded, isPartial: false },
		themeModule.theme,
	);
	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("LSP render", () => {
	it("renders hover code through the cached theme highlighter", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode").mockReturnValue(["CACHED_HIGHLIGHT"]);
		const component = renderResult(
			{ content: [{ type: "text", text: "```ts\nconst value = 1;\n```" }] },
			{ expanded: true, isPartial: false },
			themeModule.theme,
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(highlightSpy).toHaveBeenCalledTimes(1);
		expect(highlightSpy).toHaveBeenCalledWith("const value = 1;", "ts", themeModule.theme);
		expect(rendered).toContain("CACHED_HIGHLIGHT");
	});

	it("keeps grouped diagnostic locations and messages visible when collapsed or expanded", () => {
		const text = [
			"2 error(s):",
			"# packages/coding-agent/src/session/",
			"## session-maintenance.ts",
			"  375:16 [error] Property 'providerContextTokens' does not exist.",
			"  1139:15 [error] Cannot find name 'providerContextTokens'.",
		].join("\n");

		for (const expanded of [false, true]) {
			const rendered = renderDiagnosticText(text, expanded);
			expect(rendered).toContain("session-maintenance.ts:375:16");
			expect(rendered).toContain("session-maintenance.ts:1139:15");
			expect(rendered).toContain("providerContextTokens");
		}
	});

	it("classifies hint-only results as diagnostics", () => {
		const rendered = renderDiagnosticText(
			["2 hint(s):", "# src/", "## index.ts", "  8:3 [hint] First hint", "  9:4 [hint] Second hint"].join("\n"),
			true,
		);

		expect(rendered).toContain("Diagnostics");
		expect(rendered).not.toContain("Response");
		expect(rendered).toContain("index.ts:8:3");
		expect(rendered).toContain("First hint");
	});

	it("preserves raw lines alongside parsed grouped diagnostics", () => {
		const rendered = renderDiagnosticText(
			["1 error(s):", "# src/", "## index.ts", "  4:2 [error] Known diagnostic", "some servers failed: tsgo"].join(
				"\n",
			),
			true,
		);

		expect(rendered).toContain("index.ts:4:2");
		expect(rendered).toContain("Known diagnostic");
		expect(rendered).toContain("some servers failed: tsgo");
	});
});
