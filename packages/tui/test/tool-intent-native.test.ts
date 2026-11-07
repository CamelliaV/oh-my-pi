import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TspText } from "@oh-my-pi/pi-wire";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { setTranscriptPresenters } from "../src/chat/transcript-presentation";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";

const cx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool",
	feature: () => true,
};
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };

function plain(value: TspText | undefined): string {
	return typeof value === "string" ? value : (value ?? []).map(part => part.t).join("");
}

/** Visible labels only: a tooltip/intent prop alone does not put the intent on screen. */
function visible(node: NativeNode): string {
	const labels: string[] = [];
	if (node.k === "tool") labels.push(plain(node.p?.title), plain(node.p?.target));
	if (node.k === "card" || node.k === "section") labels.push(plain(node.p?.head));
	if (node.k === "text") labels.push(node.p?.text ?? plain(node.p?.spans));
	if (node.k === "item") labels.push(plain(node.p?.label), plain(node.p?.detail));
	for (const child of node.c ?? []) if ("k" in child) labels.push(visible(child));
	return labels.join("\n");
}

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	stopSharedSpinnerTicker();
	setTranscriptPresenters([]);
});

describe("native tool intent visibility", () => {
	it("updates a mounted Glob head when intent arrives, then retains it with stripped execution args", () => {
		const card = new ToolExecutionComponent("glob", { path: "src/**/*.ts" }, {}, undefined, ui);
		card.describe(cx);
		card.updateIntent("查找渲染入口");
		expect(visible(card.describe(cx))).toContain("查找渲染入口");
		card.updateArgs({ path: "src/**/*.tsx" });
		card.updateResult({ content: [{ type: "text", text: "src/app.tsx" }], details: { files: ["src/app.tsx"] } });
		const done = card.describe(cx);
		expect(done.p).toMatchObject({ status: "done", collapsed: true, intent: "查找渲染入口" });
		expect(done.k === "tool" ? plain(done.p?.title) : "").toContain("查找渲染入口");
		expect(done.k === "tool" ? done.p?.target : undefined).toBe("src/**/*.tsx");
		expect(visible(card.describe())).toContain("查找渲染入口");
	});

	it("shows a skill URL Read intent before its collapsed result and after a presenter compacts it", () => {
		const card = new ToolExecutionComponent(
			"read",
			{ path: "skill://release-history", i: "读取升级记录" },
			{},
			undefined,
			ui,
		);
		card.updateResult({ content: [{ type: "text", text: "# Release history" }] });
		for (const compact of [false, true]) {
			if (compact) {
				setTranscriptPresenters([() => "compact"]);
				card.refreshTranscriptPresentation();
			}
			const node = card.describe(cx);
			expect(node.k === "tool" ? plain(node.p?.title) : "").toContain("读取升级记录");
			expect(node.k === "tool" ? node.p?.target : undefined).toBe("skill://release-history");
		}
	});

	it("sanitizes metadata-only intent and keeps it visible with an error and on legacy native hosts", () => {
		const card = new ToolExecutionComponent(
			"custom_lookup",
			{ query: "x" },
			{ intent: "检查\t\u001b[31m来源\u001b[0m\n状态" },
			undefined,
			ui,
		);
		card.updateResult({ content: [{ type: "text", text: "lookup failed" }], isError: true });
		for (const context of [cx, undefined]) {
			const output = visible(card.describe(context));
			expect(output).toContain("检查 来源 状态");
			expect(output).not.toMatch(/[\t\u001b]/);
		}
	});

	it("does not repeat intents already displayed by Bash and Edit", () => {
		for (const [name, args] of [
			["bash", { command: "pwd", i: "检查工作目录" }],
			["edit", { path: "src/a.ts", old_text: "a", new_text: "b", i: "修复参数解析" }],
		] as const) {
			const card = new ToolExecutionComponent(name, args, {}, undefined, ui);
			for (const context of [cx, undefined]) expect(visible(card.describe(context)).split(args.i)).toHaveLength(2);
		}
	});

	it("keeps a single file Read intent in its head when content previews are disabled", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/a.ts" }, "a");
		group.describe(cx);
		group.updateIntent("检查调用入口", "a");
		group.updateResult({ content: [{ type: "text", text: "contents" }] }, false, "a");
		const node = group.describe(cx);
		expect(node.k === "tool" ? plain(node.p?.title) : "").toContain("检查调用入口");
		expect(visible(group.describe())).toContain("检查调用入口");
	});

	it("associates grouped Read intents with each file in summaries and content previews", () => {
		for (const showContentPreview of [false, true]) {
			const group = new ReadToolGroupComponent({ showContentPreview });
			for (const [id, intent] of [
				["a", "检查解析器"],
				["b", "检查调用方"],
			]) {
				group.updateArgs({ path: `src/${id}.ts` }, id);
				group.updateIntent(intent, id);
				group.updateResult({ content: [{ type: "text", text: "contents" }] }, false, id);
			}
			for (const context of [cx, undefined]) {
				const node = group.describe(context);
				for (const [id, intent] of [
					["a", "检查解析器"],
					["b", "检查调用方"],
				]) {
					const row = (node.c ?? [])
						.filter((child): child is NativeNode => "k" in child)
						.flatMap(child =>
							child.k === "list" ? (child.c ?? []).filter((item): item is NativeNode => "k" in item) : [child],
						)
						.find(child => visible(child).includes(`src/${id}.ts`));
					expect(row && visible(row)).toContain(intent!);
				}
			}
		}
	});
});
