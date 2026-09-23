/**
 * Memory backend abstraction.
 *
 * Backends are mutually exclusive — `await resolveMemoryBackend(settings)` returns
 * exactly one. Implementations MUST be self-contained: they own the per-session
 * state they create in `start()` and tear it down on `clear()`.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";

export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "sharpshooter" | "wiki";

export interface MemoryBackendCapabilities {
	writable: boolean;
	searchable: boolean;
	readable: boolean;
	editable: boolean;
	reflective: boolean;
	/** Whether the standalone retain tool is available (local lessons use learn). */
	retainable: boolean;
	/** Whether learn may write managed skills without the backend's candidate gate. */
	directSkills: boolean;
	saveApproval: "read" | "write";
}

/** Shared synchronous factory gates; importing this table never loads a backend. */
export const memoryBackendCapabilities = {
	off: {
		writable: false,
		searchable: false,
		readable: false,
		editable: false,
		reflective: false,
		retainable: false,
		directSkills: false,
		saveApproval: "read",
	},
	local: {
		writable: true,
		searchable: false,
		readable: false,
		editable: false,
		reflective: false,
		retainable: false,
		directSkills: true,
		saveApproval: "write",
	},
	hindsight: {
		writable: true,
		searchable: true,
		readable: false,
		editable: false,
		reflective: true,
		retainable: true,
		directSkills: true,
		saveApproval: "read",
	},
	mnemopi: {
		writable: true,
		searchable: true,
		readable: true,
		editable: true,
		reflective: true,
		retainable: true,
		directSkills: true,
		saveApproval: "read",
	},
	sharpshooter: {
		writable: false,
		searchable: true,
		readable: false,
		editable: false,
		reflective: false,
		retainable: false,
		directSkills: false,
		saveApproval: "read",
	},
	wiki: {
		writable: true,
		searchable: true,
		readable: true,
		editable: true,
		reflective: true,
		retainable: true,
		directSkills: false,
		saveApproval: "read",
	},
} as const satisfies Record<MemoryBackendId, MemoryBackendCapabilities>;

export interface MemoryBackendStatus {
	backend: MemoryBackendId;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

export interface MemoryBackendSearchOptions {
	limit?: number;
	maxChars?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying recall call. */
	signal?: AbortSignal;
}

export interface MemoryBackendReadOptions {
	revision?: number;
}

export interface MemoryBackendSearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
	revision?: number;
	sources?: { id: string; revision: number }[];
	conflicted?: boolean;
	metadata?: Record<string, unknown>;
}

export interface MemoryBackendSearchResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendSearchItem[];
	message?: string;
	/** Backend-rendered evidence, including its full-content read references. */
	text?: string;
	/** A failed/unavailable search is not a successful empty search. */
	error?: string;
}

export interface MemoryBackendSaveInput {
	content: string;
	context?: string;
	source?: string;
	importance?: number;
	/** Explicit scope is never silently ignored by a backend. */
	scope?: "project" | "global";
	/** Native tool provenance; other callers retain their existing user-save semantics. */
	tool?: "retain" | "learn";
}

export interface MemoryBackendSaveResult {
	backend: MemoryBackendId;
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
	error?: string;
}

export interface MemoryBackendReadResult {
	backend: MemoryBackendId;
	id: string;
	status: "found" | "not_found" | "unavailable";
	content?: string;
	source?: string;
	timestamp?: string;
	revision?: number;
	sources?: { id: string; revision: number }[];
	conflicted?: boolean;
	metadata?: Record<string, unknown>;
	message?: string;
	error?: string;
}

export interface MemoryBackendEditInput {
	op: "update" | "forget" | "invalidate";
	id: string;
	content?: string;
	importance?: number;
	replacementId?: string;
}

export interface MemoryBackendEditResult {
	backend: MemoryBackendId;
	id: string;
	status: "updated" | "deleted" | "invalidated" | "not_found" | "not_editable" | "unavailable";
	bank?: string;
	store?: string;
	affectedPages?: string[];
	message?: string;
	error?: string;
}

