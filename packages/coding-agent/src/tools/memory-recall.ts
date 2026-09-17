import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = session.settings.get("memory.backend");
		if (!memoryBackendCapabilities[backend].searchable) return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const result = await createToolMemoryRuntimeContext(this.session).search(params.query, { signal });
			if (result.error) throw new Error(result.error);
			const text =
				result.text ??
				(result.count === 0
					? (result.message ?? "No relevant memories found.")
					: result.items
							.map(item => {
								const reference = item.id
									? ` (memory://${item.id}${item.revision === undefined ? "" : `, revision ${item.revision}`})`
									: "";
								return `- ${item.content}${reference}${item.conflicted ? " [conflicted]" : ""}`;
							})
							.join("\n\n"));
			return {
				content: [{ type: "text", text }],
				details: result,
				...(result.count === 0 ? { useless: true } : {}),
			};
		});
	}
}
