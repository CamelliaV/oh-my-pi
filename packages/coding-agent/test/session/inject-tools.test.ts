import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * `/inject` semantics that live in SessionTools rather than the slash-command
 * shell: injection is additive, and once the transcript carries a message the
 * committed base prompt must stay byte-identical (provider prompt cache) while
 * the tool still reaches the model through its wire schema.
 */
describe("injectToolsByName", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let authDir: string;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `pi-inject-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	afterAll(() => {
		modelRegistry.authStorage.close();
		removeSyncWithRetries(authDir);
	});

	/** A whitelist-restricted session: no tools constructed at startup, like `--lightweight`. */
	const start = async (): Promise<AgentSession> => {
		const cwd = path.join(os.tmpdir(), `pi-inject-${Snowflake.next()}`);
		tempDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });
		const created = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			toolNames: [],
		});
		session = created.session;
		return created.session;
	};

	/** One prior user turn: the provider has seen, and cached, the request prefix. */
	const deliverUserMessage = (live: AgentSession): void => {
		live.agent.state.messages.push({ role: "user", content: "hello", timestamp: Date.now() });
	};

	it("adds to the active roster instead of replacing it", async () => {
		const live = await start();
		expect(live.getActiveToolNames()).toEqual([]);

		await live.injectToolsByName(["read"]);
		expect(live.getActiveToolNames()).toEqual(["read"]);

		await live.injectToolsByName(["bash"]);
		expect(live.getActiveToolNames().sort()).toEqual(["bash", "read"]);

		await live.injectToolsByName(["bash"], "remove");
		expect(live.getActiveToolNames()).toEqual(["read"]);
	});

	it("`only` replaces the set", async () => {
		const live = await start();
		await live.injectToolsByName(["read", "bash"]);
		await live.injectToolsByName(["grep"], "only");
		expect(live.getActiveToolNames()).toEqual(["grep"]);
	});

	it("lets the base prompt absorb the new roster before the first message", async () => {
		const live = await start();
		const before = [...live.systemPrompt];

		await live.injectToolsByName(["read"]);

		// Nothing is cached yet, so the prompt is free to describe the new tool.
		expect([...live.systemPrompt]).not.toEqual(before);
	});

	it("freezes the base prompt once a message exists, while exposing the tool schema", async () => {
		const live = await start();
		await live.injectToolsByName(["read"]);
		deliverUserMessage(live);
		const before = [...live.systemPrompt];

		await live.injectToolsByName(["bash"]);

		// Cache contract: the committed prompt is byte-identical, so the cached
		// prefix still matches, and the new tool rides the wire schema instead.
		expect([...live.systemPrompt]).toEqual(before);
		expect(live.getActiveToolNames().sort()).toEqual(["bash", "read"]);
	});
});
