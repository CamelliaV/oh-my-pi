import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	isValidManagedSkillName,
	sanitizeManagedDescription,
	toSkillFrontmatter,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { scanSkillsFromDir } from "../discovery/helpers";
import { DEFAULT_PROBE_TIMEOUT_MS, runBoundedProbe } from "../eval/probe";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import skillProposePrompt from "../prompts/wiki/skill-propose.md" with { type: "text" };
import { redactSecrets } from "../secrets/redact";
import { replaceFileAtomically } from "../utils/atomic-file";
import { readWikiPagesUnlocked } from "./store";
import type { WikiComplete, WikiPage, WikiSkillCandidate, WikiSkillDraft, WikiSourceRef } from "./types";

const MAX_BODY_CHARS = 16_000;
const MAX_STATE_BYTES = 8_000_000;
const MAX_RESULT_BYTES = 32_000;
const CANDIDATE_ID = /^k-[a-f0-9]{32}$/;
const PAGE_ID = /^w-[a-zA-Z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

type Validation = NonNullable<WikiSkillCandidate["validation"]>;
type BehavioralValidation = Validation & { kind: "behavioral"; baseline: number; candidate: number };
type PublicationTarget = { content: string; hash: string | null };

class SkillNameConflict extends Error {}
class UnsafeSkillFile extends Error {}

const PURGED_REASON = "Supporting Wiki pages changed or were removed; copied skill content was forgotten.";

export interface WikiSkillsOptions {
	root: string;
	agentDir: string;
	complete: WikiComplete;
	redact?: (text: string) => string;
	project?: string;
	/** May shorten the existing bounded-subprocess ceiling (10 seconds). */
	evaluatorTimeoutMs?: number;
}

function digest(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyKey(body: string): string {
	return digest(body.replace(/\s+/g, " ").trim());
}

function skillContent(candidate: WikiSkillCandidate, project?: string): string {
	return `${toSkillFrontmatter(candidate.name, candidate.description, project)}\n${candidate.body.trim()}\n\n<!-- wiki-skill:${candidate.id} -->\n`;
}

async function safeDirectory(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Wiki skills directory is unsafe: ${dir}`);
}

async function readRegular(file: string, maxBytes: number): Promise<string | null> {
	const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => {
		if (isEnoent(error)) return null;
		throw error;
	});
	if (!handle) return null;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
			throw new UnsafeSkillFile(`Wiki skill file is unsafe or oversized: ${file}`);
		}
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function removePrivateTree(dir: string): Promise<void> {
	const stat = await fs.lstat(dir).catch(error => {
		if (isEnoent(error)) return null;
		throw error;
	});
	if (stat === null) return;
	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		await fs.chmod(dir, 0o700);
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) await removePrivateTree(path.join(dir, entry.name));
		}
	}
	await fs.rm(dir, { recursive: true, force: true });
}

/** Candidate generation is inert. Only explicit approval or a trusted evaluator can publish a skill. */
export class WikiSkills {
	readonly root: string;
	readonly #agentDir: string;
	readonly #dir: string;
	readonly #complete: WikiComplete;
	readonly #redact: (text: string) => string;
	readonly #evaluatorTimeoutMs: number;
	readonly #project?: string;

	constructor(options: WikiSkillsOptions) {
		if (!options.root.trim() || !options.agentDir.trim())
			throw new Error("Wiki skills require explicit root and agentDir paths.");
		this.root = path.resolve(options.root);
		this.#agentDir = path.resolve(options.agentDir);
		this.#dir = path.join(this.root, "skills");
		if (this.root === path.parse(this.root).root) throw new Error("Wiki skills require a dedicated root directory.");
		this.#complete = options.complete;
		this.#redact = options.redact ?? (text => text);
		this.#project = options.project;
		const timeout = options.evaluatorTimeoutMs;
		this.#evaluatorTimeoutMs =
			typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
				? Math.min(timeout, DEFAULT_PROBE_TIMEOUT_MS)
				: DEFAULT_PROBE_TIMEOUT_MS;
	}

	#clean(text: string, limit: number): string {
		return redactSecrets(this.#redact(text))
			.replace(/[\p{Cc}\p{Cf}]/gu, char => (char === "\n" || char === "\t" ? char : ""))
			.trim()
			.slice(0, limit);
	}

	#draft(value: unknown): WikiSkillDraft | null {
		if (!isRecord(value) || typeof value.name !== "string" || !isValidManagedSkillName(value.name)) return null;
		if (this.#clean(value.name, 64) !== value.name) return null;
		if (![value.description, value.body, value.reason].every(field => typeof field === "string")) return null;
		if ((value.body as string).length > MAX_BODY_CHARS || !Array.isArray(value.pages)) return null;
		const description = sanitizeManagedDescription(this.#clean(value.description as string, 500));
		const body = this.#clean(value.body as string, MAX_BODY_CHARS);
		const reason = this.#clean(value.reason as string, 1_000);
		// The applicability stays in the published body, rather than disappearing with proposal metadata.
		if (!description || !reason || !/(?:^|\n)## Applicability[ \t]*\n[^\n\s][^\n]*/.test(body)) return null;
		if (value.pages.length === 0 || value.pages.length > 8) return null;
		const pages: WikiSourceRef[] = [];
		for (const ref of value.pages) {
			if (
				!isRecord(ref) ||
				typeof ref.id !== "string" ||
				!PAGE_ID.test(ref.id) ||
				!Number.isSafeInteger(ref.revision) ||
				(ref.revision as number) < 1 ||
				pages.some(page => page.id === ref.id)
			)
				return null;
			pages.push({ id: ref.id, revision: ref.revision as number });
		}
		return { name: value.name, description, body, reason, pages };
	}

	#candidate(value: unknown): WikiSkillCandidate | null {
		if (!isRecord(value) || typeof value.id !== "string" || !CANDIDATE_ID.test(value.id)) return null;
		if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
		if (!["pending", "accepted", "rejected", "invalidated"].includes(String(value.status))) return null;
		if (
			(value.status === "invalidated" || value.status === "rejected") &&
			value.name === "" &&
			value.description === "" &&
			value.body === "" &&
			Array.isArray(value.pages) &&
			value.pages.length === 0
		) {
			return {
				id: value.id,
				createdAt: new Date(value.createdAt).toISOString(),
				status: value.status,
				name: "",
				description: "",
				body: "",
				reason: PURGED_REASON,
				pages: [],
			};
		}
		const draft = this.#draft(value);
		if (!draft) return null;
		const candidate: WikiSkillCandidate = {
			...draft,
			id: value.id,
			createdAt: new Date(value.createdAt).toISOString(),
			status: value.status as WikiSkillCandidate["status"],
		};
		if (value.validation !== undefined) {
			const validation = value.validation;
			if (!isRecord(validation) || typeof validation.report !== "string") return null;
			const report = this.#clean(validation.report, 4_000);
			if (!report) return null;
			if (validation.kind === "manual") {
				candidate.validation = { kind: "manual", report };
			} else if (
				validation.kind === "behavioral" &&
				typeof validation.baseline === "number" &&
				Number.isFinite(validation.baseline) &&
				typeof validation.candidate === "number" &&
				Number.isFinite(validation.candidate)
			) {
				candidate.validation = {
					kind: "behavioral",
					baseline: validation.baseline,
					candidate: validation.candidate,
					report,
				};
			} else return null;
		}
		if (value.publishedHash !== undefined) {
			if (typeof value.publishedHash !== "string" || !SHA256.test(value.publishedHash)) return null;
			if (!candidate.validation) return null;
			if (
				candidate.validation.kind === "behavioral" &&
				candidate.validation.candidate! <= candidate.validation.baseline!
			)
				return null;
			candidate.publishedHash = value.publishedHash;
		}
		return candidate;
	}

	async #load(): Promise<WikiSkillCandidate[]> {
		const text = await readRegular(path.join(this.#dir, "candidates.json"), MAX_STATE_BYTES);
		if (text === null) return [];
		const data: unknown = JSON.parse(text);
		if (!Array.isArray(data)) throw new Error("Invalid Wiki skill candidate store.");
		const seen = new Set<string>();
		return data.map(value => {
			const candidate = this.#candidate(value);
			if (!candidate || seen.has(candidate.id)) throw new Error("Invalid Wiki skill candidate record.");
			seen.add(candidate.id);
			return candidate;
		});
	}

	async #save(candidates: WikiSkillCandidate[]): Promise<void> {
		const target = path.join(this.#dir, "candidates.json");
		const text = `${JSON.stringify(candidates, null, 2)}\n`;
		if (Buffer.byteLength(text) > MAX_STATE_BYTES)
			throw new Error("Wiki skill candidate store reached its size limit.");
		const temporary = path.join(this.#dir, `candidates-${randomUUID()}.tmp`);
		try {
			await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
			await replaceFileAtomically(temporary, target);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}

	async #scrubOutcomes(ids: Set<string>): Promise<void> {
		if (ids.size === 0) return;
		const target = path.join(this.#dir, "outcomes.jsonl");
		const source = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => {
			if (isEnoent(error)) return null;
			throw error;
		});
		if (!source) return;
		const temporary = path.join(this.#dir, `outcomes-${randomUUID()}.tmp`);
		let output: fs.FileHandle | undefined;
		try {
			const stat = await source.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new UnsafeSkillFile("Unsafe Wiki skill outcome log.");
			output = await fs.open(temporary, "wx", 0o600);
			const lines = createInterface({ input: source.createReadStream({ autoClose: false }), crlfDelay: Infinity });
			try {
				for await (const line of lines) {
					if (!line.trim()) continue;
					const record: unknown = JSON.parse(line);
					if (!isRecord(record) || typeof record.id !== "string")
						throw new Error("Invalid Wiki skill outcome record.");
					if (!ids.has(record.id)) await output.writeFile(`${line}\n`);
				}
			} finally {
				lines.close();
			}
			await output.close();
			output = undefined;
			await source.close();
			await replaceFileAtomically(temporary, target);
		} finally {
			await source.close();
			await output?.close();
			await fs.rm(temporary, { force: true });
		}
	}

	async #outcome(candidate: WikiSkillCandidate, event: string, report: string): Promise<void> {
		const handle = await fs.open(
			path.join(this.#dir, "outcomes.jsonl"),
			fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
			0o600,
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe Wiki skill outcome log.");
			await handle.writeFile(
				`${JSON.stringify({
					id: candidate.id,
					name: candidate.name,
					at: new Date().toISOString(),
					event,
					status: candidate.status,
					report: candidate.body ? this.#clean(report, 4_000) : PURGED_REASON,
					validation: candidate.validation,
					publishedHash: candidate.publishedHash,
				})}\n`,
			);
		} finally {
			await handle.close();
		}
	}

	async #managedContent(name: string): Promise<string | null> {
		const root = getManagedSkillsDir(this.#agentDir);
		for (const dir of [root, path.join(root, name)]) {
			const stat = await fs.lstat(dir).catch(error => {
				if (isEnoent(error)) return null;
				throw error;
			});
			if (stat === null) return null;
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnsafeSkillFile("Unsafe managed skill directory.");
		}
		return readRegular(path.join(root, name, "SKILL.md"), 64_000);
	}

	async #publishedContent(name: string): Promise<string | null> {
		try {
			return await this.#managedContent(name);
		} catch (error) {
			if (error instanceof UnsafeSkillFile || (error as NodeJS.ErrnoException).code === "ELOOP") return "";
			throw error;
		}
	}

	async #retract(candidate: WikiSkillCandidate): Promise<void> {
		if (!candidate.publishedHash) return;
		const content = await this.#publishedContent(candidate.name);
		if (content === null) {
			delete candidate.publishedHash;
		} else if (digest(content) === candidate.publishedHash) {
			await deleteManagedSkill(candidate.name, { agentDir: this.#agentDir, expectedHash: candidate.publishedHash });
			delete candidate.publishedHash;
		}
		// A changed file belongs to its editor. Retain the receipt, never erase their work.
	}

	async #reconcileLocked(candidates: WikiSkillCandidate[], pages: WikiPage[]): Promise<void> {
		const current = new Map(
			pages
				.filter(page => page.status === "active" && page.kind === "pattern")
				.map(page => [page.id, page.revision]),
		);
		const changed: WikiSkillCandidate[] = [];
		const purged = new Set<string>();
		for (const candidate of candidates) {
			const previous = JSON.stringify(candidate);
			const stale = candidate.pages.some(ref => current.get(ref.id) !== ref.revision);
			if (stale) {
				await this.#retract(candidate);
				candidate.status = candidate.status === "rejected" ? "rejected" : "invalidated";
				candidate.name = "";
				candidate.description = "";
				candidate.body = "";
				candidate.reason = PURGED_REASON;
				candidate.pages = [];
				delete candidate.validation;
				delete candidate.publishedHash;
				purged.add(candidate.id);
			}
			if (candidate.status === "pending" && candidate.publishedHash) {
				// Recover a crash between a gated write and its accepted-state commit.
				const content = await this.#publishedContent(candidate.name);
				if (content !== null && digest(content) === candidate.publishedHash) candidate.status = "accepted";
				else delete candidate.publishedHash;
			}
			if (candidate.status === "accepted") {
				const content = await this.#publishedContent(candidate.name);
				if (!candidate.publishedHash || content === null || digest(content) !== candidate.publishedHash) {
					candidate.status = "invalidated";
					candidate.reason = "Published skill was removed or edited outside Wiki; user changes are preserved.";
				}
			}
			if (candidate.status === "invalidated" || candidate.status === "rejected") await this.#retract(candidate);
			if (JSON.stringify(candidate) !== previous) changed.push(candidate);
		}
		// Purge old reports before committing tombstones, so a crash cannot hide unsanitized history.
		await this.#scrubOutcomes(purged);
		for (const candidate of changed) await this.#outcome(candidate, "reconciled", candidate.reason);
		if (changed.length > 0) await this.#save(candidates);
	}

	async #locked<T>(
		fn: (candidates: WikiSkillCandidate[], pages: WikiPage[], epoch: string) => Promise<T>,
	): Promise<T> {
		await safeDirectory(this.root);
		// Shared Store lock makes current-page checks and skill publication one mutation boundary.
		return withFileLock(path.join(this.root, "index.db"), async () => {
			await safeDirectory(this.#dir);
			const epochPath = path.join(this.#dir, "epoch");
			let epoch = await readRegular(epochPath, 100);
			if (epoch === null) {
				epoch = randomUUID();
				await fs.writeFile(epochPath, epoch, { flag: "wx", mode: 0o600 });
			}
			const pages = await readWikiPagesUnlocked(this.root);
			const candidates = await this.#load();
			await this.#reconcileLocked(candidates, pages);
			return fn(candidates, pages, epoch);
		});
	}

	async list(): Promise<WikiSkillCandidate[]> {
		return this.#locked(async candidates => candidates);
	}

	async reconcile(_pages: WikiPage[]): Promise<void> {
		// The caller's snapshot may already be stale; disk is authoritative under the shared lock.
		await this.#locked(async () => {});
	}

	async clear(): Promise<void> {
		await this.#locked(async candidates => {
			for (const candidate of candidates) await this.#retract(candidate);
			await removePrivateTree(this.#dir);
		});
	}

	async #assertNameAvailable(name: string): Promise<void> {
		if (isNameClaimedByAuthoredSkill(name))
			throw new SkillNameConflict(`Skill name "${name}" belongs to an authored skill.`);
		const dir = path.join(this.#agentDir, "skills");
		const authored = await scanSkillsFromDir(
			{ cwd: this.#agentDir, home: this.#agentDir, repoRoot: null },
			{ dir, providerId: "omp", level: "user", includeSelf: true },
		);
		if (authored.warnings?.length) throw new Error("Unable to safely inspect authored skill names.");
		if (authored.items.some(skill => skill.name === name))
			throw new SkillNameConflict(`Skill name "${name}" belongs to an authored skill.`);
	}

	async #target(candidate: WikiSkillCandidate, candidates: WikiSkillCandidate[]): Promise<PublicationTarget> {
		await this.#assertNameAvailable(candidate.name);
		const content = await this.#managedContent(candidate.name);
		if (content === null) return { content: "", hash: null };
		const hash = digest(content);
		if (
			!candidates.some(
				item => item.name === candidate.name && item.status === "accepted" && item.publishedHash === hash,
			)
		) {
			throw new SkillNameConflict(
				`Managed skill "${candidate.name}" is unrelated or user-edited; refusing to overwrite it.`,
			);
		}
		return { content, hash };
	}

	#pending(candidates: WikiSkillCandidate[], id: string): WikiSkillCandidate {
		const candidate = candidates.find(item => item.id === id);
		if (!candidate) throw new Error(`Unknown Wiki skill candidate: ${id}`);
		if (candidate.status !== "pending") throw new Error(`Wiki skill candidate is ${candidate.status}, not pending.`);
		return candidate;
	}

	async propose(pages: WikiPage[], signal?: AbortSignal): Promise<WikiSkillCandidate[]> {
		signal?.throwIfAborted();
		const input = await this.#locked(async (candidates, current, epoch) => {
			const requested = new Map(pages.map(page => [page.id, page.revision]));
			const selected = current
				.filter(
					page => page.status === "active" && page.kind === "pattern" && requested.get(page.id) === page.revision,
				)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
				.slice(0, 8)
				.map(page => ({
					id: page.id,
					revision: page.revision,
					title: this.#clean(page.title, 200),
					body: this.#clean(page.body, 4_000),
				}));
			const history = [
				...candidates.filter(candidate => candidate.status === "pending").slice(-4),
				...candidates
					.filter(candidate => candidate.status === "accepted" || candidate.status === "rejected")
					.slice(-12),
			].map(candidate => ({
				name: candidate.name,
				status: candidate.status,
				body: candidate.body.slice(0, 800),
				reason: candidate.reason,
				report: candidate.validation?.report.slice(0, 500),
			}));
			return { pages: selected, history, epoch };
		});
		if (input.pages.length === 0) return [];
		const response = await this.#complete({
			task: "skill",
			system: skillProposePrompt,
			prompt: JSON.stringify({ pages: input.pages, history: input.history }),
			maxTokens: 3_000,
			signal,
		});
		signal?.throwIfAborted();
		if (Buffer.byteLength(response) > 64_000) throw new Error("Wiki skill proposal response exceeded its limit.");
		const value: unknown = JSON.parse(
			response
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, ""),
		);
		if (!isRecord(value) || !Array.isArray(value.candidates))
			throw new Error("Wiki skill proposal must contain candidates.");
		const drafts = value.candidates
			.slice(0, 3)
			.map(value => this.#draft(value))
			.filter((draft): draft is WikiSkillDraft => draft !== null);
		return this.#locked(async (candidates, current, epoch) => {
			signal?.throwIfAborted();
			if (epoch !== input.epoch) throw new Error("Wiki skills were cleared during proposal.");
			const offered = new Map(input.pages.map(page => [page.id, page.revision]));
			const active = new Map(
				current
					.filter(page => page.status === "active" && page.kind === "pattern")
					.map(page => [page.id, page.revision]),
			);
			const known = new Set(
				candidates
					.filter(candidate => candidate.status !== "invalidated")
					.map(candidate => bodyKey(candidate.body)),
			);
			const proposed: WikiSkillCandidate[] = [];
			for (const draft of drafts) {
				if (draft.pages.some(ref => offered.get(ref.id) !== ref.revision || active.get(ref.id) !== ref.revision))
					continue;
				const key = bodyKey(draft.body);
				if (known.has(key)) continue;
				const candidate: WikiSkillCandidate = {
					...draft,
					id: `k-${randomUUID().replaceAll("-", "")}`,
					createdAt: new Date().toISOString(),
					status: "pending",
				};
				try {
					await this.#target(candidate, candidates);
				} catch (error) {
					if (!(error instanceof SkillNameConflict)) throw error;
					// Ineligible names are not durable candidates and never shadow authored skills.
					continue;
				}
				known.add(key);
				candidates.push(candidate);
				proposed.push(candidate);
			}
			if (proposed.length > 0) {
				await this.#save(candidates);
				for (const candidate of proposed) await this.#outcome(candidate, "proposed", candidate.reason);
			}
			return proposed;
		});
	}

	async #publish(
		candidate: WikiSkillCandidate,
		candidates: WikiSkillCandidate[],
		validation: Validation,
		baseline?: string | null,
	): Promise<void> {
		const target = await this.#target(candidate, candidates);
		if (baseline !== undefined && target.hash !== baseline)
			throw new Error("Skill baseline changed during evaluation; evaluate again.");
		candidate.validation = validation;
		candidate.publishedHash = digest(skillContent(candidate, this.#project));
		// Durable receipt precedes the gated write, enabling safe reconciliation after a crash.
		await this.#save(candidates);
		await this.#outcome(candidate, "publication-requested", validation.report);
		try {
			await writeManagedSkill({
				action: target.hash === null ? "create" : "update",
				agentDir: this.#agentDir,
				name: candidate.name,
				description: candidate.description,
				body: `${candidate.body}\n\n<!-- wiki-skill:${candidate.id} -->`,
				expectedHash: target.hash ?? undefined,
				project: this.#project,
			});
		} catch (error) {
			delete candidate.publishedHash;
			await this.#save(candidates);
			throw error;
		}
		for (const previous of candidates) {
			if (previous.id !== candidate.id && previous.name === candidate.name && previous.publishedHash) {
				delete previous.publishedHash;
				if (previous.status === "accepted") previous.status = "invalidated";
			}
		}
		candidate.status = "accepted";
		await this.#save(candidates);
		await this.#outcome(candidate, "published", validation.report);
	}

	async approve(id: string): Promise<WikiSkillCandidate> {
		return this.#locked(async candidates => {
			const candidate = this.#pending(candidates, id);
			await this.#publish(candidate, candidates, {
				kind: "manual",
				report: "Explicit user approval; no behavioral evaluation was claimed.",
			});
			return candidate;
		});
	}

	async reject(id: string, reason: string): Promise<WikiSkillCandidate> {
		const report = this.#clean(reason, 1_000);
		if (!report) throw new Error("A rejection reason is required.");
		return this.#locked(async candidates => {
			const candidate = candidates.find(item => item.id === id);
			if (!candidate) throw new Error(`Unknown Wiki skill candidate: ${id}`);
			candidate.status = "rejected";
			candidate.reason = candidate.body ? report : PURGED_REASON;
			await this.#retract(candidate);
			await this.#save(candidates);
			await this.#outcome(candidate, "rejected", report);
			return candidate;
		});
	}

	/**
	 * Executes only caller-supplied trusted argv, without a shell or generated arguments.
	 * OMP_WIKI_SKILL_INPUT points to read-only JSON with baseline/candidate {path, sha256},
	 * source page refs, and outputPath. Fixtures are complete SKILL.md files; an absent
	 * baseline is an empty file with present=false. Higher scores are better.
	 * The evaluator writes {baseline:number,candidate:number,report:string} to
	 * OMP_WIKI_SKILL_OUTPUT and exits 0. Both scores must be finite; improvement is strict.
	 * Its private cwd/HOME/temp directory is removed on success, failure, timeout, or abort.
	 */
	async validate(id: string, argv: string[], signal?: AbortSignal): Promise<WikiSkillCandidate> {
		if (
			!Array.isArray(argv) ||
			argv.length === 0 ||
			argv.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
			!argv[0]?.trim()
		) {
			throw new Error("Configure an explicit trusted Wiki skill evaluator argv before validation.");
		}
		signal?.throwIfAborted();
		const input = await this.#locked(async candidates => {
			const candidate = this.#pending(candidates, id);
			const target = await this.#target(candidate, candidates);
			return { candidate, target };
		});
		let validation: BehavioralValidation;
		try {
			validation = await this.#evaluate(input.candidate, input.target, [...argv], signal);
		} catch (error) {
			await this.#locked(async candidates => {
				const candidate = candidates.find(item => item.id === id);
				if (candidate)
					await this.#outcome(
						candidate,
						"validation-failed",
						error instanceof Error ? error.message : String(error),
					);
			});
			throw error;
		}
		return this.#locked(async candidates => {
			signal?.throwIfAborted();
			const candidate = this.#pending(candidates, id);
			if (skillContent(candidate) !== skillContent(input.candidate))
				throw new Error("Skill candidate changed during evaluation.");
			if (validation.candidate <= validation.baseline) {
				candidate.status = "rejected";
				candidate.validation = validation;
				candidate.reason = "Trusted evaluator found no improvement over the baseline.";
				await this.#save(candidates);
				await this.#outcome(candidate, "rejected", validation.report);
			} else {
				await this.#publish(candidate, candidates, validation, input.target.hash);
			}
			return candidate;
		});
	}

	async #evaluate(
		candidate: WikiSkillCandidate,
		baseline: PublicationTarget,
		argv: string[],
		signal?: AbortSignal,
	): Promise<BehavioralValidation> {
		const workspace = await fs.mkdtemp(path.join(this.#dir, "eval-"));
		const fixtures = path.join(workspace, "fixtures");
		try {
			await fs.chmod(workspace, 0o700);
			await fs.mkdir(fixtures, { mode: 0o700 });
			const baselinePath = path.join(fixtures, "baseline.md");
			const candidatePath = path.join(fixtures, "candidate.md");
			const inputPath = path.join(fixtures, "input.json");
			const outputPath = path.join(workspace, "result.json");
			const candidateBody = skillContent(candidate, this.#project);
			const input = `${JSON.stringify(
				{
					version: 1,
					id: candidate.id,
					baseline: { path: baselinePath, sha256: digest(baseline.content), present: baseline.hash !== null },
					candidate: { path: candidatePath, sha256: digest(candidateBody), name: candidate.name },
					pages: candidate.pages,
					outputPath,
					outputContract: {
						baseline: "finite number; higher is better",
						candidate: "finite number; higher is better",
						report: "non-empty string",
					},
				},
				null,
				2,
			)}\n`;
			await Promise.all([
				fs.writeFile(baselinePath, baseline.content, { mode: 0o400, flag: "wx" }),
				fs.writeFile(candidatePath, candidateBody, { mode: 0o400, flag: "wx" }),
				fs.writeFile(inputPath, input, { mode: 0o400, flag: "wx" }),
			]);
			await fs.chmod(fixtures, 0o500);
			const result = await runBoundedProbe(argv, {
				cwd: workspace,
				timeoutMs: this.#evaluatorTimeoutMs,
				signal,
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					HOME: workspace,
					USERPROFILE: workspace,
					TMPDIR: workspace,
					TMP: workspace,
					TEMP: workspace,
					XDG_CONFIG_HOME: workspace,
					XDG_CACHE_HOME: workspace,
					XDG_DATA_HOME: workspace,
					OMP_WIKI_SKILL_INPUT: inputPath,
					OMP_WIKI_SKILL_OUTPUT: outputPath,
				},
			});
			if (result.aborted) throw new Error("Wiki skill evaluation cancelled.");
			if (result.timedOut) throw new Error("Wiki skill evaluation timed out.");
			if (result.exitCode !== 0) throw new Error(`Wiki skill evaluator exited with code ${result.exitCode}.`);
			const [actualBaseline, actualCandidate, actualInput] = await Promise.all([
				readRegular(baselinePath, 64_000),
				readRegular(candidatePath, 64_000),
				readRegular(inputPath, MAX_RESULT_BYTES),
			]);
			if (actualBaseline !== baseline.content || actualCandidate !== candidateBody || actualInput !== input) {
				throw new Error("Wiki skill evaluator modified immutable fixtures.");
			}
			const output = await readRegular(outputPath, MAX_RESULT_BYTES);
			if (output === null) throw new Error("Wiki skill evaluator did not write its result JSON.");
			const scores: unknown = JSON.parse(output);
			if (
				!isRecord(scores) ||
				typeof scores.baseline !== "number" ||
				!Number.isFinite(scores.baseline) ||
				typeof scores.candidate !== "number" ||
				!Number.isFinite(scores.candidate) ||
				typeof scores.report !== "string" ||
				!this.#clean(scores.report, 4_000)
			)
				throw new Error("Wiki skill evaluator must return finite baseline/candidate scores and a report.");
			return {
				kind: "behavioral",
				baseline: scores.baseline,
				candidate: scores.candidate,
				report: this.#clean(scores.report, 4_000),
			};
		} finally {
			await removePrivateTree(workspace);
		}
	}
}
