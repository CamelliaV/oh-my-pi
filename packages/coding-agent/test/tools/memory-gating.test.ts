import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MemoryBackendId } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveXdevTool } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { loadWikiConfig } from "@oh-my-pi/pi-coding-agent/wiki/config";
import { setWikiState, WikiState } from "@oh-my-pi/pi-coding-agent/wiki/state";
import { TempDir } from "@oh-my-pi/pi-utils";

const memoryNames = ["retain", "recall", "reflect", "memory_edit", "learn"];
const cases: Array<{ backend: MemoryBackendId; enabled: string[] }> = [
	{ backend: "wiki", enabled: memoryNames },
	{ backend: "off", enabled: [] },
	{ backend: "sharpshooter", enabled: ["recall"] },
	{ backend: "local", enabled: ["learn"] },
];

function toolSession(backend: MemoryBackendId, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "memory.backend": backend, "autolearn.enabled": true }),
		...extra,
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

describe("memory tool registration", () => {
	it.each(cases)(
		"exposes only supported memory operations for $backend, directly and through xd",
		async ({ backend, enabled }) => {
			for (const requested of [undefined, ["read"]]) {
				const session = toolSession(backend);
				const tools = await createTools(session, requested);
				const available = memoryNames.filter(
					name => tools.some(tool => tool.name === name) || (session.xdev && resolveXdevTool(session.xdev, name)),
				);
				expect(available.toSorted()).toEqual(enabled.toSorted());
				if (requested === undefined) {
					for (const name of enabled.filter(name => name !== "learn")) {
						expect(tools.some(tool => tool.name === name)).toBe(false);
						expect(session.xdev?.mountedNames.has(name)).toBe(true);
					}
				} else {
					expect(
						tools
							.filter(tool => memoryNames.includes(tool.name))
							.map(tool => tool.name)
							.toSorted(),
					).toEqual(enabled.toSorted());
				}
			}
		},
	);

	it.each(cases)(
		"does not widen restricted $backend callers, while honoring explicit grants",
		async ({ backend, enabled }) => {
			for (const taskDepth of [0, 1]) {
				const session = toolSession(backend, { restrictToolNames: true, taskDepth });
				expect((await createTools(session, ["read"])).map(tool => tool.name)).toEqual(["read"]);
				expect(session.xdev).toBeUndefined();
				const explicit = await createTools(
					toolSession(backend, { restrictToolNames: true, taskDepth }),
					memoryNames,
				);
				expect(explicit.map(tool => tool.name).toSorted()).toEqual(enabled.toSorted());
			}
		},
	);

	it("keeps Wiki learn behind autolearn and explicit subagent grants, not direct skill publication", async () => {
		const disabled = toolSession("wiki", {
			settings: Settings.isolated({ "memory.backend": "wiki", "autolearn.enabled": false }),
		});
		expect((await createTools(disabled, ["learn"])).some(tool => tool.name === "learn")).toBe(false);
		for (const requested of [undefined, ["read"]]) {
			const tools = await createTools(toolSession("wiki", { taskDepth: 1 }), requested);
			expect(tools.some(tool => tool.name === "learn" || tool.name === "manage_skill")).toBe(false);
		}
		const explicit = await createTools(toolSession("wiki", { taskDepth: 1 }), ["learn"]);
		expect(explicit.some(tool => tool.name === "learn")).toBe(true);
	});

	it.each(["mounted", "explicit"] as const)(
		"retains pending evidence through %s tools and preserves partial failure status",
		async mode => {
			await using temp = TempDir.createSync("wiki-tool-gating-");
			const cwd = temp.join("project");
			const agentDir = temp.join("agent");
			const settings = Settings.isolated({
				"memory.backend": "wiki",
				"autolearn.enabled": true,
				"wiki.root": temp.join("wiki"),
				"wiki.autoMaintain": false,
				"wiki.includeGlobal": false,
			});
			const owner = {
				sessionId: "wiki-tool-gating",
				settings,
				sessionManager: { getCwd: () => cwd },
				agent: { tokenizer: new Tokenizer() },
				refreshBaseSystemPrompt: async () => {},
				refreshSkills: async () => {},
			} as unknown as AgentSession;
			const state = new WikiState({
				session: owner,
				config: loadWikiConfig(settings, agentDir, cwd),
				agentDir,
				complete: async () => {
					throw new Error("Retention must not invoke a model");
				},
			});
			try {
				await state.open();
				setWikiState(owner, state);
				const session = toolSession("wiki", {
					cwd,
					settings,
					getMemoryContext: () => ({ session: owner, agentDir, cwd }),
				});
				const tools = await createTools(session, mode === "explicit" ? ["read"] : undefined);
				const invoke = async (name: string, args: Record<string, unknown>) => {
					if (mode === "mounted") {
						return tools
							.find(tool => tool.name === "write")!
							.execute(`device-${name}`, {
								path: `xd://${name}`,
								content: JSON.stringify(args),
							});
					}
					return tools.find(tool => tool.name === name)!.execute(`direct-${name}`, args);
				};
				const retained = await invoke("retain", { items: [{ content: "Deployment region west" }] });
				expect(retained.isError).not.toBe(true);
				expect(text(retained)).toMatch(/queued/i);
				const first = await state.snapshot();
				expect(first.pending.map(source => source.content)).toEqual(["Deployment region west"]);
				expect(first.pages).toEqual([]);

				const partial = invoke("retain", {
					items: [{ content: "Rollback procedure verified" }, { content: "   " }],
				});
				let failure: string;
				if (mode === "mounted") {
					const result = await partial;
					expect(result.isError).toBe(true);
					failure = text(result);
				} else {
					failure = await partial.then(
						() => "unexpected success",
						error => String(error),
					);
				}
				expect(failure).toContain("0 stored and 1 queued");
				expect((await state.snapshot()).pending.map(source => source.content).toSorted()).toEqual(
					["Deployment region west", "Rollback procedure verified"].toSorted(),
				);

				const learned = await invoke("learn", { memory: "Run the deployment check before publishing" });
				expect(learned.isError).not.toBe(true);
				expect(
					(await state.snapshot()).pending.some(
						source => source.content === "Run the deployment check before publishing",
					),
				).toBe(true);
				const forbidden = invoke("learn", {
					memory: "Must not store this rejected skill",
					skill: { action: "create", name: "unverified", description: "Unverified", body: "Unverified procedure" },
				});
				if (mode === "mounted") expect((await forbidden).isError).toBe(true);
				else await expect(forbidden).rejects.toThrow(/verified|approved/);
				expect(
					(await state.snapshot()).pending.some(source => source.content === "Must not store this rejected skill"),
				).toBe(false);

				const forgotten = await invoke("memory_edit", { op: "forget", id: first.pending[0]!.id });
				expect(forgotten.isError).not.toBe(true);
				expect((await state.snapshot()).pending.some(source => source.id === first.pending[0]!.id)).toBe(false);
			} finally {
				setWikiState(owner, undefined);
				await state.dispose();
			}
		},
	);
});
