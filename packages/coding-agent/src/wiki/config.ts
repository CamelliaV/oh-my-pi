import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { computeMnemopiBankScope } from "../mnemopi/config";

export interface WikiConfig {
	root: string;
	projectRoot: string;
	globalRoot: string;
	includeGlobal: boolean;
	model: string;
	recallModel: string;
	autoRetain: boolean;
	autoMaintain: boolean;
	autoRecall: boolean;
	timeoutMs: number;
	batchSize: number;
	recallLimit: number;
	contextTokenLimit: number;
	skillValidationCommand: string[];
}

export function loadWikiConfig(settings: Settings, agentDir: string, cwd = settings.getCwd()): WikiConfig {
	const base = settings.get("wiki.root")?.trim() || path.join(getMemoriesDir(agentDir), "wiki");
	const scope = computeMnemopiBankScope(undefined, cwd, "per-project-tagged");
	const projectRoot = path.resolve(base, scope.bank);
	const globalRoot = path.resolve(base, scope.globalBank);
	const model = settings.get("wiki.model")?.trim() || "@smol";
	return {
		root: settings.get("wiki.scope") === "global" ? globalRoot : projectRoot,
		projectRoot,
		globalRoot,
		includeGlobal: settings.get("wiki.includeGlobal"),
		model,
		recallModel: settings.get("wiki.recallModel")?.trim() || model,
		autoRetain: settings.get("wiki.autoRetain"),
		autoMaintain: settings.get("wiki.autoMaintain"),
		autoRecall: settings.get("wiki.autoRecall"),
		timeoutMs: Math.min(120_000, Math.max(1000, settings.get("wiki.timeoutSeconds") * 1000)),
		batchSize: Math.min(32, Math.max(1, Math.floor(settings.get("wiki.maintenanceBatchSize")))),
		recallLimit: Math.min(12, Math.max(1, Math.floor(settings.get("wiki.recallLimit")))),
		contextTokenLimit: Math.max(128, Math.floor(settings.get("wiki.contextTokenLimit"))),
		skillValidationCommand: settings.get("wiki.skillValidationCommand"),
	};
}
