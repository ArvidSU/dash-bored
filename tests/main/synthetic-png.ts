import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Deterministic RGBA colour of a synthetic pixel, so crops can be checked by value. */
export function syntheticPixel(x: number, y: number): [number, number, number, number] {
  return [x % 256, y % 256, (x * 7 + y * 3) % 256, 255];
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(Bun.hash.crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const [dl, du, dul] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
}

/** An RGBA PNG whose rows cycle through every scanline filter. */
export function syntheticPng(width: number, height: number): Uint8Array {
  const stride = width * 4;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) Buffer.from(syntheticPixel(x, y)).copy(raw, x * 4);
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? raw[i - 4]! : 0;
      const up = previous[i]!;
      const upLeft = i >= 4 ? previous[i - 4]! : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      out[i + 1] = (raw[i]! - predictor) & 0xff;
    }
    rows.push(out);
    previous = raw;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}
