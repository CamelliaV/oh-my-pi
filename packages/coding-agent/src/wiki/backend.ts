import * as path from "node:path";
import { logger, prompt, truncate } from "@oh-my-pi/pi-utils";
import { projectBankSegment } from "../mnemopi/config";
import {
	memoryBackendCapabilities,
	type MemoryBackend,
	type MemoryBackendOperationContext,
	type MemoryBackendReadResult,
	type MemoryBackendSaveResult,
	type MemoryBackendSearchItem,
	type MemoryBackendSearchResult,
	type MemoryPromptPreparation,
} from "../memory-backend/types";
import vaultInstructions from "../prompts/wiki/vault-instructions.md" with { type: "text" };
import { redactSecrets } from "../secrets/redact";
import type { AgentSession } from "../session/agent-session";
import { loadWikiConfig } from "./config";
import { EXTERNAL_WIKI_VAULT, ExternalVault, type VaultNote } from "./external-vault";
import { runExternalWikiCompile } from "./external-compile";
import { createWikiComplete, type WikiUsage } from "./model";
import { formatWikiRecall, getWikiState, setWikiState, WikiState } from "./state";
import type { WikiMaintenanceStatus, WikiRecallResult } from "./types";

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
		metadata: { title: item.title, kind: item.kind, role: item.role, pending: item.pending },
	}));
}

function maintenanceSummary(status: WikiMaintenanceStatus): string {
	return `${status.pending} pending sources; ${status.failed} failed maintenance jobs${status.nextRetryAt ? `; next retry ${status.nextRetryAt}` : ""}${status.lastError ? `; last maintenance failure: ${status.lastError}` : ""}`;
}
const vaults = new WeakMap<AgentSession, ExternalVault>();

function vaultFor(session: AgentSession | undefined): ExternalVault | undefined {
	return session ? vaults.get(session) : undefined;
}

function scopesFor(cwd: string, includeGlobal: boolean): string[] {
	const project = projectBankSegment(path.resolve(cwd || "."));
	return includeGlobal && project !== "global" ? [project, "global"] : [project];
}

function noteText(note: VaultNote): string {
	return `# ${note.title}\n\n${note.body}\n\nPath: ${note.path}`;
}

async function readVault(
	vault: ExternalVault,
	cwd: string,
	includeGlobal: boolean,
	id: string,
): Promise<MemoryBackendReadResult> {
	if (id === "root" || id === "index") {
		const notes = await vault.notes(scopesFor(cwd, includeGlobal));
		const pages = notes.filter(note => note.kind === "page");
		const pending = notes.filter(note => note.kind === "source");
		const pageLines = pages.map(note => `- [${note.title}](memory://${note.id}) — ${note.scope}`).join("\n");
		const pendingLines = pending.map(note => `- [${note.id}](memory://${note.id}) — uncompiled inbox`).join("\n");
		return {
			backend: "wiki",
			id,
			status: "found",
			content: `Vault: ${vault.root}\n\n## Compiled notes\n${pageLines || "No compiled notes yet."}\n\n## Uncompiled inbox\n${pendingLines || "No uncompiled inbox files."}`,
		};
	}
	const note = await vault.find(id, scopesFor(cwd, includeGlobal));
	if (!note) return { backend: "wiki", id, status: "not_found" };
	return {
		backend: "wiki",
		id,
		status: "found",
		content: noteText(note),
		source: note.path,
		metadata: { scope: note.scope, kind: note.kind, status: note.status, path: note.path },
	};
}

async function searchVault(
	vault: ExternalVault,
	cwd: string,
	includeGlobal: boolean,
	query: string,
	limit = 8,
): Promise<MemoryBackendSearchResult> {
	const notes = vault.search(query, await vault.notes(scopesFor(cwd, includeGlobal)), limit);
	const items = notes.map(note => ({
		id: note.id,
		content: note.body,
		metadata: { title: note.title, kind: note.kind, scope: note.scope, path: note.path },
	}));
	const text = items.length
		? items.map(item => `- ${item.content} (memory://${item.id})`).join("\n\n")
		: "No matching vault notes.";
	return { backend: "wiki", query, count: items.length, items, text };
}


