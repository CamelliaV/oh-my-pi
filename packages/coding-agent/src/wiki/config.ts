import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { computeMnemopiBankScope } from "../mnemopi/config";
import {
	cfgWikiAutoMaintain,
	cfgWikiAutoRecall,
	cfgWikiAutoRetain,
	cfgWikiContextTokenLimit,
	cfgWikiIncludeGlobal,
	cfgWikiMaintenanceBatchSize,
	cfgWikiModel,
	cfgWikiRecallLimit,
	cfgWikiRecallModel,
	cfgWikiRoot,
	cfgWikiScope,
	cfgWikiSkillValidationCommand,
	cfgWikiTimeoutSeconds,
} from "./settings";

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
	const base = cfgWikiRoot.get(settings)?.trim() || path.join(getMemoriesDir(agentDir), "wiki");
	const scope = computeMnemopiBankScope(undefined, cwd, "per-project-tagged");
	const projectRoot = path.resolve(base, scope.bank);
	const globalRoot = path.resolve(base, scope.globalBank);
	const model = cfgWikiModel.get(settings)?.trim() || "@smol";
	return {
		root: cfgWikiScope.get(settings) === "global" ? globalRoot : projectRoot,
		projectRoot,
		globalRoot,
		includeGlobal: cfgWikiIncludeGlobal.get(settings),
		model,
		recallModel: cfgWikiRecallModel.get(settings)?.trim() || model,
		autoRetain: cfgWikiAutoRetain.get(settings),
		autoMaintain: cfgWikiAutoMaintain.get(settings),
		autoRecall: cfgWikiAutoRecall.get(settings),
		timeoutMs: Math.min(120_000, Math.max(1000, cfgWikiTimeoutSeconds.get(settings) * 1000)),
		batchSize: Math.min(32, Math.max(1, Math.floor(cfgWikiMaintenanceBatchSize.get(settings)))),
		recallLimit: Math.min(12, Math.max(1, Math.floor(cfgWikiRecallLimit.get(settings)))),
		contextTokenLimit: Math.max(128, Math.floor(cfgWikiContextTokenLimit.get(settings))),
		skillValidationCommand: cfgWikiSkillValidationCommand.get(settings),
	};
}
