import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Text, type Component } from "../index";
import { col, text } from "../native/describe";
import { renderStatusLine, truncateToWidth } from "../render";
import { createCachedComponent, replaceTabs, shortenEmbeddedPaths, wrapTextWithAnsi } from "../render/render-utils";
import type { Theme } from "../theme/theme";
import { resultText, toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

export interface SkillSearchDetails {
	query: string;
	offset: number;
	total: number;
	items: Array<{ name: string; description: string; uri: string }>;
	nextOffset?: number;
}

interface SkillSearchArgs {
	query?: string;
	offset?: number;
}

function clean(value: string): string {
	return shortenEmbeddedPaths(replaceTabs(sanitizeText(value)));
}

function bodyLines(result: ToolRenderResult<SkillSearchDetails>): string[] {
	if (result.isError || !result.details) return [clean(resultText(result))];
	const { items, nextOffset } = result.details;
	if (items.length === 0) return ["No matching local skills. Try other keywords or an empty query to browse."];
	return [
		...items.flatMap(skill => [clean(skill.name), clean(skill.description), clean(skill.uri), ""]),
		...(nextOffset === undefined ? [] : [`Next offset: ${nextOffset}`]),
	];
}

export const skillSearchToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: SkillSearchArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: "Skill Search", description: clean(args.query ?? "Browse local skills") },
				theme,
			),
			0,
			0,
		);
	},
	renderResult(
		result: ToolRenderResult<SkillSearchDetails>,
		_options: RenderResultOptions,
		theme: Theme,
		args?: SkillSearchArgs,
	): Component {
		const header = renderStatusLine(
			{
				icon: result.isError ? "error" : "success",
				title: "Skill Search",
				description: clean(args?.query || "Browse local skills"),
				meta: result.details ? [`${result.details.total} matches`] : [],
			},
			theme,
		);
		const body = bodyLines(result);
		return createCachedComponent(
			() => false,
			width => [
				truncateToWidth(header, width),
				...body.flatMap(line =>
					wrapTextWithAnsi(line, Math.max(1, width - 2)).map(wrapped => truncateToWidth(`  ${wrapped}`, width)),
				),
			],
		);
	},
	describeCall(args: SkillSearchArgs): NativeToolView {
		return { head: toolHead("Skill Search", clean(args.query || "Browse local skills")), inline: true };
	},
	describeResult(
		result: ToolRenderResult<SkillSearchDetails>,
		_options: RenderResultOptions,
		args?: SkillSearchArgs,
	): NativeToolView {
		return {
			head: toolHead("Skill Search", clean(args?.query || "Browse local skills")),
			inline: true,
			tone: result.isError ? "error" : undefined,
			preview: "none",
			body: [col(bodyLines(result).map(line => text(line)))],
		};
	},
} satisfies ToolRenderer<SkillSearchArgs, SkillSearchDetails>;
