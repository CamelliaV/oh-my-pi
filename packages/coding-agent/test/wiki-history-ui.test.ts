import { afterEach, describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../src/session/agent-session";
import { getWikiState, setWikiState, WikiState } from "../src/wiki/state";
import { runWikiHistoryCommand } from "../src/wiki/commands";
import { WikiStore } from "../src/wiki/store";
import type { WikiComplete } from "../src/wiki/types";
import { InternalUrlRouter } from "../src/internal-urls";
import { createMemoryRuntimeContext } from "../src/memory-backend/runtime";

const states: WikiState[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) {
		setWikiState(state.session, undefined);
		await state.dispose();
	}
});

const noModel: WikiComplete = async () => {
	throw new Error("history test must not invoke a model");
};

describe("Wiki history commands", () => {
	it("lists, diffs, and restores revisions without model calls", async () => {
		await using temp = TempDir.createSync("wiki-history-ui-");
		const settings = Settings.isolated({
			"memory.backend": "wiki",
			"wiki.root": temp.join("wiki"),
			"wiki.includeGlobal": false,
		});
		const session = {
			sessionId: "history-ui",
			settings,
			obfuscator: { obfuscate: (value: string) => value },
			sessionManager: { getCwd: () => temp.path() },
			agent: { tokenizer: new Tokenizer() },
			refreshSkills: async () => {},
		} as unknown as AgentSession;
		const config = {
			root: temp.join("wiki"),
			projectRoot: temp.join("wiki"),
			globalRoot: temp.join("global"),
			includeGlobal: false,
			model: "unused",
			recallModel: "unused",
			autoRetain: false,
			autoMaintain: false,
			autoRecall: false,
			timeoutMs: 1000,
			batchSize: 1,
			recallLimit: 1,
			contextTokenLimit: 500,
			skillValidationCommand: [],
		};
		const state = new WikiState({ session, config, agentDir: temp.join("agent"), complete: noModel });
		await state.open();
		setWikiState(session, state);
		states.push(state);
		const store = new WikiStore({ root: config.root });
		await store.open();
		const source = await store.capture({ content: "The current deployment region is west." });
		await store.publish(await store.snapshot(), {
			pages: [
				{
					id: "w-deployment",
					expectedRevision: null,
					title: "Deployment",
					summary: "Region",
					body: "The current deployment region is west.",
					kind: "knowledge",
					status: "active",
					sources: [{ id: source.id, revision: source.revision }],
					links: [],
				},
			],
			processed: [{ id: source.id, revision: source.revision }],
		});
		await store.mutate("w-deployment", { op: "invalidate" });
		store.close();
		expect(await runWikiHistoryCommand(session, "history", "w-deployment")).toContain("r2");
		expect(await runWikiHistoryCommand(session, "diff", "w-deployment 1 2")).toContain("memory://w-deployment@1");
		expect(await runWikiHistoryCommand(session, "restore", "w-deployment 1")).toContain("as w-deployment@3");
		expect((await getWikiState(session)!.history("w-deployment")).at(-1)?.current).toBe(true);
		const resource = await InternalUrlRouter.instance().resolve("memory://pages/w-deployment/r00000001.md", {
			settings,
			memory: createMemoryRuntimeContext({ session, agentDir: temp.join("agent"), cwd: temp.path() }),
		});
		expect(resource.content).toContain("west");
	});
});
