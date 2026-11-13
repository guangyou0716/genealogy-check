import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { check, trace } from '../src/graph.js';
import { applyRework, parseLinks } from '../src/input.js';
import { checkCsv, checkMd, traceMd } from '../src/formats.js';
import { ex } from './helpers.js';

const L = (text: string) => parseLinks(`parent,child,action\n${text}`);

describe('parseLinks action column', () => {
  it('add / empty / remove, any case; no action column means plain adds', () => {
    expect(L('A,B,\nA,C,ADD\nA,B,Remove\n')).toEqual([
      { parent: 'A', child: 'B', row: 2 },
      { parent: 'A', child: 'C', row: 3 },
      { parent: 'A', child: 'B', row: 4, action: 'remove' },
    ]);
    expect(parseLinks('parent,child\nA,B\n')).toEqual([{ parent: 'A', child: 'B', row: 2 }]);
  });
  it('rejects other words and a missing named column', () => {
    expect(() => L('A,B,replace\n')).toThrow(/row 2: action "replace" is not add or remove/);
    expect(() => parseLinks('parent,child\nA,B\n', { actionColumn: 'op' })).toThrow(/no "op" column/);
    expect(parseLinks('parent,child,op\nA,B,remove\n', { actionColumn: 'op' })[0].action).toBe('remove');
  });
});

describe('applyRework', () => {
  it('remove takes out the latest add of the same pair; replacement keeps only the new part', () => {
    const r = applyRework(L('M,P1,\nM,P1,\nM,P1,remove\nM,P2,\nX,P1,remove\nM,P1,remove\nM,P1,remove\n'));
    expect(r.links.map((l) => `${l.parent}>${l.child}@${l.row}`)).toEqual(['M>P2@5']);
    expect(r.removed).toEqual([
      { parent: 'M', child: 'P1', addedRow: 3, removedRow: 4 },
      { parent: 'M', child: 'P1', addedRow: 2, removedRow: 7 },
    ]);
    expect(r.orphanRemoves.map((l) => l.row)).toEqual([6, 8]);
    expect(r.removeRows).toBe(4);
  });
  it('remove then add again restores the link with the new row', () => {
    const r = applyRework(L('M,P,\nM,P,remove\nM,P,\n'));
    expect(r.links.map((l) => l.row)).toEqual([4]);
  });
});

describe('check with rework', () => {
  it('a part moved to another assembly is not double consumption', () => {
    const plain = check(parseLinks('parent,child\nM1,C\nM2,C\n'));
    expect(plain.counts['multi-parent']).toBe(1);
    const moved = check(L('M1,C,\nM1,C,remove\nM2,C,\n'));
    expect(moved.findings).toEqual([]);
    expect(moved.summary).toMatchObject({ links: 1, linkRows: 3, removeRows: 1, removedLinks: 1, topLevel: 1 });
  });
  it('remove with nothing to remove is a finding (also after the add was already removed)', () => {
    const r = check(L('M,C,\nM,C,remove\nM,C,remove\n'));
    expect(r.findings).toEqual([{ type: 'remove-without-link', parent: 'M', child: 'C', row: 4 }]);
    expect(checkCsv(r)).toContain('remove-without-link,C,M,,,,,C,4,');
    expect(checkMd(r)).toContain('Rework: 2 remove rows took out 1 links');
  });
  it('BOM counts only parts still in place; serials only in removed rows are still checked against units', () => {
    const units = [
      { serial: 'M', part: 'MTR', row: 2 },
      { serial: 'C1', part: 'LCD', row: 3 },
    ];
    const bom = [{ parentPart: 'MTR', childPart: 'LCD', qty: 1, row: 2 }];
    const r = check(L('M,C1,\nM,C0,\nM,C0,remove\n'), units, bom);
    expect(r.findings).toEqual([{ type: 'unknown-serial', serial: 'C0' }]);
  });
});

describe('trace with rework', () => {
  const rows = () => parseLinks(readFileSync(ex('rework-links.csv'), 'utf8'));
  it('removed-only serial is found, sits in no unit, lists where it was removed from', () => {
    const r = trace(rows(), ['MCU-4002', 'LCD-2002', 'NOPE']);
    expect(r.traces[0]).toMatchObject({ found: true, topLevel: [], paths: [], removedFrom: [{ parent: 'PCB-1002', addedRow: 6, removedRow: 13 }] });
    expect(r.traces[1]).toMatchObject({ topLevel: ['MTR-0003'], removedFrom: [{ parent: 'MTR-0002', addedRow: 8, removedRow: 15 }] });
    expect(r.affectedTopLevel).toEqual(['MTR-0003']);
    expect(r.notFound).toEqual(['NOPE']);
    expect(traceMd(r, () => undefined)).toContain('| MCU-4002 |  | yes |  | 0 | PCB-1002 |');
  });
  it('replacement part is traced to its unit', () => {
    expect(trace(rows(), ['MCU-4006']).affectedTopLevel).toEqual(['MTR-0002']);
  });
});

describe('cli with rework example', () => {
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
  it('check: only the stray remove row, exit 1', () => {
    const r = run(['check', ex('rework-links.csv'), '--units', ex('rework-units.csv'), '--bom', ex('bom.csv')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('rework: 3 remove rows took out 2 links (not counted above)');
    expect(r.out).toContain('row 18 removes RLY-3009 from MTR-0003, but no earlier row built it in');
    expect(r.out).toContain('Findings: 1');
  });
  it('trace text shows removed from; --action-column errors exit 2', () => {
    const r = run(['trace', ex('rework-links.csv'), 'LCD-2002']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed from (rework):\n    MTR-0002 (built in row 8, removed row 15)');
    expect(run(['check', ex('links.csv'), '--action-column', 'op']).code).toBe(2);
  });
});
