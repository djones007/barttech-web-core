import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-icon-rgba.mjs is a standalone CLI run as a consumer's prebuild step, so it is
// exercised the same way: as a child process against real files on disk.

const SCRIPT = join(process.cwd(), "scripts", "check-icon-rgba.mjs");

/** The first 33 bytes of a PNG (signature + IHDR) — all the gate reads. */
function png(colourType: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(32, 16);
  b.writeUInt32BE(32, 20);
  b[24] = 8;
  b[25] = colourType;
  return b;
}

/** An ICO holding the given embedded images. */
function ico(images: Buffer[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    header[e] = 32;
    header[e + 1] = 32;
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...images]);
}

function bmp(bpp: number): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(40, 0);
  b.writeUInt16LE(bpp, 14);
  return b;
}

function runAgainst(files: Record<string, Buffer>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "icon-rgba-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("RGBA icon.png and apple-icon.png pass", () => {
  const r = runAgainst({ "src/app/icon.png": png(6), "src/app/apple-icon.png": png(6) });
  assert.equal(r.status, 0, r.out);
});

test("an RGB icon.png fails and names the file", () => {
  const r = runAgainst({ "src/app/icon.png": png(2) });
  assert.equal(r.status, 1);
  assert.match(r.out, /src\/app\/icon\.png: PNG colour type 2 \(RGB\)/);
});

test("app/ without src/ and nested route icons are checked too", () => {
  const r = runAgainst({ "app/(site)/icon1.png": png(3) });
  assert.equal(r.status, 1);
  assert.match(r.out, /palette/);
});

test("an ICO with RGBA PNG and 32bpp BMP entries passes; a 24bpp entry fails", () => {
  assert.equal(runAgainst({ "src/app/favicon.ico": ico([png(6), bmp(32)]) }).status, 0);
  const r = runAgainst({ "src/app/favicon.ico": ico([png(6), bmp(24)]) });
  assert.equal(r.status, 1);
  assert.match(r.out, /24 bpp/);
});

test("files under public/ are not Next icon-pipeline files and are ignored", () => {
  assert.equal(runAgainst({ "public/icon.png": png(2) }).status, 0);
});
