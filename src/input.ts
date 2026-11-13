import { parseCsv } from './csv.js';
import { InputError } from './errors.js';

/** One assembly link: `child` was built into `parent`. `row` is the CSV record number (header = 1). */
export interface Link {
  parent: string;
  child: string;
  row: number;
  timestamp?: string;
  station?: string;
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
}

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
    links.push(link);
  }
  if (links.length === 0) {
    throw new InputError('links: no data rows.');
  }
  return links;
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
