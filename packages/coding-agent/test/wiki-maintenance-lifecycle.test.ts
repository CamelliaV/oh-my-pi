import { afterEach, describe, expect, it } from "bun:test";
import { Tokenizer, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { loadWikiConfig } from "@oh-my-pi/pi-coding-agent/wiki/config";
import { wikiSourcePassages } from "@oh-my-pi/pi-coding-agent/wiki/evidence";
import { WikiState } from "@oh-my-pi/pi-coding-agent/wiki/state";
import type { WikiComplete, WikiCompletionRequest } from "@oh-my-pi/pi-coding-agent/wiki/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const states: WikiState[] = [];
afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose();
});

interface MaintenanceInput {
	sources: Array<{ id: string; revision: number; passages: Array<{ content: string }> }>;
}
function input(request: WikiCompletionRequest): MaintenanceInput {
	return JSON.parse(request.prompt.match(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/)![1]!);
}
function acknowledge(data: MaintenanceInput): string {
	return JSON.stringify({ pages: [], processed: data.sources.map(({ id, revision }) => ({ id, revision })) });
}
async function fixture(temp: TempDir, complete: WikiComplete, automatic = false) {
	const settings = Settings.isolated({
		"memory.backend": "wiki",
		"wiki.root": temp.join("wiki"),
		"wiki.includeGlobal": false,
		"wiki.autoMaintain": automatic,
		"wiki.maintenanceBatchSize": 2,
	});
	let listener: AgentSessionEventListener | undefined;
	const session = {
		sessionId: crypto.randomUUID(),
		settings,
		sessionManager: { getCwd: () => temp.join("project") },
		agent: { tokenizer: new Tokenizer() },
		subscribe(callback: AgentSessionEventListener) {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as AgentSession;
	const state = new WikiState({
		session,
		config: loadWikiConfig(settings, temp.join("agent"), temp.join("project")),
		agentDir: temp.join("agent"),
		complete,
	});
	await state.open();
	states.push(state);
	return {
		state,
		emit: (messages: AgentMessage[], isTerminal = true) => listener?.({ type: "agent_end", messages, isTerminal }),
	};
}

describe("Wiki maintenance lifecycle", () => {
	it("captures tool-free user corrections and automatically processes a settled turn", async () => {
		await using temp = TempDir.createSync("wiki-correction-lifecycle-");
		const processed = Promise.withResolvers<void>();
		const fx = await fixture(
			temp,
			async request => {
				const data = input(request);
				processed.resolve();
				return acknowledge(data);
			},
			true,
		);
		fx.state.attach(true);
		const correction = "不要把原始内容丢给我，给我 human readable 的总结表格";
		const messages = [
			{ role: "user", content: correction, timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "改为可读总结。" }] },
		] as AgentMessage[];
		fx.emit(messages, false);
		expect((await fx.state.snapshot()).sources).toEqual([]);
		fx.emit(messages);
		await processed.promise;
		await fx.state.maintain();
		const snapshot = await fx.state.snapshot();
		expect(snapshot.pending).toEqual([]);
		expect(snapshot.sources?.flatMap(wikiSourcePassages)).toContainEqual({ role: "user", content: correction });
		fx.emit(messages);
		await fx.state.maintain();
		expect((await fx.state.snapshot()).sources?.map(source => source.id)).toEqual(
			snapshot.sources?.map(source => source.id),
		);
		fx.emit([{ ...messages[0], timestamp: 2 }, messages[1]] as AgentMessage[]);
		await fx.state.maintain();
		expect(
			(await fx.state.snapshot()).sources?.flatMap(wikiSourcePassages).filter(passage => passage.role === "user"),
		).toEqual([
			{ role: "user", content: correction },
			{ role: "user", content: correction },
		]);
		await fx.state.dispose();
	});

	it("isolates failed evidence, persists backoff across restart, and drains beyond one batch on manual sync", async () => {
		await using temp = TempDir.createSync("wiki-queue-recovery-");
		let unavailable = true;
		let failedCalls = 0;
		const complete: WikiComplete = async request => {
			const data = input(request);
			if (data.sources.some(source => source.passages.some(passage => passage.content === "failing evidence"))) {
				failedCalls++;
				if (unavailable) throw new Error("network unavailable", { cause: new Error("upstream socket closed") });
			}
			return acknowledge(data);
		};
		const first = await fixture(temp, complete);
		const failed = await first.state.capture({ content: "failing evidence" });
		for (let i = 0; i < 6; i++) await first.state.capture({ content: `independent observation ${i}` });
		await expect(first.state.maintain()).rejects.toThrow("upstream socket closed");
		expect((await first.state.snapshot()).pending.map(source => source.id)).toEqual([failed.id]);
		expect(await first.state.maintenanceStatus()).toMatchObject({ pending: 1, failed: 1 });
		await first.state.dispose();
		const resumed = await fixture(temp, complete);
		await resumed.state.maintain(false);
		expect(failedCalls).toBe(1);
		expect((await resumed.state.snapshot()).failures).toMatchObject([{ id: failed.id, revision: 1, attempts: 1 }]);
		unavailable = false;
		await resumed.state.maintain();
		expect(await resumed.state.maintenanceStatus()).toEqual({ pending: 0, failed: 0 });
		expect((await resumed.state.history(failed.id)).map(item => item.revision)).toEqual([1]);
		await resumed.state.dispose();
	});

	it("does not drop a second session's capture while the first session compiles", async () => {
		await using temp = TempDir.createSync("wiki-shared-queue-");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let hold = true;
		const complete: WikiComplete = async request => {
			if (hold) {
				hold = false;
				started.resolve();
				await release.promise;
			}
			return acknowledge(input(request));
		};
		const one = await fixture(temp, complete);
		const two = await fixture(temp, complete);
		const first = await one.state.capture({ content: "First observation" });
		const firstDrain = one.state.maintain();
		await started.promise;
		const second = await two.state.capture({ content: "Later correction" });
		const secondDrain = two.state.maintain();
		release.resolve();
		await Promise.all([firstDrain, secondDrain]);
		const snapshot = await two.state.snapshot();
		expect(snapshot.pending).toEqual([]);
		expect(snapshot.sources?.map(source => source.id).sort()).toEqual([first.id, second.id].sort());
		expect(snapshot.failures).toEqual([]);
		await one.state.dispose();
		await two.state.dispose();
	});
});
