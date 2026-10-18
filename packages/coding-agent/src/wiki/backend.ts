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
import { EXTERNAL_WIKI_VAULT, ExternalVault, isThinPage, type VaultNote } from "./external-vault";
import { cfgWikiIncludeGlobal } from "./settings";

const vaults = new WeakMap<AgentSession, ExternalVault>();

function vaultFor(session: AgentSession | undefined): ExternalVault | undefined {
	return session ? vaults.get(session) : undefined;
}

function scopesFor(cwd: string, includeGlobal: boolean): string[] {
	const project = projectBankSegment(path.resolve(cwd || "."));
	return includeGlobal && project !== "global" ? [project, "global"] : [project];
}

function noteText(note: VaultNote): string {
	const label =
		note.kind === "page"
			? isThinPage(note)
				? "**Derived wiki page (placeholder)** — compiled skeleton with no substantial body or `## Evidence` section. The original raw source (when it shares this id) answers reads first; rebuild this page with `/wiki compile`."
				: "**Derived wiki page** — compiled from original sources; its `## Evidence` section names them. The raw sources, not this page, are the evidence of record."
			: note.channel === "processed"
				? "**Raw vault source (archived)** — original evidence; `/wiki compile` has consumed it, text preserved verbatim."
				: "**Raw vault source (pending)** — original evidence awaiting `/wiki compile`; unchanged since capture.";
	// The body of a vault note already starts with its `# title` heading; do
	// not print the title twice.
	const body = /^#\s/m.test(note.body) ? note.body : `# ${note.title}\n\n${note.body}`;
	const metadata = [
		`Created: ${note.created || "unknown"}`,
		`Scope: ${note.scope || "unknown"}`,
		`Type: ${note.type || "unknown"}`,
		`Status: ${note.status || "unknown"}`,
		`Channel: ${note.channel}`,
		`Path: ${note.path}`,
	].join("\n");
	return `${label}\n\n${metadata}\n\n${body}`;
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
	return session ? cfgWikiIncludeGlobal.get(session.settings) : true;
}

/** Caps for the `memory://root` listing: bounded, with the omission counted. */
const ROOT_PAGE_LIST_CAP = 25;
const ROOT_SOURCE_LIST_CAP = 10;

function cappedList(notes: VaultNote[], cap: number, render: (note: VaultNote) => string): string[] {
	const lines = notes.slice(0, cap).map(render);
	const omitted = notes.length - lines.length;
	if (omitted > 0) lines.push(`… and ${omitted} more not listed here; use \`recall\` to search the full vault.`);
	return lines;
}

async function readVault(
	vault: ExternalVault,
	cwd: string,
	includeGlobal: boolean,
	id: string,
): Promise<MemoryBackendReadResult> {
	const scopes = scopesFor(cwd, includeGlobal);
	if (id === "root" || id === "index") {
		// `memory://root`: the derived-pages view plus pending-source count and
		// maintenance health (omp://memory.md), bounded so a large inbox cannot
		// flood the read result.
		const notes = await vault.notes(scopes);
		const pages = notes.filter(note => note.kind === "page");
		const pending = notes.filter(note => note.channel === "inbox");
		const processed = notes.filter(note => note.channel === "processed");
		const pageLines = cappedList(
			pages,
			ROOT_PAGE_LIST_CAP,
			note => `- [${note.title}](memory://${note.id}) — ${note.scope}`,
		);
		const pendingLines = cappedList(
			pending,
			ROOT_SOURCE_LIST_CAP,
			note =>
				`- [${note.id}](memory://${note.id}) — ${note.scope}${note.created ? ` · ${note.created.slice(0, 10)}` : ""}`,
		);
		const lastCompile = await vault.lastCompileRow();
		const content = [
			`Vault: ${vault.root}`,
			`Scopes: ${scopes.join(", ")}`,
			"",
			`## Derived pages (${pages.length})`,
			...(pageLines.length
				? pageLines
				: ["No derived pages yet — `/wiki compile` writes compiled notes into `wiki/`."]),
			"",
			`## Pending sources (${pending.length})`,
			...(pendingLines.length ? pendingLines : ["No pending sources in `raw/inbox/`."]),
			"",
			`## Processed sources (${processed.length})`,
			processed.length
				? "Archived raw evidence under `raw/processed/` — compiled away, still readable verbatim via `memory://<id>`."
				: "No archived sources yet (`raw/processed/` is empty).",
			"",
			"## Maintenance health",
			`- Last compile: ${lastCompile ?? "none recorded in `wiki/_compile-log.md` yet"}.`,
			`- Inbox backlog: ${pending.length} pending source${pending.length === 1 ? "" : "s"} awaiting \`/wiki compile\`.`,
		].join("\n");
		return {
			backend: "wiki",
			id,
			status: "found",
			content,
		};
	}
	const note = await vault.find(id, scopes);
	if (!note)
		return {
			backend: "wiki",
			id,
			status: "not_found",
			message: `No wiki memory '${id}' in scope(s): ${scopes.join(", ")}. Searched compiled pages (wiki/) and raw sources (raw/inbox/, raw/processed/) under ${vault.root}. Use \`recall\` to list the ids this session can read, or widen the scope with wiki.includeGlobal.`,
		};
	return {
		backend: "wiki",
		id,
		status: "found",
		content: noteText(note),
		source: note.path,
		timestamp: note.created || undefined,
		metadata: {
			scope: note.scope,
			kind: note.kind,
			channel: note.channel,
			status: note.status,
			type: note.type,
			created: note.created,
			path: note.path,
		},
	};
}

async function searchVault(
	vault: ExternalVault,
	cwd: string,
	includeGlobal: boolean,
	query: string,
	limit = 8,
): Promise<MemoryBackendSearchResult> {
	// `limit` is a cap on the gate passers, never a fill target (ExternalVault
	// guards with its coverage gate); recall/reflect pass no limit, so 8.
	const hits = vault.searchRanked(query, await vault.notes(scopesFor(cwd, includeGlobal)), limit);
	const items = hits.map(({ note, score, matched }) => ({
		id: note.id,
		content: note.body,
		score,
		timestamp: note.created || undefined,
		metadata: {
			title: note.title,
			kind: note.kind,
			scope: note.scope,
			channel: note.channel,
			status: note.status,
			type: note.type,
			created: note.created,
			path: note.path,
			matched,
		},
	}));
	// Each line ends `[captured-at · scope · channel/status] (memory://id)`,
	// so one recall shows when each hit was captured and which channel holds it.
	const text = items.length
		? hits
				.map(({ note }) => {
					const stamp =
						note.created.length > 16 ? `${note.created.slice(0, 16)}Z` : note.created || "unknown-time";
					// Channel and status coincide for pending inbox evidence
					// ("inbox"); print the pair only when it says something new.
					const channel =
						!note.status || note.status === note.channel ? note.channel : `${note.channel}/${note.status}`;
					return `- ${note.body} [${stamp} · ${note.scope} · ${channel}] (memory://${note.id})`;
				})
				.join("\n\n")
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
