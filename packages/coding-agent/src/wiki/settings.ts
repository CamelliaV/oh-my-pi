/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgWikiIncludeGlobal = register({
	id: "wiki.includeGlobal",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Include Global",
		description: "Search the user-global vault alongside the project vault",
	},
});
