import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { replaceFileAtomically } from "../utils/atomic-file";

const HIDES_FILENAME = "session-hides.json";

function hidesPath(agentDir: string): string {
	return path.join(agentDir, HIDES_FILENAME);
}

/**
 * Read the global set of hidden session ids (`~/.omp/session-hides.json`). Hides
 * are keyed by session id, not file path, so they survive `/move` renames; the
 * session files stay on disk untouched, so token/stat accounting is unaffected.
 * A missing file yields an empty set; a corrupt one degrades to empty with a
 * warning rather than breaking the resume picker.
 */
export async function loadHiddenSessionIds(agentDir: string = getAgentDir()): Promise<Set<string>> {
	try {
		const hides: unknown = JSON.parse(await fs.readFile(hidesPath(agentDir), "utf-8"));
		if (!Array.isArray(hides)) return new Set();
		return new Set(hides.filter((id): id is string => typeof id === "string"));
	} catch (err) {
		if (isEnoent(err)) return new Set();
		logger.warn("Failed to read session hides", { error: err });
		return new Set();
	}
}

/**
 * Add one session id to the hide set and persist; returns the new hidden state.
 *
 * The read-modify-write runs under the shared cross-process file lock and
 * commits via write-temp-then-atomic-replace, mirroring the pins writer: two omp
 * instances hiding/unhiding concurrently can no longer lose each other's update,
 * and a crash mid-write leaves the previous hides file intact instead of a
 * truncated one that degrades to an empty set.
 */
export async function hideSession(sessionId: string, agentDir: string = getAgentDir()): Promise<boolean> {
	const filePath = hidesPath(agentDir);
	await fs.mkdir(agentDir, { recursive: true });
	return withFileLock(filePath, async () => {
		const hidden = await loadHiddenSessionIds(agentDir);
		hidden.add(sessionId);
		const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify([...hidden], null, "\t"), { encoding: "utf-8", mode: 0o600 });
			await replaceFileAtomically(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		return hidden.has(sessionId);
	});
}

/**
 * Remove one session id from the hide set and persist; returns the new hidden
 * state (false once unhidden). Same locked read-modify-write as {@link hideSession}.
 */
export async function unhideSession(sessionId: string, agentDir: string = getAgentDir()): Promise<boolean> {
	const filePath = hidesPath(agentDir);
	await fs.mkdir(agentDir, { recursive: true });
	return withFileLock(filePath, async () => {
		const hidden = await loadHiddenSessionIds(agentDir);
		hidden.delete(sessionId);
		const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify([...hidden], null, "\t"), { encoding: "utf-8", mode: 0o600 });
			await replaceFileAtomically(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		return hidden.has(sessionId);
	});
}
