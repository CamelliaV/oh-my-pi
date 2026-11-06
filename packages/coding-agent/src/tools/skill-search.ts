import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SkillSearchDetails } from "@oh-my-pi/pi-tui/tools/skill-search";
import { SkillSearchIndex, formatSkillSearchResult } from "../extensibility/skill-search";
import { cfgSkillsEnabled, cfgSkillsOnDemand } from "../extensibility/settings";
import skillSearchDescription from "../prompts/tools/skill-search.md" with { type: "text" };
import type { ToolSession } from ".";

const skillSearchSchema = type({
	query: type("string").describe("keywords or exact skill name; empty string browses all local skills"),
	"offset?": type("number.integer >= 0").describe("nextOffset from a previous result; defaults to zero"),
});

export type SkillSearchParams = typeof skillSearchSchema.infer;

export function isSkillSearchEnabled(session: ToolSession): boolean {
	return (
		(session.skillCatalogPolicy?.onDemand ?? cfgSkillsOnDemand.get(session.settings)) &&
		cfgSkillsEnabled.get(session.settings) &&
		(session.skills?.some(skill => skill.hide !== true) ?? false)
	);
}

export class SkillSearchTool implements AgentTool<typeof skillSearchSchema, SkillSearchDetails> {
	readonly name = "skill_search";
	readonly label = "Skill Search";
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly description = skillSearchDescription;
	readonly summary = "Search local skills with full descriptions";
	readonly parameters = skillSearchSchema;
	readonly #index = new SkillSearchIndex();

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SkillSearchTool | null {
		return isSkillSearchEnabled(session) ? new SkillSearchTool(session) : null;
	}

	async execute(
		_id: string,
		params: SkillSearchParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SkillSearchDetails>> {
		signal?.throwIfAborted();
		const result = this.#index.search(this.session.skills ?? [], params.query, params.offset);
		return { content: [{ type: "text", text: formatSkillSearchResult(result) }], details: result };
	}
}
