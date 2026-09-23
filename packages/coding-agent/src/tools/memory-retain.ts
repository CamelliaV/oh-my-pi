import type { MemoryRetainDetails } from "@oh-my-pi/pi-tui/tools/memory";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe("explicit storage scope; unsupported backends reject it"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema, MemoryRetainDetails> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = session.settings.get("memory.backend");
		if (!memoryBackendCapabilities[backend].retainable) return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult<MemoryRetainDetails>> {
		const memory = createToolMemoryRuntimeContext(this.session);
		let stored = 0;
		let queued = 0;
		const backendMessages = new Set<string>();
		try {
			for (const item of params.items) {
				const result = await memory.save({
					...item,
					source: "coding-agent-retain",
					importance: 0.75,
					tool: "retain",
				});
				if (result.error || (!result.queued && result.stored < 1)) {
					throw new Error(result.error ?? result.message ?? "The memory backend did not store this item.");
				}
				if (result.queued) queued++;
				else stored += result.stored;
				if (result.message) backendMessages.add(result.message);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (stored || queued)
				throw new Error(
					[`Retention failed after ${stored} stored and ${queued} queued: ${reason}`, ...backendMessages].join(
						" ",
					),
					{ cause: error },
				);
			throw error instanceof Error ? error : new Error(reason);
		}
		const messages: string[] = [];
		if (stored) messages.push(`${stored} ${stored === 1 ? "memory" : "memories"} stored.`);
		if (queued) messages.push(`${queued} ${queued === 1 ? "memory" : "memories"} queued.`);
		messages.push(...backendMessages);
		return { content: [{ type: "text", text: messages.join(" ") }], details: { count: stored + queued } };
	}
}
