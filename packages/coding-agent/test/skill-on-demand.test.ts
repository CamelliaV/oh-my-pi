import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MANAGED_SKILLS_PROVIDER_ID } from "../src/autolearn/managed-skills";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { cfgSkillsOnDemand, cfgSkillsPinned } from "../src/extensibility/settings";
import { SkillSearchIndex } from "../src/extensibility/skill-search";
import { loadSkillsFromDir, type Skill } from "../src/extensibility/skills";
import { buildPromptSnapshot } from "../src/prompt-viewer/snapshot";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { BUILTIN_SKILLS_SLASH_COMMANDS } from "../src/slash-commands/builtin-skills";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";

const resources: Array<{ session: AgentSession; auth: AuthStorage; temp: TempDir }> = [];

afterEach(async () => {
	for (const { session, auth, temp } of resources.splice(0)) {
		await session.dispose();
		auth.close();
		await temp.remove();
	}
});

function skill(name: string, description: string, filePath = `/unused/${name}/SKILL.md`, managed = true): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: filePath.slice(0, -"/SKILL.md".length),
		source: `${managed ? MANAGED_SKILLS_PROVIDER_ID : "native"}:user`,
		_source: {
			provider: managed ? MANAGED_SKILLS_PROVIDER_ID : "native",
			providerName: "Test",
			path: filePath,
			level: "user",
		},
	};
}

async function start(options: { onDemand?: boolean; restricted?: boolean; model?: MockModel; pinned?: string[] } = {}) {
	const temp = TempDir.createSync("@omp-skill-on-demand-");
	const auth = await AuthStorage.create(temp.join("auth.db"));
	auth.keys.setRuntime("mock", "local-test");
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	const settings = Settings.isolated({
		"skills.onDemand": options.onDemand ?? false,
		...(options.pinned ? { "skills.pinned": options.pinned } : {}),
		"memory.backend": "off",
		"autolearn.enabled": false,
		"compaction.enabled": false,
		"tools.intentTracing": false,
		"tools.xdev": false,
	});
	const description = `KWin 跨屏移动指针。${"Only use this procedure when keyboard focus must follow the pointer. ".repeat(4)}Do not apply it to X11.`;
	const path = temp.join("managed-skills", "kwin-warp", "SKILL.md");
	await Bun.write(
		path,
		"---\nname: kwin-warp\ndescription: KWin 跨屏移动指针\n---\n\nUse the absolute pointer protocol.\n",
	);
	const skills = [
		skill("kwin-warp", description, path),
		skill("pinned-procedure", "Pinned procedure"),
		skill("authored-policy", "Authored policy", temp.join("skills", "authored-policy", "SKILL.md"), false),
	];
	const model = options.model ?? createMockModel({ handler: { content: ["done"] } });
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.path(),
		authStorage: auth,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(temp.path()),
		settings,
		model,
		skills,
		contextFiles: [],
		rules: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read"],
		restrictToolNames: options.restricted,
	});
	session.agent.streamFn = model.stream;
	resources.push({ session, auth, temp });
	return { session, settings, skills, model, description };
}

describe("optional on-demand managed skills", () => {
	it("keeps the ordinary catalog by default; enabled searches and reads append results without rewriting the request prefix", async () => {
		const ordinary = await start();
		expect(ordinary.session.systemPrompt.join("\n")).toContain("kwin-warp:");
		expect(ordinary.session.getActiveToolNames()).not.toContain("skill_search");
		const model = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "skill_search", arguments: { query: "跨屏" } }] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "skill://kwin-warp" } }] },
				{ content: ["The procedure is ready."] },
			],
		});
		const { session, description } = await start({ onDemand: true, pinned: ["pinned-procedure"], model });
		const prefix = session.systemPrompt.join("\n");
		expect(prefix).not.toContain("kwin-warp:");
		expect(prefix).toContain("pinned-procedure:");
		expect(prefix).toContain("authored-policy:");
		expect(session.getActiveToolNames()).toContain("skill_search");
		const before = buildPromptSnapshot(session).sections.find(section => section.id === "skills");
		await session.agent.prompt("Find the KWin procedure and read it.");
		expect(model.calls).toHaveLength(3);
		for (const call of model.calls.slice(1)) {
			expect(call.context.systemPrompt).toEqual(model.calls[0].context.systemPrompt);
			expect(JSON.stringify(call.context.tools)).toBe(JSON.stringify(model.calls[0].context.tools));
		}
		const searchResult = model.calls[1].context.messages.find(
			message => message.role === "toolResult" && message.toolName === "skill_search",
		);
		expect(searchResult?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining(description) }),
			]),
		);
		const readResult = model.calls[2].context.messages.find(
			message => message.role === "toolResult" && message.toolName === "read",
		);
		expect(readResult?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("absolute pointer protocol") }),
			]),
		);
		expect(session.systemPrompt.join("\n")).toBe(prefix);
		expect(buildPromptSnapshot(session).sections.find(section => section.id === "skills")).toEqual(before);
	});

	it("defers mode and pin edits until /new and restores the default roster and catalog when turned off", async () => {
		const { session, settings } = await start();
		const prefix = [...session.systemPrompt];
		const schema = session.agent.state.tools.map(tool => toolWireSchema(tool));
		cfgSkillsOnDemand.override(settings, true);
		cfgSkillsPinned.override(settings, ["pinned-procedure"]);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.systemPrompt).toEqual(prefix);
		expect(session.agent.state.tools.map(tool => toolWireSchema(tool))).toEqual(schema);
		await session.newSession();
		expect(session.getActiveToolNames()).toContain("skill_search");
		expect(session.systemPrompt.join("\n")).not.toContain("kwin-warp:");
		expect(session.systemPrompt.join("\n")).toContain("pinned-procedure:");
		cfgSkillsOnDemand.override(settings, false);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getActiveToolNames()).toContain("skill_search");
		await session.newSession();
		expect(session.getActiveToolNames()).not.toContain("skill_search");
		expect(session.systemPrompt.join("\n")).toContain("kwin-warp:");
	});

	it("does not hide skills from a restricted session that cannot call search", async () => {
		const { session } = await start({ onDemand: true, restricted: true });
		expect(session.getActiveToolNames()).not.toContain("skill_search");
		expect(session.systemPrompt.join("\n")).toContain("kwin-warp:");
	});

	it("keeps the committed catalog when skill URI recovery replaces a stale skill snapshot", async () => {
		const { session, skills } = await start({ onDemand: true, pinned: ["pinned-procedure"] });
		const prompt = [...session.systemPrompt];
		const listed = session.renderedSkills.map(skill => ({ name: skill.name, description: skill.description }));
		const recovery = session.skillRediscoveryHost();
		await recovery.replaceSkills?.(
			skills.map(skill => ({ ...skill, description: "Replacement discovery metadata" })),
		);
		await session.refreshBaseSystemPrompt();
		expect(session.skills[0].description).toBe("Replacement discovery metadata");
		expect(session.systemPrompt).toEqual(prompt);
		expect(session.renderedSkills.map(skill => ({ name: skill.name, description: skill.description }))).toEqual(
			listed,
		);
		await session.newSession();
		expect(session.promptSkills[0].description).toBe("Replacement discovery metadata");
		expect(session.renderedSkills.every(skill => skill.description === "Replacement discovery metadata")).toBe(true);
	});
});

