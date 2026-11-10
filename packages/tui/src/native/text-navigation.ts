import { randomUUID } from "node:crypto";
import { combineSignals, exec } from "@oh-my-pi/pi-utils/ptree";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export type TextNavigationDirection = "previous" | "next" | "first" | "latest";

export interface TextNavigationAnchor {
	readonly id: string;
	/** Index of the containing top-level transcript node, including non-text roots. */
	readonly root: number;
}

export interface TextNavigationDocument {
	readonly selector: string;
	readonly roots: readonly string[];
	/** All text anchors in document order, including roots the renderer has virtualized. */
	readonly anchors: readonly TextNavigationAnchor[];
}

export interface TextNavigationCursor {
	readonly id: string;
	readonly offset: number;
	readonly height: number;
}

export interface TextNavigationPosition extends TextNavigationCursor {
	/** Text edges relative to the corresponding viewport edges. */
	readonly start: number;
	readonly end: number;
}

/** A region role unique to this OMP process, even when several processes share a window. */
export const textNavigationDocumentRole = `omp.text.document.${randomUUID()}`;

const POSITION_TOLERANCE = 3;
const QUERY_TIMEOUT_MS = 2_000;

type Rect = readonly [number, number, number, number];

interface LayoutElement {
	readonly path: string;
	readonly nth: string;
	readonly rect: Rect;
}

export interface TextNavigationViewport {
	readonly top: number;
	readonly bottom: number;
	readonly offset: number;
	readonly height: number;
	readonly root: LayoutElement;
}

function layoutElements(response: unknown): LayoutElement[] {
	if (!isRecord(response)) throw new Error("Tern text navigation: malformed dump response");
	if (response.ok !== true) {
		const detail = typeof response.error === "string" ? response.error : "missing successful status";
		throw new Error(`Tern text navigation: dump failed: ${detail}`);
	}
	if (!Array.isArray(response.elements)) throw new Error("Tern text navigation: dump has no elements array");
	const elements: LayoutElement[] = [];
	for (const value of response.elements) {
		if (!isRecord(value) || typeof value.visible !== "boolean") {
			throw new Error("Tern text navigation: malformed dump element visibility");
		}
		if (!value.visible) continue;
		if (typeof value.path !== "string" || typeof value.nth !== "string" || !value.path || !value.nth) {
			throw new Error("Tern text navigation: dump element is missing its path or nth selector");
		}
		const rect = value.rect;
		if (
			!Array.isArray(rect) ||
			rect.length !== 4 ||
			!rect.every(part => typeof part === "number" && Number.isFinite(part)) ||
			rect[2] < 0 ||
			rect[3] < 0
		) {
			throw new Error(`Tern text navigation: invalid rectangle for ${value.path}`);
		}
		if (rect[2] === 0 || rect[3] === 0) continue;
		elements.push({ path: value.path, nth: value.nth, rect: rect as unknown as Rect });
	}
	return elements;
}

function lastClasses(path: string): readonly string[] {
	return path.slice(path.lastIndexOf(">") + 1).match(/\.[\w-]+/g) ?? [];
}

function isDirectChild(child: string, parent: string): boolean {
	return child.startsWith(`${parent}>`) && child.indexOf(">", parent.length + 1) === -1;
}

function documentGeometry(response: unknown): {
	elements: readonly LayoutElement[];
	region: LayoutElement;
	grid: LayoutElement;
} {
	const elements = layoutElements(response);
	const regions = elements.filter(element => {
		const classes = lastClasses(element.path);
		return classes.includes(".sf-region") && classes.includes(".sf-main");
	});
	if (regions.length !== 1) {
		throw new Error(`Tern text navigation: expected one transcript region, found ${regions.length}`);
	}
	const region = regions[0]!;
	const grids = elements.filter(
		element => lastClasses(element.path).includes(".tv-grid") && region.nth.startsWith(`${element.nth}>`),
	);
	if (grids.length !== 1) {
		throw new Error(`Tern text navigation: expected one containing pane viewport, found ${grids.length}`);
	}
	const grid = grids[0]!;
	return { elements, region, grid };
}

/** Parse the combined grid/region/direct-root dump without treating offscreen roots as hidden. */
export function parseTextNavigationViewport(response: unknown): TextNavigationViewport {
	const { elements, region, grid } = documentGeometry(response);
	const top = grid.rect[1];
	let root: LayoutElement | undefined;
	let nearest = Number.POSITIVE_INFINITY;
	for (const element of elements) {
		if (
			!isDirectChild(element.nth, region.nth) ||
			!isDirectChild(element.path, region.path) ||
			!lastClasses(element.path).includes(".sf")
		) {
			continue;
		}
		const start = element.rect[1];
		const end = start + element.rect[3];
		// In a gap, either neighboring root leads to the same logical previous/next anchors.
		const distance = start > top ? start - top : end <= top ? top - end : 0;
		if (distance < nearest || (distance === nearest && start > (root?.rect[1] ?? -Infinity))) {
			root = element;
			nearest = distance;
		}
	}
	if (!root) throw new Error("Tern text navigation: no mounted transcript root at the current viewport");
	return { top, bottom: top + grid.rect[3], offset: top - region.rect[1], height: grid.rect[3], root };
}

