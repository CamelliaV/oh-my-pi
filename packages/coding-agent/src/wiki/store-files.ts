import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import * as atomicFile from "../utils/atomic-file";
import type { WikiEvidence, WikiMaintenanceFailure, WikiPage, WikiSource } from "./types";

export interface StoredSource {
	type: "source";
	value: WikiSource;
	processedRevision: number;
	maintenance?: WikiMaintenanceFailure;
}

export interface StoredPage {
	type: "page";
	value: WikiPage;
}

export interface ForgottenRecord {
	type: "forgotten";
	id: string;
	revision: number;
	cursor?: string;
}

export type WikiRecord = StoredSource | StoredPage | ForgottenRecord;

export interface WikiDiskState {
	version: string;
	records: Map<string, WikiRecord>;
	pages: WikiPage[];
}

interface TransactionEntry {
	target: string;
	staged: string | null;
	sha256: string | null;
}

interface Transaction {
	format: 1;
	directory: string;
	entries: TransactionEntry[];
}

const ID = /^[we]-[a-z0-9][a-z0-9-]{0,95}$/;
const STAGING = /^\.wiki-txn-[0-9a-f-]{36}$/;
const TEMPORARY = /^\.wiki-write-[0-9a-f-]{36}\.tmp$/;
const JOURNAL = ".wiki-transaction.json";

export function wikiId(id: string, prefix?: "w" | "e"): string {
	if (typeof id !== "string" || !ID.test(id) || (prefix && !id.startsWith(`${prefix}-`))) {
		throw new Error("Invalid Wiki record identifier");
	}
	return id;
}

export function wikiRecordId(record: WikiRecord): string {
	return record.type === "forgotten" ? record.id : record.value.id;
}

export function wikiRecordPath(id: string): string {
	wikiId(id);
	return `${id.startsWith("e-") ? "sources" : "pages"}/${id}.md`;
}

export function wikiDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Reject symlink components, including roots supplied through a symlinked parent. */
export async function ensureWikiDirectory(directory: string): Promise<void> {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			await fs.mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Wiki directory");
	}
}

export async function assertWikiFile(file: string, missing = false): Promise<boolean> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe Wiki file");
		return true;
	} catch (error) {
		if (missing && isEnoent(error)) return false;
		throw error;
	}
}

