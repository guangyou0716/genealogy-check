import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { check, lotsOf, trace } from '../src/graph.js';
import { parseLinks } from '../src/input.js';
import { traceCsv, traceMd } from '../src/formats.js';
import { textReport, traceText } from '../src/report.js';
import { ex } from './helpers.js';

const L = (text: string) => parseLinks(`parent,child,lot,action\n${text}`);

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

describe('parseLinks lot column', () => {
  it('reads the lot; a row with a lot and no child is lot-only', () => {
    expect(L('A,B,R1,\nA,,C9,\n')).toEqual([
      { parent: 'A', child: 'B', row: 2, lot: 'R1' },
      { parent: 'A', child: '', row: 3, lot: 'C9', lotOnly: true },
    ]);
  });
  it('still needs a child or a lot, and a parent', () => {
    expect(() => L('A,,,\n')).toThrow(/row 2: child serial is empty and so is the lot/);
    expect(() => L(',B,R1,\n')).toThrow(/row 2: parent serial is empty/);
    expect(() => parseLinks('parent,child\nA,\n')).toThrow(/row 2: child serial is empty\.$/);
  });
  it('lot-only rows cannot be removed', () => {
    expect(() => L('A,,C9,remove\n')).toThrow(/row 2: a remove row needs a child serial/);
  });
  it('--lot-column renames, and a named column must exist', () => {
    expect(parseLinks('parent,child,batch\nA,,X\n', { lotColumn: 'batch' })[0]).toMatchObject({ lot: 'X', lotOnly: true });
    expect(() => parseLinks('parent,child\nA,B\n', { lotColumn: 'batch' })).toThrow(/no "batch" column/);
  });
});

describe('check with lots', () => {
  it('lot-only rows stay out of the serial checks; a lot shared by many assemblies is not double consumption', () => {
    const r = check(parseLinks(`parent,child,lot\nM1,P1,\nM2,P2,\nP1,,CAP\nP2,,CAP\nP1,U1,R1\n`));
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ serials: 5, links: 3, linkRows: 3, lotRows: 3, lotOnlyRows: 2 });
    expect(textReport(r)).toContain('lots: 3 rows with a lot, 2 of them without a child serial');
  });
  it('without a lot column the summary counts are 0 and the text has no lots line', () => {
    const r = check(parseLinks('parent,child\nA,B\n'));
    expect(r.summary).toMatchObject({ lotRows: 0, lotOnlyRows: 0 });
    expect(textReport(r)).not.toContain('lots:');
  });
});

describe('trace by lot', () => {
  const rows = parseLinks(
    'parent,child,lot,action\nM1,P1,,\nM2,P2,,\nM3,P3,,\nP1,U1,R1,\nP2,U2,R1,\nP3,U3,R2,\nP1,,CAP,\nP3,,CAP,\nM4,,CASE,\nP2,U2,,remove\nP2,U9,,\n',
  );
  it('resolves a lot to serials carrying it and assemblies lot-only rows put it in', () => {
    expect(lotsOf(rows, ['R1', 'CAP', 'NOPE'])).toEqual([
      { lot: 'R1', serials: ['U1', 'U2'], usedIn: [] },
      { lot: 'CAP', serials: [], usedIn: ['P1', 'P3'] },
      { lot: 'NOPE', serials: [], usedIn: [] },
    ]);
  });
  it('affected units come from the lot serials (removed ones are not affected) and lot-only assemblies', () => {
    const r = trace(rows, [], undefined, 50, { lots: ['R1', 'CAP'] });
    expect(r.traces.map((t) => t.serial)).toEqual(['U1', 'U2', 'P1', 'P3']);
    expect(r.affectedTopLevel).toEqual(['M1', 'M3']);
    expect(r.traces[1].removedFrom).toMatchObject([{ parent: 'P2', child: 'U2' }]);
    expect(r.notFound).toEqual([]);
    expect(r.lotsNotFound).toEqual([]);
  });
  it('an assembly only seen in lot-only rows is found and is its own top-level unit', () => {
    const r = trace(rows, [], undefined, 50, { lots: ['CASE'] });
    expect(r.traces[0]).toMatchObject({ serial: 'M4', found: true, topLevel: ['M4'] });
    expect(r.affectedTopLevel).toEqual(['M4']);
  });
  it('serials and lots together, each traced once; unknown lot reported', () => {
    const r = trace(rows, ['U1', 'U3'], undefined, 50, { lots: ['R1', 'R1', 'ZZ'] });
    expect(r.traces.map((t) => t.serial)).toEqual(['U1', 'U3', 'U2']);
    expect(r.lots.map((l) => l.lot)).toEqual(['R1', 'ZZ']);
    expect(r.lotsNotFound).toEqual(['ZZ']);
    expect(traceText(r)).toContain('Lots not found (1): ZZ');
    expect(traceText(r)).toContain('  R1: serials U1, U2');
    expect(traceText(r)).toContain('  ZZ: not found');
  });
  it('no lots asked: empty arrays, no Lots section', () => {
    const r = trace(rows, ['U1'], undefined);
    expect(r.lots).toEqual([]);
    expect(r.lotsNotFound).toEqual([]);
    expect(traceText(r)).not.toContain('Lots');
    expect(traceMd(r, () => undefined)).not.toContain('## Lots');
  });
  it('markdown and csv', () => {
    const r = trace(rows, [], undefined, 50, { lots: ['CAP'] });
    expect(traceMd(r, () => undefined)).toContain('| CAP |  | P1, P3 |');
    expect(traceCsv(r, () => undefined)).toBe('top_level,part,traced_serials\nM1,,P1\nM3,,P3\n');
  });
});

describe('cli trace --lot', () => {
  it('example: a reel and a capacitor lot', () => {
    const r = run(['trace', ex('lot-links.csv'), '--lot', 'REEL-A17', '--lot', 'CAP-LOT-0915']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('REEL-A17: serials MCU-6101, MCU-6102');
    expect(r.out).toContain('CAP-LOT-0915: lot-only rows in PCB-5101, PCB-5103');
    expect(r.out).toContain('Affected top-level units (3): MTR-0101, MTR-0102, MTR-0103');
  });
  it('--lots file, --csv recall list', () => {
    const r = run(['trace', ex('lot-links.csv'), '--lots', ex('recall-lots.txt'), '--csv']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('top_level,part,traced_serials\nMTR-0102,,PCB-5102\nMTR-0104,,MTR-0104\n');
  });
  it('unknown lot exits 1; lot flags are trace only; need a serial or a lot', () => {
    expect(run(['trace', ex('lot-links.csv'), '--lot', 'NOPE']).code).toBe(1);
    const c = run(['check', ex('lot-links.csv'), '--lot', 'X']);
    expect(c.code).toBe(2);
    expect(c.err).toContain('--lot / --lots are for trace');
    const t = run(['trace', ex('lot-links.csv')]);
    expect(t.code).toBe(2);
    expect(t.err).toContain('or lot (--lot or --lots)');
    expect(run(['trace', ex('lot-links.csv'), '--lot', ' ']).err).toContain('--lot is empty');
  });
  it('check on the example: no findings, lot rows counted', () => {
    const r = run(['check', ex('lot-links.csv'), '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).summary).toMatchObject({ lotRows: 7, lotOnlyRows: 4, linkRows: 6 });
  });
});
