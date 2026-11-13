#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const ex = (n) => join(root, 'examples', n);
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const dir = mkdtempSync(join(tmpdir(), 'genealogy-smoke-'));
const link = join(dir, 'genealogy-check');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const res = run(bin, ['check', ex('links.csv'), '--units', ex('units.csv'), '--bom', ex('bom.csv'), '--json']);
  const data = res.stdout ? JSON.parse(res.stdout) : {};
  if (res.status !== 1 || data.findings?.length !== 4 || data.summary?.serials !== 19) {
    fail(`example via ${bin}: status ${res.status} ${JSON.stringify(data.summary)} ${res.stderr}`);
  }
  const t = run(bin, ['trace', ex('links.csv'), '--serials', ex('recall-serials.txt'), '--json']);
  const td = t.stdout ? JSON.parse(t.stdout) : {};
  if (t.status !== 0 || td.affectedTopLevel?.join() !== 'MTR-0002,MTR-0003') fail(`trace via ${bin}: ${t.status} ${t.stderr}`);
}
console.log('smoke: ok example (direct and via symlink): check 4 findings exit 1; recall trace -> MTR-0002, MTR-0003');

// 50,000 meters x (PCB with 3 parts, LCD, relay) = 300,000 link rows; 3 meters share one relay (double consumption).
const rows = ['parent,child'];
const units = ['serial,part'];
const bom = 'parent_part,child_part,qty\nMTR,PCB,1\nMTR,LCD,1\nMTR,RLY,1\nPCB,MCU,1\nPCB,CAP,2\n';
for (let i = 0; i < 50_000; i++) {
  const m = `M${i}`;
  const p = `P${i}`;
  const relay = i === 101 || i === 202 ? 'R100' : `R${i}`;
  rows.push(`${m},${p}`, `${m},L${i}`, `${m},${relay}`, `${p},U${i}`, `${p},CA${i}`, `${p},CB${i}`);
  units.push(`${m},MTR`, `${p},PCB`, `L${i},LCD`, `R${i},RLY`, `U${i},MCU`, `CA${i},CAP`, `CB${i},CAP`);
}
writeFileSync(join(dir, 'links.csv'), rows.join('\n') + '\n');
writeFileSync(join(dir, 'units.csv'), units.join('\n') + '\n');
writeFileSync(join(dir, 'bom.csv'), bom);
let t0 = Date.now();
const big = run(cli, ['check', join(dir, 'links.csv'), '--units', join(dir, 'units.csv'), '--bom', join(dir, 'bom.csv'), '--json']);
const bd = big.stdout ? JSON.parse(big.stdout) : {};
const ms = Date.now() - t0;
// R101 and R202 are never used -> no finding (not built in is fine); R100 in 3 meters -> 1 multi-parent.
if (big.status !== 1 || bd.summary?.linkRows !== 300_000 || bd.counts?.['multi-parent'] !== 1 || bd.findings?.length !== 1) {
  fail(`large check: status ${big.status} ${JSON.stringify(bd.summary)} ${JSON.stringify(bd.counts)} ${big.stderr}`);
}
t0 = Date.now();
const bt = run(cli, ['trace', join(dir, 'links.csv'), 'R100', '--json']);
const btd = bt.stdout ? JSON.parse(bt.stdout) : {};
if (bt.status !== 0 || btd.affectedTopLevel?.join() !== 'M100,M101,M202') fail(`large trace: ${bt.status} ${bt.stderr}`);
console.log(`smoke: ok large (300,000 links, 350,000 units, BOM on 100,000 assemblies) check ${ms} ms, trace ${Date.now() - t0} ms`);
