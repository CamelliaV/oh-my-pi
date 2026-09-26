import { describe, expect, it } from "bun:test";
import { ExternalVault } from "@oh-my-pi/pi-coding-agent/wiki/external-vault";
import { TempDir } from "@oh-my-pi/pi-utils";

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