export interface MemoryBackendReflectOptions extends MemoryBackendSearchOptions {
	context?: string;
}

export interface MemoryBackendReflectResult {
	backend: MemoryBackendId;
	query: string;
	text: string;
	items?: MemoryBackendSearchItem[];
	error?: string;
}

export interface MemoryBackendOperationContext {
	agentDir: string;
	cwd: string;
	session?: AgentSession;
}

export interface MemoryRuntimeContext {
	status(): Promise<MemoryBackendStatus>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	read(id: string, options?: MemoryBackendReadOptions): Promise<MemoryBackendReadResult>;
	edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;
	reflect(query: string, options?: MemoryBackendReflectOptions): Promise<MemoryBackendReflectResult>;
}

export interface MemoryBackendStartOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
}

/** A successful recall, including an empty result, staged until user-turn delivery. */
export interface MemoryPromptPreparation {
	context?: string;
	/** Commit synchronously after delivery validation; false rejects lost ownership without state writes. */
	commit(): boolean;
}

export interface MemoryBackend {
	readonly id: MemoryBackendId;
	readonly capabilities: MemoryBackendCapabilities;

	/**
	 * Wire any background work or session subscriptions for this backend.
	 *
	 * Called once per agent session at startup. Implementations MUST be
	 * non-throwing: failures should be logged and swallowed so a misconfigured
	 * memory backend cannot break the agent loop.
	 */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/** Drain session-owned work and release resources on shutdown or backend transition. */
	dispose?(context: MemoryBackendOperationContext): Promise<void>;

	/** Reset transcript cursors and prompt caches without clearing persisted memory. */
	reset?(session: AgentSession): void;

	/**
	 * Markdown injected as the system-prompt append section.
	 * Returned on every prompt rebuild via `refreshBaseSystemPrompt()`.
	 */
	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Structured state for UI, slash commands, and extensions. */
	status?(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus>;

	/** Explicit user-facing semantic/lexical search. */
	search?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult>;

	/** Explicit user-facing save operation. */
	save?(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;

	/** Read the full stored content behind a recall preview. */
	read?(
		context: MemoryBackendOperationContext,
		id: string,
		options?: MemoryBackendReadOptions,
	): Promise<MemoryBackendReadResult>;

	/** Correct, forget, or supersede a memory within this session's allowed scope. */
	edit?(context: MemoryBackendOperationContext, input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;

	/** Backend-owned reflection; evidence-only backends MUST NOT fabricate a synthesized answer. */
	reflect?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendReflectOptions,
	): Promise<MemoryBackendReflectResult>;

	/** Render backend-specific memory statistics as markdown (`/memory stats`). */
	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	/** Render backend-specific memory diagnostics as markdown (`/memory diagnose`). */
	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	/** Render pending deltas awaiting consolidation (`/memory queue`). */
	queuePreview?(context: MemoryBackendOperationContext): Promise<string | undefined>;
	/**
	 * Optional hook to inject a backend-specific block into the current turn's
	 * system prompt before the agent starts generating.
	 *
	 * This is the only place a backend can affect the very first answer of a
	 * fresh session. Context is appended to the winning base prompt at delivery;
	 * commit publishes the cached snippet and first-turn consumption together.
	 * Return undefined for an ineligible or failed recall, not an empty success.
	 */
	beforeAgentStartPrompt?(
		session: AgentSession,
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined>;

	/**
	 * Optional hook to splice extra context into a compaction summarization.
	 *
	 * Called from the compaction call site before the LLM summary is requested.
	 * Returning a string appends one entry to the compaction's `extraContext`
	 * list (which becomes part of the summarization prompt). Return `undefined`
	 * to inject nothing — the local backend takes this branch because its
	 * summary is already part of the system prompt.
	 */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;
}
