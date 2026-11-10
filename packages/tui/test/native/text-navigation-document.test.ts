import { beforeAll, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../../src/chat/assistant-message";
import { UserMessageComponent } from "../../src/chat/user-message";
import { TspDocument } from "../../src/native/apply";
import { node } from "../../src/native/describe";
import type { DescribeContext, NativeChild } from "../../src/native/node";
import { Reconciler } from "../../src/native/reconcile";
import { initTheme } from "../../src/theme";
import { Container } from "../../src/tui";

const cx: DescribeContext = { cols: 100, dark: true, reduceMotion: true, supports: () => true, feature: () => true };
beforeAll(() => initTheme(false));

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "probe",
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{ type: "thinking", thinking: "Private thought" },
			{ type: "text", text: "First prose" },
			{ type: "toolCall", id: "call", name: "read", arguments: { path: "example" } },
			{ type: "text", text },
		],
	};
}

it("navigates only rendered conversation prose in document order across settled blocks, updates and removal", () => {
	const user = new UserMessageComponent("Question");
	const answer = new AssistantMessageComponent(assistant("Second prose"));
	const grouped = new Container();
	grouped.addChild(answer);
	const tool = node("tool", { name: "read", status: "done", title: "Read", role: "omp.tool.read" }, [
		node("md", { text: "Tool output" }),
	]);
	const synthetic = new UserMessageComponent("Internal instruction", { synthetic: true });
	const reconciler = new Reconciler("test", "omp.text.document.test");
	const doc = new TspDocument("test");
	let seq = 0;
	const render = (main: NativeChild[]) => {
		const ops = reconciler.reconcile({ main, dock: [], layer: [] }, cx);
		expect(doc.applyFrame({ sf: "test", s: ++seq, ops })).toEqual([]);
		const navigation = reconciler.textNavigationDocument();
		return {
			navigation,
			text: navigation.anchors.map(anchor => {
				const target = doc.get(anchor.id);
				return target?.k === "md" ? target.p?.text : undefined;
			}),
		};
	};
	const initial = render([user, tool, synthetic, grouped]);
	expect(initial.text).toEqual(["Question", "First prose", "Second prose"]);
	expect(initial.navigation.anchors.map(anchor => anchor.root)).toEqual([0, 3, 3]);
	const secondId = initial.navigation.anchors[2]!.id;
	answer.updateContent(assistant("Second prose grows"), { transient: true });
	const updated = render([user, tool, synthetic, grouped]);
	expect(updated.navigation.anchors[2]!.id).toBe(secondId);
	expect(updated.text[2]).toBe("Second prose grows");
	const reordered = render([grouped, tool]);
	expect(reordered.text).toEqual(["First prose", "Second prose grows"]);
	expect(reordered.navigation.anchors.map(anchor => anchor.root)).toEqual([0, 0]);
	expect(reconciler.target(initial.navigation.anchors[0]!.id)).toBeNull();
});
