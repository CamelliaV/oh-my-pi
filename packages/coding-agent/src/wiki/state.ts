import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, truncate, withTimeout } from "@oh-my-pi/pi-utils";
import { stripMemoryTags } from "../hindsight/content";
import type { MemoryBackendSaveInput } from "../memory-backend/types";
import wikiInstructions from "../prompts/wiki/instructions.md" with { type: "text" };
import { redactSecretFields, redactSecrets } from "../secrets/redact";
import type { AgentSession } from "../session/agent-session";
import type { WikiConfig } from "./config";
import { wikiSourceEvidence } from "./evidence";
import { maintainWiki, WikiMaintenanceError } from "./maintain";
import type { WikiUsage } from "./model";
import { recallWiki } from "./recall";
import { WikiSkills } from "./skills";
import { WikiStore } from "./store";
import type {
	WikiComplete,
	WikiMaintenanceStatus,
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
const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

export function getWikiState(session?: AgentSession): WikiState | undefined {
	return session ? states.get(session) : undefined;
}

export function setWikiState(session: AgentSession, state?: WikiState): WikiState | undefined {
	const previous = states.get(session);
	if (state) states.set(session, state);
	else states.delete(session);
	return previous;
}

/** Keep user corrections even without tool use; assistant speech remains explicitly attributed. */
export function wikiTurnEvidence(
	messages: readonly AgentMessage[],
	redact: (text: string) => string = redactSecrets,
): string | undefined {
	const start = messages.findLastIndex(message => message.role === "user");
	if (start < 0) return undefined;
	const records: Array<{ role: string; content: string; tool?: string; error?: boolean }> = [];
	let remaining = MAX_TURN_CHARS;
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
			records.push({ role: "toolResult", tool: message.toolName, error: message.isError, content: captured });
		} else {
			records.push({ role: message.role, content: captured });
		}
	}
	return records.some(record => record.role === "user") ? JSON.stringify(records) : undefined;
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
	#automatic = false;
	#maintenanceTimer?: NodeJS.Timeout;
	#maintenanceRuns = new Set<Promise<void>>();

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
		this.#automatic = automatic && this.config.autoMaintain;
		this.#clearMaintenanceTimer();
		if (!automatic) return;
		this.#unsubscribe = this.session.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal === false || !this.config.autoRetain || this.#disposed)
				return;
			const content = wikiTurnEvidence(event.messages, text => this.redact(text));
			if (!content) return;
			const userTimestamp = event.messages.findLast(message => message.role === "user")?.timestamp;
			const cursor = `${this.session.sessionId}:${userTimestamp ?? 0}:${Bun.hash(content).toString(16)}`;
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
			if (this.#automatic) this.#scheduleMaintenance(0);
		});
		if (this.#automatic) this.#scheduleMaintenance(0);
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
		if (input.source === "task-observations")
			throw new Error("Native Wiki observation provenance is reserved for automatic capture");
		if (root !== this.config.root && !(this.config.includeGlobal && root === this.config.globalRoot))
			throw new Error("The requested Wiki write scope is not readable in this session");
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
		if (this.#automatic) this.#scheduleMaintenance(0);
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
			sources: snapshots.flatMap(snapshot => snapshot.sources ?? snapshot.pending),
			failures: snapshots.flatMap(snapshot => snapshot.failures ?? []),
		};
	}

	maintain(force = true): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		const run = this.#maintain(force);
		this.#maintenanceRuns.add(run);
		void run.then(
			() => this.#maintenanceRuns.delete(run),
			() => this.#maintenanceRuns.delete(run),
		);
		return run;
	}

	async #maintain(force: boolean): Promise<void> {
		await this.#captureChain;
		try {
			for (const [root, store] of this.#stores) {
				// Another session may have taken its snapshot before our newest capture.
				while (maintenanceJobs.has(root)) {
					await maintenanceJobs.get(root)?.catch(() => {});
					this.#shutdown.signal.throwIfAborted();
				}
				const job = this.#drainStore(store, force);
				maintenanceJobs.set(root, job);
				try {
					await job;
				} finally {
					if (maintenanceJobs.get(root) === job) maintenanceJobs.delete(root);
				}
			}
			await this.skills.reconcile((await this.snapshot()).pages);
			const status = await this.maintenanceStatus();
			this.lastError = status.lastError;
			if (force && status.failed)
				throw new Error(`${status.failed} Wiki source(s) remain failed: ${status.lastError}`);
		} finally {
			if (this.#automatic && !this.#shutdown.signal.aborted) await this.#schedulePendingMaintenance();
		}
	}

	async #drainStore(store: WikiStore, force: boolean): Promise<void> {
		const initial = await store.snapshot();
		const now = Date.now();
		const failures = new Map((initial.failures ?? []).map(failure => [failure.id, failure]));
		const eligible = initial.pending.filter(source => {
			const failure = failures.get(source.id);
			return (
				force || !failure || (failure.attempts < MAX_AUTOMATIC_ATTEMPTS && Date.parse(failure.nextRetryAt) <= now)
			);
		});
		const selected = force ? eligible : eligible.slice(0, this.config.batchSize);
		for (const source of selected) {
			this.#shutdown.signal.throwIfAborted();
			const snapshot = await store.snapshot();
			if (!snapshot.pending.some(current => current.id === source.id && current.revision === source.revision))
				continue;
			try {
				const change = await maintainWiki({ ...snapshot, pending: [source] }, this.#complete, {
					limit: this.config.batchSize,
					signal: this.#shutdown.signal,
				});
				if (!change.processed.some(ref => ref.id === source.id && ref.revision === source.revision))
					throw new WikiMaintenanceError("response", "Wiki maintenance made no progress on the supplied source");
				this.#shutdown.signal.throwIfAborted();
				await store.publish(snapshot, change);
				this.#invalidate();
			} catch (error) {
				this.#shutdown.signal.throwIfAborted();
				const message = this.#errorMessage(error);
				const attempts = failures.get(source.id)?.attempts ?? 0;
				const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS * 2 ** Math.min(attempts, 6)).toISOString();
				await store.markMaintenanceFailure(source, message, nextRetryAt);
				this.#report(error);
				// A failing source never prevents later evidence, including corrections, from being considered.
			}
		}
	}

	async maintenanceStatus(): Promise<WikiMaintenanceStatus> {
		const snapshot = await this.snapshot();
		const failures = snapshot.failures ?? [];
		const next = failures
			.filter(failure => failure.attempts < MAX_AUTOMATIC_ATTEMPTS)
			.sort((a, b) => a.nextRetryAt.localeCompare(b.nextRetryAt))[0];
		return {
			pending: snapshot.pending.length,
			failed: failures.length,
			...(next ? { nextRetryAt: next.nextRetryAt } : {}),
			...(failures.length
				? {
						lastError: failures
							.map(
								failure =>
									`${failure.id}: ${failure.lastError}${failure.attempts >= MAX_AUTOMATIC_ATTEMPTS ? " (automatic retries paused; /memory sync retries)" : ""}`,
							)
							.join("; "),
					}
				: {}),
		};
	}

	#clearMaintenanceTimer(): void {
		clearTimeout(this.#maintenanceTimer);
		this.#maintenanceTimer = undefined;
	}

	#scheduleMaintenance(delay: number): void {
		if (!this.#automatic || this.#disposed || this.#shutdown.signal.aborted) return;
		this.#clearMaintenanceTimer();
		this.#maintenanceTimer = setTimeout(() => {
			this.#maintenanceTimer = undefined;
			void this.maintain(false).catch(error => this.#report(error));
		}, delay);
		this.#maintenanceTimer.unref();
	}

	async #schedulePendingMaintenance(): Promise<void> {
		const snapshot = await this.snapshot();
		const failures = new Map((snapshot.failures ?? []).map(failure => [failure.id, failure]));
		let next = Number.POSITIVE_INFINITY;
		for (const source of snapshot.pending) {
			const failure = failures.get(source.id);
			if (!failure) next = 0;
			else if (failure.attempts < MAX_AUTOMATIC_ATTEMPTS) next = Math.min(next, Date.parse(failure.nextRetryAt));
		}
		if (Number.isFinite(next)) this.#scheduleMaintenance(Math.max(100, next - Date.now()));
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
			sources: snapshot.sources ?? snapshot.pending,
			pending: snapshot.pending,
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
		const bounded: WikiRecallResult = { ...result, status: items.length ? "found" : "not_found", items };
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
		const sources = new Map((snapshot.sources ?? []).map(source => [source.id, source]));
		const preferences: string[] = [];
		for (const page of snapshot.pages.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			if (page.kind !== "preference" || page.status !== "active") continue;
			for (const evidence of page.evidence ?? []) {
				const source = sources.get(evidence.id);
				if (
					!source ||
					source.revision !== evidence.revision ||
					evidence.role !== "user" ||
					wikiSourceEvidence(source, evidence.quote, evidence.passage)?.role !== "user"
				)
					continue;
				const text = `${evidence.quote} (memory://${source.id}, revision ${source.revision})`;
				if (
					this.session.agent.tokenizer.checkTokenBudget(
						[...preferences, text],
						Math.min(500, this.config.contextTokenLimit),
					).fits
				)
					preferences.push(text);
			}
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
		this.#clearMaintenanceTimer();
		this.#shutdown.abort();
		await this.#captureChain;
		await Promise.allSettled([
			...this.#maintenanceRuns,
			...[...this.#stores.keys()].map(root => maintenanceJobs.get(root)),
		]);
		for (const store of this.#stores.values()) await store.clear();
		await this.skills.clear();
		this.#shutdown = new AbortController();
		this.#invalidate();
	}

	async dispose(): Promise<void> {
		this.#automatic = false;
		this.#clearMaintenanceTimer();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#shutdown.abort();
		await this.#captureChain;
		this.#disposed = true;
		try {
			await withTimeout(
				Promise.allSettled([
					...this.#maintenanceRuns,
					...[...this.#stores.keys()].map(root => maintenanceJobs.get(root)),
				]),
				this.config.timeoutMs + 1000,
				"Wiki maintenance cancellation timed out",
			);
		} finally {
			for (const store of this.#stores.values()) store.close();
			this.#stores.clear();
			this.#cache.clear();
		}
	}

	#errorMessage(error: unknown): string {
		const messages: string[] = [];
		const seen = new Set<unknown>();
		let current = error;
		while (current !== undefined && !seen.has(current) && messages.length < 5) {
			seen.add(current);
			messages.push(current instanceof Error ? current.message : String(current));
			current = current instanceof Error ? current.cause : undefined;
		}
		return truncate(this.redact(messages.join(": ")), 2000);
	}

	#report(error: unknown): void {
		if (this.#shutdown.signal.aborted) return;
		this.lastError = this.#errorMessage(error);
		logger.warn("Wiki memory background operation failed", { error: this.lastError });
	}
}

export function formatWikiRecall(result: WikiRecallResult): string {
	const health = [
		result.pending
			? `${result.pending} source(s) are not yet compiled; source excerpts below remain uncompiled evidence.`
			: "",
		result.degraded ? `Wiki maintenance/retrieval warning: ${result.degraded}` : "",
	].filter(Boolean);
	const excerpts = result.items.map(
		item =>
			`### ${item.title}\n${item.content}\n\n${item.kind === "source" ? `Source (${item.role ?? "unknown"}${item.pending ? ", pending compilation" : ""})` : "Derived page"}: memory://${item.id} (revision ${item.revision}, ${item.updatedAt})${item.conflicted ? " — conflicting evidence" : ""}\nSources: ${item.sources.map(source => `memory://${source.id} (revision ${source.revision})`).join(", ")}`,
	);
	return [
		...health,
		...(excerpts.length
			? excerpts
			: [
					result.pending
						? "No matching excerpt found in the current search; pending evidence exists."
						: "No supporting Wiki evidence found.",
				]),
	].join("\n\n");
}