export const wikiBackend: MemoryBackend = {
	id: "wiki",
	capabilities: memoryBackendCapabilities.wiki,
	async start({ session, settings, modelRegistry, agentDir, taskDepth }) {
		await setWikiState(session, undefined)?.dispose();
		const configured = settings.get("wiki.root")?.trim();
		if (!configured) {
			vaults.set(session, new ExternalVault(EXTERNAL_WIKI_VAULT));
			startupErrors.delete(session);
			return;
		}
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
		vaults.delete(session);
		await setWikiState(session, undefined)?.dispose();
		startupErrors.delete(session);
	},
	reset(session) {
		getWikiState(session)?.reset();
	},
	async buildDeveloperInstructions(_agentDir, settings, session) {
		const vault = vaultFor(session);
		if (!vault || !session || !settings) return getWikiState(session)?.instructions();
		const notes = (await vault.notes(scopesFor(session.sessionManager.getCwd(), settings.get("wiki.includeGlobal"))))
			.filter(note => note.kind === "page")
			.slice(0, 12);
		return prompt.render(vaultInstructions, {
			vault: vault.root,
			preferences: notes.map(note => `- ${note.title} (memory://${note.id})`).join("\n"),
		});
	},
	async beforeAgentStartPrompt(session, query): Promise<MemoryPromptPreparation | undefined> {
		const context = await getWikiState(session)?.autoRecall(query);
		if (context === undefined) return undefined;
		// Wiki recall is status-only (no first-turn latch, no prompt-cache
		// sensitivity), so the commit is an unconditional accept.
		return { context, commit: () => true };
	},
	async clear(_agentDir, _cwd, session) {
		if (vaultFor(session)) throw new Error("The external vault is not cleared by /memory clear.");
		await requireState({ agentDir: _agentDir, cwd: _cwd, session }).clear();
	},
	async enqueue(_agentDir, _cwd, session) {
		if (session && vaultFor(session)) {
			await runExternalWikiCompile(session);
			return;
		}
		await requireState({ agentDir: _agentDir, cwd: _cwd, session }).maintain();
	},
	async save(context, input): Promise<MemoryBackendSaveResult> {
		const vault = vaultFor(context.session);
		if (vault) {
			const scope = input.scope === "global" ? "global" : scopesFor(context.cwd, false)[0]!;
			const written = await vault.append({
				content: input.content,
				context: input.context,
				scope,
				type: input.tool === "learn" ? "procedure" : "fact",
			});
			return {
				backend: "wiki",
				stored: 1,
				ids: [written.id],
				queued: true,
				message: `Appended to the external vault inbox: ${written.path}`,
			};
		}
		const state = requireState(context);
		const source = await state.capture(input);
		return {
			backend: "wiki",
			stored: 1,
			ids: [source.id],
			queued: true,
			message: "Original evidence stored and available to recall; Wiki maintenance queued.",
		};
	},
	async search(context, query, options) {
		const vault = vaultFor(context.session);
		if (vault) {
			const includeGlobal = context.session?.settings.get("wiki.includeGlobal") ?? true;
			return searchVault(vault, context.cwd, includeGlobal, query, options?.limit);
		}
		const state = requireState(context);
		const result = await state.recall(query, options?.signal, options?.limit);
		const maintenance = await state.maintenanceStatus();
		const items = searchItems(result);
		return {
			backend: "wiki",
			query,
			count: items.length,
			items,
			text: `${formatWikiRecall(result)}\n\nMaintenance: ${maintenanceSummary(maintenance)}`,
		};
	},
	async read(context, id, options) {
		const vault = vaultFor(context.session);
		if (vault && options?.revision === undefined) {
			const includeGlobal = context.session?.settings.get("wiki.includeGlobal") ?? true;
			return readVault(vault, context.cwd, includeGlobal, id);
		}
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
				content:
					"body" in record
						? `# ${record.title}\n\nDerived Wiki page; verify claims against its original sources.\n\n${record.body}`
						: `Original source evidence (historical revision):\n\n${record.content}`,
				revision: historical.revision,
				timestamp: historical.updatedAt,
				sources: "body" in record ? record.sources : undefined,
				conflicted: "body" in record ? record.status === "conflicted" : false,
				metadata: {
					historical: true,
					current: historical.current,
					change: historical.change,
					recordKind: "body" in record ? "page" : "source",
					derived: "body" in record,
				},
			};
		}
		if (id === "root" || id === "index") {
			const snapshot = await state.snapshot();
			const maintenance = await state.maintenanceStatus();
			const content = snapshot.pages
				.map(
					page =>
						`- [${page.title}](memory://${page.id}) — ${page.summary} [derived page]${page.status === "conflicted" ? " [conflicting evidence]" : ""}`,
				)
				.join("\n");
			const queued = snapshot.pending
				.map(source => `- [${source.id}@${source.revision}](memory://${source.id}) — pending original evidence`)
				.join("\n");
			return {
				backend: "wiki",
				id,
				status: "found",
				content: `Maintenance: ${maintenanceSummary(maintenance)}\n\n## Derived pages\n${content || "No compiled Wiki pages yet."}\n\n## Pending original evidence\n${queued || "No pending sources."}`,
				metadata: { ...maintenance },
			};
		}
		const item = await state.read(id);
		if (!item) return { backend: "wiki", id, status: "not_found" };
		if ("body" in item) {
			return {
				backend: "wiki",
				id,
				status: "found",
				content: `# ${item.title}\n\nDerived Wiki page; verify claims against its original sources.\n\n${item.body}`,
				revision: item.revision,
				timestamp: item.updatedAt,
				sources: item.sources,
				conflicted: item.status === "conflicted",
				metadata: { kind: item.kind, links: item.links, recordKind: "page", derived: true },
			};
		}
		return {
			backend: "wiki",
			id,
			status: "found",
			content: `Original source evidence:\n\n${item.content}`,
			source: item.source,
			revision: item.revision,
			timestamp: item.updatedAt,
			metadata: { status: item.status, context: item.context, recordKind: "source", derived: false },
		};
	},
	async edit(context, input) {
		if (vaultFor(context.session))
			return {
				backend: "wiki" as const,
				id: input.id,
				status: "not_editable" as const,
				message: "External vault notes are append-only. Add a new retain instead of editing a raw file.",
			};
		const state = requireState(context);
		const result = await state.mutate(input.id, input);
		await context.session?.refreshBaseSystemPrompt();
		return { backend: "wiki" as const, id: input.id, ...result };
	},
	async reflect(context, query, options) {
		const vault = vaultFor(context.session);
		if (vault) {
			const includeGlobal = context.session?.settings.get("wiki.includeGlobal") ?? true;
			const found = await searchVault(
				vault,
				context.cwd,
				includeGlobal,
				options?.context ? `${query}\n${options.context}` : query,
				options?.limit,
			);
			return { backend: "wiki" as const, query, text: found.text ?? "", items: found.items };
		}
		const state = requireState(context);
		const result = await state.recall(
			options?.context ? `${query}\n${options.context}` : query,
			options?.signal,
			options?.limit,
		);
		const maintenance = await state.maintenanceStatus();
		return {
			backend: "wiki" as const,
			query,
			text: `${formatWikiRecall(result)}\n\nMaintenance: ${maintenanceSummary(maintenance)}`,
			items: searchItems(result),
		};
	},
	async status(context) {
		const vault = vaultFor(context.session);
		if (vault) {
			const includeGlobal = context.session?.settings.get("wiki.includeGlobal") ?? true;
			const notes = await vault.notes(scopesFor(context.cwd, includeGlobal));
			const pending = notes.filter(note => note.kind === "source").length;
			const pages = notes.filter(note => note.kind === "page").length;
			return {
				backend: "wiki" as const,
				active: true,
				writable: true,
				searchable: true,
				workingCount: pending,
				episodicCount: pages,
				database: vault.root,
				message: `${pages} compiled notes; ${pending} uncompiled inbox files; vault ${vault.root}`,
			};
		}
		const state = getWikiState(context.session);
		if (!state)
			return {
				backend: "wiki" as const,
				active: false,
				writable: false,
				searchable: false,
				error: context.session ? startupErrors.get(context.session) : "No owning session",
			};
		const snapshot = await state.snapshot();
		const maintenance = await state.maintenanceStatus();
		return {
			backend: "wiki" as const,
			active: true,
			writable: true,
			searchable: true,
			scope: state.config.root === state.config.globalRoot ? "global" : "project",
			workingCount: maintenance.pending,
			episodicCount: snapshot.pages.length,
			database: state.config.root,
			lastRecall: Boolean(state.lastRecall?.items.length),
			error: maintenance.lastError ?? state.lastError,
			message: `${snapshot.pages.length} Wiki pages; ${maintenanceSummary(maintenance)}`,
		};
	},
	async stats(agentDir, cwd, session) {
		const vault = vaultFor(session);
		if (vault) {
			const notes = await vault.notes(scopesFor(cwd, session?.settings.get("wiki.includeGlobal") ?? true));
			return `## External Wiki\n\n- Vault: ${vault.root}\n- Compiled notes: ${notes.filter(note => note.kind === "page").length}\n- Uncompiled inbox: ${notes.filter(note => note.kind === "source").length}`;
		}
		const state = requireState({ agentDir, cwd, session });
		const snapshot = await state.snapshot();
		const candidates = await state.skills.list();
		const maintenance = await state.maintenanceStatus();
		return `## Wiki Memory\n\n- Pages: ${snapshot.pages.length}\n- Maintenance: ${maintenanceSummary(maintenance)}\n- Skill candidates: ${candidates.length}\n- Model calls this session: ${state.usage.calls}\n- Input/output tokens: ${state.usage.inputTokens}/${state.usage.outputTokens}\n- Reported cost: $${state.usage.cost.toFixed(4)}\n- Automatic recall: ${state.config.autoRecall ? "on" : "off (explicit recall available)"}\n- Root: ${state.redact(state.config.root)}`;
	},
	async diagnose(agentDir, cwd, session) {
		const vault = vaultFor(session);
		if (vault)
			return `## External Wiki Diagnostics\n\n- Vault: ${vault.root}\n- Readable scopes: ${scopesFor(cwd, session?.settings.get("wiki.includeGlobal") ?? true).join(", ")}\n- Internal sqlite wiki: not used for reads or writes`;
		const state = requireState({ agentDir, cwd, session });
		const snapshot = await state.snapshot();
		const maintenance = await state.maintenanceStatus();
		return `## Wiki Diagnostics\n\n- Revision: ${snapshot.version}\n- Conflicted pages: ${snapshot.pages.filter(page => page.status === "conflicted").length}\n- Maintenance model: ${state.config.model}\n- Recall model: ${state.config.recallModel}\n- Maintenance: ${maintenanceSummary(maintenance)}\n- Last background error: ${state.lastError ?? "none"}\n- Skill validator: ${state.config.skillValidationCommand.length ? "configured" : "not configured; explicit manual approval only"}`;
	},
	async queuePreview(context) {
		const vault = vaultFor(context.session);
		if (vault) {
			const pending = (await vault.notes(scopesFor(context.cwd, context.session?.settings.get("wiki.includeGlobal") ?? true)))
				.filter(note => note.kind === "source")
				.map(note => `### ${note.id}\n${truncate(note.body, 500)}`)
				.join("\n\n");
			return pending || "No uncompiled vault inbox files.";
		}
		const state = requireState(context);
		const maintenance = await state.maintenanceStatus();
		const pending = (await state.snapshot()).pending
			.map(source => `### ${source.id}\n${truncate(state.redact(source.content), 500)}`)
			.join("\n\n");
		return `Maintenance: ${maintenanceSummary(maintenance)}\n\n${pending || "No pending Wiki evidence."}`;
	},
};
