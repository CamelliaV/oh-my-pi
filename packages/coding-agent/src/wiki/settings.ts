/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgWikiRoot = register({
	id: "wiki.root",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Wiki Root",
		description: "Vault directory. Empty uses the default project/user vault.",
	},
});

export const cfgWikiScope = register({
	id: "wiki.scope",
	type: "enum",
	values: ["project", "global"] as const,
	default: "project",
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Write Scope",
		description: "Project-local knowledge or explicitly shared user knowledge",
	},
});

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

export const cfgWikiModel = register({
	id: "wiki.model",
	type: "string",
	default: "@smol",
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Knowledge Model",
		description: "Model for incremental maintenance and skill proposals",
	},
});

export const cfgWikiRecallModel = register({
	id: "wiki.recallModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Recall Model",
		description: "Optional faster model for read-only evidence selection; empty uses Knowledge Model",
	},
});

export const cfgWikiAutoRetain = register({ id: "wiki.autoRetain", type: "boolean", default: true });
export const cfgWikiAutoMaintain = register({ id: "wiki.autoMaintain", type: "boolean", default: true });
export const cfgWikiAutoRecall = register({ id: "wiki.autoRecall", type: "boolean", default: false });

export const cfgWikiTimeoutSeconds = register({
	id: "wiki.timeoutSeconds",
	type: "number",
	default: 30,
	ui: {
		tab: "memory",
		group: "Wiki",
		label: "Wiki Timeout",
		description:
			"Seconds for each Wiki model request and the whole recall. Timed-out or failed recall retries on the session model, then falls back to FTS keyword search instead of hanging.",
	},
});

export const cfgWikiMaintenanceBatchSize = register({
	id: "wiki.maintenanceBatchSize",
	type: "number",
	default: 8,
});
export const cfgWikiRecallLimit = register({ id: "wiki.recallLimit", type: "number", default: 4 });
export const cfgWikiContextTokenLimit = register({ id: "wiki.contextTokenLimit", type: "number", default: 1500 });
export const cfgWikiSkillValidationCommand = register({
	id: "wiki.skillValidationCommand",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});
