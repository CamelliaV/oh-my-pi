import * as path from "node:path";
import { prompt, truncate } from "@oh-my-pi/pi-utils";
import { projectBankSegment } from "../mnemopi/config";
import {
	memoryBackendCapabilities,
	type MemoryBackend,
	type MemoryBackendEditInput,
	type MemoryBackendReadResult,
	type MemoryBackendSaveResult,
	type MemoryBackendSearchResult,
} from "../memory-backend/types";
import vaultInstructions from "../prompts/wiki/vault-instructions.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { EXTERNAL_WIKI_VAULT, ExternalVault, type VaultNote } from "./external-vault";

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

/**
 * Body for a `memory_edit` correction. The vault never rewrites a note in place:
 * the correction enters as new evidence and the compiler supersedes the old
 * account (vault AGENTS.md, Eligibility + Step 4).
 */
function correctionBody(input: MemoryBackendEditInput, target: VaultNote): string {
	const head = `Correction: this supersedes memory://${target.id}${target.title ? ` (${target.title})` : ""}.`;
	if (input.op === "forget") return `${head}\n\nThe user withdrew this memory. Do not restate it.`;
	if (input.op === "invalidate")
		return `${head}\n\nSuperseded by memory://${input.replacementId ?? "unknown"}. Keep the old account only as history.`;
	return `${head}\n\n${input.content?.trim() ?? "The user re-asserted this memory without changing its wording."}`;
}

function requireVault(session: AgentSession | undefined): ExternalVault {
	const vault = vaultFor(session);
	if (!vault) throw new Error("The external wiki vault is not available for this session.");
	return vault;
}

function includeGlobalFor(session: AgentSession | undefined): boolean {
	return session?.settings.get("wiki.includeGlobal") ?? true;
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
	async start({ session }) {
		vaults.set(session, new ExternalVault(EXTERNAL_WIKI_VAULT));
	},
	async dispose({ session }) {
		if (session) vaults.delete(session);
	},
	async buildDeveloperInstructions(_agentDir, _settings, session) {
		const vault = vaultFor(session);
		if (!vault) return undefined;
		return prompt.render(vaultInstructions, { vault: vault.root });
	},
	async clear() {
		throw new Error("The external vault is not cleared by /memory clear.");
	},
	async enqueue() {
		return "The external vault compiles with /wiki compile.";
	},
	async save(context, input): Promise<MemoryBackendSaveResult> {
		const vault = requireVault(context.session);
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
	},
	async search(context, query, options) {
		return searchVault(
			requireVault(context.session),
			context.cwd,
			includeGlobalFor(context.session),
			query,
			options?.limit,
		);
	},
	async read(context, id, options) {
		const vault = requireVault(context.session);
		if (options?.revision !== undefined)
			return {
				backend: "wiki" as const,
				id,
				status: "not_found" as const,
				message: "The external vault keeps no revisions. Read memory://<id> for the current note.",
			};
		return readVault(vault, context.cwd, includeGlobalFor(context.session), id);
	},
	async edit(context, input) {
		const vault = requireVault(context.session);
		const target = await vault.find(input.id, scopesFor(context.cwd, includeGlobalFor(context.session)));
		if (!target) return { backend: "wiki" as const, id: input.id, status: "not_found" as const };
		// The vault has no in-place edit path: raw files are append-only and a
		// compiled note is only rewritten by compile. An edit therefore records
		// the user's correction as new evidence and lets the compiler supersede
		// the old account (vault AGENTS.md, Eligibility + Step 4).
		const scope = target.scope === "global" ? "global" : scopesFor(context.cwd, false)[0]!;
		const written = await vault.append({
			content: correctionBody(input, target),
			scope,
			type: "decision",
		});
		return {
			backend: "wiki" as const,
			id: input.id,
			status: "queued" as const,
			message: `Correction appended to ${written.path}. It supersedes memory://${target.id} at the next /wiki compile.`,
		};
	},
	async reflect(context, query, options) {
		const found = await searchVault(
			requireVault(context.session),
			context.cwd,
			includeGlobalFor(context.session),
			options?.context ? `${query}\n${options.context}` : query,
			options?.limit,
		);
		return { backend: "wiki" as const, query, text: found.text ?? "", items: found.items };
	},
	async status(context) {
		const vault = vaultFor(context.session);
		if (!vault)
			return {
				backend: "wiki" as const,
				active: false,
				writable: false,
				searchable: false,
				error: context.session ? "Wiki vault is not started for this session" : "No owning session",
			};
		const notes = await vault.notes(scopesFor(context.cwd, includeGlobalFor(context.session)));
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
	},
	async stats(_agentDir, cwd, session) {
		const vault = vaultFor(session);
		if (!vault) return undefined;
		const notes = await vault.notes(scopesFor(cwd, includeGlobalFor(session)));
		return `## External Wiki\n\n- Vault: ${vault.root}\n- Readable scopes: ${scopesFor(cwd, includeGlobalFor(session)).join(", ")}\n- Compiled notes: ${notes.filter(note => note.kind === "page").length}\n- Uncompiled inbox: ${notes.filter(note => note.kind === "source").length}`;
	},
	async diagnose(_agentDir, cwd, session) {
		const vault = vaultFor(session);
		if (!vault) return "## External Wiki Diagnostics\n\n- Vault: not started for this session";
		return `## External Wiki Diagnostics\n\n- Vault: ${vault.root}\n- Readable scopes: ${scopesFor(cwd, includeGlobalFor(session)).join(", ")}\n- Include global: ${includeGlobalFor(session) ? "on" : "off"}\n- Compile: \`/wiki compile\` (vault AGENTS.md)`;
	},
	async queuePreview(context) {
		const vault = requireVault(context.session);
		const pending = (await vault.notes(scopesFor(context.cwd, includeGlobalFor(context.session))))
			.filter(note => note.kind === "source")
			.map(note => `### ${note.id}\n${truncate(note.body, 500)}`)
			.join("\n\n");
		return pending || "No uncompiled vault inbox files.";
	},
};
