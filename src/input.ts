import { parseCsv } from './csv.js';
import { InputError } from './errors.js';

/** One assembly link: `child` was built into `parent`. `row` is the CSV record number (header = 1). */
export interface Link {
  parent: string;
  child: string;
  row: number;
  timestamp?: string;
  station?: string;
  /** Set only for a rework row that takes `child` out of `parent` again (action column = remove). */
  action?: 'remove';
  /** `timestamp` as milliseconds, set by `timeOrder` (zone-less stamps are compared as they are, like UTC). */
  time?: number;
}

/** A link that a later remove row took out again (rework / component replacement). */
export interface RemovedLink {
  parent: string;
  child: string;
  /** Row that built it in. */
  addedRow: number;
  /** Row that took it out. */
  removedRow: number;
}

/** Result of replaying add / remove rows in file order. */
export interface Rework {
  /** Links still in place after every remove row (file order). */
  links: Link[];
  removed: RemovedLink[];
  /** Remove rows with no earlier, still-present add row for the same parent and child. */
  orphanRemoves: Link[];
  removeRows: number;
}

export interface Unit {
  serial: string;
  part: string;
  row: number;
}

export interface BomLine {
  parentPart: string;
  childPart: string;
  qty: number;
  row: number;
}

export interface LinkColumns {
  parentColumn?: string;
  childColumn?: string;
  timeColumn?: string;
  stationColumn?: string;
  actionColumn?: string;
}

const ADD_WORDS = new Set(['', 'add']);
const REMOVE_WORDS = new Set(['remove']);

interface Table {
  header: string[];
  rows: { cells: string[]; row: number }[];
  index: (name: string, required: boolean, what: string) => number;
}

function table(text: string, what: string): Table {
  const records = parseCsv(text);
  if (records.length === 0) {
    throw new InputError(`${what}: the file is empty.`);
  }
  const header = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((cells, i) => ({ cells: cells.map((c) => c.trim()), row: i + 2 }));
  const index = (name: string, required: boolean, label: string) => {
    const i = header.indexOf(name.trim().toLowerCase());
    if (i < 0 && required) {
      throw new InputError(`${what}: no "${name}" column (${label}). Header: ${records[0].join(',')}`);
    }
    return i;
  };
  return { header, rows, index };
}

function cell(cells: string[], i: number): string {
  return i < 0 ? '' : (cells[i] ?? '');
}

export function parseLinks(text: string, columns: LinkColumns = {}): Link[] {
  const t = table(text, 'links');
  const p = t.index(columns.parentColumn ?? 'parent', true, 'parent serial');
  const c = t.index(columns.childColumn ?? 'child', true, 'child serial');
  const ts = t.index(columns.timeColumn ?? 'timestamp', columns.timeColumn !== undefined, 'timestamp');
  const st = t.index(columns.stationColumn ?? 'station', columns.stationColumn !== undefined, 'station');
  const ac = t.index(columns.actionColumn ?? 'action', columns.actionColumn !== undefined, 'add / remove');
  const links: Link[] = [];
  for (const { cells, row } of t.rows) {
    const parent = cell(cells, p);
    const child = cell(cells, c);
    if (!parent || !child) {
      throw new InputError(`links row ${row}: ${!parent ? 'parent' : 'child'} serial is empty.`);
    }
    const link: Link = { parent, child, row };
    const timestamp = cell(cells, ts);
    const station = cell(cells, st);
    if (timestamp) link.timestamp = timestamp;
    if (station) link.station = station;
    const action = cell(cells, ac).toLowerCase();
    if (REMOVE_WORDS.has(action)) link.action = 'remove';
    else if (!ADD_WORDS.has(action)) {
      throw new InputError(`links row ${row}: action "${cell(cells, ac)}" is not add or remove (empty means add).`);
    }
    links.push(link);
  }
  if (links.length === 0) {
    throw new InputError('links: no data rows.');
  }
  return links;
}

/**
 * Replays rework history in file order: a remove row takes out the latest still-present add row with the same parent
 * and child, so "remove old, add new" leaves only the replacement. Links without remove rows come back unchanged.
 */
export function applyRework(rows: Link[]): Rework {
  const active = new Map<string, Link[]>();
  const removedAdds = new Set<Link>();
  const removed: RemovedLink[] = [];
  const orphanRemoves: Link[] = [];
  let removeRows = 0;
  for (const l of rows) {
    const k = `${l.parent}\u0000${l.child}`;
    if (l.action !== 'remove') {
      const list = active.get(k);
      if (list) list.push(l);
      else active.set(k, [l]);
      continue;
    }
    removeRows++;
    const add = active.get(k)?.pop();
    if (!add) {
      orphanRemoves.push(l);
      continue;
    }
    removedAdds.add(add);
    removed.push({ parent: l.parent, child: l.child, addedRow: add.row, removedRow: l.row });
  }
  const links = rows.filter((l) => l.action !== 'remove' && !removedAdds.has(l));
  return { links, removed, orphanRemoves, removeRows };
}

