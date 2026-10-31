// Child-process driver for test/wiki-vault-metadata.test.ts. Runs the REAL
// wiki backend under a scratch HOME (os.homedir() is frozen at process start,
// so the parent test passes HOME at spawn). Static imports are safe here:
// this process boots with the scratch HOME already in the environment.
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryBackendOperationContext } from "../src/memory-backend/types";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import { wikiBackend } from "../src/wiki/backend";
import { EXTERNAL_WIKI_VAULT } from "../src/wiki/external-vault";

const home = os.homedir();
const gammaPath = path.join(EXTERNAL_WIKI_VAULT, "raw", "inbox", "global", "20261014T031956Z-gamma-note.md");
const decoyPath = path.join(EXTERNAL_WIKI_VAULT, "raw", "inbox", "global", "20251001T040000Z-decoy-note.md");

await Bun.write(
	gammaPath,
	"---\nid: w-probe-gamma\nscope: global\ntype: fact\nstatus: inbox\ncreated: 2026-10-14T03:19:56.394Z\n---\n\nZXQ-MEM-20261014-GAMMA backend probe marker.\n",
);
// Decoy: `remember` must NOT satisfy a `mem` term (whole-word rule), and a
// lone id match in the metadata haystack never clears the coverage gate.
await Bun.write(
	decoyPath,
	"---\nid: w-probe-decoy\nscope: global\ntype: fact\nstatus: inbox\n---\n\nPlease remember this page.\n",
);

const session = {
	settings: Settings.isolated({ "memory.backend": "wiki" }),
} as unknown as AgentSession;
await wikiBackend.start({ session, settings: session.settings } as never);

const context: MemoryBackendOperationContext = {
	agentDir: path.join(home, "agent"),
	cwd: path.join(home, "project"),
	session,
};

if (!wikiBackend.search || !wikiBackend.read) {
	throw new Error("Wiki backend must support search and read operations");
}
const search = await wikiBackend.search(context, "ZXQ-MEM-20261014-GAMMA");
const emptySearch = await wikiBackend.search(context, "QQZZNONEXISTENTTOKEN987654");
const substringSearch = await wikiBackend.search(context, "remember");
const gammaRead = await wikiBackend.read(context, "w-probe-gamma");
const decoyRead = await wikiBackend.read(context, "w-probe-decoy");

console.log(
	JSON.stringify({
		vaultRoot: EXTERNAL_WIKI_VAULT,
		gammaPath,
		search: { count: search.count, text: search.text, items: search.items },
		emptySearch: { count: emptySearch.count, text: emptySearch.text },
		substringSearch: { count: substringSearch.count, ids: substringSearch.items.map(item => item.id) },
		gammaRead: {
			status: gammaRead.status,
			content: gammaRead.content,
			timestamp: gammaRead.timestamp,
			metadata: gammaRead.metadata,
		},
		decoyRead: { status: decoyRead.status, content: decoyRead.content, metadata: decoyRead.metadata },
	}),
);
