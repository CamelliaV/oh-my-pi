#!/usr/bin/env bun
/**
 * One-shot migration: local md memory (~/.omp/agent/memories/<project>/) →
 * mnemopi SQLite banks under ~/.omp/agent/memories/mnemopi/.
 *
 * Reads each project's learned.md / MEMORY.md bullet entries and imports them
 * as working_memory rows via the official importFromDict() channel (same
 * schema as `mnemopi export`). Bank layout mirrors omp's per-project scoping:
 *   shared bank  → mnemopi/mnemopi.db
 *   project bank → mnemopi/banks/<basename>-<hash36>/mnemopi.db
 * where hash36 = Bun.hash(absolute project root).toString(36), matching
 * projectBankSegment() in packages/coding-agent/src/mnemopi/config.ts.
 *
 * Usage: bun scripts/migrate-local-memory-to-mnemopi.ts [--apply]
 * Without --apply: dry-run, prints a per-project report and writes JSON
 * staging files to /tmp/mnemopi-migration/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BankManager } from "../packages/mnemopi/src/core/banks";
import { BeamMemory } from "../packages/mnemopi/src/core/beam";
import { importFromDict } from "../packages/mnemopi/src/core/beam/store";

const AGENT_DIR = path.join(process.env.HOME!, ".omp", "agent");
const MEMORIES_DIR = path.join(AGENT_DIR, "memories");
const MNEMOPI_DIR = path.join(MEMORIES_DIR, "mnemopi");
const APPLY = process.argv.includes("--apply");
const STAGING = "/tmp/mnemopi-migration";


/** omp per-project bank id: mnemopi/config.ts:189 projectBankSegment. */
function projectBankSegment(projectRoot: string): string {
	const project = path.basename(projectRoot).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
	const name = `${project}-${Bun.hash(projectRoot).toString(36)}`;
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefix = name.slice(0, Math.max(1, 63 - hash.length)).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

interface Entry {
	content: string;
	context: string | null;
	sourceFile: "learned.md" | "MEMORY.md";
}

/** Parse markdown bullet entries ("- text" / "- text _(context: ...)_"). */
function parseEntries(md: string, sourceFile: Entry["sourceFile"]): Entry[] {
	const out: Entry[] = [];
	for (const rawLine of md.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line.startsWith("- ")) continue;
		let text = line.slice(2).trim();
		if (!text) continue;
		let context: string | null = null;
		const ctx = /\s*_\(context:\s*(.+)\)_\s*$/.exec(text);
		if (ctx) {
			context = ctx[1].trim();
			text = text.slice(0, ctx.index).trim();
		}
		if (text) out.push({ content: text, context, sourceFile });
	}
	return out;
}

function toRow(entry: Entry, projectRoot: string, index: number, bank: string): Record<string, unknown> {
	const timestamp = new Date().toISOString();
	return {
		id: `mig-${Bun.hash(`${projectRoot}:${entry.sourceFile}:${index}:${entry.content}`).toString(36)}-${index}`,
		content: entry.context ? `${entry.content} (context: ${entry.context})` : entry.content,
		source: `local-memory-migration:${entry.sourceFile}`,
		timestamp,
		session_id: "local-migration",
		importance: entry.sourceFile === "MEMORY.md" ? 0.8 : 0.6,
		metadata_json: JSON.stringify({
			cwd: projectRoot,
			origin: "local-memory-migration",
			origin_file: entry.sourceFile,
			...(entry.context ? { origin_context: entry.context } : {}),
		}),
		scope: "bank",
		veracity: "stated",
		memory_type: "fact",
		// omp's MnemopiSessionState recalls with channelId=<bank name>; rows
		// without channel_id are invisible to scoped recall (recall.ts buildWhere).
		channel_id: bank,
	};
}

interface ProjectReport {
	dir: string;
	projectRoot: string | null;
	bank: string | null;
	entries: number;
	skipped: string[];
}

const reports: ProjectReport[] = [];
const sharedRows: Record<string, unknown>[] = [];

