import type { BomLine, Link, Unit } from './input.js';

/** Assembly genealogy: unique parent -> child edges (self-links and repeated rows are kept out, but reported). */
export interface Genealogy {
  serials: string[];
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
  /** Rows of each unique edge, key `parent\0child`. */
  edgeRows: Map<string, number[]>;
  selfLinks: Map<string, number[]>;
  part: Map<string, string>;
}

const key = (a: string, b: string) => `${a}\u0000${b}`;

export function buildGenealogy(links: Link[], units: Unit[] = []): Genealogy {
  const g: Genealogy = {
    serials: [],
    children: new Map(),
    parents: new Map(),
    edgeRows: new Map(),
    selfLinks: new Map(),
    part: new Map(units.map((u) => [u.serial, u.part])),
  };
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      g.serials.push(s);
    }
  };
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const l of links) {
    add(l.parent);
    add(l.child);
    if (l.parent === l.child) {
      g.selfLinks.set(l.parent, [...(g.selfLinks.get(l.parent) ?? []), l.row]);
      continue;
    }
    const k = key(l.parent, l.child);
    const rows = g.edgeRows.get(k);
    if (rows) {
      rows.push(l.row);
      continue;
    }
    g.edgeRows.set(k, [l.row]);
    push(g.children, l.parent, l.child);
    push(g.parents, l.child, l.parent);
  }
  return g;
}

export type Finding =
  | { type: 'self-link'; serial: string; rows: number[] }
  | { type: 'duplicate-link'; parent: string; child: string; rows: number[] }
  | { type: 'multi-parent'; child: string; parents: string[]; rows: number[] }
  | { type: 'cycle'; serials: string[] }
  | { type: 'unknown-serial'; serial: string }
  | {
      type: 'bom-missing' | 'bom-extra';
      parent: string;
      parentPart: string;
      childPart: string;
      expected: number;
      actual: number;
      children: string[];
    }
  | { type: 'bom-unexpected'; parent: string; parentPart: string; childPart: string; children: string[] };

export interface CheckReport {
  summary: {
    serials: number;
    links: number;
    linkRows: number;
    topLevel: number;
    components: number;
    maxLevels: number;
    unitsGiven: number;
    bomLines: number;
    bomChecked: number;
  };
  findings: Finding[];
  counts: Record<string, number>;
}

/** Strongly connected components with more than one serial (Tarjan, iterative so deep chains cannot overflow). */
export function cycles(g: Genealogy): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of g.serials) {
    if (index.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const kids = g.children.get(top.v) ?? [];
      if (top.i < kids.length) {
        const w = kids[top.i++];
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
      }
      if (low.get(top.v) === index.get(top.v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== top.v);
        if (scc.length > 1) out.push(scc.sort());
      }
    }
  }
  return out;
}

/** Longest top-down chain, in serials (a lone unit is 1). Serials on a cycle are left out. */
function maxLevels(g: Genealogy): number {
  const indeg = new Map<string, number>();
  for (const s of g.serials) indeg.set(s, (g.parents.get(s) ?? []).length);
  const level = new Map<string, number>();
  const queue = g.serials.filter((s) => indeg.get(s) === 0);
  for (const s of queue) level.set(s, 1);
  let best = 0;
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    const lv = level.get(v)!;
    best = Math.max(best, lv);
    for (const w of g.children.get(v) ?? []) {
      level.set(w, Math.max(level.get(w) ?? 0, lv + 1));
      const d = indeg.get(w)! - 1;
      indeg.set(w, d);
      if (d === 0) queue.push(w);
    }
  }
  return best;
}

export function check(links: Link[], units?: Unit[], bom?: BomLine[]): CheckReport {
  const g = buildGenealogy(links, units);
  const findings: Finding[] = [];
  for (const [serial, rows] of g.selfLinks) findings.push({ type: 'self-link', serial, rows });
  for (const [k, rows] of g.edgeRows) {
    if (rows.length > 1) {
      const [parent, child] = k.split('\u0000');
      findings.push({ type: 'duplicate-link', parent, child, rows });
    }
  }
  for (const [child, parents] of g.parents) {
    if (parents.length > 1) {
      const rows = parents.flatMap((p) => g.edgeRows.get(key(p, child))!).sort((a, b) => a - b);
      findings.push({ type: 'multi-parent', child, parents, rows });
    }
  }
  for (const serials of cycles(g)) findings.push({ type: 'cycle', serials });
  if (units) {
    for (const s of g.serials) if (!g.part.has(s)) findings.push({ type: 'unknown-serial', serial: s });
  }
  let bomChecked = 0;
  if (units && bom) {
    const bomByPart = new Map<string, BomLine[]>();
    for (const b of bom) bomByPart.set(b.parentPart, [...(bomByPart.get(b.parentPart) ?? []), b]);
    for (const u of units) {
      const lines = bomByPart.get(u.part);
      if (!lines) continue;
      bomChecked++;
      const byPart = new Map<string, string[]>();
      for (const c of g.children.get(u.serial) ?? []) {
        const cp = g.part.get(c);
        if (cp === undefined) continue; // reported as unknown-serial
        byPart.set(cp, [...(byPart.get(cp) ?? []), c]);
      }
      for (const b of lines) {
        const kids = byPart.get(b.childPart) ?? [];
        if (kids.length !== b.qty) {
          findings.push({
            type: kids.length < b.qty ? 'bom-missing' : 'bom-extra',
            parent: u.serial,
            parentPart: u.part,
            childPart: b.childPart,
            expected: b.qty,
            actual: kids.length,
            children: kids,
          });
        }
        byPart.delete(b.childPart);
      }
      for (const [childPart, kids] of byPart) {
        findings.push({ type: 'bom-unexpected', parent: u.serial, parentPart: u.part, childPart, children: kids });
      }
    }
  }
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  const topLevel = g.serials.filter((s) => !g.parents.has(s)).length;
  return {
    summary: {
      serials: g.serials.length,
      links: g.edgeRows.size,
      linkRows: links.length,
      topLevel,
      components: g.serials.length - topLevel,
      maxLevels: maxLevels(g),
      unitsGiven: units?.length ?? 0,
      bomLines: bom?.length ?? 0,
      bomChecked,
    },
    findings,
    counts,
  };
}