describe("local skill search", () => {
	it("lets slash commands display descriptions and defer pin changes to the next conversation", async () => {
		const { session, settings, description } = await start({ onDemand: true });
		const shown: string[] = [];
		const runtime = {
			ctx: {
				session,
				settings,
				sessionManager: session.sessionManager,
				editor: { setText() {} },
				showStatus: (value: string) => shown.push(value),
				showError: (value: string) => {
					throw new Error(value);
				},
			},
		} as unknown as TuiSlashCommandRuntime;
		const run = async (args: string) =>
			BUILTIN_SKILLS_SLASH_COMMANDS[0].handleTui!({ name: "skills", args, text: `/skills ${args}` }, runtime);
		await run("local kwin-warp");
		expect(shown.at(-1)).toContain(description);
		const prompt = [...session.systemPrompt];
		await run("pin kwin-warp");
		expect(cfgSkillsPinned.get(settings)).toContain("kwin-warp");
		expect(session.systemPrompt).toEqual(prompt);
		await session.newSession();
		expect(session.systemPrompt.join("\n")).toContain("kwin-warp:");
		await run("unpin kwin-warp");
		await session.newSession();
		expect(session.systemPrompt.join("\n")).not.toContain("kwin-warp:");
	});
	it("finds a Chinese trigger present only in the discovered body without returning that body", async () => {
		await using temp = await TempDir.create("@omp-skill-body-search-");
		await Bun.write(
			temp.join("pointer", "SKILL.md"),
			"---\nname: pointer\ndescription: Pointer control\n---\n跨屏移动指针\nBODY_ONLY_INSTRUCTIONS\n",
		);
		const { skills } = await loadSkillsFromDir({ dir: temp.path(), source: "omp-managed:user" });
		const results = new SkillSearchIndex().search(skills, "跨屏");
		expect(results.items.map(item => item.name)).toEqual(["pointer"]);
		expect(JSON.stringify(results)).not.toContain("BODY_ONLY_INSTRUCTIONS");
	});

	it("ranks an exact name ahead of description matches and preserves Chinese triggers and complete descriptions", () => {
		const index = new SkillSearchIndex();
		const description = `${"多屏幕键盘焦点处理。".repeat(20)}Only applies to Wayland.`;
		const skills = [
			skill("other", "kwin-warp settings"),
			skill("kwin-warp", description),
			{ ...skill("hidden", "kwin-warp"), hide: true },
		];
		expect(index.search(skills, "kwin-warp").items[0].name).toBe("kwin-warp");
		expect(index.search(skills, "多屏幕").items).toEqual([
			{ name: "kwin-warp", description, uri: "skill://kwin-warp" },
		]);
		expect(index.search(skills, "no-such-procedure-999").items).toEqual([]);
	});

	it("browses every visible skill once through pagination, including namespaced names", () => {
		const index = new SkillSearchIndex();
		const skills = Array.from({ length: 7 }, (_, i) => skill(`plugin/procedure-${i}`, "Workflow"));
		skills.push({ ...skill("hidden", "Hidden workflow"), hide: true });
		const first = index.search(skills, "");
		const second = index.search(skills, "", first.nextOffset);
		expect([...first.items, ...second.items].map(item => item.name)).toEqual(
			skills.slice(0, 7).map(skill => skill.name),
		);
		expect(second.nextOffset).toBeUndefined();
		expect(second.items[0].uri).toBe("skill://plugin/procedure-5");
	});
});
