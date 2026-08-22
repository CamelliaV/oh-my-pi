/**
 * Gateway tool standing in for a lazily-connected MCP server.
 *
 * A server marked `lazy: true` is never connected at startup: the manager
 * holds its config back and mounts one of these gateways instead, so an
 * unused integration costs one prompt line rather than a connection plus a
 * full tool catalog. The first dispatch to the gateway connects the real
 * server; `connectServers` replaces this gateway (matched by
 * `mcpServerName` ownership) with the server's actual tools and fires
 * `onToolsChanged`, so the session registry refreshes through the exact same
 * path as any other runtime MCP connect.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderMCPCall, renderMCPResult } from "./render";
import { createMCPToolName, type MCPToolDetails } from "./tool-bridge";

/** Outcome of an activation attempt, produced by the manager-owned callback. */
export interface LazyGatewayActivation {
	/** Present when the server failed to connect; carries the surfaced message. */
	error?: string;
}

export class LazyMCPServerGateway implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters = type({});
	readonly mcpServerName: string;
	readonly mcpToolName = "gateway";
	readonly approval = "write" as const;
	/** Replace the pending call header with the result header once settled. */
	readonly mergeCallAndResult = true;

	constructor(
		serverName: string,
		private readonly activate: () => Promise<LazyGatewayActivation>,
		private readonly mountedToolNames: () => string[],
	) {
		this.mcpServerName = serverName;
		this.name = createMCPToolName(serverName, "gateway");
		this.label = `${serverName} gateway`;
		this.description = [
			`Lazily-connected MCP server gateway for "${serverName}": none of its tools are loaded yet.`,
			"Write {} here to connect the server now and mount its real tools under xd:// devices.",
			"If connecting fails with an auth error, tell the user to run /mcp to authorize.",
		].join(" ");
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeRenderArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeRenderArgs(args));
	}

	async execute(
		_toolCallId: string,
		_params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
	): Promise<AgentToolResult<MCPToolDetails>> {
		const outcome = await this.activate();
		if (outcome.error) {
			return {
				content: [
					{
						type: "text",
						text:
							`Failed to activate MCP server "${this.mcpServerName}": ${outcome.error}\n` +
							`If this is an authorization failure, tell the user to run /mcp and authorize "${this.mcpServerName}".`,
					},
				],
				details: { serverName: this.mcpServerName, mcpToolName: this.mcpToolName, isError: true },
				isError: true,
			};
		}
		const mounted = this.mountedToolNames();
		const list = mounted.length > 0 ? mounted.join(", ") : "(no tools reported)";
		return {
			content: [
				{
					type: "text",
					text:
						`Connected MCP server "${this.mcpServerName}". Mounted devices: ${list}.\n` +
						"Read xd://<device> for docs before first use.",
				},
			],
			details: { serverName: this.mcpServerName, mcpToolName: this.mcpToolName },
		};
	}
}

/// Renders receive streamed/partial args of uncertain shape; the MCP
/// renderers only need an object (or nothing) for property hints.
function normalizeRenderArgs(args: unknown): Record<string, unknown> {
	return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}
