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
		new RegExp(`^${name}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
	const body = text.slice(match[0].length).trim();
	const id = value("id");
	if (!id) return undefined;
	const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || id;
	const kind = filePath.includes(`${path.sep}wiki${path.sep}`) ? "page" : "source";
	return {
		id,
		scope: value("scope") || fallbackScope,
		title,
		body,
		path: filePath,
		kind,
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

export class ExternalVault {
	constructor(readonly root: string) {}

	async append(input: {
		content: string;
		context?: string;
		scope: string;
		type?: string;
	}): Promise<VaultWrite> {
		const created = new Date();
		const stamp = created.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
		const id = `v-${crypto.randomUUID()}`;
		const slug = input.content
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
		const roots = [path.join(this.root, "wiki"), path.join(this.root, "raw", "inbox")];
		const notes: VaultNote[] = [];
		for (const root of roots) {
			for (const filePath of await files(root)) {
				const scope = path.relative(root, filePath).split(path.sep)[0] || "";
				if (root.endsWith(`${path.sep}inbox`) && scope && !allowed.has(scope)) continue;
				const text = await fs.readFile(filePath, "utf8");
				const note = parse(filePath, text, scope);
				if (!note || (note.scope && !allowed.has(note.scope))) continue;
				notes.push(note);
			}
		}
		return notes;
	}

	async find(id: string, scopes: readonly string[]): Promise<VaultNote | undefined> {
		return (await this.notes(scopes)).find(note => note.id === id);
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
