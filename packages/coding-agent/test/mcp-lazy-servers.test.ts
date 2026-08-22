import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { LazyMCPServerGateway } from "@oh-my-pi/pi-coding-agent/mcp/lazy-gateway";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;
const GATEWAY_NAME = "mcp__econ_gateway";

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

/** Minimal execution context; the gateway's execute path never touches it. */
const stubContext = {} as unknown as CustomToolContext;

describe("lazy MCP servers", () => {
	let tempHome = "";
	let projectDir = "";
	let agentDir = "";
	let originalHome: string | undefined;
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-home-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-proj-"));
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-agent-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) setAgentDir(originalAgentDirEnv);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		removeSyncWithRetries(tempHome);
		removeSyncWithRetries(projectDir);
		removeSyncWithRetries(agentDir);
	});

	it("loadAllMCPConfigs holds lazy servers out of the connect set", async () => {
		writeJson(path.join(agentDir, "mcp.json"), {
			mcpServers: {
				eager: { command: "echo" },
				shy: { command: "true", lazy: true },
			},
		});

		const result = await loadAllMCPConfigs(projectDir, {});

		expect(Object.keys(result.configs).sort()).toEqual(["eager"]);
		expect(result.lazyConfigs.shy?.lazy).toBe(true);
		expect(Object.keys(result.lazySources)).toEqual(["shy"]);
		expect(result.sources.shy).toBeUndefined();
	});

	it("the enabledServers allowlist bypasses the lazy hold", async () => {
		writeJson(path.join(agentDir, "mcp.json"), {
			mcpServers: {
				eager: { command: "echo" },
				shy: { command: "true", lazy: true },
			},
			enabledServers: ["shy"],
		});

		const result = await loadAllMCPConfigs(projectDir, {});

		expect(Object.keys(result.configs).sort()).toEqual(["eager", "shy"]);
		expect(Object.keys(result.lazyConfigs)).toEqual([]);
	});

	it("holds a lazy server behind a gateway, then swaps in real tools on activation", async () => {
		writeJson(path.join(projectDir, ".omp", "mcp.json"), {
			mcpServers: {
				econ: { command: BUN_EXEC, args: [FIXTURE_PATH], lazy: true },
			},
		});

		const manager = new MCPManager(projectDir);
		try {
			const discovered = await manager.discoverAndConnect({ enableProjectConfig: true });

			// Held back: no connection, exactly one gateway device.
			expect(discovered.connectedServers).toEqual([]);
			expect(manager.getConnectionStatus("econ")).toBe("disconnected");
			expect(manager.getLazyServerNames()).toEqual(["econ"]);
			expect(discovered.tools.map(tool => tool.name)).toEqual([GATEWAY_NAME]);
			const gateway = discovered.tools[0];
			expect(gateway).toBeInstanceOf(LazyMCPServerGateway);
			// Ownership metadata is what evicts the gateway once real tools land.
			expect(gateway.mcpServerName).toBe("econ");

			const activated = await gateway.execute("call-1", {}, undefined, stubContext);
			expect(activated.isError).toBeFalsy();
			const text = activated.content[0]?.type === "text" ? activated.content[0].text : "";
			expect(text).toContain(`Connected MCP server "econ"`);
			expect(text).toContain("Mounted devices:");

			expect(manager.getConnectionStatus("econ")).toBe("connected");
			expect(manager.getLazyServerNames()).toEqual([]);
			const names = manager.getTools().map(tool => tool.name);
			expect(names).not.toContain(GATEWAY_NAME);
			expect(names.length).toBeGreaterThan(1);

			// Reload after activation re-admits the connected server as ordinary:
			// no gateway resurrection alongside its live tools.
			const reloaded = await manager.discoverAndConnect({ enableProjectConfig: true });
			expect(reloaded.tools.map(tool => tool.name)).not.toContain(GATEWAY_NAME);
			expect(reloaded.connectedServers).toContain("econ");
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);

	it("surfaces an activation failure with /mcp guidance", async () => {
		const gateway = new LazyMCPServerGateway(
			"authy",
			() => Promise.resolve({ error: "HTTP 401: invalid_token" }),
			() => [],
		);

		const result = await gateway.execute("call-2", {}, undefined, stubContext);

		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`Failed to activate MCP server "authy"`);
		expect(text).toContain("/mcp");
	});
});
