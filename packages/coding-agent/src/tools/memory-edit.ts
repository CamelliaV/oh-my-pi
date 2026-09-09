import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	readonly description = memoryEditDescription;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate long-term memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		if (!memoryBackendCapabilities[session.settings.get("memory.backend")].editable) return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}
		const result = await createToolMemoryRuntimeContext(this.session).edit({
			op: params.op,
			id: params.id,
			content: params.content,
			importance: params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance)),
			replacementId: params.replacement_id,
		});
		if (result.error || result.status === "unavailable")
			throw new Error(result.error ?? result.message ?? "Memory editing is unavailable.");
		const text =
			result.message ??
			(result.status === "not_found"
				? `Memory ${params.id} was not found.`
				: result.status === "not_editable"
					? `Memory ${params.id} cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}.`);
		return { content: [{ type: "text", text }], details: result };
	}
}
