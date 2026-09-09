/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.omp/agent/managed-skills`) separate from
 * user-authored skills (`~/.omp/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape `getManagedSkillsDir()`
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string, project?: string): string {
	const frontmatter = YAML.stringify(
		{
			name,
			description: sanitizeManagedDescription(description),
			...(project ? { project: path.resolve(project) } : {}),
		},
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface ManagedSkillMutationOptions {
	/** Explicit root for isolated callers; omitted by the normal session tools. */
	agentDir?: string;
	/** SHA-256 of the published file; a mismatch refuses update or deletion. */
	expectedHash?: string;
}

export interface WriteManagedSkillInput extends ManagedSkillMutationOptions {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
	/** Omit for global skills; project-scoped skills are hidden outside this cwd. */
	project?: string;
}

/**
 * Serialize create/update/delete on the same skill name. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-name promise chain runs same-skill mutations in submission order while
 * different names still proceed in parallel. In-process only; cross-process
 * races are out of scope.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(name: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(name) ?? Promise.resolve();
	const run = prev.then(
		() => withFileLock(name, op),
		() => withFileLock(name, op),
	);
	const guarded = run.catch(() => {});
	skillMutationChains.set(name, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(name) === guarded) skillMutationChains.delete(name);
	});
	return run;
}

/**
 * Reject when the managed-skills root itself is a symlink. lstat on a child
 * follows intermediate components, so a symlinked root would let an otherwise
 * valid name write/delete outside the isolated directory (e.g. onto authored
 * skills). Checked before composing any child path.
 */
async function assertManagedRootSafe(root: string): Promise<void> {
	const rootStat = await fs.lstat(root).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (rootStat?.isSymbolicLink()) {
		throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		throw err;
	}
}

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.name);
	const description = sanitizeManagedDescription(input.description);
	const body = input.body.trim();
	// Reject empty content: an all-whitespace/control description sanitizes to ""
	// and the `requireDescription` discovery scan then silently drops the skill,
	// so the tool would report success for a skill that never appears.
	if (!description) {
		throw new Error(`Managed skill "${name}" needs a non-empty description.`);
	}
	if (!body) {
		throw new Error(`Managed skill "${name}" needs a non-empty body.`);
	}
	if (input.action === "create" && input.expectedHash !== undefined) {
		throw new Error("expectedHash requires action update.");
	}
	const content = `${toSkillFrontmatter(name, description, input.project)}\n${body}\n`;
	// Cap the UTF-8 byte size of the FINAL file (body + description + frontmatter),
	// not the UTF-16 code-unit length of the body alone.
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		throw new Error(
			`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
		);
	}
	const root = getManagedSkillsDir(input.agentDir);
	await assertManagedRootSafe(root);
	await fs.mkdir(root, { recursive: true });
	const dir = path.join(root, name);
	return serializeSkillMutation(dir, async () => {
		await assertManagedRootSafe(root);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`);
				}
				throw err;
			}
			return { path: file };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (fileStat === null) {
			throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			if (input.expectedHash !== undefined) {
				const currentHash = createHash("sha256")
					.update(await handle.readFile())
					.digest("hex");
				if (currentHash !== input.expectedHash) {
					throw new Error(`Managed skill "${name}" changed since publication; refusing to overwrite it.`);
				}
			}
			await handle.truncate(0);
			const bytes = Buffer.from(content);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
				if (bytesWritten === 0) throw new Error(`Unable to finish writing managed skill "${name}".`);
				offset += bytesWritten;
			}
		} finally {
			await handle.close();
		}
		return { path: file };
	});
}

/** Delete a managed skill directory. Throws when it does not exist. */
export async function deleteManagedSkill(name: string, options: ManagedSkillMutationOptions = {}): Promise<void> {
	const safe = sanitizeSkillName(name);
	const root = getManagedSkillsDir(options.agentDir);
	await assertManagedRootSafe(root);
	await fs.mkdir(root, { recursive: true });
	const dir = path.join(root, safe);
	await serializeSkillMutation(dir, async () => {
		await assertManagedRootSafe(root);
		// Refuse to follow a symlinked skill directory (rm would delete the target).
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
		}
		if (options.expectedHash !== undefined) {
			const file = path.join(dir, "SKILL.md");
			const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				assertManagedSkillFileSafeForUpdate(safe, await handle.stat());
				const currentHash = createHash("sha256")
					.update(await handle.readFile())
					.digest("hex");
				if (currentHash !== options.expectedHash) {
					throw new Error(`Managed skill "${safe}" changed since publication; refusing to delete it.`);
				}
			} finally {
				await handle.close();
			}
			// A hash owns SKILL.md, not additional files the user may have added.
			await fs.unlink(file);
			await fs.rmdir(dir).catch(error => {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
			});
			return;
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Managed skill "${safe}" does not exist.`);
			}
			throw err;
		}
	});
}
