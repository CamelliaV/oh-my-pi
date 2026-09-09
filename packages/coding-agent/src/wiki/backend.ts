import { logger, truncate } from "@oh-my-pi/pi-utils";
import {
	memoryBackendCapabilities,
	type MemoryBackend,
	type MemoryBackendOperationContext,
	type MemoryBackendReadResult,
	type MemoryBackendSearchItem,
} from "../memory-backend/types";
import { redactSecrets } from "../secrets/redact";
import type { AgentSession } from "../session/agent-session";
import { loadWikiConfig } from "./config";
import { createWikiComplete, type WikiUsage } from "./model";
import { formatWikiRecall, getWikiState, setWikiState, WikiState } from "./state";
import type { WikiRecallResult } from "./types";

const startupErrors = new WeakMap<AgentSession, string>();

function requireState(context: MemoryBackendOperationContext): WikiState {
	const state = getWikiState(context.session);
	if (!state)
		throw new Error(
			(context.session && startupErrors.get(context.session)) || "Wiki memory is not initialized for this session",
		);
	return state;
}

function searchItems(result: WikiRecallResult): MemoryBackendSearchItem[] {
	return result.items.map(item => ({
		id: item.id,
		content: item.content,
		timestamp: item.updatedAt,
		revision: item.revision,
		sources: item.sources,
		conflicted: item.conflicted,
		metadata: { title: item.title },
	}));
}