async function readFile(file: string): Promise<string> {
	await assertWikiFile(file);
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe Wiki file");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeExclusive(file: string, content: string): Promise<void> {
	const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function atomicWrite(file: string, content: string): Promise<void> {
	await ensureWikiDirectory(path.dirname(file));
	await assertWikiFile(file, true);
	const temporary = path.join(path.dirname(file), `.wiki-write-${crypto.randomUUID()}.tmp`);
	try {
		await writeExclusive(temporary, content);
		await atomicFile.replaceFileAtomically(temporary, file);
		await syncDirectory(path.dirname(file));
	} finally {
		await fs.unlink(temporary).catch(error => {
			if (!isEnoent(error)) throw error;
		});
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki record metadata");
	return value as Record<string, unknown>;
}

function text(value: unknown, optional = false): string {
	if (optional && value === undefined) return "";
	if (typeof value !== "string" || !value.trim()) throw new Error("Invalid Wiki record text");
	return value;
}

function revision(value: unknown, zero = false): number {
	if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) throw new Error("Invalid Wiki revision");
	return value as number;
}

function timestamp(value: unknown): string {
	const result = text(value);
	if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid Wiki timestamp");
	return result;
}

export function parseWikiRecord(markdown: string, id: string): WikiRecord {
	wikiId(id);
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/.exec(markdown);
	if (!match) throw new Error("Invalid Wiki Markdown record");
	const metadata = object(YAML.parse(match[1]!));
	if (metadata.format !== 1 || metadata.id !== id) throw new Error("Invalid Wiki record identity");
	const rev = revision(metadata.revision);
	const body = match[2]!.trim();
	if (metadata.type === "forgotten") {
		if (body) throw new Error("Forgotten Wiki records cannot retain content");
		const cursor = text(metadata.cursor, true) || undefined;
		return { type: "forgotten", id, revision: rev, ...(cursor ? { cursor } : {}) };
	}
	const updatedAt = timestamp(metadata.updatedAt);
	if (metadata.type === "source") {
		wikiId(id, "e");
		if (metadata.status !== "active" && metadata.status !== "invalidated")
			throw new Error("Invalid Wiki source status");
		const processedRevision = revision(metadata.processedRevision, true);
		if (processedRevision > rev) throw new Error("Invalid Wiki source processing revision");
		const context = text(metadata.context, true) || undefined;
		const source = text(metadata.source, true) || undefined;
		const cursor = text(metadata.cursor, true) || undefined;
		let maintenance: WikiMaintenanceFailure | undefined;
		if (metadata.maintenance !== undefined) {
			const failure = object(metadata.maintenance);
			if (failure.id !== id || revision(failure.revision) > rev)
				throw new Error("Invalid Wiki maintenance failure identity");
			maintenance = {
				id,
				revision: revision(failure.revision),
				attempts: revision(failure.attempts),
				nextRetryAt: timestamp(failure.nextRetryAt),
				lastError: text(failure.lastError),
			};
		}
		return {
			type: "source",
			processedRevision,
			...(maintenance ? { maintenance } : {}),
			value: {
				id,
				revision: rev,
				content: text(body),
				...(context ? { context } : {}),
				...(source ? { source } : {}),
				...(cursor ? { cursor } : {}),
				createdAt: timestamp(metadata.createdAt),
				updatedAt,
				status: metadata.status,
			},
		};
	}
	if (metadata.type !== "page") throw new Error("Invalid Wiki record type");
	wikiId(id, "w");
	if (metadata.kind !== "knowledge" && metadata.kind !== "preference" && metadata.kind !== "pattern") {
		throw new Error("Invalid Wiki page kind");
	}
	if (metadata.status !== "active" && metadata.status !== "conflicted" && metadata.status !== "invalidated") {
		throw new Error("Invalid Wiki page status");
	}
	if (!Array.isArray(metadata.sources) || !metadata.sources.length || !Array.isArray(metadata.links)) {
		throw new Error("Invalid Wiki page lineage");
	}
	const sources = metadata.sources.map(value => {
		const ref = object(value);
		return { id: wikiId(text(ref.id), "e"), revision: revision(ref.revision) };
	});
	const links = metadata.links.map(value => wikiId(text(value), "w"));
	if (new Set(sources.map(ref => ref.id)).size !== sources.length || new Set(links).size !== links.length) {
		throw new Error("Duplicate Wiki lineage reference");
	}
	let evidence: WikiEvidence[] | undefined;
	if (metadata.evidence !== undefined) {
		if (!Array.isArray(metadata.evidence)) throw new Error("Invalid Wiki page evidence");
		evidence = metadata.evidence.map(value => {
			const item = object(value);
			const role = item.role;
			if (role !== "user" && role !== "observation" && role !== "assistant" && role !== "unknown")
				throw new Error("Invalid Wiki evidence role");
			const ref = { id: wikiId(text(item.id), "e"), revision: revision(item.revision) };
			if (!sources.some(source => source.id === ref.id && source.revision === ref.revision))
				throw new Error("Wiki quotation is outside page lineage");
			if (item.passage !== undefined && (!Number.isSafeInteger(item.passage) || (item.passage as number) < 0))
				throw new Error("Invalid Wiki evidence passage index");
			return {
				...ref,
				role,
				quote: text(item.quote),
				...(item.passage === undefined ? {} : { passage: item.passage as number }),
			};
		});
	}
	return {
		type: "page",
		value: {
			id,
			revision: rev,
			title: text(metadata.title),
			summary: text(metadata.summary),
			body: text(body),
			kind: metadata.kind,
			status: metadata.status,
			sources,
			links,
			updatedAt,
			...(evidence ? { evidence } : {}),
		},
	};
}

/** Values arrive sanitized; fields are explicit so unknown caller metadata never reaches disk. */
export function serializeWikiRecord(record: WikiRecord): string {
	let metadata: Record<string, unknown>;
	let body = "";
	if (record.type === "forgotten") {
		metadata = { format: 1, ...record };
	} else if (record.type === "source") {
		const { content, ...source } = record.value;
		metadata = {
			format: 1,
			type: "source",
			...source,
			processedRevision: record.processedRevision,
			...(record.maintenance ? { maintenance: record.maintenance } : {}),
		};
		body = content;
	} else {
		const { body: content, ...page } = record.value;
		metadata = { format: 1, type: "page", ...page };
		body = content;
	}
	const markdown = `---\n${YAML.stringify(metadata, null, 2).trimEnd()}\n---\n\n${body.trim()}\n`;
	parseWikiRecord(markdown, wikiRecordId(record));
	return markdown;
}

function transaction(value: unknown): Transaction {
	const data = object(value);
	if (
		data.format !== 1 ||
		typeof data.directory !== "string" ||
		!STAGING.test(data.directory) ||
		!Array.isArray(data.entries)
	) {
		throw new Error("Invalid Wiki transaction journal");
	}
	const targets = new Set<string>();
	const entries = data.entries.map(value => {
		const entry = object(value);
		const target = text(entry.target);
		const id = wikiId(target.split("/").at(-1)!.replace(/\.md$/, ""));
		if (
			target !== wikiRecordPath(id) ||
			(entry.staged !== null && entry.staged !== `${id}.md`) ||
			targets.has(target)
		) {
			throw new Error("Unsafe Wiki transaction target");
		}
		targets.add(target);
		if (entry.staged === null) {
			if (entry.sha256 !== null) throw new Error("Invalid Wiki deletion digest");
			return { target, staged: null, sha256: null };
		}
		const sha256 = text(entry.sha256);
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid Wiki transaction digest");
		return { target, staged: entry.staged as string, sha256 };
	});
	return { format: 1, directory: data.directory, entries };
}

async function removeStaging(directory: string): Promise<void> {
	await ensureWikiDirectory(directory);
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || (!/^[we]-[a-z0-9][a-z0-9-]{0,95}\.md$/.test(entry.name) && !TEMPORARY.test(entry.name))) {
			throw new Error("Unsafe Wiki staging entry");
		}
		const file = path.join(directory, entry.name);
		await assertWikiFile(file);
		await fs.unlink(file);
	}
	await fs.rmdir(directory);
}

