import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import {
	assertWikiFile,
	ensureWikiDirectory,
	parseWikiRecord,
	serializeWikiRecord,
	wikiId,
	wikiRecordId,
} from "./store-files";
import type { WikiDiskState, WikiRecord, StoredPage, StoredSource } from "./store-files";
import type { WikiPage, WikiRevision, WikiRevisionChange, WikiRevisionInfo, WikiSource } from "./types";

const HISTORY_FILE = /^r(\d{1,12})\.md$/;
const HISTORY_OPERATIONS = new Set<WikiRevisionChange["operation"]>([
	"baseline",
	"capture",
	"publish",
	"update",
	"invalidate",
	"restore",
]);

type HistoryRecord = StoredPage | StoredSource;

function historyPath(root: string, id: string, revision: number): string {
	wikiId(id);
	if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid Wiki history revision");
	const kind = id.startsWith("e-") ? "sources" : "pages";
	return path.join(root, "history", kind, id, `r${String(revision).padStart(8, "0")}.md`);
}

function parseChange(value: unknown): WikiRevisionChange {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid Wiki history change metadata");
	const record = value as Record<string, unknown>;
	if (
		typeof record.operation !== "string" ||
		!HISTORY_OPERATIONS.has(record.operation as WikiRevisionChange["operation"])
	)
		throw new Error("Invalid Wiki history operation");
	if (typeof record.reason !== "string" || !record.reason.trim()) throw new Error("Invalid Wiki history reason");
	if (
		record.restoredFrom !== undefined &&
		(!Number.isSafeInteger(record.restoredFrom) || (record.restoredFrom as number) < 1)
	)
		throw new Error("Invalid Wiki history restore revision");
	return {
		operation: record.operation as WikiRevisionChange["operation"],
		reason: record.reason,
		...(record.restoredFrom === undefined ? {} : { restoredFrom: record.restoredFrom as number }),
	};
}

function recordValue(record: HistoryRecord): WikiPage | WikiSource {
	return record.value;
}

function historyMarkdown(record: HistoryRecord, change: WikiRevisionChange): string {
	const serialized = serializeWikiRecord(record);
	const match = /^---\n([\s\S]*?)\n---\n/.exec(serialized);
	if (!match) throw new Error("Invalid Wiki record serialization");
	const metadata = YAML.parse(match[1]!) as Record<string, unknown>;
	metadata.history = change;
	return `---\n${YAML.stringify(metadata, null, 2).trimEnd()}\n---\n${serialized.slice(match[0].length)}`;
}

