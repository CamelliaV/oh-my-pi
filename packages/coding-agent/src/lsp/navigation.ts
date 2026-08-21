import * as path from "node:path";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ensureFileOpen, getOrCreateClient, isRustAnalyzerClient, sendRequest, waitForProjectLoaded } from "./client";
import {
	hasRustWorkspaceAncestor,
	isOnlyQueriedDeclaration,
	normalizeLocationResult,
	PROJECT_INDEXED_ACTIONS,
	REFERENCES_RETRY_COUNT,
	REFERENCES_RETRY_DELAY_MS,
} from "./diagnostics";
import { getConfig, getLspServerForFile, isProjectAwareLspServer } from "./servers";
import type { Location, LocationLink, LspClient, ServerConfig } from "./types";
import { fileToUri, resolveSymbolColumn, uriToFile } from "./utils";

export type LspNavigationAction = "definition" | "type_definition" | "implementation" | "references";

export interface LspNavigationQuery {
	cwd: string;
	file: string;
	line: number;
	symbol: string;
	action: LspNavigationAction;
	signal?: AbortSignal;
}
export interface LspLocationRequest {
	action: LspNavigationAction;
	client: LspClient;
	file: string;
	position: { line: number; character: number };
	serverConfig: ServerConfig;
	signal?: AbortSignal;
}

export interface LspNavigationLocation {
	serverName: string;
	path: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

function requestMethod(action: LspNavigationAction): string {
	switch (action) {
		case "definition":
			return "textDocument/definition";
		case "type_definition":
			return "textDocument/typeDefinition";
		case "implementation":
			return "textDocument/implementation";
		case "references":
			return "textDocument/references";
	}
}

function isLocationResult(result: unknown): result is Location | Location[] | LocationLink | LocationLink[] | null {
	return result === null || typeof result === "object";
}

function toNavigationLocation(location: Location, serverName: string): LspNavigationLocation {
	return {
		serverName,
		path: path.resolve(uriToFile(location.uri)),
		line: location.range.start.line + 1,
		column: location.range.start.character + 1,
		endLine: location.range.end.line + 1,
		endColumn: location.range.end.character + 1,
	};
}

export async function queryLspLocationResults(request: LspLocationRequest): Promise<Location[]> {
	const { action, client, file, position, serverConfig, signal } = request;
	const uri = fileToUri(file);
	const params =
		action === "references"
			? {
					textDocument: { uri },
					position,
					context: { includeDeclaration: true },
				}
			: { textDocument: { uri }, position };

	let result: Location | Location[] | LocationLink | LocationLink[] | null = null;
	const attempts = action === "references" ? REFERENCES_RETRY_COUNT + 1 : 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const raw = await sendRequest(client, requestMethod(action), params, signal);
		if (!isLocationResult(raw)) return [];
		result = raw;
		const locations = normalizeLocationResult(raw);
		if (
			action !== "references" ||
			!isProjectAwareLspServer(serverConfig) ||
			attempt === attempts - 1 ||
			(locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position))
		) {
			break;
		}
		await waitForProjectLoaded(client, signal);
		await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
	}

	return normalizeLocationResult(result);
}

/** Query the active project LSP server without requiring callers to parse tool text output. */
export async function queryLspLocations(query: LspNavigationQuery): Promise<LspNavigationLocation[]> {
	const cwd = path.resolve(query.cwd);
	const file = path.resolve(cwd, query.file);
	const config = getConfig(cwd);
	const serverInfo = getLspServerForFile(config, file);
	if (!serverInfo) return [];

	const [serverName, serverConfig] = serverInfo;
	const client = await getOrCreateClient(serverConfig, cwd, undefined, query.signal);
	const needsProjectIndex = PROJECT_INDEXED_ACTIONS.has(query.action) && isProjectAwareLspServer(serverConfig);
	const isRustAnalyzerServer = isRustAnalyzerClient(client) || serverName === "rust-analyzer";
	const rustWorkspaceWait = needsProjectIndex && isRustAnalyzerServer && hasRustWorkspaceAncestor(file);

	await ensureFileOpen(client, file, query.signal);
	if (rustWorkspaceWait || (needsProjectIndex && !isRustAnalyzerServer)) {
		await waitForProjectLoaded(client, query.signal);
	}

	const line = Math.max(1, query.line);
	const character = await resolveSymbolColumn(file, line, query.symbol);
	const locations = await queryLspLocationResults({
		action: query.action,
		client,
		file,
		position: { line: line - 1, character },
		serverConfig,
		signal: query.signal,
	});
	return locations.map(location => toNavigationLocation(location, serverName));
}
