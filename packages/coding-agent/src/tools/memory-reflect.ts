import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "Reflect";
	readonly description = reflectDescription;
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Synthesize an answer from long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		const backend = session.settings.get("memory.backend");
		if (!memoryBackendCapabilities[backend].reflective) return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const result = await createToolMemoryRuntimeContext(this.session).reflect(params.query, {
				context: params.context,
				signal,
			});
			if (result.error) throw new Error(result.error);
			return { content: [{ type: "text", text: result.text }], details: result };
		});
	}
}
