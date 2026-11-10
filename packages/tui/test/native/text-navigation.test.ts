import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	findTextNavigationTarget,
	parseTextNavigationViewport,
	readTextNavigationPosition,
	selectTextNavigationAnchor,
	type TextNavigationDocument,
	textNavigationDocumentRole,
} from "@oh-my-pi/pi-tui/native/text-navigation";
import * as ptree from "@oh-my-pi/pi-utils/ptree";

const gridPath = "main#panel.ph-chat>div.tn-stage>section.tn-pane.on.lone.agent>div.tn-body>div.tv>div.tv-grid";
const gridNth =
	"main:nth-of-type(1)>div:nth-of-type(1)>section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)";
const regionPath = `${gridPath}>div.tv-blocks>div.tv-block>div.sf-region.sf-main.sf-chat-reader`;
const regionNth = `${gridNth}>div:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)`;
const selector = `.sf-main[data-role='${textNavigationDocumentRole}']`;

type DumpElement = {
	path: string;
	nth: string;
	rect: [number, number, number, number];
	visible: boolean;
};

function rootElement(index: number, y: number, height = 100): DumpElement {
	return {
		path: `${regionPath}>div.sf.sf-col`,
		nth: `${regionNth}>div:nth-of-type(${index + 1})`,
		rect: [20, y, 760, height],
		visible: true,
	};
}

function snapshot(...roots: DumpElement[]) {
	return {
		ok: true,
		header: { viewport: { width: 1_000, height: 800 } },
		elements: [
			{ path: gridPath, nth: gridNth, rect: [0, 40, 800, 600], visible: true },
			{ path: regionPath, nth: regionNth, rect: [0, -1_000, 800, 5_000], visible: true },
			...roots,
		],
	};
}

const document: TextNavigationDocument = {
	selector,
	roots: ["user0", "tool1", "answer2", "thought3", "tool4", "user5", "answer6"],
	anchors: [
		{ id: "user0.body", root: 0 },
		{ id: "answer2.t0", root: 2 },
		{ id: "user5.body", root: 5 },
		{ id: "answer6.t0", root: 6 },
	],
};

const originalControl = process.env.OMP_TERN_CONTROL;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalControl === undefined) delete process.env.OMP_TERN_CONTROL;
	else process.env.OMP_TERN_CONTROL = originalControl;
});

