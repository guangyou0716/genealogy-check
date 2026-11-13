import { describe, expect, it, vi, afterEach } from 'vitest';
import { main } from '../src/cli.js';
import { check, trace } from '../src/graph.js';
import { parseLinks, parseStamp, timeOrder } from '../src/input.js';
import { checkCsv, checkMd } from '../src/formats.js';
import { textReport } from '../src/report.js';
import { ex } from './helpers.js';

const L = (text: string) => parseLinks(`parent,child,timestamp,action\n${text}`);

describe('parseStamp', () => {
  it('accepts space or T, optional seconds and fraction, Z and offsets', () => {
    expect(parseStamp('2026-11-10 08:01')).toEqual({ ms: Date.UTC(2026, 10, 10, 8, 1), zoned: false });
    expect(parseStamp('2026-11-10T08:01:02.5')?.ms).toBe(Date.UTC(2026, 10, 10, 8, 1, 2, 500));
    expect(parseStamp('2026-11-10T08:00:00Z')).toEqual({ ms: Date.UTC(2026, 10, 10, 8), zoned: true });
    expect(parseStamp('2026-11-10 16:00:00+08:00')?.ms).toBe(Date.UTC(2026, 10, 10, 8));
    expect(parseStamp('2026-11-10 03:00:00-0500')?.ms).toBe(Date.UTC(2026, 10, 10, 8));
  });
  it('rejects dates only, bad dates and junk', () => {
    for (const s of ['2026-11-10', '2026-02-30 10:00', '2026-13-01 10:00', '2026-11-10 24:00', '10/11/2026 08:00', 'x', '2026-11-10 08:00+15:00']) {
      expect(parseStamp(s), s).toBeUndefined();
    }
  });
});

describe('timeOrder', () => {
  it('sorts by time, equal times keep file order', () => {
    const rows = timeOrder(L('A,B,2026-11-10 09:00,\nA,C,2026-11-10 08:00,\nA,D,2026-11-10 08:00,\n'));
    expect(rows.map((r) => r.child)).toEqual(['C', 'D', 'B']);
  });
  it('needs a valid timestamp on every row, one style', () => {
    expect(() => timeOrder(L('A,B,,\n'))).toThrow(/row 2: no timestamp/);
    expect(() => timeOrder(L('A,B,yesterday,\n'))).toThrow(/row 2: timestamp "yesterday" is not a date and time/);
    expect(() => timeOrder(L('A,B,2026-11-10 08:00,\nA,C,2026-11-10 08:00Z,\n'))).toThrow(/row 3: .* has time zone, but row 2 has none/);
  });
});

describe('check --time-order', () => {
  it('reports a component added to a sub-assembly after it was used; earlier is fine', () => {
    const r = check(L('M1,P1,2026-11-10 08:00,\nP1,U1,2026-11-09 08:00,\nM2,P2,2026-11-10 08:00,\nP2,U2,2026-11-10 09:00,\nP2,U3,2026-11-10 08:00,\n'), undefined, undefined, { timeOrder: true });
    expect(r.findings).toEqual([
      {
        type: 'late-component',
        parent: 'P2',
        child: 'U2',
        row: 5,
        timestamp: '2026-11-10 09:00',
        assembly: 'M2',
        assemblyRow: 4,
        assemblyTimestamp: '2026-11-10 08:00',
      },
    ]);
    expect(r.summary.timeOrder).toBe(true);
    expect(textReport(r)).toContain('U2 went into P2 at 2026-11-10 09:00 (row 5), after P2 was built into M2 at 2026-11-10 08:00 (row 4)');
    expect(textReport(r)).toContain('time order: rows replayed by timestamp');
    expect(checkCsv(r)).toContain('late-component,U2,P2,,,,,U2 P2 M2,5 4,');
    expect(checkMd(r)).toContain('Time order: rows replayed by timestamp.');
  });
  it('without the option nothing changes and timestamps may be anything', () => {
    const rows = L('M2,P2,whenever,\nP2,U2,later,\n');
    expect(check(rows).findings).toEqual([]);
    expect(check(rows).summary.timeOrder).toBe(false);
  });
  it('replays rework by time: a remove stamped after its add works even when listed first', () => {
    const rows = L('M,R1,2026-11-10 08:30,remove\nM,R1,2026-11-10 08:00,\nM,R2,2026-11-10 08:31,\n');
    expect(check(rows).counts['remove-without-link']).toBe(1);
    const r = check(rows, undefined, undefined, { timeOrder: true });
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ links: 1, removedLinks: 1 });
    const t = trace(rows, ['R1'], undefined, 50, { timeOrder: true });
    expect(t.traces[0].removedFrom).toEqual([{ parent: 'M', child: 'R1', addedRow: 3, removedRow: 2 }]);
    expect(t.affectedTopLevel).toEqual([]);
  });
  it('a repeated scan uses the first time; equal times are fine', () => {
    const r = check(L('M,P,2026-11-10 08:00,\nP,U,2026-11-10 08:00,\nM,P,2026-11-10 10:00,\nP,U,2026-11-10 11:00,\n'), undefined, undefined, { timeOrder: true });
    expect(r.counts).toEqual({ 'duplicate-link': 2 });
  });
  it('one finding per assembly when a sub-assembly is in two (also a multi-parent finding)', () => {
    const r = check(L('M1,P,2026-11-10 08:00,\nM2,P,2026-11-10 08:05,\nP,U,2026-11-10 09:00,\n'), undefined, undefined, { timeOrder: true });
    expect(r.counts).toEqual({ 'multi-parent': 1, 'late-component': 2 });
  });
});

describe('cli --time-order', () => {
  const out: string[] = [];
  const err: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    out.length = 0;
    err.length = 0;
  });
  const run = (args: string[]) => {
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
    return main(args);
  };
  it('example: one late MCU, rework replayed by time', () => {
    expect(run(['check', ex('time-order-links.csv'), '--time-order', '--json'])).toBe(1);
    const r = JSON.parse(out.join(''));
    expect(r.counts).toEqual({ 'late-component': 1 });
    expect(r.findings[0]).toMatchObject({ parent: 'PCB-1002', child: 'MCU-4002', assembly: 'MTR-0002' });
    expect(r.summary).toMatchObject({ removedLinks: 1, timeOrder: true });
  });
  it('the main example is in time order', () => {
    expect(run(['check', ex('links.csv'), '--time-order', '--json'])).toBe(1);
    expect(JSON.parse(out.join('')).counts['late-component']).toBeUndefined();
  });
  it('--time-column; errors exit 2', () => {
    expect(run(['check', ex('links.csv'), '--time-column', 'timestamp'])).toBe(2);
    expect(err.join('')).toContain('--time-column needs --time-order');
    expect(run(['check', ex('links.csv'), '--time-order', '--time-column', 'when'])).toBe(2);
    expect(err.join('')).toContain('no "when" column');
    expect(run(['trace', ex('links.csv'), 'MCU-4001', '--time-order', '--time-column', 'TIMESTAMP'])).toBe(0);
  });
});
