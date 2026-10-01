import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import type { AgentNodeMeasurement } from "../../src/shared/agent-control";
import { cropNodeCapture, cropPng, nodePixelRect, pngSize } from "../../src/main/png-crop";
import { syntheticPixel, syntheticPng } from "./synthetic-png";

/** Decodes the cropped PNG back to RGBA rows (the crop writes filter 0 only). */
function pixels(png: Uint8Array): number[][][] {
  const { width, height } = pngSize(png);
  const bytes = Buffer.from(png);
  let idat = Buffer.alloc(0);
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      idat = Buffer.concat([idat, bytes.subarray(offset + 8, offset + 8 + length)]);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(idat);
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const start = y * (width * 4 + 1) + 1 + x * 4;
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    return [...raw.subarray(start, start + 4)];
  }));
}

test("cropping a PNG that uses every scanline filter keeps exactly the requested pixels", () => {
  const cropped = cropPng(syntheticPng(40, 30), { x: 7, y: 4, width: 11, height: 9 });
  expect(pngSize(cropped)).toEqual({ width: 11, height: 9 });
  const decoded = pixels(cropped);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) expect(decoded[y]![x]).toEqual(syntheticPixel(x + 7, y + 4));
  }
});

test("crops are clamped to the image and non-PNG data is refused", () => {
  expect(pngSize(cropPng(syntheticPng(10, 10), { x: 6, y: 8, width: 50, height: 50 }))).toEqual({ width: 4, height: 2 });
  expect(() => cropPng(new Uint8Array([1, 2, 3]), { x: 0, y: 0, width: 1, height: 1 })).toThrow("not a PNG");
});

test("a node's webview rectangle maps past the window frame at the capture's pixel scale", () => {
  const node: AgentNodeMeasurement = {
    nodeId: "n",
    rect: { x: 10, y: 5, width: 20, height: 10.2 },
    fullWidth: 20,
    fullHeight: 10,
    truncated: false,
    // 90x60 CSS px at 2x is 180x120; the 200x160 capture adds a 40px title bar and 10px side margins.
    viewport: { width: 90, height: 60 },
    devicePixelRatio: 2,
    changes: { revealed: false, scrolled: false },
  };
  expect(nodePixelRect({ width: 200, height: 160 }, node)).toEqual({ x: 30, y: 50, width: 40, height: 21 });
  const cropped = cropNodeCapture(syntheticPng(200, 160), node);
  expect(pngSize(cropped)).toEqual({ width: 40, height: 21 });
  expect(pixels(cropped)[0]![0]).toEqual(syntheticPixel(30, 50));
});