describe("selectTextNavigationAnchor", () => {
	it("follows mouse changes to the current viewport after an earlier navigation", () => {
		const firstViewport = new Map([["answer2.t0", 40]]);
		expect(selectTextNavigationAnchor(document, 2, firstViewport, 40, "next")?.id).toBe("user5.body");

		// The mouse has since moved up to the first answer, partly clipped above the pane.
		const scrolledUp = new Map([["user0.body", -140]]);
		expect(selectTextNavigationAnchor(document, 0, scrolledUp, 40, "next")?.id).toBe("answer2.t0");

		// Moving down again changes the result without any remembered keyboard cursor.
		const scrolledDown = new Map([["answer6.t0", -80]]);
		expect(selectTextNavigationAnchor(document, 6, scrolledDown, 40, "previous")?.id).toBe("answer6.t0");
	});

	it("returns to the beginning of clipped long text before moving to earlier text", () => {
		expect(selectTextNavigationAnchor(document, 2, new Map([["answer2.t0", -450]]), 40, "previous")?.id).toBe(
			"answer2.t0",
		);
		expect(selectTextNavigationAnchor(document, 2, new Map([["answer2.t0", 40]]), 40, "previous")?.id).toBe(
			"user0.body",
		);
		expect(selectTextNavigationAnchor(document, 2, new Map([["answer2.t0", -450]]), 40, "next")?.id).toBe(
			"user5.body",
		);
	});

	it("crosses large tool and thinking gaps by logical root order", () => {
		for (const root of [3, 4]) {
			expect(selectTextNavigationAnchor(document, root, new Map(), 40, "previous")?.id).toBe("answer2.t0");
			expect(selectTextNavigationAnchor(document, root, new Map(), 40, "next")?.id).toBe("user5.body");
		}
	});

	it("keeps a three-pixel alignment tolerance and clamps both document boundaries", () => {
		for (const y of [37, 38, 40, 42, 43]) {
			expect(selectTextNavigationAnchor(document, 2, new Map([["answer2.t0", y]]), 40, "previous")?.id).toBe(
				"user0.body",
			);
			expect(selectTextNavigationAnchor(document, 2, new Map([["answer2.t0", y]]), 40, "next")?.id).toBe(
				"user5.body",
			);
		}
		expect(selectTextNavigationAnchor(document, 0, new Map([["user0.body", 90]]), 40, "previous")?.id).toBe(
			"user0.body",
		);
		expect(selectTextNavigationAnchor(document, 6, new Map([["answer6.t0", -90]]), 40, "next")?.id).toBe(
			"answer6.t0",
		);
	});

	it("uses anchor positions within a root containing multiple text blocks", () => {
		const split: TextNavigationDocument = {
			selector,
			roots: ["answer"],
			anchors: [
				{ id: "answer.t0", root: 0 },
				{ id: "answer.t2", root: 0 },
				{ id: "answer.t4", root: 0 },
			],
		};
		const positions = new Map([
			["answer.t0", -400],
			["answer.t2", -20],
			["answer.t4", 500],
		]);
		expect(selectTextNavigationAnchor(split, 0, positions, 40, "previous")?.id).toBe("answer.t2");
		expect(selectTextNavigationAnchor(split, 0, positions, 40, "next")?.id).toBe("answer.t4");
	});

	it("retains virtualized neighbors and the global first text in the complete index", () => {
		const long: TextNavigationDocument = {
			selector,
			roots: Array.from({ length: 100 }, (_, index) => `root${index}`),
			anchors: Array.from({ length: 100 }, (_, root) => ({ id: `root${root}.body`, root })),
		};
		// Only roots 94–99 are mounted, but the previous text is still root 93.
		expect(selectTextNavigationAnchor(long, 94, new Map([["root94.body", 40]]), 40, "previous")?.id).toBe(
			"root93.body",
		);
		expect(selectTextNavigationAnchor(long, 94, new Map(), 40, "first")?.id).toBe("root0.body");
	});

	it("returns undefined for no text and rejects missing current geometry", () => {
		const empty = { ...document, anchors: [] };
		for (const direction of ["previous", "next", "first"] as const) {
			expect(selectTextNavigationAnchor(empty, 0, new Map(), 40, direction)).toBeUndefined();
		}
		expect(() => selectTextNavigationAnchor(document, 2, new Map(), 40, "next")).toThrow("missing current geometry");
	});
});

describe("parseTextNavigationViewport", () => {
	it("uses the pane viewport and the clipped root spanning its top", () => {
		const clipped = rootElement(4, -500, 1_200);
		const parsed = parseTextNavigationViewport(snapshot(rootElement(3, -700, 150), clipped, rootElement(5, 720)));
		expect(parsed.top).toBe(40);
		expect(parsed.bottom).toBe(640);
		expect(parsed.root.nth).toBe(clipped.nth);
		expect(parsed.root.rect[1]).toBe(-500);
	});

	it("chooses the nearest root across a gap, including roots outside the viewport", () => {
		const before = rootElement(0, -200, 100);
		const after = rootElement(1, 1_000, 100);
		expect(parseTextNavigationViewport(snapshot(before, after)).root.nth).toBe(before.nth);
	});

	it("ignores hidden, zero-sized, nested, and other-region roots", () => {
		const actual = rootElement(2, -40, 200);
		const hidden = { ...rootElement(0, 40), visible: false };
		const zeroWidth = rootElement(1, 40);
		zeroWidth.rect[2] = 0;
		const zeroHeight = rootElement(1, 40);
		zeroHeight.rect[3] = 0;
		const nested = {
			...rootElement(3, 40),
			path: `${actual.path}>div.sf.sf-md`,
			nth: `${actual.nth}>div:nth-of-type(1)`,
		};
		const foreign = { ...rootElement(4, 40), nth: `${gridNth}>div:nth-of-type(9)>div:nth-of-type(1)` };
		const data = snapshot(actual, hidden, zeroWidth, zeroHeight, nested, foreign);
		data.elements.unshift({
			path: gridPath,
			nth: gridNth.replace("section:nth-of-type(1)", "section:nth-of-type(2)"),
			rect: [800, 0, 200, 800],
			visible: true,
		});
		expect(parseTextNavigationViewport(data).root.nth).toBe(actual.nth);
	});

	it("reports malformed responses and absent geometry instead of inventing a cursor", () => {
		for (const malformed of [null, [], { ok: true }, { ok: true, elements: [null] }]) {
			expect(() => parseTextNavigationViewport(malformed)).toThrow("Tern text navigation");
		}
		expect(() => parseTextNavigationViewport({ ok: false, error: "no window is showing this pane" })).toThrow(
			"no window is showing this pane",
		);
		expect(() => parseTextNavigationViewport({ ok: true, elements: [] })).toThrow("transcript region");
		expect(() => parseTextNavigationViewport(snapshot())).toThrow("no mounted transcript root");
		const invalid = rootElement(0, 40);
		invalid.rect[1] = Number.NaN;
		expect(() => parseTextNavigationViewport(snapshot(invalid))).toThrow("invalid rectangle");
		const missingGrid = snapshot(rootElement(0, 40));
		missingGrid.elements.shift();
		expect(() => parseTextNavigationViewport(missingGrid)).toThrow("containing pane viewport");
	});
});

