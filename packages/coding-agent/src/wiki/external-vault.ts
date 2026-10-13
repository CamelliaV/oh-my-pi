import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const EXTERNAL_WIKI_VAULT = path.join(os.homedir(), "文档", "omp-wiki");

export interface VaultNote {
	id: string;
	scope: string;
	title: string;
	body: string;
	path: string;
	kind: "page" | "source";
	/**
	 * Where the note lives: compiled `wiki/` pages, pending `raw/inbox/`
	 * evidence, or archived `raw/processed/` evidence. Compile moves a source
	 * from inbox to processed, so both raw channels must stay readable by id.
	 */
	channel: "page" | "inbox" | "processed";
	status: string;
}

export interface VaultWrite {
	id: string;
	scope: string;
	content: string;
	context?: string;
	path: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function parse(filePath: string, text: string, fallbackScope: string): VaultNote | undefined {
	const match = FRONTMATTER.exec(text);
	if (!match) return undefined;
	const frontmatter = match[1] ?? "";
	const value = (name: string) =>
		new RegExp(`^${name}:\\s*(.+)$`, "m")
			.exec(frontmatter)?.[1]
			?.trim()
			.replace(/^["']|["']$/g, "") ?? "";
	const body = text.slice(match[0].length).trim();
	const id = value("id");
	if (!id) return undefined;
	const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || id;
	const kind = filePath.includes(`${path.sep}wiki${path.sep}`) ? ("page" as const) : ("source" as const);
	const channel =
		kind === "page"
			? ("page" as const)
			: filePath.includes(`${path.sep}raw${path.sep}processed${path.sep}`)
				? ("processed" as const)
				: ("inbox" as const);
	return {
		id,
		scope: value("scope") || fallbackScope,
		title,
		body,
		path: filePath,
		kind,
		channel,
		status: value("status"),
	};
}

async function files(dir: string): Promise<string[]> {
	const found: string[] = [];
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
		throw error;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await files(child)));
		else if (entry.isFile() && entry.name.endsWith(".md")) found.push(child);
	}
	return found;
}

/**
 * True for a compiled page that carries no usable derived knowledge: an
 * empty or title-only body, a placeholder index ("No topics yet"), or no
 * `## Evidence` section naming its sources. A thin page never hides the
 * original source of the same id — `find` and the backend's read fall back
 * to the raw evidence instead.
 */
export function isThinPage(note: VaultNote): boolean {
	if (note.kind !== "page") return false;
	// Index/maintenance pages (`_index.md`, `_master-index.md`) are legitimately
	// without knowledge of id content; they are not placeholders.
	if (path.basename(note.path).startsWith("_")) return false;
	const body = note.body.trim();
	if (!body) return true;
	// A page whose entire content is its own H1 heading carries nothing.
	const prose = body.replace(/^#\s+.*$/m, "").trim();
	if (!prose || /no topics yet/i.test(prose)) return true;
	return !/^##\s+Evidence\b/im.test(prose);
}

export class ExternalVault {
	constructor(readonly root: string) {}

	async append(input: { content: string; context?: string; scope: string; type?: string }): Promise<VaultWrite> {
		const created = new Date();
		const stamp = created
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}Z$/, "Z");
		const id = `v-${crypto.randomUUID()}`;
		const slug =
			input.content
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 40) || "note";
		const scopeDir = path.join(this.root, "raw", "inbox", input.scope);
		await fs.mkdir(scopeDir, { recursive: true });
		const filePath = path.join(scopeDir, `${stamp}-${slug}.md`);
		const lines = [
			"---",
			`id: ${id}`,
			`scope: ${input.scope}`,
			`type: ${input.type ?? "fact"}`,
			"status: inbox",
			`created: ${created.toISOString()}`,
			"---",
			"",
			input.content.trim(),
		];
		if (input.context?.trim()) lines.push("", "Context:", input.context.trim());
		lines.push("");
		await fs.writeFile(filePath, lines.join("\n"), { encoding: "utf8", flag: "wx" });
		return { id, scope: input.scope, content: input.content.trim(), context: input.context, path: filePath };
	}

	async notes(scopes: readonly string[]): Promise<VaultNote[]> {
		const allowed = new Set(scopes);
		// Scan order is the reader's priority order: compiled pages first, then
		// pending inbox evidence, then archived (compiled-away) evidence. The
		// archived root must be scanned too: compile MOVES sources from
		// raw/inbox/ to raw/processed/, so skipping it would make every compiled
		// source's id (and recall hit) unresolvable.
		const pageRoot = path.join(this.root, "wiki");
		const rawRoots = [path.join(this.root, "raw", "inbox"), path.join(this.root, "raw", "processed")];
		const notes: VaultNote[] = [];
		for (const root of [pageRoot, ...rawRoots]) {
			for (const filePath of await files(root)) {
				const scope = path.relative(root, filePath).split(path.sep)[0] || "";
				if (root !== pageRoot && scope && !allowed.has(scope)) continue;
				const text = await fs.readFile(filePath, "utf8");
				const note = parse(filePath, text, scope);
				if (!note || (note.scope && !allowed.has(note.scope))) continue;
				notes.push(note);
			}
		}
		return notes;
	}

	/**
	 * Id lookup with compiled-first priority: a substantive compiled page
	 * answers the id. When no page exists for it — or the page is a
	 * placeholder ({@link isThinPage}) — the original raw source answers
	 * instead (pending inbox first, then archived processed evidence). A
	 * placeholder page with no same-id source is still returned rather than
	 * reporting a real id as missing.
	 */
	async find(id: string, scopes: readonly string[]): Promise<VaultNote | undefined> {
		const notes = await this.notes(scopes);
		const page = notes.find(note => note.kind === "page" && note.id === id);
		if (page && !isThinPage(page)) return page;
		const source = notes.find(note => note.kind === "source" && note.id === id);
		return source ?? page;
	}

	/**
	 * Last data row of `wiki/_compile-log.md` (most recent recorded compile),
	 * pipes stripped into "date — source — topic — action" text. Undefined
	 * when the log is absent or carries no run rows yet.
	 */
	async lastCompileRow(): Promise<string | undefined> {
		let text: string;
		try {
			text = await fs.readFile(path.join(this.root, "wiki", "_compile-log.md"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const rows = text
			.split("\n")
			.map(line => line.trim())
			.filter(
				line => /^\|.*\|$/.test(line) && !/^\|[\s:-]+(\|[\s:-]+)*\|$/.test(line) && !/^\|\s*Date\s*\|/i.test(line),
			);
		const row = rows.at(-1);
		if (!row) return undefined;
		const cells = row
			.replace(/^\||\|$/g, "")
			.split("|")
			.map(cell => cell.trim())
			.filter(Boolean);
		return cells.length ? cells.join(" — ") : undefined;
	}

	search(query: string, notes: readonly VaultNote[], limit: number): VaultNote[] {
		const terms = query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(term => term.length > 1);
		const ranked = notes
			.map(note => {
				const haystack = `${note.title}\n${note.body}`.toLowerCase();
				const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
				return { note, score };
			})
			.filter(item => item.score > 0)
			.sort((left, right) => right.score - left.score || left.note.id.localeCompare(right.note.id));
		return ranked.slice(0, limit).map(item => item.note);
	}
}
