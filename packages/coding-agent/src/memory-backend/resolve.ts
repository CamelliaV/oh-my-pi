import type { Settings } from "../config/settings";
import { wikiBackend } from "../wiki/backend";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend, MemoryBackendId } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "mnemopi"`  → local Mnemopi SQLite memory
 *   - `memory.backend === "sharpshooter"` → friction-gated project decision memory
 *   - `memory.backend === "local"`      → local rollout summary pipeline
 *   - `memory.backend === "wiki"`       → evidence-backed Markdown Wiki
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 */
export async function resolveMemoryBackend(
	settings: Settings,
	id: MemoryBackendId = settings.get("memory.backend"),
): Promise<MemoryBackend> {
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;
	if (id === "sharpshooter") return (await import("../sharpshooter/backend")).sharpshooterBackend;
	if (id === "local") return localBackend;
	if (id === "wiki") return wikiBackend;
	return offBackend;
}