/** Select by the current viewport and complete logical order; no prior navigation cursor is retained. */
export function selectTextNavigationAnchor(
	document: TextNavigationDocument,
	root: number,
	anchorPositions: ReadonlyMap<string, number>,
	top: number,
	direction: "previous" | "next" | "first",
): TextNavigationAnchor | undefined {
	const first = document.anchors[0];
	if (!first || direction === "first") return first;
	let previous: TextNavigationAnchor | undefined;
	let next: TextNavigationAnchor | undefined;
	for (const anchor of document.anchors) {
		if (anchor.root < root) {
			previous = anchor;
		} else if (anchor.root > root) {
			next ??= anchor;
		} else {
			const position = anchorPositions.get(anchor.id);
			if (position === undefined || !Number.isFinite(position)) {
				throw new Error(`Tern text navigation: missing current geometry for text anchor ${anchor.id}`);
			}
			if (position < top - POSITION_TOLERANCE) previous = anchor;
			if (position > top + POSITION_TOLERANCE) next ??= anchor;
		}
	}
	return direction === "previous" ? (previous ?? first) : (next ?? document.anchors.at(-1));
}

function quotedId(id: string): string {
	return `'${id.replace(/[\0-\x1f\x7f'\\]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}'`;
}

async function dump(selector: string, signal: AbortSignal | undefined): Promise<unknown> {
	signal?.throwIfAborted();
	const command = ["tern", "ctl"];
	const control = process.env.OMP_TERN_CONTROL;
	if (control) command.push("--control", control);
	command.push("dump", selector);
	let stdout: string;
	try {
		({ stdout } = await exec(command, { signal }));
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Tern text navigation: control query failed: ${detail}`, { cause });
	}
	try {
		return JSON.parse(stdout);
	} catch (cause) {
		throw new Error("Tern text navigation: control query returned invalid JSON", { cause });
	}
}

async function locateRoot(
	document: TextNavigationDocument,
	candidate: LayoutElement,
	signal: AbortSignal | undefined,
): Promise<number> {
	let start = 0;
	let end = document.roots.length;
	while (end - start > 1) {
		const middle = start + Math.floor((end - start) / 2);
		const ids = document.roots.slice(start, middle).map(id => `[data-id=${quotedId(id)}]`);
		const matched = layoutElements(await dump(`${candidate.nth}:is(${ids.join(",")})`, signal));
		if (matched.length > 1 || (matched[0] && matched[0].nth !== candidate.nth)) {
			throw new Error("Tern text navigation: root membership query returned an unexpected element");
		}
		if (matched.length === 1) end = middle;
		else start = middle;
	}
	if (document.roots[start] === undefined) {
		throw new Error("Tern text navigation: mounted root has no logical document index");
	}
	return start;
}

/** Read scroll position and revealed geometry together after the renderer acknowledges a frame. */
export async function readTextNavigationPosition(
	document: TextNavigationDocument,
	id: string,
	signal?: AbortSignal,
): Promise<TextNavigationPosition> {
	const { elements, region, grid } = documentGeometry(
		await dump(
			`.tv-grid, ${document.selector}, ${document.selector} [data-id=${quotedId(id)}]`,
			combineSignals(signal, QUERY_TIMEOUT_MS),
		),
	);
	const targets = elements.filter(element => element.nth.startsWith(`${region.nth}>`));
	if (targets.length !== 1) throw new Error("Tern text navigation: revealed text is not mounted");
	const target = targets[0]!;
	return {
		id,
		offset: grid.rect[1] - region.rect[1],
		height: grid.rect[3],
		start: target.rect[1] - grid.rect[1],
		end: target.rect[1] + target.rect[3] - grid.rect[1] - grid.rect[3],
	};
}

/** Resolve against the renderer's current viewport, including neighbors absent through virtualization. */
export async function findTextNavigationTarget(
	document: TextNavigationDocument,
	direction: "previous" | "next" | "first",
	signal?: AbortSignal,
	cursor?: TextNavigationCursor,
): Promise<TextNavigationAnchor | undefined> {
	signal?.throwIfAborted();
	if (document.anchors.length === 0 || direction === "first") return document.anchors[0];
	const boundedSignal = combineSignals(signal, QUERY_TIMEOUT_MS);
	const viewport = parseTextNavigationViewport(
		await dump(`.tv-grid, ${document.selector}, ${document.selector} > .sf`, boundedSignal),
	);
	if (
		cursor &&
		Math.abs(cursor.offset - viewport.offset) <= POSITION_TOLERANCE &&
		Math.abs(cursor.height - viewport.height) <= POSITION_TOLERANCE
	) {
		const index = document.anchors.findIndex(anchor => anchor.id === cursor.id);
		if (index !== -1) {
			const next = Math.max(0, Math.min(document.anchors.length - 1, index + (direction === "previous" ? -1 : 1)));
			return document.anchors[next];
		}
	}
	const root = await locateRoot(document, viewport.root, boundedSignal);
	const positions = new Map<string, number>();
	for (const anchor of document.anchors) {
		if (anchor.root !== root) continue;
		const matched = layoutElements(
			await dump(`${document.selector} [data-id=${quotedId(anchor.id)}]`, boundedSignal),
		);
		const element = matched[0];
		if (
			matched.length !== 1 ||
			!element ||
			(element.nth !== viewport.root.nth && !element.nth.startsWith(`${viewport.root.nth}>`))
		) {
			throw new Error(`Tern text navigation: text anchor ${anchor.id} is no longer mounted in the current root`);
		}
		positions.set(anchor.id, element.rect[1]);
	}
	// Validate last, so wheel movement during either membership or text queries cannot mix snapshots.
	const matched = layoutElements(
		await dump(`${viewport.root.nth}[data-id=${quotedId(document.roots[root]!)}]`, boundedSignal),
	);
	const current = matched[0];
	if (matched.length !== 1 || current?.nth !== viewport.root.nth) {
		throw new Error("Tern text navigation: mounted root changed while reading the viewport");
	}
	if (current.rect.some((part, index) => Math.abs(part - viewport.root.rect[index]!) > POSITION_TOLERANCE)) {
		throw new Error("Tern text navigation: viewport moved while reading the current root");
	}
	return selectTextNavigationAnchor(document, root, positions, viewport.top, direction);
}
