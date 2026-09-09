import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, truncate, withTimeout } from "@oh-my-pi/pi-utils";
import { stripMemoryTags } from "../hindsight/content";
import type { MemoryBackendSaveInput } from "../memory-backend/types";
import wikiInstructions from "../prompts/wiki/instructions.md" with { type: "text" };
import { redactSecretFields, redactSecrets } from "../secrets/redact";
import type { AgentSession } from "../session/agent-session";
import type { WikiConfig } from "./config";
import { maintainWiki } from "./maintain";
import type { WikiUsage } from "./model";
import { recallWiki } from "./recall";
import { WikiSkills } from "./skills";
import { WikiStore } from "./store";
import type {
	WikiComplete,
	WikiMutation,
	WikiMutationResult,
	WikiPage,
	WikiRecallResult,
	WikiSnapshot,
	WikiSource,
} from "./types";

const states = new WeakMap<AgentSession, WikiState>();
const maintenanceJobs = new Map<string, Promise<void>>();
const MAX_TURN_CHARS = 12_000;
const MAX_OBSERVATION_CHARS = 2000;
const MEMORY_TOOL_NAMES = new Set(["retain", "recall", "reflect", "memory_edit", "learn", "manage_skill"]);

export function getWikiState(session?: AgentSession): WikiState | undefined {
	return session ? states.get(session) : undefined;
}

export function setWikiState(session: AgentSession, state?: WikiState): WikiState | undefined {
	const previous = states.get(session);
	if (state) states.set(session, state);
	else states.delete(session);
	return previous;
}

/** Capture observed task data, never provider reasoning or recalled-memory feedback. */
export function wikiTurnEvidence(
	messages: readonly AgentMessage[],
	redact: (text: string) => string = redactSecrets,
): string | undefined {
	const start = messages.findLastIndex(message => message.role === "user");
	if (start < 0) return undefined;
	const records: Array<{ role: string; content: string; tool?: string; error?: boolean }> = [];
	let remaining = MAX_TURN_CHARS;
	let hasObservation = false;
	for (const message of messages.slice(start)) {
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
		if (message.role === "toolResult" && MEMORY_TOOL_NAMES.has(message.toolName)) continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		const content = redact(stripMemoryTags(text)).trim();
		if (!content || remaining <= 0) continue;
		const captured = truncate(
			content,
			Math.min(remaining, message.role === "toolResult" ? MAX_OBSERVATION_CHARS : 4000),
			"\n[excerpt truncated]",
		);
		remaining -= captured.length;
		if (message.role === "toolResult") {
			hasObservation = true;
			records.push({ role: "toolResult", tool: message.toolName, error: message.isError, content: captured });
		} else {
			records.push({ role: message.role, content: captured });
		}
	}
	// Plain conversations use explicit retain/learn. Automatic sources require
	// actual observations, not an assistant claiming that its work succeeded.
	return hasObservation && records.some(record => record.role === "assistant") ? JSON.stringify(records) : undefined;
}

export class WikiState {
	readonly usage: WikiUsage;
	readonly config: WikiConfig;
	readonly session: AgentSession;
	readonly skills: WikiSkills;
	lastError?: string;
	lastRecall?: WikiRecallResult;
	#stores = new Map<string, WikiStore>();
	#complete: WikiComplete;
	#shutdown = new AbortController();
	#unsubscribe?: () => void;
	#captureChain: Promise<void> = Promise.resolve();
	#disposed = false;
	#recallEpoch = 0;
	#cache = new Map<string, WikiRecallResult>();
	#seenTurns = new Set<string>();
	#opening = new Map<string, Promise<void>>();

	constructor(options: {
		session: AgentSession;
		config: WikiConfig;
		agentDir: string;
		complete: WikiComplete;
		usage?: WikiUsage;
	}) {
		this.session = options.session;
		this.config = options.config;
		this.#complete = options.complete;
		this.usage = options.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
		this.skills = new WikiSkills({
			root: options.config.root,
			agentDir: options.agentDir,
			complete: options.complete,
			redact: text => this.redact(text),
			project:
				options.config.root === options.config.globalRoot ? undefined : options.session.sessionManager.getCwd(),
		});
	}

	redact(text: string): string {
		return redactSecrets(text, this.session.obfuscator);
	}