export const wikiBackend: MemoryBackend = {
	id: "wiki",
	capabilities: memoryBackendCapabilities.wiki,
	async start({ session, settings, modelRegistry, agentDir, taskDepth }) {
		await setWikiState(session, undefined)?.dispose();
		const config = loadWikiConfig(settings, agentDir, session.sessionManager.getCwd());
		const usage: WikiUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
		const complete = createWikiComplete(session, settings, modelRegistry, config, usage);
		const state = new WikiState({ session, config, agentDir, complete, usage });
		try {
			await state.open();
			setWikiState(session, state);
			startupErrors.delete(session);
			state.attach(taskDepth === 0);
		} catch (error) {
			await state.dispose();
			const message = redactSecrets(error instanceof Error ? error.message : String(error), session.obfuscator);
			startupErrors.set(session, message);
			logger.warn("Wiki memory startup failed", { error: message });
		}
	},
	async dispose({ session }) {
		if (!session) return;
		await setWikiState(session, undefined)?.dispose();
		startupErrors.delete(session);
	},
	reset(session) {
		getWikiState(session)?.reset();
	},
	async buildDeveloperInstructions(_agentDir, _settings, session) {
		return getWikiState(session)?.instructions();
	},
	async beforeAgentStartPrompt(session, query) {
		return getWikiState(session)?.autoRecall(query);
	},
	async clear(agentDir, cwd, session) {
		await requireState({ agentDir, cwd, session }).clear();
	},
	async enqueue(agentDir, cwd, session) {
		await requireState({ agentDir, cwd, session }).maintain();
	},
	async save(context, input) {
		const state = requireState(context);
		const source = await state.capture(input);
		return {
			backend: "wiki",
			stored: 1,
			ids: [source.id],
			message: "Evidence stored; incremental Wiki maintenance is pending.",
		};
	},
	async search(context, query, options) {
		const result = await requireState(context).recall(query, options?.signal, options?.limit);
		const items = searchItems(result);
		return {
			backend: "wiki",
			query,
			count: items.length,
			items,
			text: result.items.length ? formatWikiRecall(result) : "No supporting Wiki evidence found.",
		};
	},
	async read(context, id, options) {
		const state = requireState(context);
		if (options?.revision !== undefined) {
			const historical = await state.readRevision(id, options.revision);
			if (!historical)
				return {
					backend: "wiki",
					id,
					status: "not_found",
					message: `Wiki revision ${id}@${options.revision} was not found.`,
				};
			const record = historical.record;
			return {
				backend: "wiki",
				id,
				status: "found",
				content: "body" in record ? `# ${record.title}\n\n${record.body}` : record.content,
				revision: historical.revision,
				timestamp: historical.updatedAt,
				sources: "body" in record ? record.sources : undefined,
				conflicted: "body" in record ? record.status === "conflicted" : false,
				metadata: { historical: true, current: historical.current, change: historical.change },
			};
		}
		if (id === "root" || id === "index") {
			const snapshot = await state.snapshot();
			const content = snapshot.pages
				.map(
					page =>
						`- [${page.title}](memory://${page.id}) — ${page.summary}${page.status === "conflicted" ? " [conflicting evidence]" : ""}`,
				)
				.join("\n");
			return {
				backend: "wiki",
				id,
				status: "found",
				content: content || "No compiled Wiki pages yet. Use retain, then /memory sync.",
				metadata: { pending: snapshot.pending.length },
			};
		}
		const item = await state.read(id);
		if (!item) return { backend: "wiki", id, status: "not_found" };
		if ("body" in item) {
			return {
				backend: "wiki",
				id,
				status: "found",
				content: `# ${item.title}\n\n${item.body}`,
				revision: item.revision,
				timestamp: item.updatedAt,
				sources: item.sources,
				conflicted: item.status === "conflicted",
				metadata: { kind: item.kind, links: item.links },
			};
		}
		return {
			backend: "wiki",
			id,
			status: "found",
			content: item.content,
			source: item.source,
			revision: item.revision,
			timestamp: item.updatedAt,
			metadata: { status: item.status, context: item.context },
		};
	},
	async edit(context, input) {
		const state = requireState(context);
		const result = await state.mutate(input.id, input);
		await context.session?.refreshBaseSystemPrompt();
		return { backend: "wiki", id: input.id, ...result };
	},
	async reflect(context, query, options) {
		const state = requireState(context);
		const result = await state.recall(
			options?.context ? `${query}\n${options.context}` : query,
			options?.signal,
			options?.limit,
		);
		return {
			backend: "wiki",
			query,
			text: result.items.length ? formatWikiRecall(result) : "No supporting Wiki evidence found.",
			items: searchItems(result),
		};
	},
	async status(context) {
		const state = getWikiState(context.session);
		if (!state)
			return {
				backend: "wiki",
				active: false,
				writable: false,
				searchable: false,
				error: context.session ? startupErrors.get(context.session) : "No owning session",
			};
		const snapshot = await state.snapshot();
		return {
			backend: "wiki",
			active: true,
			writable: true,
			searchable: true,
			scope: state.config.root === state.config.globalRoot ? "global" : "project",
			workingCount: snapshot.pending.length,
			episodicCount: snapshot.pages.length,
			database: state.config.root,
			lastRecall: Boolean(state.lastRecall?.items.length),
			error: state.lastError,
			message: `${snapshot.pages.length} Wiki pages; ${snapshot.pending.length} pending sources`,
		};
	},
	async stats(agentDir, cwd, session) {
		const state = requireState({ agentDir, cwd, session });
		const snapshot = await state.snapshot();
		const candidates = await state.skills.list();
		return `## Wiki Memory\n\n- Pages: ${snapshot.pages.length}\n- Pending evidence: ${snapshot.pending.length}\n- Skill candidates: ${candidates.length}\n- Model calls this session: ${state.usage.calls}\n- Input/output tokens: ${state.usage.inputTokens}/${state.usage.outputTokens}\n- Reported cost: $${state.usage.cost.toFixed(4)}\n- Automatic recall: ${state.config.autoRecall ? "on" : "off (explicit recall available)"}\n- Root: ${state.redact(state.config.root)}`;
	},
	async diagnose(agentDir, cwd, session) {
		const state = requireState({ agentDir, cwd, session });
		const snapshot = await state.snapshot();
		return `## Wiki Diagnostics\n\n- Revision: ${snapshot.version}\n- Conflicted pages: ${snapshot.pages.filter(page => page.status === "conflicted").length}\n- Maintenance model: ${state.config.model}\n- Recall model: ${state.config.recallModel}\n- Last background error: ${state.lastError ?? "none"}\n- Skill validator: ${state.config.skillValidationCommand.length ? "configured" : "not configured; explicit manual approval only"}`;
	},
	async queuePreview(context) {
		const state = requireState(context);
		return (
			(await state.snapshot()).pending
				.map(source => `### ${source.id}\n${truncate(state.redact(source.content), 500)}`)
				.join("\n\n") || "No pending Wiki evidence."
		);
	},
};