export interface TreeNode {
  serial: string;
  part?: string;
  /** Set when the serial already appears higher on this branch (a cycle), the depth limit was hit, or the tree hit MAX_TREE_NODES. */
  stop?: 'cycle' | 'depth' | 'limit';
  children: TreeNode[];
}

export interface TraceResult {
  serial: string;
  found: boolean;
  part?: string;
  /** Serials above it, nearest first, one list per route to a top-level unit. */
  paths: string[][];
  pathsTruncated: boolean;
  topLevel: string[];
  tree: TreeNode;
}

export interface TraceReport {
  traces: TraceResult[];
  affectedTopLevel: string[];
  notFound: string[];
}

const MAX_PATHS = 100;
const MAX_TREE_NODES = 10_000;

function upPaths(g: Genealogy, serial: string): { paths: string[][]; truncated: boolean; top: string[] } {
  // Top-level ancestors: plain search over parents (each serial visited once).
  const top = new Set<string>();
  const seen = new Set([serial]);
  const queue = [serial];
  for (let i = 0; i < queue.length; i++) {
    const ps = g.parents.get(queue[i]) ?? [];
    if (ps.length === 0) top.add(queue[i]);
    for (const p of ps) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  // Routes upwards, depth-first, at most MAX_PATHS (multi-parent errors can multiply routes).
  const paths: string[][] = [];
  let truncated = false;
  const work: string[][] = [[serial]];
  while (work.length) {
    if (paths.length >= MAX_PATHS) {
      truncated = true;
      break;
    }
    const route = work.pop()!;
    const last = route[route.length - 1];
    const ps = (g.parents.get(last) ?? []).filter((p) => !route.includes(p));
    if (ps.length === 0) {
      if (route.length > 1) paths.push(route.slice(1));
      continue;
    }
    for (let i = ps.length - 1; i >= 0; i--) work.push([...route, ps[i]]);
  }
  return { paths, truncated, top: [...top].sort() };
}

function downTree(g: Genealogy, serial: string, maxDepth: number): TreeNode {
  const make = (s: string): TreeNode => {
    const node: TreeNode = { serial: s, children: [] };
    const part = g.part.get(s);
    if (part !== undefined) node.part = part;
    return node;
  };
  const root = make(serial);
  let nodes = 1;
  const work: { node: TreeNode; branch: Set<string>; depth: number }[] = [{ node: root, branch: new Set([serial]), depth: 0 }];
  while (work.length) {
    const { node, branch, depth } = work.pop()!;
    const kids = g.children.get(node.serial) ?? [];
    if (kids.length && depth >= maxDepth) {
      node.stop = 'depth';
      continue;
    }
    if (kids.length && nodes + kids.length > MAX_TREE_NODES) {
      node.stop = 'limit';
      continue;
    }
    for (const k of kids) {
      const child = make(k);
      nodes++;
      node.children.push(child);
      if (branch.has(k)) {
        child.stop = 'cycle';
        continue;
      }
      work.push({ node: child, branch: new Set([...branch, k]), depth: depth + 1 });
    }
  }
  return root;
}

export function trace(links: Link[], serials: string[], units?: Unit[], maxDepth = 50): TraceReport {
  const g = buildGenealogy(links, units);
  const known = new Set(g.serials);
  const traces: TraceResult[] = [];
  const affected = new Set<string>();
  const notFound: string[] = [];
  for (const serial of serials) {
    const found = known.has(serial);
    if (!found) notFound.push(serial);
    const up = found ? upPaths(g, serial) : { paths: [], truncated: false, top: [] };
    up.top.forEach((t) => affected.add(t));
    const result: TraceResult = {
      serial,
      found,
      paths: up.paths,
      pathsTruncated: up.truncated,
      topLevel: up.top,
      tree: downTree(g, serial, maxDepth),
    };
    const part = g.part.get(serial);
    if (part !== undefined) result.part = part;
    traces.push(result);
  }
  return { traces, affectedTopLevel: [...affected].sort(), notFound };
}
