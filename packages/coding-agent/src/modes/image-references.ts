import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

/** Matches a single `[Image #N]` / `[Image #N, WxH]` marker. Group 1 is the
 *  1-based index, group 2 the optional metadata tail (leading comma, no `]` or
 *  newline) so future label tweaks keep matching. Paste markers are excluded
 *  on purpose: their numbering is owned by the editor's paste store, not by
 *  the pending-image buffer. */
export const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\]/g;

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
