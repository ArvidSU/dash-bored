import { deflateSync, inflateSync } from "node:zlib";
import { CoreError } from "../core/index";
import type { AgentNodeMeasurement } from "../shared/agent-control";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Chunk {
  type: string;
  data: Buffer;
}

function malformed(message: string): CoreError {
  return new CoreError("SCREENSHOT_FAILED", `The captured image cannot be cropped: ${message}`);
}

function readChunks(png: Uint8Array): Chunk[] {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.byteLength < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw malformed("not a PNG.");
  }
  const chunks: Chunk[] = [];
  for (let offset = SIGNATURE.length; offset + 12 <= bytes.byteLength;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > bytes.byteLength) throw malformed("truncated chunk.");
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

/** Reverses PNG scanline filters in place; returns the raw rows. */
function unfilter(data: Buffer, height: number, stride: number, bytesPerPixel: number): Buffer {
  const rows = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = data[row * (stride + 1)]!;
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const raw = data[source + index]!;
      const left = index >= bytesPerPixel ? rows[target + index - bytesPerPixel]! : 0;
      const up = row > 0 ? rows[target - stride + index]! : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? rows[target - stride + index - bytesPerPixel]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        predictor = distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft;
      } else if (filter !== 0) throw malformed(`unknown scanline filter ${filter}.`);
      rows[target + index] = (raw + predictor) & 0xff;
    }
  }
  return rows;
}

/**
 * Crops an 8-bit, non-interlaced RGB or RGBA PNG (what `screencapture`
 * writes) in process, so cropping needs no external tool and runs the same in
 * tests. Colour-profile and density chunks are kept so colours stay faithful.
 */
export function cropPng(png: Uint8Array, rect: PixelRect): Uint8Array<ArrayBuffer> {
  const chunks = readChunks(png);
  const header = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (!header || header.byteLength < 13) throw malformed("missing header.");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colorType, , , interlace] = [header[8]!, header[9]!, header[10]!, header[11]!, header[12]!];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (depth !== 8 || channels === 0 || interlace !== 0) {
    throw malformed("only 8-bit non-interlaced RGB and RGBA images are supported.");
  }
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  const cropWidth = Math.max(1, Math.min(width - x, Math.round(rect.width)));
  const cropHeight = Math.max(1, Math.min(height - y, Math.round(rect.height)));

  const stride = width * channels;
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = inflateSync(compressed);
  if (raw.byteLength < height * (stride + 1)) throw malformed("image data is incomplete.");
  const rows = unfilter(raw, height, stride, channels);

  const cropStride = cropWidth * channels;
  const cropped = Buffer.alloc(cropHeight * (cropStride + 1));
  for (let row = 0; row < cropHeight; row += 1) {
    const start = (y + row) * stride + x * channels;
    rows.copy(cropped, row * (cropStride + 1) + 1, start, start + cropStride);
  }

  const newHeader = Buffer.from(header);
  newHeader.writeUInt32BE(cropWidth, 0);
  newHeader.writeUInt32BE(cropHeight, 4);
  const kept = chunks.filter((chunk) => ["iCCP", "sRGB", "gAMA", "cHRM", "pHYs"].includes(chunk.type));
  const output = Buffer.concat([
    SIGNATURE,
    writeChunk("IHDR", newHeader),
    ...kept.map((chunk) => writeChunk(chunk.type, chunk.data)),
    writeChunk("IDAT", deflateSync(cropped)),
    writeChunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
}

export function pngSize(png: Uint8Array): { width: number; height: number } {
  const header = readChunks(png).find((chunk) => chunk.type === "IHDR")?.data;
  if (!header || header.byteLength < 8) throw malformed("missing header.");
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * Maps a node's webview rectangle onto the window capture. The capture holds
 * the window frame (title bar) around the webview, and the webview anchors to
 * the window's bottom and horizontal centre, so the offsets follow from the
 * size difference instead of a platform query.
 */
export function nodePixelRect(image: { width: number; height: number }, node: AgentNodeMeasurement): PixelRect {
  const scale = node.devicePixelRatio;
  const offsetX = Math.max(0, (image.width - node.viewport.width * scale) / 2);
  const offsetY = Math.max(0, image.height - node.viewport.height * scale);
  const left = Math.floor(offsetX + node.rect.x * scale);
  const top = Math.floor(offsetY + node.rect.y * scale);
  const right = Math.ceil(offsetX + (node.rect.x + node.rect.width) * scale);
  const bottom = Math.ceil(offsetY + (node.rect.y + node.rect.height) * scale);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cropNodeCapture(png: Uint8Array, node: AgentNodeMeasurement): Uint8Array<ArrayBuffer> {
  return cropPng(png, nodePixelRect(pngSize(png), node));
}