export function parseUnits(text: string, columns: { serialColumn?: string; partColumn?: string } = {}): Unit[] {
  const t = table(text, 'units');
  const s = t.index(columns.serialColumn ?? 'serial', true, 'serial');
  const p = t.index(columns.partColumn ?? 'part', true, 'part number');
  const seen = new Map<string, Unit>();
  const units: Unit[] = [];
  for (const { cells, row } of t.rows) {
    const serial = cell(cells, s);
    const part = cell(cells, p);
    if (!serial || !part) {
      throw new InputError(`units row ${row}: ${!serial ? 'serial' : 'part'} is empty.`);
    }
    const prev = seen.get(serial);
    if (prev) {
      if (prev.part !== part) {
        throw new InputError(`units: serial ${serial} has two parts: ${prev.part} (row ${prev.row}) and ${part} (row ${row}).`);
      }
      continue;
    }
    const unit = { serial, part, row };
    seen.set(serial, unit);
    units.push(unit);
  }
  return units;
}

export function parseBom(text: string): BomLine[] {
  const t = table(text, 'bom');
  const pp = t.index('parent_part', true, 'assembly part number');
  const cp = t.index('child_part', true, 'component part number');
  const q = t.index('qty', true, 'components per assembly');
  const seen = new Map<string, number>();
  const lines: BomLine[] = [];
  for (const { cells, row } of t.rows) {
    const parentPart = cell(cells, pp);
    const childPart = cell(cells, cp);
    const qtyText = cell(cells, q);
    if (!parentPart || !childPart) {
      throw new InputError(`bom row ${row}: ${!parentPart ? 'parent_part' : 'child_part'} is empty.`);
    }
    if (!/^\d+$/.test(qtyText) || Number(qtyText) < 1) {
      throw new InputError(`bom row ${row}: qty "${qtyText}" is not a whole number of 1 or more.`);
    }
    const key = `${parentPart}\u0000${childPart}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new InputError(`bom: ${parentPart} -> ${childPart} is listed twice (rows ${prev} and ${row}).`);
    }
    seen.set(key, row);
    lines.push({ parentPart, childPart, qty: Number(qtyText), row });
  }
  return lines;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/i;

/**
 * Parses an ISO-like timestamp `YYYY-MM-DD HH:MM[:SS[.fff]]` (T or space, optional Z / +08:00 / +0800).
 * Returns milliseconds and whether a zone was given, or undefined when it is not a valid date and time.
 */
export function parseStamp(text: string): { ms: number; zoned: boolean } | undefined {
  const m = STAMP.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return undefined;
  const base = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (new Date(base).getUTCDate() !== d) return undefined; // e.g. 2026-02-30
  let ms = base + Math.floor(frac);
  const zone = m[8];
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    const off = Number(z[2]) * 60 + Number(z[3]);
    if (Number(z[2]) > 14 || Number(z[3]) > 59) return undefined;
    ms -= (z[1] === '-' ? -1 : 1) * off * 60_000;
  }
  return { ms, zoned: zone !== undefined };
}

/**
 * For --time-order: every row needs a valid timestamp (all with a zone or all without, so they compare). Returns the
 * rows with `time` set, stably sorted by time (equal times keep file order), ready for `applyRework`.
 */
export function timeOrder(rows: Link[]): Link[] {
  let zoned: boolean | undefined;
  let firstRow = 0;
  const out = rows.map((l) => {
    if (!l.timestamp) throw new InputError(`links row ${l.row}: no timestamp (--time-order needs one on every row).`);
    const t = parseStamp(l.timestamp);
    if (!t) {
      throw new InputError(`links row ${l.row}: timestamp "${l.timestamp}" is not a date and time like 2026-11-10 08:01:00 (optional seconds, T, Z or +08:00).`);
    }
    if (zoned === undefined) {
      zoned = t.zoned;
      firstRow = l.row;
    } else if (zoned !== t.zoned) {
      throw new InputError(`links row ${l.row}: timestamp "${l.timestamp}" ${t.zoned ? 'has' : 'has no'} time zone, but row ${firstRow} ${zoned ? 'has one' : 'has none'}; use one style.`);
    }
    return { ...l, time: t.ms };
  });
  return out.map((l, i) => ({ l, i })).sort((a, b) => a.l.time! - b.l.time! || a.i - b.i).map((x) => x.l);
}