for (const dirent of fs.readdirSync(MEMORIES_DIR, { withFileTypes: true })) {
	if (!dirent.isDirectory() || dirent.name === "mnemopi") continue;
	const dir = path.join(MEMORIES_DIR, dirent.name);
	if (!dirent.name.startsWith("--") || !dirent.name.endsWith("--")) {
		reports.push({ dir: dirent.name, projectRoot: null, bank: null, entries: 0, skipped: ["not a project dir"] });
		continue;
	}
	// Reverse encodeProjectPath. The encoding collapses `/` and `:` to `-`, so
	// the mapping is not injective; resolve ambiguity by probing candidates
	// (dash-split rejoin) against the filesystem, preferring the longest match.
	const stem = dirent.name.slice(2, -2);
	const candidates: string[] = [];
	const rejoin = (parts: string[], offset: number, acc: string): void => {
		if (offset === parts.length) {
			candidates.push(`/${acc}`);
			return;
		}
		for (let i = offset + 1; i <= parts.length; i++) {
			const seg = parts.slice(offset, i).join("-");
			rejoin(parts, i, acc ? `${acc}/${seg}` : seg);
		}
	};
	rejoin(stem.split("-"), 0, "");
	candidates.sort((a, b) => b.length - a.length);
	const projectRoot = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isDirectory()) ?? `/${stem}`;
	if (!fs.existsSync(projectRoot)) {
		// Legacy hashed dirs or deleted projects: fold into shared bank so
		// nothing is dropped; recall can still reach them via the shared bank.
		const learnedPath = path.join(dir, "learned.md");
		const memoryPath = path.join(dir, "MEMORY.md");
		const entries = [
			...parseEntries(fs.existsSync(learnedPath) ? fs.readFileSync(learnedPath, "utf8") : "", "learned.md"),
			...parseEntries(fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf8") : "", "MEMORY.md"),
		];
		for (const [i, e] of entries.entries()) sharedRows.push(toRow(e, projectRoot, i, "default"));
		reports.push({
			dir: dirent.name,
			projectRoot,
			bank: "default (shared; project path missing on disk)",
			entries: entries.length,
			skipped: [],
		});
		continue;
	}
	const learnedPath = path.join(dir, "learned.md");
	const memoryPath = path.join(dir, "MEMORY.md");
	const entries = [
		...parseEntries(fs.existsSync(learnedPath) ? fs.readFileSync(learnedPath, "utf8") : "", "learned.md"),
		...parseEntries(fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf8") : "", "MEMORY.md"),
	];
	const bank = projectBankSegment(projectRoot);
	const rows = entries.map((e, i) => toRow(e, projectRoot, i, bank));
	const payload = {
		mnemopi_export: {
			version: "1.0",
			export_date: new Date().toISOString(),
			source_db: "local-memory-migration",
			component: "beam",
		},
		working_memory: rows,
		episodic_memory: [],
		episodic_embeddings: [],
		scratchpad: [],
		consolidation_log: [],
	};
	if (APPLY) {
		fs.mkdirSync(path.join(STAGING), { recursive: true });
		const jsonPath = path.join(STAGING, `${bank}.json`);
		fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
		const bankManager = new BankManager(MNEMOPI_DIR);
		const dbPath = bankManager.getBankDbPath(bank);
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const beam = new BeamMemory({ dbPath, sessionId: bank });
		try {
			const stats = importFromDict(beam as never, payload);
			console.log(`[${dirent.name}] bank=${bank} imported:`, JSON.stringify(stats.working_memory));
		} finally {
			beam.close();
		}
	}
	reports.push({ dir: dirent.name, projectRoot, bank, entries: entries.length, skipped: [] });
}

// Shared-bank rows (deleted/legacy projects) always land in staging, import on --apply.
if (sharedRows.length > 0) {
	fs.mkdirSync(STAGING, { recursive: true });
	const payload = {
		mnemopi_export: {
			version: "1.0",
			export_date: new Date().toISOString(),
			source_db: "local-memory-migration",
			component: "beam",
		},
		working_memory: sharedRows,
		episodic_memory: [],
		episodic_embeddings: [],
		scratchpad: [],
		consolidation_log: [],
	};
	fs.writeFileSync(path.join(STAGING, "shared.json"), JSON.stringify(payload, null, 2));
	if (APPLY) {
		const dbPath = path.join(MNEMOPI_DIR, "mnemopi.db");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const beam = new BeamMemory({ dbPath, sessionId: "default" });
		try {
			const stats = importFromDict(beam as never, payload);
			console.log(`[shared] imported:`, JSON.stringify(stats.working_memory));
		} finally {
			beam.close();
		}
	}
}

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} report ===`);
let total = 0;
for (const r of reports) {
	total += r.entries;
	const root = r.projectRoot ?? "?";
	console.log(`${r.dir}\n  root: ${root}\n  bank: ${r.bank ?? "-"}\n  entries: ${r.entries}${r.skipped.length ? `\n  skipped: ${r.skipped.join("; ")}` : ""}`);
}
console.log(`\nTotal entries: ${total}${sharedRows.length ? ` (+${sharedRows.length} shared-bank)` : ""}`);
if (!APPLY) console.log(`Staging JSON: ${STAGING}/ (dry-run wrote nothing to mnemopi)`);
