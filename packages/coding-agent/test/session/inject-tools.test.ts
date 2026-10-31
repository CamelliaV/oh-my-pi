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
			// Clone the bundled entry: `getBundledModel` returns a shared object, and
			// `prefixBinding` decides whether an implicit prompt rebuild may commit —
			// reading it from a mutable global would make this test order-dependent.
			model: {
				...getBundledModel("openai", "gpt-4o-mini"),
				thinking: { enabled: false, prefixBinding: false },
			} as never,
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

	/**
	 * One settled turn: the provider answered, so its prompt cache holds the
	 * prefix that this session sent.
	 */
	const deliverTurn = (live: AgentSession): void => {
		live.agent.state.messages.push({ role: "user", content: "hello", timestamp: Date.now() });
		live.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		} as never);
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

	it("does not freeze on unsent scaffolding that was never on the wire", async () => {
		const live = await start();
		// A seeded `custom` notice (an attached eval kernel state, a session-agent
		// card) rides the next request; it is not evidence of a cached prefix, so
		// the prompt may still absorb the roster.
		live.agent.state.messages.push({
			role: "custom",
			customType: "eval-state-context",
			content: "kernel state",
			display: false,
			timestamp: Date.now(),
		} as never);
		const before = live.systemPrompt;

		await live.injectToolsByName(["read"]);

		expect(live.systemPrompt).not.toBe(before);
	});

	it("`only` replaces the set", async () => {
		const live = await start();
		await live.injectToolsByName(["read", "bash"]);
		await live.injectToolsByName(["grep"], "only");
		expect(live.getActiveToolNames()).toEqual(["grep"]);
	});

	it("lets the base prompt absorb the new roster before the first message", async () => {
		const live = await start();
		// `agent.setSystemPrompt` stores the array by reference, so identity is the
		// rebuild signal — independent of what the template happens to render.
		const before = live.systemPrompt;

		await live.injectToolsByName(["read"]);

		// Nothing is cached yet, so a rebuild is allowed to commit.
		expect(live.systemPrompt).not.toBe(before);
	});

	it("freezes the base prompt once the provider answered, while exposing the tool schema", async () => {
		const live = await start();
		await live.injectToolsByName(["read"]);
		deliverTurn(live);
		const before = live.systemPrompt;

		await live.injectToolsByName(["bash"]);

		// Cache contract: the committed prompt is not even re-assigned, let alone
		// rewritten, so the cached prefix still matches and the new tool rides the
		// wire schema instead.
		expect(live.systemPrompt).toBe(before);
		expect([...live.systemPrompt]).toEqual([...before]);
		expect(live.getActiveToolNames().sort()).toEqual(["bash", "read"]);
	});
});