describe("findTextNavigationTarget", () => {
	it("captures both scroll position and alignment from a single rendered snapshot", async () => {
		const body = rootElement(0, 40, 80);
		spyOn(ptree, "exec").mockResolvedValue({
			stdout: JSON.stringify(snapshot(body)),
			stderr: "",
			exitCode: 0,
			ok: true,
		});
		const position = await readTextNavigationPosition(document, document.anchors[2]!.id);
		expect(position).toEqual({ id: "user5.body", offset: 1_040, height: 600, start: 0, end: -520 });
	});

	it("continues across short tail anchors when reveal cannot scroll the viewport further", async () => {
		const short: TextNavigationDocument = {
			selector,
			roots: ["first", "middle", "last"],
			anchors: [
				{ id: "first.body", root: 0 },
				{ id: "middle.body", root: 1 },
				{ id: "last.body", root: 2 },
			],
		};
		const visible = snapshot(rootElement(0, 40, 60), rootElement(1, 120, 60), rootElement(2, 200, 60));
		visible.elements[1]!.rect = [0, 40, 800, 260];
		spyOn(ptree, "exec").mockResolvedValue({
			stdout: JSON.stringify(visible),
			stderr: "",
			exitCode: 0,
			ok: true,
		});
		let cursor = { id: short.anchors[0]!.id, offset: 0, height: 600 };
		const middle = await findTextNavigationTarget(short, "next", undefined, cursor);
		expect(middle?.id).toBe("middle.body");
		cursor = { ...cursor, id: middle!.id };
		const last = await findTextNavigationTarget(short, "next", undefined, cursor);
		expect(last?.id).toBe("last.body");
		cursor = { ...cursor, id: last!.id };
		expect((await findTextNavigationTarget(short, "next", undefined, cursor))?.id).toBe("last.body");
		expect((await findTextNavigationTarget(short, "previous", undefined, cursor))?.id).toBe("middle.body");
	});

	it("discards the prior cursor after mouse scrolling, resizing, or removal of its text", async () => {
		const current = rootElement(0, -200, 800);
		spyOn(ptree, "exec").mockImplementation(async command => {
			const query = command.at(-1)!;
			const response = query.startsWith(".tv-grid,")
				? snapshot(current)
				: { ok: true, elements: query.includes("[data-id='tool4']") ? [current] : [] };
			return { stdout: JSON.stringify(response), stderr: "", exitCode: 0, ok: true };
		});
		for (const cursor of [
			{ id: "answer6.t0", offset: 1_100, height: 600 },
			{ id: "answer6.t0", offset: 1_040, height: 620 },
			{ id: "removed.body", offset: 1_040, height: 600 },
		]) {
			expect((await findTextNavigationTarget(document, "previous", undefined, cursor))?.id).toBe("answer2.t0");
		}
	});

	it("resolves a mounted tool root to text on either side through bounded membership queries", async () => {
		const current = rootElement(0, -200, 800);
		const calls: string[][] = [];
		const signals: (AbortSignal | undefined)[] = [];
		const control = "/tmp/isolated renderer $(literal);control.sock";
		process.env.OMP_TERN_CONTROL = control;
		spyOn(ptree, "exec").mockImplementation(async (command, options) => {
			calls.push(command);
			signals.push(options?.signal);
			const query = command.at(-1)!;
			const response = query.startsWith(".tv-grid,")
				? snapshot(current)
				: { ok: true, elements: query.includes("[data-id='tool4']") ? [current] : [] };
			return { stdout: JSON.stringify(response), stderr: "", exitCode: 0, ok: true };
		});
		expect((await findTextNavigationTarget(document, "previous"))?.id).toBe("answer2.t0");
		expect((await findTextNavigationTarget(document, "next"))?.id).toBe("user5.body");
		expect(
			calls.every(
				command => command.slice(0, 5).join("\0") === ["tern", "ctl", "--control", control, "dump"].join("\0"),
			),
		).toBe(true);
		expect(new Set(signals.slice(0, 5)).size).toBe(1);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it("reads the exact current text start and uses the normal daemon relay by default", async () => {
		delete process.env.OMP_TERN_CONTROL;
		const current = rootElement(0, -200, 800);
		const body = { ...current, path: `${current.path}>div.sf.sf-md`, nth: `${current.nth}>div:nth-of-type(1)` };
		const single: TextNavigationDocument = {
			selector,
			roots: ["answer", "later"],
			anchors: [
				{ id: "answer.t0", root: 0 },
				{ id: "later.body", root: 1 },
			],
		};
		const calls: string[][] = [];
		spyOn(ptree, "exec").mockImplementation(async command => {
			calls.push(command);
			const query = command.at(-1)!;
			const response = query.startsWith(".tv-grid,")
				? snapshot(current)
				: { ok: true, elements: [query.includes("[data-id='answer.t0']") ? body : current] };
			return { stdout: JSON.stringify(response), stderr: "", exitCode: 0, ok: true };
		});
		expect((await findTextNavigationTarget(single, "previous"))?.id).toBe("answer.t0");
		expect((await findTextNavigationTarget(single, "next"))?.id).toBe("later.body");
		expect(calls.every(command => command.slice(0, 3).join(" ") === "tern ctl dump")).toBe(true);
	});

	it("returns first or empty text without renderer queries", async () => {
		const execute = spyOn(ptree, "exec").mockRejectedValue(new Error("unexpected renderer query"));
		expect((await findTextNavigationTarget(document, "first"))?.id).toBe("user0.body");
		expect(await findTextNavigationTarget({ ...document, anchors: [] }, "next")).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
	});

	it("propagates control failures, invalid JSON and cancellation", async () => {
		const execute = spyOn(ptree, "exec").mockRejectedValueOnce(new Error("renderer disconnected"));
		await expect(findTextNavigationTarget(document, "next")).rejects.toThrow("renderer disconnected");
		execute.mockResolvedValueOnce({ stdout: "not JSON", stderr: "", exitCode: 0, ok: true });
		await expect(findTextNavigationTarget(document, "next")).rejects.toThrow("invalid JSON");
		const abort = new AbortController();
		abort.abort(new Error("navigation superseded"));
		await expect(findTextNavigationTarget(document, "next", abort.signal)).rejects.toThrow("navigation superseded");
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("uses one deadline for the whole lookup and stops before another query after it expires", async () => {
		const deadline = new AbortController();
		const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const current = rootElement(0, -200, 800);
		let queries = 0;
		spyOn(ptree, "exec").mockImplementation(async (_command, options) => {
			expect(options?.signal).toBe(deadline.signal);
			queries++;
			if (queries === 2) deadline.abort(new Error("overall navigation deadline"));
			const response = queries === 1 ? snapshot(current) : { ok: true, elements: [] };
			return { stdout: JSON.stringify(response), stderr: "", exitCode: 0, ok: true };
		});
		await expect(findTextNavigationTarget(document, "next")).rejects.toThrow("overall navigation deadline");
		expect(timeout).toHaveBeenCalledTimes(1);
		expect(timeout).toHaveBeenCalledWith(2_000);
		expect(queries).toBe(2);
	});

	it("rejects a viewport that moves while measuring the current text", async () => {
		const current = rootElement(0, -200, 800);
		const moved = rootElement(0, -400, 800);
		const body = { ...current, path: `${current.path}>div.sf.sf-md`, nth: `${current.nth}>div:nth-of-type(1)` };
		spyOn(ptree, "exec")
			.mockResolvedValueOnce({ stdout: JSON.stringify(snapshot(current)), stderr: "", exitCode: 0, ok: true })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ ok: true, elements: [body] }),
				stderr: "",
				exitCode: 0,
				ok: true,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ ok: true, elements: [moved] }),
				stderr: "",
				exitCode: 0,
				ok: true,
			});
		await expect(
			findTextNavigationTarget({ selector, roots: ["user0"], anchors: [document.anchors[0]!] }, "next"),
		).rejects.toThrow("viewport moved");
	});
});
