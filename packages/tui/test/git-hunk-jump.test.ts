/**
 * Alt+Down/Up in the git TUI jumps between hunks, not between every
 * contiguous change block, and file view maps each hunk onto its first
 * new-side line (a deletion-only hunk lands on the line after it). These
 * tests pin the starts `DiffPane.jumpHunk` uses so file view stops skipping
 * a hunk's second change block and deletion-only hunks stay reachable.
 */
import { describe, expect, it } from "bun:test";
import { buildDiffDocument, DiffPane } from "../src/apps/git/diff-pane";

const lines = (count: number): string =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

function paneFor(oldText: string, newText: string, mode: "file" | "split" | "inline"): DiffPane {
	const pane = new DiffPane();
	pane.mode = mode;
	pane.setDocument(buildDiffDocument(oldText, newText, "f.txt"), "ready");
	// setDocument centers split/inline on the first change; start before it.
	pane.cursor = 0;
	pane.scrollTop = 0;
	return pane;
}

describe("git hunk jumping", () => {
	it("stops once per hunk in file view", () => {
		const oldText = lines(40);
		const newText = oldText.replace("line 5", "line five").replace("line 7", "line seven");
		const pane = paneFor(oldText, newText, "file");

		expect(pane.doc?.hunks).toHaveLength(1);
		expect(pane.jumpHunk(1)).toBe(true);
		expect(pane.cursor).toBe(4);
		expect(pane.jumpHunk(1)).toBe(false);
		expect(pane.cursor).toBe(4);
	});

	it("walks each hunk in file view", () => {
		const oldText = lines(40);
		const newText = oldText.replace("line 5", "line five").replace("line 25", "line twentyfive");
		const pane = paneFor(oldText, newText, "file");

		expect(pane.jumpHunk(1)).toBe(true);
		expect(pane.cursor).toBe(4);
		expect(pane.jumpHunk(1)).toBe(true);
		expect(pane.cursor).toBe(24);
		expect(pane.jumpHunk(1)).toBe(false);
	});

	it("lands a one-hunk all-added file on its first line", () => {
		const pane = paneFor("", lines(30), "file");

		expect(pane.doc?.hunks).toHaveLength(1);
		expect(pane.jumpHunk(1)).toBe(false);
		pane.seekHunk("first");
		expect(pane.cursor).toBe(0);
	});

	it("lands a deletion-only hunk on the line after it", () => {
		const oldText = lines(10);
		const newText = oldText.replace("line 5\n", "");
		const pane = paneFor(oldText, newText, "file");

		pane.seekHunk("first");
		expect(pane.cursor).toBe(4);
	});

	it("stops once per hunk in split and inline views", () => {
		for (const mode of ["split", "inline"] as const) {
			const oldText = lines(40);
			const newText = oldText.replace("line 5", "line five").replace("line 7", "line seven");
			const pane = paneFor(oldText, newText, mode);

			expect(pane.doc?.hunks).toHaveLength(1);
			expect(pane.jumpHunk(1)).toBe(true);
			expect(pane.cursor).toBe(4);
			expect(pane.jumpHunk(1)).toBe(false);
			expect(pane.cursor).toBe(4);
		}
	});
});
