import { FuzzyCorpus, FuzzyQuery } from "@oh-my-pi/pi-tui";
import type { SkillSearchDetails } from "@oh-my-pi/pi-tui/tools/skill-search";
import { MANAGED_SKILLS_PROVIDER_ID } from "../autolearn/managed-skills";
import type { Settings } from "../config/settings";
import { compareSkillOrder } from "../discovery/helpers";
import { cfgSkillsOnDemand, cfgSkillsPinned } from "./settings";
import { skillSearchBody, type Skill } from "./skills";

export interface SkillCatalogPolicy {
	readonly onDemand: boolean;
	readonly pinned: readonly string[];
}

export function snapshotSkillCatalogPolicy(settings: Settings): SkillCatalogPolicy {
	return { onDemand: cfgSkillsOnDemand.get(settings), pinned: [...cfgSkillsPinned.get(settings)] };
}

/** A restricted tool slate without search retains the ordinary catalog, so skills remain discoverable. */
export function selectPromptSkills(
	skills: readonly Skill[],
	policy: SkillCatalogPolicy | undefined,
	searchAvailable: boolean,
): readonly Skill[] {
	if (!policy?.onDemand || !searchAvailable) return skills;
	const pinned = new Set(policy.pinned);
	return skills.filter(skill => skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID || pinned.has(skill.name));
}

export const SKILL_SEARCH_PAGE_SIZE = 5;

/** Uses the same keyword/fuzzy matcher as the local selectors; no model calls or prompt mutations. */
export class SkillSearchIndex {
	#source?: readonly Skill[];
	#corpus?: FuzzyCorpus<Skill>;
	#bodyCorpus?: FuzzyCorpus<Skill>;
	#visible: Skill[] = [];

	search(skills: readonly Skill[], query: string, offset = 0): SkillSearchDetails {
		if (skills !== this.#source) {
			this.#source = skills;
			this.#visible = skills
				.filter(skill => skill.hide !== true)
				.toSorted((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
			this.#corpus = new FuzzyCorpus(this.#visible, skill => `${skill.name}\n${skill.description}`);
			this.#bodyCorpus = undefined;
		}
		const normalized = query.trim();
		const nameQuery = new FuzzyQuery(normalized);
		let matches = this.#corpus!.rank(normalized);
		if (normalized && matches.length === 0) {
			this.#bodyCorpus ??= new FuzzyCorpus(
				this.#visible,
				skill => `${skill.name}\n${skill.description}\n${skillSearchBody(skill)}`,
			);
			matches = this.#bodyCorpus.rank(normalized);
		}
		const ranked = matches.map(({ item, score }) => ({
			skill: item,
			score,
			exact: item.name.toLowerCase() === normalized.toLowerCase(),
			nameMatch: nameQuery.match(item.name).matches,
		}));
		if (normalized) {
			ranked.sort(
				(a, b) =>
					Number(b.exact) - Number(a.exact) || Number(b.nameMatch) - Number(a.nameMatch) || a.score - b.score,
			);
		}
		const start = Math.max(0, Math.floor(offset));
		const items = ranked.slice(start, start + SKILL_SEARCH_PAGE_SIZE).map(({ skill }) => ({
			name: skill.name,
			description: skill.description,
			uri: `skill://${skill.name}`,
		}));
		return {
			query: normalized,
			offset: start,
			total: ranked.length,
			items,
			...(start + items.length < ranked.length ? { nextOffset: start + items.length } : {}),
		};
	}
}

export function formatSkillSearchResult(result: SkillSearchDetails): string {
	const heading =
		result.total === 0
			? "No matching local skills."
			: result.items.length === 0
				? `${result.total} local skills; no entries at offset ${result.offset}.`
				: `${result.total} local skills; showing ${result.offset + 1}-${result.offset + result.items.length}.`;
	const rows = result.items.map(skill => `${skill.name}\n${skill.description}\n${skill.uri}`);
	const more = result.nextOffset === undefined ? [] : [`Next offset: ${result.nextOffset}`];
	return [heading, ...rows, ...more].join("\n\n");
}
