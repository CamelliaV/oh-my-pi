import type { MemoryRetainDetails } from "@oh-my-pi/pi-tui/tools/memory";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";
import { isGlobalMemoryScopeAvailable } from "../mnemopi/settings";
import { getMnemopiSessionState } from "../mnemopi/state";

const memoryRetainSchemaBase = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

/** Offered only where a shared bank exists; see {@link isGlobalMemoryScopeAvailable}. */
const memoryRetainSchemaWithScope = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe(
			"storage scope; defaults to project, global is for durable cross-project knowledge",
		),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

type MemoryRetainSchema = typeof memoryRetainSchemaBase | typeof memoryRetainSchemaWithScope;

export type MemoryRetainParams = typeof memoryRetainSchemaWithScope.infer;
export class MemoryRetainTool implements AgentTool<MemoryRetainSchema, MemoryRetainDetails> {
	readonly name = "retain";
	/** A global item reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) =>
		(args as Partial<MemoryRetainParams>).items?.some(item => item.scope === "global") ? "write" : "read";
	readonly label = "Retain";
	get description(): string {
		return prompt.render(retainDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session.settings) });
	}
	get parameters(): MemoryRetainSchema {
		return isGlobalMemoryScopeAvailable(this.session.settings) ? memoryRetainSchemaWithScope : memoryRetainSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (!memoryBackendCapabilities[backend].retainable) return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult<MemoryRetainDetails>> {
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (params.items.some(item => item.scope === "global")) {
			if (backend !== "mnemopi") throw new Error("Global memory scope is only available with the Mnemopi backend.");
			// Resolve before any write so an unsupported scoping mode rejects the whole batch.
			const owner = this.session.getMemoryContext?.()?.session;
			getMnemopiSessionState(owner)?.getGlobalRetainTarget();
		}
		const memory = createToolMemoryRuntimeContext(this.session);
		let stored = 0;
		let queued = 0;
		const storedIds: string[] = [];
		const backendMessages = new Set<string>();
		const mnemopi = backend === "mnemopi";
		try {
			for (const [index, item] of params.items.entries()) {
				const result = await memory.save({
					content: item.content,
					context: item.context,
					source: "coding-agent-retain",
					importance: 0.75,
					scope: item.scope,
					tool: "retain",
				});
				if (result.error || (!result.queued && result.stored < 1)) {
					const raw = result.error ?? result.message ?? "The memory backend did not store this item.";
					const reason = raw.replace(/^Mnemopi did not store the memory: /, "");
					if (!mnemopi) throw new Error(reason);
					const kept =
						storedIds.length === 0
							? "Nothing was stored."
							: `Stored before the failure and kept: ${storedIds.map((storedId, storedIndex) => `item ${storedIndex + 1} (id ${storedId})`).join(", ")}.`;
					const untried = index + 1 < params.items.length ? " Later items were not attempted." : "";
					throw new Error(
						`Mnemopi did not store item ${index + 1} of ${params.items.length}: ${reason}. ${kept}${untried}`,
					);
				}
				if (result.queued) queued++;
				else stored += result.stored;
				if (result.ids) storedIds.push(...result.ids);
				if (result.message) backendMessages.add(result.message);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (!mnemopi && (stored || queued))
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
