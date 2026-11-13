import type { CheckReport, Finding, TraceReport } from './graph.js';
import { describe, ORDER, TITLE } from './report.js';

/** One CSV cell: quoted when needed; cells starting with = + @ tab or CR get a leading ' so spreadsheets do not run them as formulas. */
export function csvCell(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: (string | number | undefined)[]) => cells.map(csvCell).join(',');

/** Markdown table cell: pipes escaped, line breaks flattened. */
const mdCell = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');

const CHECK_HEADER = ['type', 'serial', 'parent', 'parent_part', 'child_part', 'expected', 'actual', 'serials', 'rows', 'detail'];

function findingCells(f: Finding): (string | number | undefined)[] {
  const d = describe(f);
  switch (f.type) {
    case 'self-link':
      return [f.type, f.serial, undefined, undefined, undefined, undefined, undefined, f.serial, f.rows.join(' '), d];
    case 'duplicate-link':
      return [f.type, f.child, f.parent, undefined, undefined, undefined, undefined, f.child, f.rows.join(' '), d];
    case 'multi-parent':
      return [f.type, f.child, f.parents.join(' '), undefined, undefined, undefined, f.parents.length, f.child, f.rows.join(' '), d];
    case 'cycle':
      return [f.type, undefined, undefined, undefined, undefined, undefined, f.serials.length, f.serials.join(' '), undefined, d];
    case 'unknown-serial':
      return [f.type, f.serial, undefined, undefined, undefined, undefined, undefined, f.serial, undefined, d];
    case 'bom-missing':
    case 'bom-extra':
      return [f.type, undefined, f.parent, f.parentPart, f.childPart, f.expected, f.actual, f.children.join(' '), undefined, d];
    case 'bom-unexpected':
      return [f.type, undefined, f.parent, f.parentPart, f.childPart, 0, f.children.length, f.children.join(' '), undefined, d];
  }
}

/**
 * check findings as CSV, one row per finding (all of them, no --limit), in the text report's order. Lists inside a
 * cell are space separated; `serials` is what to look at (the component, the cycle, the BOM children).
 */
export function checkCsv(r: CheckReport): string {
  const sorted = [...r.findings].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return [csvLine(CHECK_HEADER), ...sorted.map((f) => csvLine(findingCells(f)))].join('\n') + '\n';
}

/** Affected top-level units, each with the traced serials that end up in it. */
function affected(r: TraceReport): { unit: string; via: string[] }[] {
  const via = new Map<string, string[]>();
  for (const t of r.traces) {
    if (!t.found) continue;
    for (const u of t.topLevel) {
      const list = via.get(u);
      if (list) list.push(t.serial);
      else via.set(u, [t.serial]);
    }
  }
  return r.affectedTopLevel.map((unit) => ({ unit, via: via.get(unit) ?? [] }));
}

/** trace as CSV: one row per affected top-level unit with the traced serials it contains (e.g. a recall list). */
export function traceCsv(r: TraceReport, partOf: (serial: string) => string | undefined): string {
  const lines = [csvLine(['top_level', 'part', 'traced_serials'])];
  for (const a of affected(r)) lines.push(csvLine([a.unit, partOf(a.unit), a.via.join(' ')]));
  return lines.join('\n') + '\n';
}

export function checkMd(r: CheckReport, limit = 50): string {
  const s = r.summary;
  const out = [
    '# Genealogy check',
    '',
    '| serials | links | link rows | top-level units | components | deepest chain |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.serials} | ${s.links} | ${s.linkRows} | ${s.topLevel} | ${s.components} | ${s.maxLevels} |`,
  ];
  if (s.unitsGiven) out.push('', `Units file: ${s.unitsGiven} serials${s.bomLines ? `; BOM: ${s.bomLines} lines, ${s.bomChecked} assemblies checked` : ''}.`);
  if (!r.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `## Findings: ${r.findings.length}`, '', '| kind | count |', '| --- | ---: |');
  for (const type of ORDER) {
    const n = r.findings.filter((f) => f.type === type).length;
    if (n) out.push(`| ${TITLE[type]} | ${n} |`);
  }
  for (const type of ORDER) {
    const fs = r.findings.filter((f) => f.type === type);
    if (!fs.length) continue;
    out.push('', `### ${TITLE[type]} (${fs.length})`, '');
    for (const f of fs.slice(0, limit)) out.push(`- ${mdCell(describe(f))}`);
    if (fs.length > limit) out.push(`- ... ${fs.length - limit} more (use --json or --csv for all)`);
  }
  return out.join('\n') + '\n';
}

export function traceMd(r: TraceReport, partOf: (serial: string) => string | undefined): string {
  const out = ['# Genealogy trace', '', '| serial | part | found | top-level units | routes up |', '| --- | --- | --- | --- | ---: |'];
  for (const t of r.traces) {
    out.push(
      `| ${mdCell(t.serial)} | ${mdCell(t.part ?? '')} | ${t.found ? 'yes' : 'no'} | ${mdCell(t.topLevel.join(', '))} | ${t.paths.length}${t.pathsTruncated ? '+' : ''} |`,
    );
  }
  const a = affected(r);
  out.push('', `## Affected top-level units (${a.length})`, '');
  if (a.length) {
    out.push('| top-level unit | part | traced serials inside |', '| --- | --- | --- |');
    for (const x of a) out.push(`| ${mdCell(x.unit)} | ${mdCell(partOf(x.unit) ?? '')} | ${mdCell(x.via.join(', '))} |`);
  } else out.push('(none)');
  if (r.notFound.length) out.push('', `Not found (${r.notFound.length}): ${mdCell(r.notFound.join(', '))}`);
  return out.join('\n') + '\n';
}
