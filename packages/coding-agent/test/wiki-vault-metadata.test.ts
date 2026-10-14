import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";

// Backend-level wiki coverage runs in a child bun process whose HOME is a
// scratch dir: `EXTERNAL_WIKI_VAULT` is os.homedir()-based and frozen at
// process start, so the vault relocates only via spawn-time env.
const DRIVER = new URL("./wiki-vault-backend.driver.ts", import.meta.url).pathname;

interface DriverOutput {
	vaultRoot: string;
	gammaPath: string;
	search: {
		count: number;
		text?: string;
		items: {
			id?: string;
			timestamp?: string;
			score?: number;
			metadata?: Record<string, unknown>;
		}[];
	};
	emptySearch: { count: number; text?: string };
	substringSearch: { count: number; ids: (string | undefined)[] };
	gammaRead: {
		status: string;
		content?: string;
		timestamp?: string;
		metadata?: Record<string, unknown>;
	};
	decoyRead: { status: string; content?: string; metadata?: Record<string, unknown> };
}

function runDriver(home: TempDir): DriverOutput {
	const proc = Bun.spawnSync(["bun", DRIVER], {
		env: { ...process.env, HOME: home.join("."), PI_CODING_AGENT_DIR: home.join("agent") },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`wiki backend driver failed (${proc.exitCode}): ${proc.stderr.toString()}`);
	return JSON.parse(proc.stdout.toString()) as DriverOutput;
}

describe("wiki backend recall metadata", () => {
	it("attaches capture metadata to search items, rendered lines, and reads", async () => {
		await using home = TempDir.createSync("wiki-vault-backend-home-");
		const output = runDriver(home);
		expect(output.vaultRoot).toBe(home.join("文档/omp-wiki"));

		expect(output.search.count).toBe(1);
		const item = output.search.items[0]!;
		expect(item.id).toBe("w-probe-gamma");
		expect(item.timestamp).toBe("2026-10-14T03:19:56.394Z");
		expect(item.score).toBeGreaterThan(0);
		expect(item.metadata).toMatchObject({
			kind: "source",
			scope: "global",
			channel: "inbox",
			status: "inbox",
			type: "fact",
			created: "2026-10-14T03:19:56.394Z",
			path: output.gammaPath,
		});
		expect(output.search.text).toContain(
			"ZXQ-MEM-20261014-GAMMA backend probe marker. [2026-10-14T03:19Z · global · inbox] (memory://w-probe-gamma)",
		);

		expect(output.emptySearch.count).toBe(0);
		expect(output.emptySearch.text).toBe("No matching vault notes.");

		// A >= 5-char term keeps raw substring matching at the backend layer.
		expect(output.substringSearch.ids).toEqual(["w-probe-decoy"]);

		const read = output.gammaRead;
		expect(read.status).toBe("found");
		const content = read.content ?? "";
		expect(content).toContain("Created: 2026-10-14T03:19:56.394Z");
		expect(content).toContain("Scope: global");
		expect(content).toContain("Type: fact");
		expect(content).toContain("Status: inbox");
		expect(content).toContain("Channel: inbox");
		expect(content).toContain(`Path: ${output.gammaPath}`);
		// The metadata block precedes the note body.
		expect(content.indexOf("Created: ")).toBeLessThan(content.indexOf("ZXQ-MEM-20261014-GAMMA backend probe"));
		expect(read.timestamp).toBe("2026-10-14T03:19:56.394Z");
		expect(read.metadata).toMatchObject({ created: "2026-10-14T03:19:56.394Z", type: "fact" });

		// No frontmatter `created` → the filename stamp supplies it.
		expect(output.decoyRead.status).toBe("found");
		expect(output.decoyRead.metadata).toMatchObject({ created: "2025-10-01T04:00:00Z", type: "fact" });
		expect(output.decoyRead.content).toContain("Created: 2025-10-01T04:00:00Z");
	});
});
