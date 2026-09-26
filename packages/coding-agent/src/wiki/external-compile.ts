import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import compilePrompt from "../prompts/wiki/external-compile.md" with {
	type: "text",
};
import type { AgentSession } from "../session/agent-session";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition } from "../task/types";
import { EXTERNAL_WIKI_VAULT } from "./external-vault";

export { EXTERNAL_WIKI_VAULT };

const compiler: AgentDefinition = {
	name: "wiki-compiler",
	description: "Compile the external omp wiki vault",
	systemPrompt:
		"Compile only the external wiki vault. Read AGENTS.md there and follow it exactly.",
	tools: ["read", "grep", "find", "edit", "write", "bash"],
	model: ["@wiki"],
	source: "bundled",
};

export async function runExternalWikiCompile(
	session: AgentSession,
): Promise<string> {
	const agentId = `wiki-compile-${Date.now().toString(36)}`;
	const artifactsDir = session.sessionManager.getArtifactsDir();
	if (!artifactsDir)
		throw new Error("The current session has no artifact directory.");
	const result = await runSubprocess({
		cwd: EXTERNAL_WIKI_VAULT,
		agent: compiler,
		task: prompt.render(compilePrompt, { vault: EXTERNAL_WIKI_VAULT }),
		description: "Compile external wiki",
		index: 0,
		id: agentId,
		modelOverride: "@wiki",
		modelRole: "wiki",
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		taskDepth: 0,
		enableIrc: false,
		enableLsp: false,
		enableMCP: false,
		sessionFile: session.sessionFile ?? null,
		artifactsDir,
		persistArtifacts: true,
	});
	const sessionFile = path.join(artifactsDir, `${agentId}.jsonl`);
	if (result.exitCode !== 0) {
		throw new Error(
			`Wiki compile failed: ${result.error ?? result.stderr ?? "unknown error"}\nSession: ${sessionFile}`,
		);
	}
	return `Wiki compile finished.\nAgent: ${agentId}\nSession: ${sessionFile}\n\n${result.output.trim()}`;
}
