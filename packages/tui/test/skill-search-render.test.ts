import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import { skillSearchToolRenderer, type SkillSearchDetails } from "../src/tools/skill-search";

beforeAll(async () => {
	await initTheme(false, "unicode", false);
});

describe("skill search descriptions", () => {
	it("shows the complete description in collapsed live and restored cards, wrapping safely at narrow widths", () => {
		const description = `跨屏移动指针\t${"preserve-focus ".repeat(25)}末尾限制：仅适用于 Wayland。\x1b[?1049h`;
		const result = {
			content: [{ type: "text", text: "search response" }],
			details: {
				query: "跨屏",
				offset: 0,
				total: 1,
				items: [{ name: "kwin-warp", description, uri: "skill://kwin-warp" }],
			} satisfies SkillSearchDetails,
		};
		for (const restored of [false, true]) {
			const component = new ToolExecutionComponent(
				"skill_search",
				{ query: "跨屏" },
				{ useBuiltInRenderer: true },
				undefined,
				{
					requestRender() {},
					requestComponentRender() {},
					resetDisplay() {},
				},
			);
			component.updateResult(restored ? structuredClone(result) : result, false);
			component.setExpanded(false);
			const lines = component.render(38);
			const visible = Bun.stripANSI(lines.join("")).replace(/\s/g, "");
			expect(visible).toContain("跨屏移动指针");
			expect(visible).toContain("preserve-focus".repeat(25));
			expect(visible).toContain("末尾限制：仅适用于Wayland。");
			expect(visible).toContain("skill://kwin-warp");
			expect(lines.every(line => Bun.stringWidth(line) <= 38)).toBe(true);
			expect(lines.join("\n")).not.toContain("\x1b[?1049h");
			expect(lines.join("\n")).not.toContain("\t");
		}
	});

	it("keeps full descriptions in the native result body without a collapsed preview clamp", () => {
		const description = `${"Native description. ".repeat(30)}Final qualifier.`;
		const view = skillSearchToolRenderer.describeResult(
			{
				content: [],
				details: {
					query: "native",
					offset: 0,
					total: 1,
					items: [{ name: "native", description, uri: "skill://native" }],
				},
			},
			{ expanded: false, isPartial: false },
			{ query: "native" },
		);
		expect(JSON.stringify(view.body)).toContain(description);
		expect(view.preview).toBe("none");
	});
});
