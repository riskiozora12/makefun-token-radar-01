// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores
// every rankable pre-token protocol with the radar-3 model in lib/model.ts, writes the ranked board
// to /output/board.json, and copies this repository's dashboard/ and screenshots/ to /output. Last,
// it writes /output/dossier.json, the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/
// app.css and dashboard/app.js read /output/data.js, which this program writes from the same board.
// The model is the entry's own claim: implied value from the snapshot's TVL, its seven-day growth,
// how long the protocol has run with no token, how many chains it spans, and the market multiple of
// its category — the median market-cap / TVL of the live-token protocols in the same category,
// read from the same snapshot, never a hand-written list of names. The dashboard recomputes every
// row from the same figures, so the page and board.json always agree.
//
// Before it writes the dossier it checks the screenshots the way the gate will: each one a whole
// PNG or JPEG within the byte cap, its long side at most 1440 and its short side at least 800
// pixels, so a bad screenshot fails here, loudly, instead of shipping an invalid entry.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Usage, printed for --help and -h: the program's inputs, outputs and flags. */
const USAGE = `token radar: rank every rankable pre-token protocol by implied value
usage: node main.ts [--input <snapshot.json|directory>] [--output <directory>]
  --input <path>   the sealed snapshot, a snapshot.json file or its directory
                   (default /input, or the directory holding snapshot.json)
  --output <dir>   where board.json, data.js, dashboard/, screenshots/ and
                   dossier.json go (default $MAKEFUN_OUTPUT_DIR, else /output)
  --help, -h       print this usage and stop
The snapshot must be a JSON object with as_of (a YYYY-MM-DD date), source,
floor_usd (a positive integer), a protocols array and a watchlist of slugs.
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

/** A --flag the program does not know, or null: unknown flags fail loudly. */
function unknownFlag(): string | null {
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=', 1)[0]!;
    if (name !== 'input' && name !== 'output' && name !== 'help') return a;
  }
  return null;
}
const badFlag = unknownFlag();
if (badFlag !== null) {
  process.stderr.write(`token radar: unknown flag ${badFlag}: run node main.ts --help for the flags this program takes\n`);
  process.exit(2);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

/** Read the snapshot at `path` and check its shape, or stop naming the fault. */
function readSnapshot(path: string) {
  // A missing file names the flag that would find it, not just the path.
  if (!existsSync(path)) {
    process.stderr.write(`token radar: no snapshot at ${path}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  // A directory passes existsSync but is not a snapshot: say so, do not read it.
  if (!statSync(path).isFile()) {
    process.stderr.write(`token radar: ${path} is not a file: pass --input <snapshot.json|directory>\n`);
    process.exit(2);
  }
  // A read failure names the file and the operating system's cause.
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`token radar: cannot read ${path}: ${cause}\n`);
    process.exit(2);
  }
  // A syntax error names the file and where it breaks; the shape check below
  // would only say "not JSON", which hides the position from the operator.
  try {
    JSON.parse(text);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`token radar: ${path} is not JSON: ${cause}\n`);
    process.exit(2);
  }
  // The model's own shape check names the field that is missing or mistyped.
  try {
    return parseSnapshot(text);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`token radar: ${path}: ${cause}\n`);
    process.exit(2);
  }
}

const snapshot = readSnapshot(inputFile);
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

/** A PNG or JPEG's pixel size, read from its own header, or null when it is not one. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk's width and height (big-endian, offsets 16 and 20).
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: SOI, then segments until a start-of-frame (SOF0/SOF1/SOF2) carries height and width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = bytes.readUInt16BE(at + 2);
      if (len < 2 || at + 2 + len > bytes.length) return null;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + len;
    }
  }
  return null;
}

/** The gate's screenshots row, checked here: size, whole image, and both sides in range. */
function checkScreenshots(dir: string, names: string[]): string | null {
  for (const name of names) {
    const path = join(dir, name);
    const size = statSync(path).size;
    if (size > SCREENSHOT_CAPS.max_bytes) return `screenshots/${name} is ${size} bytes, over the 512 KiB cap`;
    const bytes = readFileSync(path);
    const dims = imageSize(bytes);
    if (dims === null) return `screenshots/${name} is not a whole PNG or JPEG`;
    const long = Math.max(dims.width, dims.height);
    const short = Math.min(dims.width, dims.height);
    if (long > 1440) return `screenshots/${name} is ${dims.width}x${dims.height}: its long side is over 1440`;
    if (short < 800) return `screenshots/${name} is ${dims.width}x${dims.height}: its short side is under 800`;
  }
  return null;
}

const shotIssue = checkScreenshots(join(out, 'screenshots'), shots);
if (shotIssue !== null) {
  process.stderr.write(`token radar: ${shotIssue}\n`);
  process.exit(1);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossierBytes = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
writeFileSync(join(out, 'dossier.json'), dossierBytes);
// buildDossier returns bytes, not text: decode them before reading the dossier's own text.
// A cut dossier is still valid, but the judge then reads a partial source: say so loudly.
if (JSON.parse(new TextDecoder().decode(dossierBytes)).text.includes('[Cut at')) {
  process.stderr.write('token radar: warning: the dossier text is cut — the dashboard source is over the 65,536-byte text cap, and the judge reads only part of it\n');
}

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
