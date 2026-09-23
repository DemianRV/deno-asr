/** Tray icons rendered at startup: a microphone glyph in the state's color. */

type RGB = [number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Microphone silhouette in a 22×22 unit space. */
function inMic(x: number, y: number, dot: boolean): boolean {
  // capsule
  const cx = 11, top = 3.5, bottom = 11.5, r = 3.5;
  const cy = Math.min(Math.max(y, top), bottom);
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  // holder arc (lower half ring)
  const d = Math.hypot(x - cx, y - 10);
  if (y >= 10 && d >= 5.5 && d <= 7) return true;
  // stem + base
  if (x >= 10.25 && x <= 11.75 && y >= 16.5 && y <= 19) return true;
  if (x >= 7.5 && x <= 14.5 && y >= 18.5 && y <= 20) return true;
  // status dot (top-right)
  if (dot && (x - 18) ** 2 + (y - 4) ** 2 <= 3.2 ** 2) return true;
  return false;
}

async function render(color: RGB, dot: boolean, size = 22): Promise<Uint8Array> {
  const ss = 4; // supersampling for anti-aliasing
  const rgba = new Uint8Array(size * size * 4);
  const scale = 22 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (inMic((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale, dot)) hits++;
        }
      }
      const i = (py * size + px) * 4;
      rgba.set(color, i);
      rgba[i + 3] = Math.round((hits / (ss * ss)) * 255);
    }
  }
  return await encodePng(size, size, rgba);
}

export interface TrayIcons {
  idle: Uint8Array;
  idleDark: Uint8Array;
  recording: Uint8Array;
  busy: Uint8Array;
}

export async function trayIcons(): Promise<TrayIcons> {
  const [idle, idleDark, recording, busy] = await Promise.all([
    render([0, 0, 0], false),
    render([255, 255, 255], false),
    render([255, 59, 48], true),
    render([255, 159, 10], true),
  ]);
  return { idle, idleDark, recording, busy };
}