/** Caller holds root/index.db's file lock. No read may bypass unfinished publication. */
export async function recoverWikiTransaction(root: string): Promise<void> {
	await ensureWikiDirectory(root);
	for (const directory of ["pages", "sources"]) await ensureWikiDirectory(path.join(root, directory));
	const journal = path.join(root, JOURNAL);
	if (await assertWikiFile(journal, true)) {
		const plan = transaction(JSON.parse(await readFile(journal)));
		const staging = path.join(root, plan.directory);
		await ensureWikiDirectory(staging);
		// Verify the complete durable intent before changing any destination.
		const contents = await Promise.all(
			plan.entries.map(async entry => {
				await assertWikiFile(path.join(root, entry.target), true);
				if (entry.staged === null) return null;
				const content = await readFile(path.join(staging, entry.staged));
				if (wikiDigest(content) !== entry.sha256) throw new Error("Damaged Wiki transaction; recovery required");
				parseWikiRecord(content, entry.staged.slice(0, -3));
				return content;
			}),
		);
		for (let index = 0; index < plan.entries.length; index++) {
			const target = path.join(root, plan.entries[index]!.target);
			const content = contents[index]!;
			if (content === null) {
				await fs.unlink(target).catch(error => {
					if (!isEnoent(error)) throw error;
				});
				await syncDirectory(path.dirname(target));
			} else {
				await atomicWrite(target, content);
			}
		}
		await fs.unlink(journal);
		await syncDirectory(root);
		await removeStaging(staging);
	}
	// A crash before journal publication or after its removal leaves only uncommitted copies.
	for (const directory of [root, path.join(root, "pages"), path.join(root, "sources")]) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (directory === root && STAGING.test(entry.name)) {
				if (!entry.isDirectory()) throw new Error("Unsafe Wiki staging directory");
				await removeStaging(path.join(root, entry.name));
			} else if (TEMPORARY.test(entry.name)) {
				const file = path.join(directory, entry.name);
				await assertWikiFile(file);
				await fs.unlink(file);
			}
		}
	}
}

export async function publishWikiRecords(root: string, records: WikiRecord[], removeIds: string[] = []): Promise<void> {
	if (!records.length && !removeIds.length) return;
	const directory = `.wiki-txn-${crypto.randomUUID()}`;
	const staging = path.join(root, directory);
	await ensureWikiDirectory(staging);
	let committed = false;
	try {
		const entries: TransactionEntry[] = [];
		for (const record of records) {
			const id = wikiRecordId(record);
			const content = serializeWikiRecord(record);
			const staged = `${id}.md`;
			await assertWikiFile(path.join(root, wikiRecordPath(id)), true);
			await writeExclusive(path.join(staging, staged), content);
			entries.push({ target: wikiRecordPath(id), staged, sha256: wikiDigest(content) });
		}
		for (const id of removeIds) {
			const target = wikiRecordPath(id);
			await assertWikiFile(path.join(root, target), true);
			entries.push({ target, staged: null, sha256: null });
		}
		await syncDirectory(staging);
		const plan: Transaction = { format: 1, directory, entries };
		await atomicWrite(path.join(root, JOURNAL), `${JSON.stringify(plan)}\n`);
		committed = true;
		await recoverWikiTransaction(root);
	} catch (error) {
		// Once intent is durable, keep its staging files for mandatory redo on the next access.
		if (!committed && !(await assertWikiFile(path.join(root, JOURNAL), true))) await removeStaging(staging);
		throw error;
	}
}

export async function readWikiDiskState(root: string): Promise<WikiDiskState> {
	await recoverWikiTransaction(root);
	const records = new Map<string, WikiRecord>();
	const digest = createHash("sha256").update(path.resolve(root)).update("\0");
	for (const directory of ["sources", "pages"]) {
		for (const entry of (await fs.readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) throw new Error("Unsafe Wiki record entry");
			const id = wikiId(entry.name.slice(0, -3), directory === "sources" ? "e" : "w");
			const content = await readFile(path.join(root, directory, entry.name));
			records.set(id, parseWikiRecord(content, id));
			digest.update(id).update("\0").update(content).update("\0");
		}
	}
	const visible = new Map<string, WikiPage>();
	for (const record of records.values()) {
		if (record.type !== "page" || record.value.status === "invalidated") continue;
		if (
			!record.value.sources.every(ref => {
				const source = records.get(ref.id);
				return (
					source?.type === "source" && source.value.status === "active" && source.value.revision === ref.revision
				);
			})
		)
			continue;
		visible.set(record.value.id, record.value);
	}
	// Links are navigation, never evidence dependencies. Hide dangling links without hiding knowledge.
	for (const page of visible.values()) page.links = page.links.filter(link => visible.has(link));
	return { version: digest.digest("hex"), records, pages: [...visible.values()] };
}
