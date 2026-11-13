import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { parseBom, parseLinks, parseUnits } from '../src/input.js';

describe('parseLinks', () => {
  it('reads parent/child with optional timestamp and station, trims, row numbers', () => {
    const links = parseLinks('\uFEFFParent, Child ,Station\r\n A1 ,B1,SMT\r\n\r\nA1,B2,\r\n');
    expect(links).toEqual([
      { parent: 'A1', child: 'B1', row: 2, station: 'SMT' },
      { parent: 'A1', child: 'B2', row: 3 },
    ]);
  });
  it('custom columns', () => {
    expect(parseLinks('asm_sn,comp_sn\nA,B\n', { parentColumn: 'asm_sn', childColumn: 'comp_sn' })).toEqual([
      { parent: 'A', child: 'B', row: 2 },
    ]);
  });
  it('rejects missing columns, empty serials, empty files', () => {
    expect(() => parseLinks('parent,kid\nA,B\n')).toThrow(/no "child" column/);
    expect(() => parseLinks('parent,child\nA,\n')).toThrow(/row 2: child serial is empty/);
    expect(() => parseLinks('parent,child\n')).toThrow(/no data rows/);
    expect(() => parseLinks('')).toThrow(InputError);
    expect(() => parseLinks('parent,child\nA,B\n', { stationColumn: 'line' })).toThrow(/no "line" column/);
  });
});

describe('parseUnits', () => {
  it('reads serial/part, ignores an identical repeat', () => {
    expect(parseUnits('serial,part\nA,P1\nA,P1\nB,P2\n')).toEqual([
      { serial: 'A', part: 'P1', row: 2 },
      { serial: 'B', part: 'P2', row: 4 },
    ]);
  });
  it('rejects a serial with two parts and empty cells', () => {
    expect(() => parseUnits('serial,part\nA,P1\nA,P2\n')).toThrow(/A has two parts: P1 \(row 2\) and P2 \(row 3\)/);
    expect(() => parseUnits('serial,part\nA,\n')).toThrow(/part is empty/);
  });
});

describe('parseBom', () => {
  it('reads lines', () => {
    expect(parseBom('parent_part,child_part,qty\nM,P,2\n')).toEqual([{ parentPart: 'M', childPart: 'P', qty: 2, row: 2 }]);
  });
  it('rejects bad qty and repeated lines', () => {
    expect(() => parseBom('parent_part,child_part,qty\nM,P,0\n')).toThrow(/qty "0"/);
    expect(() => parseBom('parent_part,child_part,qty\nM,P,1.5\n')).toThrow(/qty "1.5"/);
    expect(() => parseBom('parent_part,child_part,qty\nM,P,1\nM,P,2\n')).toThrow(/listed twice \(rows 2 and 3\)/);
  });
});
