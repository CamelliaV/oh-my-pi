import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import { resolveMemoryBackend } from "./resolve";
import type {
	MemoryBackendEditInput,
	MemoryBackendEditResult,
	MemoryBackendId,
	MemoryBackendOperationContext,
	MemoryBackendReadResult,
	MemoryBackendReflectOptions,
	MemoryBackendReflectResult,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryRuntimeContext,
} from "./types";
import type { MemoryBackendReadOptions } from "./types";
export function createMemoryRuntimeContext(context: MemoryBackendOperationContext): MemoryRuntimeContext {
	const settings = context.session?.settings;
	return {
		async status() {
			if (!settings) {
				return {
					backend: "off" as const,
					active: false,
					writable: false,
					searchable: false,
					message: "No active agent session.",
				};
			}
			const backend = await resolveMemoryBackend(settings);
			return backend.status
				? await backend.status(context)
				: {
						backend: backend.id,
						active: backend.id !== "off",
						writable: backend.capabilities.writable,
						searchable: backend.capabilities.searchable,
						message: "This memory backend does not expose structured status.",
					};
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			if (!settings) return unavailableSearch("off", query, "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			return backend.capabilities.searchable && backend.search
				? await backend.search(context, query, options)
				: unavailableSearch(backend.id, query, `Memory search is not available for the ${backend.id} backend.`);
		},
		async save(input: string | MemoryBackendSaveInput) {
			if (!settings) return unavailableSave("off", "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			const normalized = typeof input === "string" ? { content: input } : input;
			return backend.capabilities.writable && backend.save
				? await backend.save(context, normalized)
				: unavailableSave(backend.id, `Memory save is not available for the ${backend.id} backend.`);
		},
		async read(id: string, options?: MemoryBackendReadOptions): Promise<MemoryBackendReadResult> {
			if (!settings) return { backend: "off", id, status: "unavailable", error: "No active agent session." };
			const backend = await resolveMemoryBackend(settings);
			return backend.capabilities.readable && backend.read
				? await backend.read(context, id, options)
				: {
						backend: backend.id,
						id,
						status: "unavailable",
						error: `Memory read is not available for the ${backend.id} backend.`,
					};
		},
		async edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult> {
			if (!settings)
				return { backend: "off", id: input.id, status: "unavailable", error: "No active agent session." };
			const backend = await resolveMemoryBackend(settings);
			return backend.capabilities.editable && backend.edit
				? await backend.edit(context, input)
				: {
						backend: backend.id,
						id: input.id,
						status: "unavailable",
						error: `Memory edit is not available for the ${backend.id} backend.`,
					};
		},
		async reflect(query: string, options?: MemoryBackendReflectOptions): Promise<MemoryBackendReflectResult> {
			if (!settings) return { backend: "off", query, text: "", error: "No active agent session." };
			const backend = await resolveMemoryBackend(settings);
			return backend.capabilities.reflective && backend.reflect
				? await backend.reflect(context, query, options)
				: {
						backend: backend.id,
						query,
						text: "",
						error: `Memory reflection is not available for the ${backend.id} backend.`,
					};
		},
	};
}

export function createSessionMemoryRuntimeContext(
	session: AgentSession,
	agentDir: string,
	cwd: string,
): MemoryRuntimeContext {
	return createMemoryRuntimeContext({ agentDir, cwd, session });
}

/** Tool calls resolve the exact owner, never whichever legacy state happens to exist. */
export function createToolMemoryRuntimeContext(session: Pick<ToolSession, "getMemoryContext">): MemoryRuntimeContext {
	const context = session.getMemoryContext?.();
	if (!context?.session) throw new Error("Memory tools require an owning agent session.");
	return createMemoryRuntimeContext(context);
}

function unavailableSearch(backend: MemoryBackendId, query: string, message: string) {
	return { backend, query, count: 0, items: [], message, error: message };
}

function unavailableSave(backend: MemoryBackendId, message: string) {
	return { backend, stored: 0, message, error: message };
}
