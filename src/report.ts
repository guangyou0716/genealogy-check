import type { CheckReport, Finding, TraceReport, TreeNode } from './graph.js';

const rows = (r: number[]) => (r.length === 1 ? `row ${r[0]}` : `rows ${r.join(', ')}`);
const list = (xs: string[]) => (xs.length ? xs.join(', ') : '(none)');

export function describe(f: Finding): string {
  switch (f.type) {
    case 'self-link':
      return `${f.serial} is linked into itself (${rows(f.rows)})`;
    case 'duplicate-link':
      return `${f.child} into ${f.parent} is recorded ${f.rows.length} times (${rows(f.rows)})`;
    case 'multi-parent':
      return `${f.child} is built into ${f.parents.length} assemblies: ${f.parents.join(', ')} (${rows(f.rows)})`;
    case 'cycle':
      return `cycle: ${f.serials.join(', ')} contain each other`;
    case 'unknown-serial':
      return `${f.serial} is not in the units file`;
    case 'remove-without-link':
      return `row ${f.row} removes ${f.child} from ${f.parent}, but no earlier row built it in (or it was already removed)`;
    case 'bom-missing':
    case 'bom-extra':
      return `${f.parent} (${f.parentPart}) has ${f.actual} x ${f.childPart}, BOM says ${f.expected}${f.children.length ? `: ${f.children.join(', ')}` : ''}`;
    case 'bom-unexpected':
      return `${f.parent} (${f.parentPart}) has ${f.children.length} x ${f.childPart}, not in its BOM: ${f.children.join(', ')}`;
  }
}

export const ORDER: Finding['type'][] = [
  'multi-parent',
  'cycle',
  'self-link',
  'bom-missing',
  'bom-extra',
  'bom-unexpected',
  'unknown-serial',
  'remove-without-link',
  'duplicate-link',
];

export const TITLE: Record<Finding['type'], string> = {
  'multi-parent': 'Built into more than one assembly (double consumption)',
  cycle: 'Cycles',
  'self-link': 'Linked into itself',
  'bom-missing': 'Fewer components than the BOM',
  'bom-extra': 'More components than the BOM',
  'bom-unexpected': 'Components not in the BOM',
  'unknown-serial': 'Serials not in the units file',
  'remove-without-link': 'Remove rows with nothing to remove',
  'duplicate-link': 'Same link recorded more than once',
};

export function textReport(r: CheckReport, limit = 50): string {
  const s = r.summary;
  const out = [
    'Genealogy check',
    `  serials ${s.serials}, links ${s.links} (${s.linkRows} rows), top-level units ${s.topLevel}, components ${s.components}, deepest chain ${s.maxLevels} levels`,
  ];
  if (s.removeRows) out.push(`  rework: ${s.removeRows} remove rows took out ${s.removedLinks} links (not counted above)`);
  if (s.unitsGiven) out.push(`  units file: ${s.unitsGiven} serials${s.bomLines ? `; BOM: ${s.bomLines} lines, ${s.bomChecked} assemblies checked` : ''}`);
  if (!r.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `Findings: ${r.findings.length}`);
  for (const type of ORDER) {
    const fs = r.findings.filter((f) => f.type === type);
    if (!fs.length) continue;
    out.push('', `${TITLE[type]} (${fs.length})`);
    for (const f of fs.slice(0, limit)) out.push(`  - ${describe(f)}`);
    if (fs.length > limit) out.push(`  ... ${fs.length - limit} more (use --json for all)`);
  }
  return out.join('\n') + '\n';
}

function treeLines(node: TreeNode, prefix: string, last: boolean, top: boolean, out: string[]): void {
  const label = `${node.serial}${node.part ? ` [${node.part}]` : ''}${node.stop === 'cycle' ? ' (cycle, not expanded)' : node.stop === 'depth' ? ' (depth limit, not expanded)' : node.stop === 'limit' ? ' (size limit, not expanded)' : ''}`;
  out.push(top ? `    ${label}` : `    ${prefix}${last ? '`-- ' : '|-- '}${label}`);
  const next = top ? '' : prefix + (last ? '    ' : '|   ');
  node.children.forEach((c, i) => treeLines(c, next, i === node.children.length - 1, false, out));
}

export function traceText(r: TraceReport): string {
  const out: string[] = [];
  for (const t of r.traces) {
    out.push(`${t.serial}${t.part ? ` [${t.part}]` : ''}`);
    if (!t.found) {
      out.push('  not found in the links file', '');
      continue;
    }
    if (t.removedFrom.length) {
      out.push('  removed from (rework):');
      for (const r of t.removedFrom) out.push(`    ${r.parent} (built in row ${r.addedRow}, removed row ${r.removedRow})`);
    }
    out.push(`  top-level: ${list(t.topLevel)}`);
    if (t.paths.length) {
      out.push('  used in:');
      for (const p of t.paths) out.push(`    ${[t.serial, ...p].join(' -> ')}`);
      if (t.pathsTruncated) out.push('    ... more routes (first 100 shown)');
    }
    out.push('  contains:');
    if (t.tree.children.length) treeLines(t.tree, '', true, true, out);
    else out.push('    (no components)');
    out.push('');
  }
  out.push(`Affected top-level units (${r.affectedTopLevel.length}): ${list(r.affectedTopLevel)}`);
  if (r.notFound.length) out.push(`Not found (${r.notFound.length}): ${r.notFound.join(', ')}`);
  return out.join('\n') + '\n';
}

export const jsonReport = (r: unknown) => JSON.stringify(r, null, 2) + '\n';
