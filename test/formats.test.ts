import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, trace } from '../src/graph.js';
import { checkCsv, checkMd, csvCell, traceCsv, traceMd } from '../src/formats.js';
import { parseCsv } from '../src/csv.js';
import { parseBom, parseLinks, parseUnits } from '../src/input.js';
import { ex } from './helpers.js';

const links = parseLinks(readFileSync(ex('links.csv'), 'utf8'));
const units = parseUnits(readFileSync(ex('units.csv'), 'utf8'));
const bom = parseBom(readFileSync(ex('bom.csv'), 'utf8'));
const parts = new Map(units.map((u) => [u.serial, u.part]));
const partOf = (s: string) => parts.get(s);
const L = (rows: [string, string][]) => parseLinks(['parent,child', ...rows.map((r) => r.join(','))].join('\n'));

describe('csvCell', () => {
  it('quotes and guards formulas', () => {
    expect(csvCell('A-1')).toBe('A-1');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+60')).toBe("'+60");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(3)).toBe('3');
  });
});

describe('checkCsv', () => {
  it('one row per finding, text order, parses back', () => {
    const rows = parseCsv(checkCsv(check(links, units, bom)));
    expect(rows[0]).toEqual(['type', 'serial', 'parent', 'parent_part', 'child_part', 'expected', 'actual', 'serials', 'rows', 'detail']);
    expect(rows.slice(1).map((r) => r[0])).toEqual(['multi-parent', 'bom-missing', 'bom-extra', 'duplicate-link']);
    expect(rows[1]).toEqual(['multi-parent', 'LCD-2002', 'MTR-0002 MTR-0003', '', '', '', '2', 'LCD-2002', '7 11', 'LCD-2002 is built into 2 assemblies: MTR-0002, MTR-0003 (rows 7, 11)']);
    expect(rows[3].slice(0, 9)).toEqual(['bom-extra', '', 'PCB-1003', 'PCBA-MAIN', 'MCU-A', '1', '2', 'MCU-4003 MCU-4004', '']);
  });
  it('header only when clean; cycles, self-links, unknown, unexpected', () => {
    expect(checkCsv(check(L([['A', 'B']])))).toBe('type,serial,parent,parent_part,child_part,expected,actual,serials,rows,detail\n');
    const rows = parseCsv(checkCsv(check(L([['A', 'B'], ['B', 'A'], ['C', 'C']]))));
    expect(rows.slice(1).map((r) => [r[0], r[1], r[7]])).toEqual([
      ['cycle', '', 'A B'],
      ['self-link', 'C', 'C'],
    ]);
    const u = parseUnits('serial,part\nM1,METER\nX1,ODD');
    const b = parseBom('parent_part,child_part,qty\nMETER,PCB,1');
    const r2 = parseCsv(checkCsv(check(L([['M1', 'X1'], ['M1', 'Z9']]), u, b)));
    expect(r2.slice(1).map((r) => r[0])).toEqual(['bom-missing', 'bom-unexpected', 'unknown-serial']);
    expect(r2[2].slice(0, 8)).toEqual(['bom-unexpected', '', 'M1', 'METER', 'ODD', '0', '1', 'X1']);
  });
});

describe('checkMd', () => {
  it('summary, counts table, sections, limit', () => {
    const md = checkMd(check(links, units, bom), 1);
    expect(md).toContain('| 19 | 16 | 17 | 4 | 15 | 3 |');
    expect(md).toContain('| Built into more than one assembly (double consumption) | 1 |');
    expect(md).toContain('### More components than the BOM (1)');
    expect(md).toContain('- PCB-1003 (PCBA-MAIN) has 2 x MCU-A, BOM says 1: MCU-4003, MCU-4004');
    expect(checkMd(check(L([['A', 'B']])))).toContain('No findings.');
    const many = checkMd(check(L([['A', 'A'], ['B', 'B']])), 1);
    expect(many).toContain('- ... 1 more (use --json or --csv for all)');
  });
  it('escapes pipes in serials', () => {
    expect(checkMd(check(L([['A|1', 'A|1']])))).toContain('- A\\|1 is linked into itself (row 2)');
  });
});

describe('trace formats', () => {
  const r = trace(links, ['MCU-4002', 'MCU-4003', 'LCD-2002', 'NOPE'], units);
  it('csv: one row per affected unit with the traced serials inside', () => {
    expect(parseCsv(traceCsv(r, partOf))).toEqual([
      ['top_level', 'part', 'traced_serials'],
      ['MTR-0002', 'METER-1P', 'MCU-4002 LCD-2002'],
      ['MTR-0003', 'METER-1P', 'MCU-4003 LCD-2002'],
    ]);
    expect(traceCsv(trace(links, ['NOPE']), partOf)).toBe('top_level,part,traced_serials\n');
  });
  it('md: per-serial table, affected table, not found', () => {
    const md = traceMd(r, partOf);
    expect(md).toContain('| MCU-4002 | MCU-A | yes | MTR-0002 | 1 |');
    expect(md).toContain('| NOPE |  | no |  | 0 |');
    expect(md).toContain('| MTR-0003 | METER-1P | MCU-4003, LCD-2002 |');
    expect(md).toContain('Not found (1): NOPE');
    expect(traceMd(trace(links, ['NOPE']), partOf)).toContain('## Affected top-level units (0)\n\n(none)');
  });
});
