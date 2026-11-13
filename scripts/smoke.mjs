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
{
  const r = run(cli, ['check', ex('rework-links.csv'), '--units', ex('rework-units.csv'), '--bom', ex('bom.csv'), '--json']);
  const d = r.stdout ? JSON.parse(r.stdout) : {};
  if (r.status !== 1 || d.findings?.length !== 1 || d.summary?.removedLinks !== 2) fail(`rework example: ${r.status} ${r.stderr}`);
  console.log('smoke: ok rework example: 3 remove rows, 2 links taken out, 1 stray remove row');
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

// --time-order on the example and on 300,000 timestamped rows (shuffled file order); one MCU is linked late.
{
  const r = run(cli, ['check', ex('time-order-links.csv'), '--time-order', '--json']);
  const d = r.stdout ? JSON.parse(r.stdout) : {};
  if (r.status !== 1 || d.counts?.['late-component'] !== 1 || d.findings?.length !== 1) fail(`time-order example: ${r.status} ${r.stderr}`);
}
const stamp = (min) => new Date(Date.UTC(2026, 10, 1) + min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const timed = [];
for (let i = 0; i < 50_000; i++) {
  const m = `M${i}`;
  const p = `P${i}`;
  const late = i === 777 ? 10_000_000 : 0;
  timed.push(`${p},U${i},${stamp(i * 10 + late)}`, `${p},CA${i},${stamp(i * 10 + 1)}`, `${p},CB${i},${stamp(i * 10 + 2)}`);
  timed.push(`${m},${p},${stamp(i * 10 + 5)}`, `${m},L${i},${stamp(i * 10 + 6)}`, `${m},R${i},${stamp(i * 10 + 7)}`);
}
timed.reverse();
writeFileSync(join(dir, 'timed.csv'), 'parent,child,timestamp\n' + timed.join('\n') + '\n');
t0 = Date.now();
const tc = run(cli, ['check', join(dir, 'timed.csv'), '--time-order', '--json']);
const tcd = tc.stdout ? JSON.parse(tc.stdout) : {};
if (tc.status !== 1 || tcd.summary?.linkRows !== 300_000 || tcd.findings?.length !== 1 || tcd.findings[0].child !== 'U777') {
  fail(`large time-order: status ${tc.status} ${JSON.stringify(tcd.counts)} ${tc.stderr}`);
}
console.log(`smoke: ok --time-order example (1 late component) and 300,000 reversed timestamped rows (1 late) in ${Date.now() - t0} ms`);