async function writeImmutable(file: string, content: string): Promise<void> {
	await ensureWikiDirectory(path.dirname(file));
	if (await assertWikiFile(file, true)) {
		const old = await Bun.file(file).text();
		if (old !== content) throw new Error(`Wiki history revision already exists with different content: ${file}`);
		return;
	}
	const temporary = path.join(path.dirname(file), `.wiki-history-${crypto.randomUUID()}.tmp`);
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await replaceFileAtomically(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function readHistory(root: string, id: string): Promise<WikiRevision[]> {
	wikiId(id);
	const directory = path.join(root, "history", id.startsWith("e-") ? "sources" : "pages", id);
	let entries: fsSync.Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const revisions: WikiRevision[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
		const match = HISTORY_FILE.exec(entry.name);
		if (!match || !entry.isFile()) throw new Error(`Unsafe Wiki history entry: ${entry.name}`);
		const revision = Number(match[1]);
		const file = path.join(directory, entry.name);
		await assertWikiFile(file);
		const markdown = await Bun.file(file).text();
		const parsed = parseWikiRecord(markdown, id);
		if (parsed.type === "forgotten") throw new Error("Forgotten Wiki records cannot have history");
		const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
		const metadata = frontmatter ? (YAML.parse(frontmatter[1]!) as Record<string, unknown>) : {};
		const change =
			metadata.history === undefined
				? { operation: "baseline" as const, reason: "Imported existing Wiki record" }
				: parseChange(metadata.history);
		if (parsed.value.revision !== revision) throw new Error("Wiki history filename does not match record revision");
		if (revisions.some(item => item.revision === revision)) throw new Error("Duplicate Wiki history revision");
		revisions.push({
			id,
			revision,
			type: parsed.type,
			status: parsed.value.status,
			updatedAt: parsed.value.updatedAt,
			current: false,
			change,
			record: parsed.value,
		});
	}
	return revisions;
}

async function removeHistory(root: string, id: string): Promise<void> {
	wikiId(id);
	const directory = path.join(root, "history", id.startsWith("e-") ? "sources" : "pages", id);
	try {
		const stat = await fs.lstat(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe Wiki history directory");
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	await fs.rm(directory, { recursive: true, force: false });
}

function sameValue(left: HistoryRecord, right: HistoryRecord): boolean {
	return JSON.stringify(left.value) === JSON.stringify(right.value);
}

/** Fill gaps after a crash between current-record publication and history indexing. */
export async function syncWikiHistory(root: string, state: WikiDiskState): Promise<void> {
	await ensureWikiDirectory(path.join(root, "history", "pages"));
	await ensureWikiDirectory(path.join(root, "history", "sources"));
	for (const record of state.records.values()) {
		if (record.type === "forgotten") {
			await removeHistory(root, record.id);
			continue;
		}
		const file = historyPath(root, wikiRecordId(record), record.value.revision);
		if (!(await assertWikiFile(file, true)))
			await writeHistorySnapshot(root, record, { operation: "baseline", reason: "Recovered current Wiki record" });
	}
}

export async function writeHistorySnapshot(
	root: string,
	record: HistoryRecord,
	change: WikiRevisionChange,
): Promise<void> {
	const id = wikiRecordId(record);
	const file = historyPath(root, id, record.value.revision);
	await writeImmutable(file, historyMarkdown(record, change));
}

export async function recordWikiHistory(
	root: string,
	before: WikiDiskState,
	writes: readonly WikiRecord[],
	operation: WikiRevisionChange["operation"],
	restoredFrom?: number,
): Promise<void> {
	for (const record of writes) {
		const id = wikiRecordId(record);
		if (record.type === "forgotten") {
			await removeHistory(root, id);
			continue;
		}
		const previous = before.records.get(id);
		if (previous && previous.type !== "forgotten" && sameValue(previous, record as HistoryRecord)) continue;
		await writeHistorySnapshot(root, record as HistoryRecord, {
			operation,
			reason: operation === "baseline" ? "Initial Wiki record" : `Wiki ${operation} committed`,
			...(restoredFrom === undefined ? {} : { restoredFrom }),
		});
	}
}

export async function listWikiHistory(root: string, state: WikiDiskState, id: string): Promise<WikiRevision[]> {
	wikiId(id);
	const current = state.records.get(id);
	if (!current || current.type === "forgotten") return [];
	const revisions = await readHistory(root, id);
	const latest = revisions.find(revision => revision.revision === current.value.revision);
	if (!latest) {
		await writeHistorySnapshot(root, current, { operation: "baseline", reason: "Recovered current Wiki record" });
		revisions.push({
			id,
			revision: current.value.revision,
			type: current.type,
			status: current.value.status,
			updatedAt: current.value.updatedAt,
			current: true,
			change: { operation: "baseline", reason: "Recovered current Wiki record" },
			record: recordValue(current),
		});
	}
	return revisions
		.sort((left, right) => left.revision - right.revision)
		.map(item => ({ ...item, current: item.revision === current.value.revision }));
}

export async function readWikiRevision(
	root: string,
	state: WikiDiskState,
	id: string,
	revision: number,
): Promise<WikiRevision | null> {
	const history = await listWikiHistory(root, state, id);
	return history.find(item => item.revision === revision) ?? null;
}

export function formatWikiRecordForDiff(record: WikiPage | WikiSource): string[] {
	if ("body" in record)
		return [
			`title: ${record.title}`,
			`summary: ${record.summary}`,
			`kind: ${record.kind}`,
			`status: ${record.status}`,
			`sources: ${record.sources.map(ref => `${ref.id}@${ref.revision}`).join(", ")}`,
			"",
			...record.body.split("\n"),
		];
	return [
		`status: ${record.status}`,
		`source: ${record.source ?? ""}`,
		`context: ${record.context ?? ""}`,
		"",
		...record.content.split("\n"),
	];
}

export async function diffWikiRevisions(
	root: string,
	state: WikiDiskState,
	id: string,
	from: number,
	to: number,
): Promise<string> {
	const left = await readWikiRevision(root, state, id, from);
	const right = await readWikiRevision(root, state, id, to);
	if (!left || !right) throw new Error(`Wiki revision not found: ${id}@${!left ? from : to}`);
	const a = formatWikiRecordForDiff(left.record);
	const b = formatWikiRecordForDiff(right.record);
	const lines = [`--- memory://${id}@${from}`, `+++ memory://${id}@${to}`];
	const max = Math.max(a.length, b.length);
	for (let index = 0; index < max; index++) {
		if (a[index] === b[index]) lines.push(` ${a[index] ?? ""}`);
		else {
			if (a[index] !== undefined) lines.push(`-${a[index]}`);
			if (b[index] !== undefined) lines.push(`+${b[index]}`);
		}
	}
	return lines.join("\n");
}

export function historyRevisionInfo(revision: WikiRevision): WikiRevisionInfo {
	return {
		id: revision.id,
		revision: revision.revision,
		type: revision.type,
		status: revision.status,
		updatedAt: revision.updatedAt,
		current: revision.current,
		change: revision.change,
	};
}