	async open(): Promise<void> {
		await this.#store(this.config.root);
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot)
			await this.#store(this.config.globalRoot);
		await this.skills.reconcile((await this.snapshot()).pages);
	}

	attach(automatic: boolean): void {
		this.#unsubscribe?.();
		if (!automatic) return;
		this.#unsubscribe = this.session.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal === false || !this.config.autoRetain || this.#disposed)
				return;
			const content = wikiTurnEvidence(event.messages, text => this.redact(text));
			if (!content) return;
			const cursor = `${this.session.sessionId}:${Bun.hash(content).toString(16)}`;
			if (this.#seenTurns.has(cursor)) return;
			this.#seenTurns.add(cursor);
			this.#captureChain = this.#captureChain
				.then(async () => {
					if (this.#disposed) return;
					await (
						await this.#store(this.config.root)
					).capture({ content: this.redact(content), source: "task-observations", cursor });
				})
				.catch(error => {
					this.#seenTurns.delete(cursor);
					this.#report(error);
				});
			if (this.config.autoMaintain)
				void this.#captureChain.then(() => this.maintain()).catch(error => this.#report(error));
		});
		if (this.config.autoMaintain) void this.maintain().catch(error => this.#report(error));
	}

	async #store(root: string): Promise<WikiStore> {
		if (this.#disposed) throw new Error("Wiki memory is disposed");
		let store = this.#stores.get(root);
		if (!store) {
			store = new WikiStore({ root, redact: text => this.redact(text) });
			this.#stores.set(root, store);
			const opening = store.open();
			this.#opening.set(root, opening);
		}
		await this.#opening.get(root);
		return store;
	}

	async capture(input: MemoryBackendSaveInput): Promise<WikiSource> {
		const root =
			input.scope === "global"
				? this.config.globalRoot
				: input.scope === "project"
					? this.config.projectRoot
					: this.config.root;
		const captured = await (
			await this.#store(root)
		).capture(
			redactSecretFields(
				{
					content: input.content,
					context: input.context,
					source: input.source ?? input.tool ?? "retain",
				},
				this.session.obfuscator,
			),
		);
		this.#invalidate();
		if (this.config.autoMaintain) void this.maintain().catch(error => this.#report(error));
		return captured;
	}

	async snapshot(): Promise<WikiSnapshot> {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		const snapshots = await Promise.all(roots.map(async root => (await this.#store(root)).snapshot()));
		const pages = new Map<string, WikiPage>();
		for (const snapshot of snapshots)
			for (const page of snapshot.pages) if (!pages.has(page.id)) pages.set(page.id, page);
		return {
			version: snapshots.map(snapshot => snapshot.version).join(":"),
			pages: [...pages.values()],
			pending: snapshots.flatMap(snapshot => snapshot.pending),
		};
	}

	async maintain(): Promise<void> {
		if (this.#disposed) return;
		await this.#captureChain;
		for (const [root, store] of this.#stores) {
			const active = maintenanceJobs.get(root);
			if (active) {
				await active;
				continue;
			}
			const job = (async () => {
				const snapshot = await store.snapshot();
				if (!snapshot.pending.length) return;
				const change = await maintainWiki(snapshot, this.#complete, {
					limit: this.config.batchSize,
					signal: this.#shutdown.signal,
				});
				this.#shutdown.signal.throwIfAborted();
				await store.publish(snapshot, change);
				this.#invalidate();
				this.lastError = undefined;
			})();
			maintenanceJobs.set(root, job);
			try {
				await job;
			} finally {
				if (maintenanceJobs.get(root) === job) maintenanceJobs.delete(root);
			}
		}
		await this.skills.reconcile((await this.snapshot()).pages);
	}

	async read(id: string): Promise<WikiPage | WikiSource | null> {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const item = await (await this.#store(root)).read(id);
			if (item) return redactSecretFields(item, this.session.obfuscator);
		}
		return null;
	}

	async history(id: string) {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const items = await (await this.#store(root)).history(id);
			if (items.length) return items;
		}
		return [];
	}

	async readRevision(id: string, revision: number) {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const item = await (await this.#store(root)).readRevision(id, revision);
			if (item) return redactSecretFields(item, this.session.obfuscator);
		}
		return null;
	}

	async diff(id: string, fromRevision: number, toRevision: number): Promise<string> {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const items = await (await this.#store(root)).history(id);
			if (items.length) return (await this.#store(root)).diff(id, fromRevision, toRevision);
		}
		throw new Error(`Wiki record ${id} was not found`);
	}

	async restore(id: string, revision: number) {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const store = await this.#store(root);
			if ((await store.history(id)).length) {
				const result = await store.restore(id, revision);
				this.#invalidate();
				await this.skills.reconcile((await this.snapshot()).pages);
				return result;
			}
		}
		throw new Error(`Wiki record ${id} was not found`);
	}

	async recall(query: string, signal?: AbortSignal, limit = this.config.recallLimit): Promise<WikiRecallResult> {
		const combined = signal ? AbortSignal.any([signal, this.#shutdown.signal]) : this.#shutdown.signal;
		combined.throwIfAborted();
		const snapshot = await this.snapshot();
		const safeQuery = this.redact(query);
		const key = JSON.stringify([snapshot.version, safeQuery, limit]);
		const cached = this.#cache.get(key);
		if (cached) return cached;
		const result = await recallWiki(safeQuery, snapshot.pages, this.#complete, {
			signal: combined,
			limit,
			maxChars: this.config.contextTokenLimit * 4,
		});
		const current = await this.snapshot();
		if (current.version !== snapshot.version)
			throw new Error("Wiki changed during recall; retry against the current revision");
		const items = [];
		let rendered = "";
		for (const item of result.items) {
			const safe = redactSecretFields(item, this.session.obfuscator);
			const fragment = `${safe.title}\n${safe.content}\n${JSON.stringify(safe.sources)}`;
			if (!this.session.agent.tokenizer.checkTokenBudget(rendered + fragment, this.config.contextTokenLimit).fits)
				continue;
			items.push(safe);
			rendered += fragment;
		}
		if (result.items.length && !items.length)
			throw new Error(
				"Wiki evidence exceeds the configured context budget; open its page directly or increase wiki.contextTokenLimit",
			);
		const bounded: WikiRecallResult = { status: items.length ? "found" : "not_found", items };
		if (this.#cache.size >= 32) this.#cache.delete(this.#cache.keys().next().value!);
		this.#cache.set(key, bounded);
		this.lastRecall = bounded;
		return bounded;
	}

	async mutate(id: string, mutation: WikiMutation): Promise<WikiMutationResult> {
		const roots = [this.config.root];
		if (this.config.includeGlobal && this.config.root !== this.config.globalRoot) roots.push(this.config.globalRoot);
		for (const root of roots) {
			const store = await this.#store(root);
			if (!(await store.read(id))) continue;
			const result = await store.mutate(id, redactSecretFields(mutation, this.session.obfuscator));
			this.#invalidate();
			await this.skills.reconcile((await this.snapshot()).pages);
			return result;
		}
		return { status: "not_found", affectedPages: [] };
	}

	async instructions(): Promise<string> {
		const snapshot = await this.snapshot();
		const preferences: string[] = [];
		for (const page of snapshot.pages) {
			if (page.kind !== "preference" || page.status !== "active") continue;
			const text = `${page.title}: ${page.body} (memory://${page.id}, revision ${page.revision})`;
			if (
				this.session.agent.tokenizer.checkTokenBudget(
					[...preferences, text],
					Math.min(500, this.config.contextTokenLimit),
				).fits
			)
				preferences.push(text);
		}
		return prompt.render(wikiInstructions, { preferences: this.redact(preferences.join("\n")) });
	}

	async autoRecall(query: string): Promise<string | undefined> {
		if (!this.config.autoRecall) return undefined;
		const epoch = ++this.#recallEpoch;
		const result = await this.recall(query);
		if (epoch !== this.#recallEpoch || !result.items.length) return undefined;
		return formatWikiRecall(result);
	}

	reset(): void {
		this.#invalidate();
		this.#seenTurns.clear();
	}

	#invalidate(): void {
		this.#cache.clear();
		this.#recallEpoch++;
		this.lastRecall = undefined;
	}

	async clear(): Promise<void> {
		this.#shutdown.abort();
		await this.#captureChain;
		await Promise.allSettled([...this.#stores.keys()].map(root => maintenanceJobs.get(root)));
		for (const store of this.#stores.values()) await store.clear();
		await this.skills.clear();
		this.#shutdown = new AbortController();
		this.#invalidate();
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#shutdown.abort();
		await this.#captureChain;
		this.#disposed = true;
		try {
			await withTimeout(
				Promise.allSettled([...this.#stores.keys()].map(root => maintenanceJobs.get(root))),
				this.config.timeoutMs + 1000,
				"Wiki maintenance cancellation timed out",
			);
		} finally {
			for (const store of this.#stores.values()) store.close();
			this.#stores.clear();
			this.#cache.clear();
		}
	}

	#report(error: unknown): void {
		if (this.#shutdown.signal.aborted) return;
		this.lastError = this.redact(error instanceof Error ? error.message : String(error));
		logger.warn("Wiki memory background operation failed", { error: this.lastError });
	}
}

export function formatWikiRecall(result: WikiRecallResult): string {
	return result.items
		.map(
			item =>
				`### ${item.title}\n${item.content}\n\nPage: memory://${item.id} (revision ${item.revision}, ${item.updatedAt})${item.conflicted ? " — conflicting evidence" : ""}\nSources: ${item.sources.map(source => `memory://${source.id} (revision ${source.revision})`).join(", ")}`,
		)
		.join("\n\n");
}
