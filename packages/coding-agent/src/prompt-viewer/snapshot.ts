import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { computeSessionContextBreakdown } from "../session/context-usage-runtime";
import type { AgentSession } from "../session/agent-session";

/**
 * Read-only snapshot of the invisible system-side prompt content behind the
 * /context usage modal categories. All text is captured verbatim from the live
 * session at open time — the same strings the estimator tokenizes.
 */

export type SectionId = "systemPrompt" | "systemContext" | "systemTools" | "skills";

export interface PromptBlock {
	readonly label: string;
	readonly text: string;
	readonly tokens: number;
}

export interface PromptSection {
	readonly id: SectionId;
	readonly label: string;
	readonly tokens: number;
	readonly blocks: readonly PromptBlock[];
}

export interface PromptSnapshot {
	readonly sections: readonly PromptSection[];
	readonly error?: string;
}

interface SessionShape {
	readonly model?: AgentSession["model"];
	readonly systemPrompt?: readonly string[];
	readonly renderedSkills?: readonly {
		readonly name: string;
		readonly description?: string;
		readonly hide?: boolean;
	}[];
	readonly agent?: {
		readonly tokenizer: { countTokens(text: string | readonly string[]): number };
		readonly state?: {
			readonly tools?: readonly {
				readonly name: string;
				readonly description?: string;
				readonly parameters?: unknown;
				readonly examples?: unknown[];
			}[];
		};
	};
}

/** Mirror of `renderedSkills` in packages/tui/src/status-line/context-usage.ts. */

/**
 * Build the category snapshot from the live session. Numbers come from the
 * same `computeSessionContextBreakdown` the /context modal uses, so the header
 * tokens match the modal; per-block token counts reuse the session tokenizer.
 */
export function buildPromptSnapshot(session: AgentSession): PromptSnapshot {
	const shape = session as unknown as SessionShape;
	const countTokens = (fragments: string | readonly string[]): number => {
		try {
			return shape.agent?.tokenizer.countTokens(fragments) ?? 0;
		} catch {
			return 0;
		}
	};
	let breakdown;
	try {
		breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
	} catch (error) {
		return { sections: [], error: error instanceof Error ? error.message : String(error) };
	}
	const categoryTokens: Record<string, number> = {};
	for (const category of breakdown.categories) categoryTokens[category.id] = category.tokens;

	const parts = shape.systemPrompt ?? [];
	const block0 = parts[0] ?? "";

	const systemPromptBlocks: PromptBlock[] = [
		{
			label: "block 0 · harness template (skills list rendered inside; counted under Skills)",
			text: block0,
			tokens: countTokens(block0),
		},
	];

	const systemContextBlocks: PromptBlock[] = parts.slice(1).map((part, index) => ({
		label: `block ${index + 1}${index === parts.length - 2 && parts.length > 1 ? " · project context" : ""}`,
		text: part ?? "",
		tokens: countTokens(part ?? ""),
	}));

	const tools = shape.agent?.state?.tools ?? [];
	const systemToolsBlocks: PromptBlock[] = tools.map(tool => {
		// Per-tool wire text: the same fragments the schema estimator tokenizes.
		const wireLines: string[] = [];
		try {
			const wireTool = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				examples: tool.examples,
			} as Parameters<typeof toolWireSchema>[0];
			wireLines.push(JSON.stringify(toolWireSchema(wireTool) ?? {}, null, 2));
			const examplesBlock = renderToolExamples(wireTool as Parameters<typeof renderToolExamples>[0]);
			if (examplesBlock) wireLines.push(examplesBlock);
		} catch (error) {
			wireLines.push(`[schema unavailable: ${error instanceof Error ? error.message : String(error)}]`);
		}
		const text = wireLines.join("\n");
		return {
			label: tool.name,
			text,
			tokens: countTokens([tool.name, tool.description ?? "", text].filter(fragment => fragment.length > 0)),
		};
	});

	// Skills shown only when the estimator counts them: read tool present, hide unset.
	const skills = tools.some(tool => tool.name === "read")
		? (shape.renderedSkills ?? []).filter(skill => skill.hide !== true)
		: [];
	const skillsBlocks: PromptBlock[] = [
		{
			label: `${skills.length} skill(s) · catalog lines embedded in block 0`,
			text: skills.map(skill => `- ${skill.name}: ${skill.description ?? ""}`).join("\n"),
			tokens: countTokens(skills.flatMap(skill => [skill.name, skill.description ?? ""])),
		},
	];

	const sections: PromptSection[] = [
		{
			id: "systemPrompt",
			label: "System prompt",
			tokens: categoryTokens.systemPrompt ?? 0,
			blocks: systemPromptBlocks,
		},
		{
			id: "systemContext",
			label: "System context",
			tokens: categoryTokens.systemContext ?? 0,
			blocks: systemContextBlocks,
		},
		{
			id: "systemTools",
			label: "System tools",
			tokens: categoryTokens.systemTools ?? 0,
			blocks: systemToolsBlocks,
		},
		{
			id: "skills",
			label: "Skills",
			tokens: categoryTokens.skills ?? 0,
			blocks: skillsBlocks,
		},
	];
	return { sections };
}
