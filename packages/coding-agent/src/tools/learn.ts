import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { createToolMemoryRuntimeContext } from "../memory-backend/runtime";
import { memoryBackendCapabilities } from "../memory-backend/types";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { isGlobalMemoryScopeAvailable } from "../mnemopi/settings";
import { getMnemopiSessionState } from "../mnemopi/state";

const learnSkillSchema = type({
	action: "'create' | 'update'",
	name: type("string").describe("kebab-case skill name"),
	description: type("string").describe("one-line description of when to use the skill"),
	body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
}).describe("also create or enhance a managed skill in the same call");

const learnSchemaBase = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": learnSkillSchema,
});

/** Offered only where a shared bank exists; see {@link isGlobalMemoryScopeAvailable}. */
const learnSchemaWithScope = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"scope?": type("'project' | 'global'").describe(
		"storage scope; defaults to project, global is for durable cross-project knowledge",
	),
	"skill?": learnSkillSchema,
});

type LearnSchema = typeof learnSchemaBase | typeof learnSchemaWithScope;

export type LearnParams = typeof learnSchemaWithScope.infer;

/**
 * Persists a lesson through the native backend, optionally writing a managed skill
 * when that backend permits direct publication. Candidate-gated backends require
 * verified behavior or manual approval through their skill workflow instead.
 */
export class LearnTool implements AgentTool<LearnSchema> {
	readonly name = "learn";
	/** A global lesson reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) => {
		const params = args as Partial<LearnParams>;
		const capabilities = memoryBackendCapabilities[cfgMemoryBackend.get(this.session.settings)];
		return params.skill || params.scope === "global" ? "write" : capabilities.saveApproval;
	};
	readonly label = "Learn";
	get description(): string {
		return prompt.render(learnDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session.settings) });
	}
	get parameters(): LearnSchema {
		return isGlobalMemoryScopeAvailable(this.session.settings) ? learnSchemaWithScope : learnSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!cfgAutolearnEnabled.get(session.settings)) return null;
		const backend = cfgMemoryBackend.get(session.settings);
		if (!memoryBackendCapabilities[backend].writable) return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new LearnTool(session);
	}

	async execute(_id: string, params: LearnParams): Promise<AgentToolResult> {
		const capabilities = memoryBackendCapabilities[cfgMemoryBackend.get(this.session.settings)];
		if (params.skill && !capabilities.directSkills) {
			throw new Error(
				"This memory backend requires verified or manually approved skill candidates. Use /memory skill propose; the lesson and skill were not saved.",
			);
		}
		if (params.scope === "global") {
			if (cfgMemoryBackend.get(this.session.settings) !== "mnemopi") {
				throw new Error("Global memory scope is only available with the Mnemopi backend.");
			}
			const owner = this.session.getMemoryContext?.()?.session;
			getMnemopiSessionState(owner)?.getGlobalRetainTarget();
		}
		const result = await createToolMemoryRuntimeContext(this.session).save({
			content: params.memory,
			context: params.context,
			source: "coding-agent-learn",
			importance: 0.8,
			scope: params.scope,
			tool: "learn",
		});
		if (result.error || (!result.queued && result.stored < 1)) {
			const raw = result.error ?? result.message ?? "The memory backend did not store the lesson.";
			const reason = raw.replace(/^Mnemopi did not store the memory: /, "");
			const prefixed =
				cfgMemoryBackend.get(this.session.settings) === "mnemopi" && !reason.startsWith("Mnemopi ")
					? `Mnemopi did not store the lesson: ${reason}`
					: reason;
			throw new Error(prefixed);
		}
		const memoryMessage = result.queued ? "Lesson queued for retention" : "Lesson stored";

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
