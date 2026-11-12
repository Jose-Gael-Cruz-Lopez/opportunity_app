#!/usr/bin/env node
/**
 * Renders the Novus favicon set and web app icons from the glow tile (the `.nv-glowbg` ramp in
 * client/src/index.css, Ember look) into client/public/icons/.
 *
 *   node infra/scripts/render-icons.mjs [--out client/public/icons] [--chrome "/path/to/Chrome"]
 *
 * The SVG sources are written first (favicon.svg is also served as the scalable favicon), then
 * each PNG is a screenshot of that SVG at its exact pixel size by the system Chrome in headless
 * mode (no npm dependency, nothing downloaded), and favicon.ico packs the 16, 32 and 48 px PNGs.
 * When writing to client/public/icons, favicon.ico is also copied to client/public/favicon.ico,
 * which the Worker serves at /favicon.ico for browsers that ask for it there.
 * Output is deterministic for a given Chrome version. The letter is drawn as a path, so no font
 * is needed in a standalone SVG favicon.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(arg("--out", "client/public/icons"));
const CHROME = arg("--chrome", process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

// Glow tile ramp (client/src/index.css, :root Ember look).
const C = {
  deep: "#130905",
  top: "#2A150A",
  mid: "#C2611E",
  low: "#F2C88E",
  sand: "#FCE8CC",
  clay: "#D9772A",
  sky: "#A7BFC4",
};

/** CSS `radial-gradient(RX% RY% at X% Y%, color A%, transparent B%)` on a 512 square. */
function radial(id, { rx, ry, x, y, color, from = 0, to }) {
  const s = 512 / 100;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${x * s} ${y * s}) scale(${rx * s} ${ry * s})">
      <stop offset="${from}" stop-color="${color}"/>
      <stop offset="${to}" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>`;
}

/**
 * The tile. `shape`: "rounded" (transparent corners, for favicons and `any` icons) or "full"
 * (full bleed, for maskable and Apple touch icons, which the platform crops). `weight` thickens
 * the letter at 16-32 px so it survives.
 */
function tileSvg({ shape, weight = 48 }) {
  const rx = shape === "rounded" ? 112 : 0;
  // Lower-case n: a full-height left stem, and a shoulder that leaves it below the top and
  // falls into the right stem. Centred on the tile; strokes with butt caps.
  const w = weight;
  const half = w / 2;
  const left = 256 - 58;
  const right = 256 + 58;
  const top = 206 + (64 - w) / 4;
  const base = 352;
  const glyph =
    `M${left} ${base} V${top - half} ` +
    `M${left} ${top + 52} C${left + 8} ${top + 14} ${left + 40} ${top} ${left + 72} ${top} ` +
    `C${right - 12} ${top} ${right} ${top + 26} ${right} ${top + 62} V${base}`;
  const shadow = Math.round(w / 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Novus</title>
  <defs>
    <linearGradient id="ramp" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.top}"/>
      <stop offset=".44" stop-color="${C.mid}"/>
      <stop offset=".70" stop-color="${C.low}"/>
      <stop offset="1" stop-color="${C.sand}"/>
    </linearGradient>
    ${radial("floor", { rx: 95, ry: 62, x: 50, y: 100, color: C.sand, from: 0.1, to: 0.72 })}
    ${radial("rim", { rx: 42, ry: 36, x: 0, y: 50, color: C.clay, to: 0.74 })}
    ${radial("sky", { rx: 54, ry: 52, x: 100, y: 4, color: C.sky, to: 0.7 })}
    ${radial("soil", { rx: 56, ry: 44, x: 30, y: 20, color: C.deep, to: 0.74 })}
    <linearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
      <stop offset=".82" stop-color="#FFF0DC" stop-opacity="0"/>
      <stop offset="1" stop-color="#FFF0DC" stop-opacity=".45"/>
    </linearGradient>
    <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${Math.round(shadow / 2)}" stdDeviation="${shadow}" flood-color="#3C1908" flood-opacity="${w > 48 ? 0.55 : 0.4}"/>
    </filter>
    <clipPath id="tile"><rect width="512" height="512" rx="${rx}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="url(#ramp)"/>
    <rect width="512" height="512" fill="url(#floor)"/>
    <rect width="512" height="512" fill="url(#rim)"/>
    <rect width="512" height="512" fill="url(#sky)"/>
    <rect width="512" height="512" fill="url(#soil)"/>
    <rect width="512" height="512" fill="url(#lip)"/>
  </g>
  <path d="${glyph}" fill="none" stroke="#FFFFFF" stroke-width="${w}" stroke-linejoin="round" filter="url(#lift)"/>
</svg>
`;
}

function render(svg, size, file) {
  const dir = mkdtempSync(join(tmpdir(), "novus-icons-"));
  try {
    const sized = svg.replace('width="512" height="512">', `width="${size}" height="${size}">`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${sized}</body></html>`;
    const page = join(dir, "icon.html");
    writeFileSync(page, html);
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(dir, "profile")}`,
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--window-size=${size},${size}`,
        `--screenshot=${join(OUT, file)}`,
        `file://${page}`,
      ],
      { stdio: "ignore" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ICO with embedded PNG images (supported by every current browser and Windows Vista+). */
function writeIco(file, pngFiles) {
  const images = pngFiles.map(([size, name]) => ({ size, data: readFileSync(join(OUT, name)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  writeFileSync(join(OUT, file), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
}

mkdirSync(OUT, { recursive: true });
const rounded = tileSvg({ shape: "rounded" });
const small = tileSvg({ shape: "rounded", weight: 64 });
const full = tileSvg({ shape: "full" });
writeFileSync(join(OUT, "favicon.svg"), rounded);
writeFileSync(join(OUT, "tile-maskable.svg"), full);

const PNGS = [
  [small, 16, "favicon-16.png"],
  [small, 32, "favicon-32.png"],
  [rounded, 48, "favicon-48.png"],
  [full, 180, "apple-touch-icon.png"],
  [rounded, 192, "icon-192.png"],
  [rounded, 512, "icon-512.png"],
  [full, 192, "icon-maskable-192.png"],
  [full, 512, "icon-maskable-512.png"],
];
for (const [svg, size, file] of PNGS) render(svg, size, file);
writeIco("favicon.ico", [
  [16, "favicon-16.png"],
  [32, "favicon-32.png"],
  [48, "favicon-48.png"],
]);
if (basename(OUT) === "icons" && basename(dirname(OUT)) === "public") copyFileSync(join(OUT, "favicon.ico"), join(dirname(OUT), "favicon.ico"));
console.log(`wrote ${PNGS.length} PNGs, favicon.ico, favicon.svg and tile-maskable.svg to ${OUT}`);
