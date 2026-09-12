import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cjkBigramize } from "@oh-my-pi/pi-mnemopi/util/regex";
import { getDbBusyTimeoutMs, isSqliteCorruptionError } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { redactSecrets } from "../secrets/redact";
import {
	assertWikiFile,
	ensureWikiDirectory,
	publishWikiRecords,
	readWikiDiskState,
	type StoredSource,
	type WikiDiskState,
	type WikiRecord,
	wikiDigest,
	wikiId,
	wikiRecordId,
} from "./store-files";
import type {
	WikiCaptureInput,
	WikiMaintenance,
	WikiMutation,
	WikiMutationResult,
	WikiPage,
	WikiPageDraft,
	WikiSnapshot,
	WikiSource,
	WikiSourceRef,
} from "./types";
import {
	diffWikiRevisions,
	historyRevisionInfo,
	listWikiHistory,
	readWikiRevision,
	recordWikiHistory,
	syncWikiHistory,
} from "./history";

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, pending INTEGER NOT NULL,
 status TEXT NOT NULL, cursor TEXT UNIQUE
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(id UNINDEXED, title, summary, body);
`;

function sameRef(left: WikiSourceRef, right: WikiSourceRef): boolean {
	return left.id === right.id && left.revision === right.revision;
}

function sourceRef(source: WikiSourceRef): WikiSourceRef {
	return { id: source.id, revision: source.revision };
}

/** For skill publication: the caller MUST already hold withFileLock(root/index.db). */
export async function readWikiPagesUnlocked(root: string): Promise<WikiPage[]> {
	return (await readWikiDiskState(path.resolve(root))).pages;
}

/** Markdown is authoritative. SQLite contains only a disposable queue and search index. */
export class WikiStore {
	readonly root: string;
	#redact: (text: string) => string;
	#opened = false;

	constructor(options: { root: string; redact?: (text: string) => string }) {
		if (!options.root.trim()) throw new Error("Wiki root must be a dedicated directory");
		this.root = path.resolve(options.root);
		if (this.root === path.parse(this.root).root) throw new Error("Wiki root must be a dedicated directory");
		this.#redact = text => redactSecrets(options.redact ? options.redact(text) : text);
	}

	async open(): Promise<void> {
		await ensureWikiDirectory(this.root);
		await assertWikiFile(path.join(this.root, "index.db.lock"), true);
		await withFileLock(path.join(this.root, "index.db"), async () => {
			const state = await readWikiDiskState(this.root);
			await syncWikiHistory(this.root, state);
			const db = await this.#openIndex();
			try {
				this.#syncIndex(db, state);
			} finally {
				db.close();
			}
		});
		this.#opened = true;
	}

	close(): void {
		this.#opened = false;
	}

	async capture(input: WikiCaptureInput): Promise<WikiSource> {
		const content = this.#text(input.content);
		const context = this.#optionalText(input.context);
		const source = this.#optionalText(input.source);
		// Cursors are opaque identities, not knowledge. Never persist a credential-bearing raw cursor.
		const cursor =
			input.cursor === undefined ? undefined : `sha256:${wikiDigest(`${this.root}\0${this.#cursor(input.cursor)}`)}`;
		return this.#run(async (state, db) => {
			if (cursor) {
				for (const record of state.records.values()) {
					if (record.type === "page") continue;
					const existingCursor = record.type === "forgotten" ? record.cursor : record.value.cursor;
					if (existingCursor !== cursor) continue;
					if (record.type === "forgotten" || record.value.status !== "active") {
						throw new Error("Wiki capture cursor belongs to retired evidence");
					}
					const existing = record.value;
					if (existing.content !== content || existing.context !== context || existing.source !== source) {
						throw new Error("Wiki capture cursor was reused for different evidence");
					}
					return this.#safeSource(existing);
				}
			}
			const now = new Date().toISOString();
			const value: WikiSource = {
				id: `e-${crypto.randomUUID()}`,
				revision: 1,
				content,
				...(context ? { context } : {}),
				...(source ? { source } : {}),
				...(cursor ? { cursor } : {}),
				createdAt: now,
				updatedAt: now,
				status: "active",
			};
			await this.#commit(db, [{ type: "source", value, processedRevision: 0 }], "capture", state);
			return value;
		});
	}

	async snapshot(): Promise<WikiSnapshot> {
		return this.#run(async (state, db) => {
			const pending = db.query<{ id: string }, []>("SELECT id FROM sources WHERE pending = 1 ORDER BY id").all();
			return {
				version: state.version,
				pages: state.pages.map(page => this.#safePage(page)),
				pending: pending.map(({ id }) => this.#safeSource((state.records.get(id) as StoredSource).value)),
			};
		});
	}

	async read(id: string): Promise<WikiPage | WikiSource | null> {
		wikiId(id);
		return this.#run(async state => {
			const record = state.records.get(id);
			if (!record || record.type === "forgotten") return null;
			if (record.type === "source") return this.#safeSource(record.value);
			const page = state.pages.find(page => page.id === id);
			return page ? this.#safePage(page) : null;
		});
	}

	async publish(snapshot: WikiSnapshot, change: WikiMaintenance): Promise<void> {
		return this.#run(async (state, db) => {
			if (snapshot.version !== state.version)
				throw new Error("Stale Wiki snapshot; take a new snapshot before publishing");
			const pages = new Map(state.pages.map(page => [page.id, page]));
			const pending = [...state.records.values()].filter(
				(record): record is StoredSource =>
					record.type === "source" &&
					record.value.status === "active" &&
					record.processedRevision !== record.value.revision,
			);
			if (
				snapshot.pages.length !== pages.size ||
				snapshot.pending.length !== pending.length ||
				new Set(snapshot.pages.map(page => page.id)).size !== snapshot.pages.length ||
				new Set(snapshot.pending.map(source => source.id)).size !== snapshot.pending.length ||
				snapshot.pages.some(page => !pages.has(page.id) || pages.get(page.id)!.revision !== page.revision) ||
				snapshot.pending.some(source => !pending.some(record => sameRef(record.value, source)))
			) {
				throw new Error("Wiki snapshot revisions do not match the current store");
			}
			if (!Array.isArray(change.pages) || !Array.isArray(change.processed))
				throw new Error("Invalid Wiki maintenance");
			const available = new Map<string, number>();
			for (const page of state.pages) for (const ref of page.sources) available.set(ref.id, ref.revision);
			for (const record of pending) available.set(record.value.id, record.value.revision);
			const drafts = new Map<string, WikiPageDraft>();
			for (const draft of change.pages) {
				this.#safeId(draft.id, "w");
				if (drafts.has(draft.id)) throw new Error("Duplicate Wiki page draft");
				drafts.set(draft.id, draft);
			}
			const writes: WikiRecord[] = [];
			const now = new Date().toISOString();
			for (const draft of drafts.values()) {
				const previous = pages.get(draft.id);
				const stored = state.records.get(draft.id);
				if (
					previous
						? draft.expectedRevision !== previous.revision
						: draft.expectedRevision !== null || stored?.type === "forgotten"
				) {
					throw new Error("Wiki page revision changed or identifier was retired");
				}
				if (
					!Array.isArray(draft.sources) ||
					!draft.sources.length ||
					!Array.isArray(draft.links) ||
					new Set(draft.sources.map(ref => ref.id)).size !== draft.sources.length ||
					new Set(draft.links).size !== draft.links.length
				) {
					throw new Error("Wiki pages require distinct evidence references and links");
				}
				for (const ref of draft.sources) {
					this.#safeId(ref.id, "e");
					const record = state.records.get(ref.id);
					if (
						record?.type !== "source" ||
						record.value.status !== "active" ||
						!sameRef(record.value, ref) ||
						available.get(ref.id) !== ref.revision
					) {
						throw new Error("Wiki page cites missing, inactive, outdated, or unseen evidence");
					}
				}
				if (!previous && stored && !draft.sources.some(ref => pending.some(record => sameRef(record.value, ref)))) {
					throw new Error("Rebuilding an invalidated Wiki page requires fresh pending evidence");
				}
				if (previous?.sources.some(ref => !draft.sources.some(next => sameRef(ref, next)))) {
					throw new Error("Wiki page update would discard prior evidence lineage");
				}
				for (const link of draft.links) {
					this.#safeId(link, "w");
					if (link === draft.id || (!pages.has(link) && !drafts.has(link)))
						throw new Error("Wiki page links to an unknown page");
				}
				if (draft.status !== "active" && draft.status !== "conflicted")
					throw new Error("Invalid Wiki draft status");
				const value = this.#safePage({
					id: draft.id,
					revision: (stored?.type === "page" ? stored.value.revision : 0) + 1,
					title: draft.title,
					summary: draft.summary,
					body: draft.body,
					kind: draft.kind,
					status: draft.status,
					sources: draft.sources.map(sourceRef),
					links: [...draft.links],
					updatedAt: now,
				});
				this.#validateInlineReferences(value);
				writes.push({ type: "page", value });
			}
			const processed = new Set<string>();
			for (const ref of change.processed) {
				if (processed.has(ref.id) || !pending.some(record => sameRef(record.value, ref))) {
					throw new Error("Wiki processing acknowledgement is stale or was not pending");
				}
				processed.add(ref.id);
				const record = state.records.get(ref.id) as StoredSource;
				writes.push({ ...record, processedRevision: ref.revision });
			}
			await this.#commit(db, writes);
		});
	}

	async mutate(id: string, mutation: WikiMutation): Promise<WikiMutationResult> {
		wikiId(id);
		if (!["update", "invalidate", "forget"].includes(mutation.op)) throw new Error("Invalid Wiki mutation");
		if (mutation.importance !== undefined) throw new Error("Wiki evidence does not have an importance score");
		const content = mutation.op === "update" ? this.#text(mutation.content ?? "") : undefined;
		return this.#run(async (state, db) => {
			const record = state.records.get(id);
			if (!record || record.type === "forgotten") return { status: "not_found", affectedPages: [] };
			if (mutation.replacementId !== undefined) {
				wikiId(mutation.replacementId, id.startsWith("e-") ? "e" : "w");
				const replacement = state.records.get(mutation.replacementId);
				if (
					mutation.replacementId === id ||
					!replacement ||
					replacement.type === "forgotten" ||
					replacement.value.status !== "active"
				) {
					throw new Error("Wiki replacement must be a distinct active record in this store");
				}
			}
			const writes = new Map<string, WikiRecord>();
			const affected = new Set<string>();
			const now = new Date().toISOString();
			const put = (value: WikiRecord) => writes.set(wikiRecordId(value), value);
			const forget = (value: WikiRecord) => {
				if (value.type === "forgotten") return;
				put({
					type: "forgotten",
					id: value.value.id,
					revision: value.value.revision + 1,
					...(value.type === "source" && value.value.cursor ? { cursor: value.value.cursor } : {}),
				});
			};
			const retireSource = (source: StoredSource, purge: boolean) => {
				if (purge) forget(source);
				else
					put({
						...source,
						processedRevision: 0,
						value: {
							...source.value,
							revision: source.value.revision + 1,
							status: "invalidated",
							updatedAt: now,
						},
					});
			};
			if (record.type === "source") {
				if (mutation.op === "forget") forget(record);
				else
					put({
						...record,
						processedRevision: 0,
						value: {
							...record.value,
							revision: record.value.revision + 1,
							updatedAt: now,
							status: mutation.op === "update" ? "active" : "invalidated",
							...(content !== undefined
								? {
										content,
										source: "manual-correction",
										context: `User correction of ${id} revision ${record.value.revision}`,
									}
								: {}),
							...(mutation.replacementId ? { context: `Superseded by ${mutation.replacementId}` } : {}),
						},
					});
				for (const candidate of state.records.values()) {
					if (candidate.type !== "page" || !candidate.value.sources.some(ref => ref.id === id)) continue;
					affected.add(candidate.value.id);
					if (mutation.op === "forget") forget(candidate);
					else
						put({
							type: "page",
							value: {
								...candidate.value,
								revision: candidate.value.revision + 1,
								status: "invalidated",
								updatedAt: now,
							},
						});
					for (const ref of candidate.value.sources) {
						if (ref.id === id) continue;
						const surviving = state.records.get(ref.id);
						if (surviving?.type === "source" && surviving.value.status === "active")
							put({ ...surviving, processedRevision: 0 });
					}
				}
			} else {
				affected.add(id);
				// A page does not own shared transcript evidence or navigational backlinks.
				for (const ref of record.value.sources) {
					const supporting = state.records.get(ref.id);
					if (supporting?.type !== "source") continue;
					const shared = [...state.records.values()].some(
						candidate =>
							candidate.type === "page" &&
							candidate.value.id !== id &&
							candidate.value.status !== "invalidated" &&
							candidate.value.sources.some(other => other.id === ref.id),
					);
					if (!shared) {
						if (mutation.op !== "invalidate") retireSource(supporting, mutation.op === "forget");
						if (mutation.op === "forget") {
							for (const candidate of state.records.values()) {
								if (
									candidate.type === "page" &&
									candidate.value.id !== id &&
									candidate.value.sources.some(other => other.id === ref.id)
								) {
									forget(candidate);
									affected.add(candidate.value.id);
								}
							}
						}
					}
				}
				if (mutation.op === "forget") forget(record);
				else if (mutation.op === "invalidate")
					put({
						type: "page",
						value: {
							...record.value,
							revision: record.value.revision + 1,
							status: "invalidated",
							updatedAt: now,
						},
					});
				else {
					const correction: WikiSource = {
						id: `e-${crypto.randomUUID()}`,
						revision: 1,
						content: content!,
						source: "manual-correction",
						context: `User correction of ${id} revision ${record.value.revision}; replaces evidence ${record.value.sources.map(ref => `${ref.id}@${ref.revision}`).join(", ")}`,
						createdAt: now,
						updatedAt: now,
						status: "active",
					};
					put({ type: "source", value: correction, processedRevision: 1 });
					put({
						type: "page",
						value: {
							...record.value,
							revision: record.value.revision + 1,
							body: content!,
							summary: content!,
							sources: [sourceRef(correction)],
							status: "active",
							updatedAt: now,
						},
					});
				}
			}
			await this.#commit(db, [...writes.values()], mutation.op === "forget" ? "invalidate" : mutation.op, state);
			return {
				status: mutation.op === "update" ? "updated" : mutation.op === "forget" ? "deleted" : "invalidated",
				affectedPages: [...affected].sort(),
			};
		});
	}

	/** List immutable revisions; forgotten records intentionally have no history. */
	async history(id: string) {
		wikiId(id);
		return this.#run(async state => (await listWikiHistory(this.root, state, id)).map(historyRevisionInfo));
	}

	async readRevision(id: string, revision: number) {
		wikiId(id);
		return this.#run(async state => readWikiRevision(this.root, state, id, revision));
	}

	async diff(id: string, fromRevision: number, toRevision: number): Promise<string> {
		wikiId(id);
		return this.#run(async state => diffWikiRevisions(this.root, state, id, fromRevision, toRevision));
	}

	/** Restore an old revision as a new current revision; history remains immutable. */
	async restore(id: string, revision: number) {
		wikiId(id);
		return this.#run(async (state, db) => {
			const current = state.records.get(id);
			if (!current || current.type === "forgotten") throw new Error(`Wiki record ${id} was forgotten or not found`);
			const historical = await readWikiRevision(this.root, state, id, revision);
			if (!historical || revision >= current.value.revision)
				throw new Error(`Wiki historical revision ${id}@${revision} is not restorable`);
			const now = new Date().toISOString();
			const writes: WikiRecord[] = [];
			const affectedPages = new Set<string>();
			if (current.type === "page") {
				if (historical.type !== "page" || !("sources" in historical.record))
					throw new Error("Wiki revision type changed");
				for (const ref of historical.record.sources) {
					const source = state.records.get(ref.id);
					if (
						source?.type !== "source" ||
						source.value.status !== "active" ||
						source.value.revision !== ref.revision
					)
						throw new Error("Wiki page revision depends on unavailable evidence; restore the evidence first");
				}
				writes.push({
					type: "page",
					value: { ...historical.record, revision: current.value.revision + 1, status: "active", updatedAt: now },
				});
			} else {
				if (historical.type !== "source" || !("content" in historical.record))
					throw new Error("Wiki revision type changed");
				writes.push({
					type: "source",
					processedRevision: 0,
					value: { ...historical.record, revision: current.value.revision + 1, status: "active", updatedAt: now },
				});
				for (const candidate of state.records.values()) {
					if (candidate.type !== "page" || !candidate.value.sources.some(ref => ref.id === id)) continue;
					affectedPages.add(candidate.value.id);
					writes.push({
						type: "page",
						value: {
							...candidate.value,
							revision: candidate.value.revision + 1,
							status: "invalidated",
							updatedAt: now,
						},
					});
				}
			}
			await this.#commit(db, writes, "restore", state, revision);
			return {
				id,
				revision: current.value.revision + 1,
				restoredFrom: revision,
				affectedPages: [...affectedPages].sort(),
			};
		});
	}

	async clear(): Promise<void> {
		await this.#run(async (state, db) => {
			await publishWikiRecords(this.root, [], [...state.records.keys()]);
			await syncWikiHistory(this.root, await readWikiDiskState(this.root));
			this.#syncIndex(db, await readWikiDiskState(this.root));
		});
	}

	async search(query: string, limit = 20): Promise<WikiPage[]> {
		const count = Math.max(0, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 20));
		const terms = [
			...new Set(
				cjkBigramize(this.#redact(query))
					.toLowerCase()
					.match(/[\p{L}\p{N}]+/gu) ?? [],
			),
		].slice(0, 64);
		if (!count || !terms.length) return [];
		return this.#run(async (state, db) => {
			const expression = terms.map(term => `"${term}"`).join(" OR ");
			const rows = db
				.query<{ id: string }, [string, number]>(
					"SELECT id FROM pages_fts WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 0, 5, 2, 1), id LIMIT ?",
				)
				.all(expression, count);
			const pages = new Map(state.pages.map(page => [page.id, page]));
			return rows.flatMap(({ id }) => (pages.has(id) ? [this.#safePage(pages.get(id)!)] : []));
		});
	}

	#cursor(cursor: string): string {
		if (typeof cursor !== "string" || !cursor.trim()) throw new Error("Wiki capture cursor cannot be empty");
		return cursor;
	}

	#text(value: string): string {
		if (typeof value !== "string") throw new Error("Wiki evidence must be text");
		const result = this.#redact(value)
			.replace(/\r\n?/g, "\n")
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
			.trim();
		if (!result || !result.replaceAll("[REDACTED]", "").trim())
			throw new Error("Wiki evidence is empty after sanitization");
		return result;
	}

	#optionalText(value?: string): string | undefined {
		if (value === undefined) return undefined;
		const result = this.#redact(value)
			.replace(/\r\n?/g, "\n")
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
			.trim();
		return result || undefined;
	}

	#safeId(id: string, prefix: "w" | "e"): string {
		wikiId(id, prefix);
		if (this.#redact(id) !== id) throw new Error("Wiki identifier contains sensitive text");
		return id;
	}

	#safeSource(source: WikiSource): WikiSource {
		const context = this.#optionalText(source.context);
		const origin = this.#optionalText(source.source);
		const cursor = this.#optionalText(source.cursor);
		return {
			id: this.#safeId(source.id, "e"),
			revision: source.revision,
			content: this.#text(source.content),
			...(context ? { context } : {}),
			...(origin ? { source: origin } : {}),
			...(cursor ? { cursor } : {}),
			createdAt: this.#text(source.createdAt),
			updatedAt: this.#text(source.updatedAt),
			status: source.status,
		};
	}

	#safePage(page: WikiPage): WikiPage {
		return {
			id: this.#safeId(page.id, "w"),
			revision: page.revision,
			title: this.#text(page.title),
			summary: this.#text(page.summary),
			body: this.#text(page.body),
			kind: page.kind,
			status: page.status,
			updatedAt: this.#text(page.updatedAt),
			sources: page.sources.map(ref => ({ id: this.#safeId(ref.id, "e"), revision: ref.revision })),
			links: page.links.map(id => this.#safeId(id, "w")),
		};
	}

	#validateInlineReferences(page: WikiPage): void {
		// Validate explicit internal citations without treating ordinary technical prose as a link.
		const text = `${page.title}\n${page.summary}\n${page.body}`;
		for (const match of text.matchAll(/memory:\/\/([^\s)\]>"#?]+)(?:[?#](?:revision=)?(\d+))?/g)) {
			const id = match[1]!;
			const ref = page.sources.find(ref => ref.id === id);
			if (!ref && !page.links.includes(id)) throw new Error("Wiki body contains an undeclared internal citation");
			if (match[2] && (!ref || ref.revision !== Number(match[2])))
				throw new Error("Wiki body cites an outdated evidence revision");
		}
		for (const match of text.matchAll(/\[\[([we]-[^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
			if (!page.links.includes(match[1]!) && !page.sources.some(ref => ref.id === match[1]))
				throw new Error("Wiki body contains an undeclared Wiki link");
		}
		for (const match of text.matchAll(/\b(e-[a-z0-9][a-z0-9-]*)@(\d+)\b/g)) {
			if (!page.sources.some(ref => ref.id === match[1] && ref.revision === Number(match[2]))) {
				throw new Error("Wiki body contains an invented or outdated evidence citation");
			}
		}
	}

	async #run<T>(operation: (state: WikiDiskState, db: Database) => Promise<T>): Promise<T> {
		if (!this.#opened) throw new Error("Wiki store is not open");
		await ensureWikiDirectory(this.root);
		await assertWikiFile(path.join(this.root, "index.db.lock"), true);
		return withFileLock(path.join(this.root, "index.db"), async () => {
			const state = await readWikiDiskState(this.root);
			const db = await this.#openIndex();
			try {
				this.#syncIndex(db, state);
				return await operation(state, db);
			} finally {
				db.close();
			}
		});
	}

	async #commit(
		db: Database,
		writes: WikiRecord[],
		operation: "baseline" | "capture" | "publish" | "update" | "invalidate" | "restore" = "publish",
		before?: WikiDiskState,
		restoredFrom?: number,
	): Promise<void> {
		const previous = before ?? (await readWikiDiskState(this.root));
		const safe = writes.map((record): WikiRecord => {
			if (record.type === "source") return { ...record, value: this.#safeSource(record.value) };
			if (record.type === "page") return { ...record, value: this.#safePage(record.value) };
			return {
				type: "forgotten",
				id: this.#safeId(record.id, record.id.startsWith("e-") ? "e" : "w"),
				revision: record.revision,
				...(record.cursor ? { cursor: this.#optionalText(record.cursor) } : {}),
			};
		});
		await publishWikiRecords(this.root, safe);
		await recordWikiHistory(this.root, previous, safe, operation, restoredFrom);
		this.#syncIndex(db, await readWikiDiskState(this.root));
	}

	async #openIndex(): Promise<Database> {
		const file = path.join(this.root, "index.db");
		for (const suffix of ["", "-journal", "-wal", "-shm", ".lock"]) await assertWikiFile(`${file}${suffix}`, true);
		if (!(await assertWikiFile(file, true))) await fs.writeFile(file, "", { flag: "wx", mode: 0o600 });
		await fs.chmod(file, 0o600);
		const create = (): Database => {
			const db = new Database(file, { create: true });
			try {
				db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
				db.run("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
				db.run(INDEX_SCHEMA);
				return db;
			} catch (error) {
				db.close();
				throw error;
			}
		};
		let db: Database;
		try {
			db = create();
		} catch (error) {
			if (!isSqliteCorruptionError(error)) throw error;
			// No evidence is lost: rebuild only the disposable index, never quarantine a second content copy.
			for (const suffix of ["", "-journal", "-wal", "-shm"]) {
				if (await assertWikiFile(`${file}${suffix}`, true)) await fs.unlink(`${file}${suffix}`);
			}
			await fs.writeFile(file, "", { flag: "wx", mode: 0o600 });
			db = create();
		}
		return db;
	}

	#syncIndex(db: Database, state: WikiDiskState): void {
		const indexed = db.query<{ value: string }, []>("SELECT value FROM state WHERE key = 'version'").get();
		if (indexed?.value === state.version) {
			const counts = db
				.query<{ pages: number; sources: number }, []>(
					"SELECT (SELECT count(*) FROM pages_fts) AS pages, (SELECT count(*) FROM sources) AS sources",
				)
				.get()!;
			let sources = 0;
			for (const record of state.records.values()) if (record.type === "source") sources++;
			if (counts.pages === state.pages.length && counts.sources === sources) return;
		}
		db.transaction(() => {
			// Rebuild FTS under secure_delete: retired excerpts must not remain in old FTS segments.
			db.run(
				"DROP TABLE pages_fts; CREATE VIRTUAL TABLE pages_fts USING fts5(id UNINDEXED, title, summary, body); DELETE FROM sources;",
			);
			const insertSource = db.prepare(
				"INSERT INTO sources(id, revision, pending, status, cursor) VALUES (?, ?, ?, ?, ?)",
			);
			for (const record of state.records.values()) {
				if (record.type !== "source") continue;
				const source = this.#safeSource(record.value);
				insertSource.run(
					source.id,
					source.revision,
					source.status === "active" && record.processedRevision !== source.revision ? 1 : 0,
					source.status,
					source.cursor ?? null,
				);
			}
			const insertPage = db.prepare("INSERT INTO pages_fts(id, title, summary, body) VALUES (?, ?, ?, ?)");
			for (const page of state.pages) {
				const safe = this.#safePage(page);
				insertPage.run(safe.id, cjkBigramize(safe.title), cjkBigramize(safe.summary), cjkBigramize(safe.body));
			}
			db.run("INSERT OR REPLACE INTO state(key, value) VALUES ('version', ?)", [state.version]);
		})();
	}
}
