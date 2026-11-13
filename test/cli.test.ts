import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { ex } from './helpers.js';

function run(args: string[]) {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  try {
    return { code: main(args), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

const full = ['check', ex('links.csv'), '--units', ex('units.csv'), '--bom', ex('bom.csv')];

describe('cli check', () => {
  it('example: 4 findings, exit 1', () => {
    const r = run(full);
    expect(r.code).toBe(1);
    expect(r.out).toContain('LCD-2002 is built into 2 assemblies: MTR-0002, MTR-0003 (rows 7, 11)');
    expect(r.out).toContain('MTR-0004 (METER-1P) has 0 x LCD-SEG, BOM says 1');
    expect(r.out).toContain('PCB-1003 (PCBA-MAIN) has 2 x MCU-A, BOM says 1: MCU-4003, MCU-4004');
    expect(r.out).toContain('RLY-3003 into MTR-0003 is recorded 2 times (rows 12, 13)');
  });
  it('json', () => {
    const r = run([...full, '--json']);
    const data = JSON.parse(r.out);
    expect(data.summary).toMatchObject({ serials: 19, links: 16, linkRows: 17, topLevel: 4, maxLevels: 3, bomChecked: 8 });
    expect(data.counts).toEqual({ 'duplicate-link': 1, 'multi-parent': 1, 'bom-missing': 1, 'bom-extra': 1 });
  });
  it('--limit trims the text list', () => {
    const r = run([...full, '--limit', '1']);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('more (use --json');
  });
  it('input errors exit 2', () => {
    expect(run([]).code).toBe(2);
    expect(run(['fix', ex('links.csv')]).err).toContain('unknown command "fix"');
    expect(run(['check']).err).toContain('missing the links CSV');
    expect(run(['check', ex('links.csv'), '--bom', ex('bom.csv')]).err).toContain('--bom needs --units');
    expect(run(['check', ex('nope.csv')]).err).toContain('cannot read links file');
    expect(run(['check', ex('links.csv'), 'extra']).code).toBe(2);
    expect(run(['check', ex('links.csv'), '--max-depth', '3']).code).toBe(2);
    expect(run(['check', ex('links.csv'), '--bogus']).code).toBe(2);
    expect(run(['check', ex('links.csv'), '--limit', '0']).err).toContain('--limit must be');
  });
  it('help', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: genealogy-check check');
  });
});

describe('cli trace', () => {
  it('recall list from a file: affected top-level units, exit 0', () => {
    const r = run(['trace', ex('links.csv'), '--serials', ex('recall-serials.txt'), '--units', ex('units.csv')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('MCU-4002 -> PCB-1002 -> MTR-0002');
    expect(r.out).toContain('Affected top-level units (2): MTR-0002, MTR-0003');
  });
  it('tree down with parts', () => {
    const r = run(['trace', ex('links.csv'), 'MTR-0003', '--units', ex('units.csv')]);
    expect(r.out).toContain("    |   `-- MCU-4004 [MCU-A]");
  });
  it('unknown serial exits 1, json', () => {
    const r = run(['trace', ex('links.csv'), 'NOPE', 'LCD-2002', '--json']);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.out);
    expect(data.notFound).toEqual(['NOPE']);
    expect(data.affectedTopLevel).toEqual(['MTR-0002', 'MTR-0003']);
  });
  it('trace errors', () => {
    expect(run(['trace', ex('links.csv')]).err).toContain('at least one serial');
    expect(run(['trace', ex('links.csv'), 'A', '--bom', ex('bom.csv')]).code).toBe(2);
    expect(run(['trace', ex('links.csv'), 'A', '--max-depth', '1001']).err).toContain('--max-depth must be');
    expect(run(['trace', ex('links.csv'), 'A', '--part-column', 'pn']).err).toContain('need --units');
  });
});
