import { describe, expect, it } from 'vitest';
import { check, cycles, buildGenealogy, trace } from '../src/graph.js';
import { parseBom, parseLinks, parseUnits } from '../src/input.js';

const L = (rows: string) => parseLinks('parent,child\n' + rows);

describe('check', () => {
  it('clean two-level genealogy has no findings and counts levels', () => {
    const r = check(L('M1,P1\nP1,C1\nM2,P2\n'));
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ serials: 5, links: 3, linkRows: 3, topLevel: 2, components: 3, maxLevels: 3 });
  });
  it('double consumption lists every parent and row', () => {
    const r = check(L('M1,X\nM2,X\nM3,X\n'));
    expect(r.findings).toEqual([{ type: 'multi-parent', child: 'X', parents: ['M1', 'M2', 'M3'], rows: [2, 3, 4] }]);
  });
  it('repeated row is a duplicate-link, not double consumption', () => {
    const r = check(L('M1,X\nM1,X\n'));
    expect(r.findings).toEqual([{ type: 'duplicate-link', parent: 'M1', child: 'X', rows: [2, 3] }]);
    expect(r.summary.links).toBe(1);
  });
  it('self-link and cycles', () => {
    const r = check(L('A,A\nA,B\nB,C\nC,A\nD,E\nE,D\n'));
    expect(r.findings).toContainEqual({ type: 'self-link', serial: 'A', rows: [2] });
    expect(r.findings).toContainEqual({ type: 'cycle', serials: ['A', 'B', 'C'] });
    expect(r.findings).toContainEqual({ type: 'cycle', serials: ['D', 'E'] });
    expect(r.counts).toEqual({ 'self-link': 1, cycle: 2 });
  });
  it('finds a cycle at the end of a 50,000-deep chain without overflowing', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => `S${i},S${i + 1}`);
    rows.push('S50000,S25000');
    expect(cycles(buildGenealogy(L(rows.join('\n')))).map((c) => c.length)).toEqual([25_001]);
    const clean = check(L(Array.from({ length: 50_000 }, (_, i) => `S${i},S${i + 1}`).join('\n')));
    expect(clean.summary.maxLevels).toBe(50_001);
  });
  it('unknown serials when a units file is given', () => {
    const r = check(L('M1,P1\n'), parseUnits('serial,part\nM1,MTR\n'));
    expect(r.findings).toEqual([{ type: 'unknown-serial', serial: 'P1' }]);
  });
  it('BOM missing / extra / unexpected, parts without BOM not checked', () => {
    const units = parseUnits('serial,part\nM1,MTR\nM2,MTR\nM3,MTR\nP1,PCB\nP2,PCB\nP3,PCB\nS1,SCREW\nS2,SCREW\nS3,SCREW\nL1,LABEL\n');
    const bom = parseBom('parent_part,child_part,qty\nMTR,PCB,1\nMTR,SCREW,2\n');
    const r = check(L('M1,P1\nM1,S1\nM1,S2\nM2,P2\nM2,P3\nM2,S3\nM3,L1\n'), units, bom);
    expect(r.summary.bomChecked).toBe(3);
    expect(r.findings).toEqual([
      { type: 'bom-extra', parent: 'M2', parentPart: 'MTR', childPart: 'PCB', expected: 1, actual: 2, children: ['P2', 'P3'] },
      { type: 'bom-missing', parent: 'M2', parentPart: 'MTR', childPart: 'SCREW', expected: 2, actual: 1, children: ['S3'] },
      { type: 'bom-missing', parent: 'M3', parentPart: 'MTR', childPart: 'PCB', expected: 1, actual: 0, children: [] },
      { type: 'bom-missing', parent: 'M3', parentPart: 'MTR', childPart: 'SCREW', expected: 2, actual: 0, children: [] },
      { type: 'bom-unexpected', parent: 'M3', parentPart: 'MTR', childPart: 'LABEL', children: ['L1'] },
    ]);
  });
  it('BOM ignores components of unknown part (reported once as unknown-serial)', () => {
    const r = check(L('M1,P1\nM1,Q\n'), parseUnits('serial,part\nM1,MTR\nP1,PCB\n'), parseBom('parent_part,child_part,qty\nMTR,PCB,1\n'));
    expect(r.findings).toEqual([{ type: 'unknown-serial', serial: 'Q' }]);
  });
});

describe('trace', () => {
  const links = L('M1,P1\nP1,C1\nM2,P2\nP2,C2\nM3,C2\n');
  it('routes up, tree down, affected top-level units', () => {
    const r = trace(links, ['C1', 'C2', 'M1']);
    expect(r.traces[0]).toMatchObject({ serial: 'C1', found: true, paths: [['P1', 'M1']], topLevel: ['M1'] });
    expect(r.traces[1].paths).toEqual([['P2', 'M2'], ['M3']]);
    expect(r.traces[1].topLevel).toEqual(['M2', 'M3']);
    expect(r.traces[2].tree).toEqual({ serial: 'M1', children: [{ serial: 'P1', children: [{ serial: 'C1', children: [] }] }] });
    expect(r.traces[2].topLevel).toEqual(['M1']);
    expect(r.affectedTopLevel).toEqual(['M1', 'M2', 'M3']);
    expect(r.notFound).toEqual([]);
  });
  it('not found, part labels, depth limit, cycles stop', () => {
    const units = parseUnits('serial,part\nM1,MTR\n');
    const r = trace(links, ['ZZ', 'M1'], units, 1);
    expect(r.notFound).toEqual(['ZZ']);
    expect(r.traces[0].found).toBe(false);
    expect(r.traces[1].tree).toEqual({ serial: 'M1', part: 'MTR', children: [{ serial: 'P1', stop: 'depth', children: [] }] });
    const c = trace(L('A,B\nB,A\n'), ['A']);
    expect(c.traces[0].tree).toEqual({ serial: 'A', children: [{ serial: 'B', children: [{ serial: 'A', stop: 'cycle', children: [] }] }] });
    expect(c.traces[0].topLevel).toEqual([]);
  });
  it('caps routes at 100 when double consumption multiplies them', () => {
    // 8 levels, each serial built into 2 parents -> 256 routes.
    const rows: string[] = [];
    for (let lv = 0; lv < 8; lv++) rows.push(`L${lv + 1}a,L${lv}`, `L${lv + 1}b,L${lv}`, `L${lv + 1},L${lv + 1}a`, `L${lv + 1},L${lv + 1}b`);
    const r = trace(L(rows.join('\n')), ['L0']);
    expect(r.traces[0].paths).toHaveLength(100);
    expect(r.traces[0].pathsTruncated).toBe(true);
    expect(r.traces[0].topLevel).toEqual(['L8']);
  });
});
