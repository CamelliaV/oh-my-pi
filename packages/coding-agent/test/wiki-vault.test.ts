import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { ExternalVault } from "@oh-my-pi/pi-coding-agent/wiki/external-vault";
import { TempDir } from "@oh-my-pi/pi-utils";

async function fixture(
	temp: TempDir,
	name: string,
	frontmatter: { id: string; scope?: string; type?: string; status?: string; created?: string },
	body: string,
): Promise<string> {
	const meta = [
		"---",
		`id: ${frontmatter.id}`,
		`scope: ${frontmatter.scope ?? "project-a"}`,
		...(frontmatter.type === undefined ? [] : [`type: ${frontmatter.type}`]),
		...(frontmatter.status === undefined ? [] : [`status: ${frontmatter.status}`]),
		...(frontmatter.created === undefined ? [] : [`created: ${frontmatter.created}`]),
		"---",
	].join("\n");
	const filePath = temp.join(`raw/inbox/project-a/${name}`);
	await Bun.write(filePath, `${meta}\n\n${body}\n`);
	return filePath;
}

describe("external wiki vault", () => {
	it("appends evidence and recalls it without crossing project scopes", async () => {
		await using temp = TempDir.createSync("external-vault-");
		const vault = new ExternalVault(temp.join("."));
		const written = await vault.append({
			content: "Marker VAULTSCOPE says the external vault is the memory store.",
			scope: "project-a",
		});
		await Bun.write(
			temp.join("wiki/memory/cutover.md"),
			"---\nid: w-cutover\nscope: project-a\nstatus: active\n---\n# Vault cutover\n\nCompiled notes are read from wiki.\n",
		);
		await Bun.write(
			temp.join("wiki/other/secret.md"),
			"---\nid: w-secret\nscope: project-b\nstatus: active\n---\n# Secret\n\nVAULTSCOPE belongs to another project.\n",
		);
		const notes = await vault.notes(["project-a"]);
		expect(vault.search("VAULTSCOPE", notes, 5).map(note => note.id)).toEqual([written.id]);
		expect((await vault.find("w-cutover", ["project-a"]))?.kind).toBe("page");
		expect(await vault.find(written.id, ["project-b"])).toBeUndefined();
		expect(await vault.find("w-secret", ["project-a"])).toBeUndefined();
	});

	it("drops a note whose scope no reader can resolve", async () => {
		await using temp = TempDir.createSync("external-vault-scope-");
		const vault = new ExternalVault(temp.join("."));
		await Bun.write(
			temp.join("wiki/stray.md"),
			"---\nid: w-stray\nscope: general-action-uep0m97sxfz4\nstatus: active\n---\n# Stray\n\nAgent-id scope.\n",
		);
		expect(await vault.notes(["project-a"])).toEqual([]);
		expect(await vault.find("w-stray", ["project-a"])).toBeUndefined();
	});
});

describe("external wiki vault search precision", () => {
	it("does not match a short term inside a longer alphanumeric run", async () => {
		await using temp = TempDir.createSync("external-vault-boundary-");
		const vault = new ExternalVault(temp.join("."));
		await fixture(
			temp,
			"20260101T000000Z-remember.md",
			{ id: "w-remember" },
			"Please remember to keepmem levels across restarts.",
		);
		await fixture(temp, "20260101T000001Z-marker.md", { id: "w-marker" }, "ZXQ-MEM-20261014-GAMMA probe entry.");
		await fixture(temp, "20260101T000002Z-pdf.md", { id: "w-pdf" }, "The pdf-js renderer handles PDFs well.");
		const notes = await vault.notes(["project-a"]);
		// `mem` matches the ZXQ-MEM token but NOT the `remember`/`keepmem` substrings.
		expect(vault.search("mem", notes, 8).map(note => note.id)).toEqual(["w-marker"]);
		// Longer terms (>= 5 chars) keep raw substring matching.
		expect(vault.search("remember", notes, 8).map(note => note.id)).toEqual(["w-remember"]);
		// Short terms still match as whole words in hyphenated or plural runs.
		expect(vault.search("pdf", notes, 8).map(note => note.id)).toEqual(["w-pdf"]);
	});

	it("gates multi-term queries on term coverage instead of filling up to the limit", async () => {
		await using temp = TempDir.createSync("external-vault-gate-");
		const vault = new ExternalVault(temp.join("."));
		await fixture(temp, "20260101T000000Z-gamma.md", { id: "w-gamma" }, "ZXQ-MEM-20261014-GAMMA probe entry.");
		await fixture(
			temp,
			"20260101T000001Z-alpha.md",
			{ id: "w-alpha" },
			"ZXQ-MEM-20261014-ALPHA probe entry on gamma decay.",
		);
		// `gamma` now has df 3 of 4, above the distinctive cap (2), so the
		// 1-of-4-term note below clears neither the coverage gate nor the
		// distinctive-term bypass.
		await fixture(temp, "20260101T000002Z-single.md", { id: "w-single" }, "Barely relevant gamma mention.");
		await fixture(temp, "20260101T000003Z-inside.md", { id: "w-inside" }, "Please remember this config.");
		const notes = await vault.notes(["project-a"]);
		// 4-term query: the 1-term `gamma`-only note and the `remember` substring
		// note stay out; the gate keeps exactly the two real markers, which tie
		// on the same four terms and order by id.
		expect(vault.search("ZXQ-MEM-20261014-GAMMA", notes, 8).map(note => note.id)).toEqual(["w-alpha", "w-gamma"]);
	});

	it("lets a distinctive term carry a note past the coverage gate", async () => {
		await using temp = TempDir.createSync("external-vault-distinctive-");
		const vault = new ExternalVault(temp.join("."));
		await fixture(temp, "20260101T000000Z-full.md", { id: "w-full" }, "Page delta layout three.");
		await fixture(temp, "20260101T000001Z-rare.md", { id: "w-rare" }, "Stutter relief tonight.");
		await fixture(temp, "20260101T000002Z-page-1.md", { id: "w-page-1" }, "Page layout one.");
		await fixture(temp, "20260101T000003Z-page-2.md", { id: "w-page-2" }, "Page layout two.");
		const notes = await vault.notes(["project-a"]);
		// 3-term query, coverage gate = 2: `page` (df 3 of 4) alone is too common
		// to carry the page-only notes, and they drop out; `stutter` (df 1) is
		// distinctive, so its note survives on that one rare hit. Ranking is
		// IDF-weighted: delta (df 1) beats page, so w-full outranks w-rare.
		expect(vault.search("page stutter delta", notes, 8).map(note => note.id)).toEqual(["w-full", "w-rare"]);
	});

	it("treats limit as a maximum, never a fill target", async () => {
		await using temp = TempDir.createSync("external-vault-cap-");
		const vault = new ExternalVault(temp.join("."));
		await fixture(temp, "20260101T000000Z-hit.md", { id: "w-hit" }, "UNIQTOKEN12345 appears here.");
		await fixture(temp, "20260101T000001Z-miss-1.md", { id: "w-miss-1" }, "Unrelated cats.");
		await fixture(temp, "20260101T000002Z-miss-2.md", { id: "w-miss-2" }, "Unrelated dogs.");
		const notes = await vault.notes(["project-a"]);
		expect(vault.search("UNIQTOKEN12345", notes, 8).map(note => note.id)).toEqual(["w-hit"]);
		expect(vault.search("unrelated", notes, 2).map(note => note.id)).toEqual(["w-miss-1", "w-miss-2"]);
	});

	it("parses created and type, falling back to the filename stamp then the file mtime", async () => {
		await using temp = TempDir.createSync("external-vault-created-");
		const vault = new ExternalVault(temp.join("."));
		await fixture(
			temp,
			"20260101T000000Z-stamped.md",
			{ id: "w-stamped", type: "decision", created: "2026-03-04T05:06:07.891Z" },
			"Frontmatter wins.",
		);
		await fixture(temp, "20261014T031956Z-slug.md", { id: "w-slugname" }, "Creatd only via filename.");
		const unstamped = await fixture(temp, "misc-note.md", { id: "w-mtime" }, "No created anywhere.");
		const notes = await vault.notes(["project-a"]);
		expect(notes.find(note => note.id === "w-stamped")?.created).toBe("2026-03-04T05:06:07.891Z");
		expect(notes.find(note => note.id === "w-stamped")?.type).toBe("decision");
		expect(notes.find(note => note.id === "w-slugname")?.created).toBe("2026-10-14T03:19:56Z");
		expect(notes.find(note => note.id === "w-mtime")?.created).toBe(fs.statSync(unstamped).mtime.toISOString());
	});
});
