#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError } from './errors.js';
import { check, trace } from './graph.js';
import { parseBom, parseLinks, parseUnits } from './input.js';
import { checkCsv, checkMd, traceCsv, traceMd } from './formats.js';
import { jsonReport, textReport, traceText } from './report.js';

const USAGE = `Usage: genealogy-check check <links.csv> [--units <units.csv> [--bom <bom.csv>]] [options]
       genealogy-check trace <links.csv> <serial>... [--serials <file>] [--units <units.csv>] [options]

Checks a serial-number assembly genealogy (which component serial went into which assembly serial), as exported
from an MES or traceability system, and traces serials up (where used, down to the top-level unit) and down (what
they contain). Offline; reads local files only.

links.csv: header "parent,child" (optional timestamp, station columns are kept for later use). One row per
component built into an assembly; multi-level genealogies are just more rows (a sub-assembly is a child in one row
and a parent in others). Rework: an optional "action" column, add (or empty) / remove. Rows are replayed in file
order; a remove row takes out the latest add of the same parent,child, so remove old + add new = a replacement.
units.csv: header "serial,part" - part number of each serial (optional, enables the BOM check and part labels).
bom.csv:   header "parent_part,child_part,qty" - components per assembly part number.

check findings (exit 1): a serial built into more than one assembly (double consumption), cycles, a serial linked
into itself, assemblies with fewer / more components of a part than the BOM, components whose part is not in the
assembly's BOM, serials not in the units file, remove rows with nothing to remove, the same link recorded twice.
trace: for each serial, every route up to a top-level unit and the tree of what it contains, plus the set of
affected top-level units (e.g. for a recall from a bad component lot), and assemblies a serial was removed from by
rework (those are not affected units). Exit 1 when a serial is not found.

Options:
  --units <file>            units CSV (serial,part)
  --bom <file>              BOM CSV (parent_part,child_part,qty); needs --units          [check]
  --serials <file>          serials to trace, one per line (blank lines and # comments skipped) [trace]
  --max-depth <n>           levels shown below a traced serial (default 50, max 1000)   [trace]
  --limit <n>               findings listed per kind in the text report (default 50)    [check]
  --parent-column <name>    links parent column (default parent)
  --child-column <name>     links child column (default child)
  --action-column <name>    links rework column, add / remove (default action, optional)
  --serial-column <name>    units serial column (default serial)
  --part-column <name>      units part column (default part)
  --json                    JSON report (everything)
  --md                      Markdown report (summary + tables, for a ticket or wiki page)
  --csv                     CSV: check -> one row per finding (all, --limit ignored);
                            trace -> one row per affected top-level unit with the traced serials inside it
                            (a recall list). Cells starting with = + @ get a leading ' for spreadsheets.
  -h, --help                show this help

Exit codes: 0 ok, 1 findings (check) or serial not found (trace), 2 input error.
`;

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${what} file ${path}: ${(e as Error).message}`);
  }
}

function int(v: string | undefined, flag: string, def: number, max: number): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) {
    throw new InputError(`${flag} must be a whole number from 1 to ${max}.`);
  }
  return Number(v);
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        units: { type: 'string' },
        bom: { type: 'string' },
        serials: { type: 'string' },
        'max-depth': { type: 'string' },
        limit: { type: 'string' },
        'parent-column': { type: 'string' },
        'child-column': { type: 'string' },
        'action-column': { type: 'string' },
        'serial-column': { type: 'string' },
        'part-column': { type: 'string' },
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        csv: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const [command, linksFile, ...rest] = positionals;
    if (command !== 'check' && command !== 'trace') {
      throw new InputError(command === undefined ? 'missing command (check or trace); see --help.' : `unknown command "${command}" (check or trace); see --help.`);
    }
    if (linksFile === undefined) throw new InputError('missing the links CSV file.');
    if ([values.json, values.md, values.csv].filter(Boolean).length > 1) throw new InputError('pick one of --json, --md, --csv.');
    const links = parseLinks(read(linksFile, 'links'), {
      parentColumn: values['parent-column'],
      childColumn: values['child-column'],
      actionColumn: values['action-column'],
    });
    if ((values['serial-column'] !== undefined || values['part-column'] !== undefined) && values.units === undefined) {
      throw new InputError('--serial-column / --part-column need --units.');
    }
    const units =
      values.units === undefined
        ? undefined
        : parseUnits(read(values.units, 'units'), { serialColumn: values['serial-column'], partColumn: values['part-column'] });

    if (command === 'check') {
      if (rest.length) throw new InputError(`check takes one links file; unexpected: ${rest.join(' ')}`);
      if (values.serials !== undefined || values['max-depth'] !== undefined) throw new InputError('--serials / --max-depth are for trace.');
      if (values.bom !== undefined && units === undefined) throw new InputError('--bom needs --units (the part number of each serial).');
      const bom = values.bom === undefined ? undefined : parseBom(read(values.bom, 'bom'));
      const report = check(links, units, bom);
      const limit = int(values.limit, '--limit', 50, 1_000_000);
      process.stdout.write(
        values.json ? jsonReport(report) : values.md ? checkMd(report, limit) : values.csv ? checkCsv(report) : textReport(report, limit),
      );
      return report.findings.length ? 1 : 0;
    }

    if (values.bom !== undefined || values.limit !== undefined) throw new InputError('--bom / --limit are for check.');
    const serials = [...rest];
    if (values.serials !== undefined) {
      for (const line of read(values.serials, 'serials').split(/\r?\n/)) {
        const s = line.replace(/^\uFEFF/, '').trim();
        if (s && !s.startsWith('#')) serials.push(s);
      }
    }
    if (!serials.length) throw new InputError('trace needs at least one serial (arguments or --serials).');
    const report = trace(links, [...new Set(serials)], units, int(values['max-depth'], '--max-depth', 50, 1000));
    const parts = new Map((units ?? []).map((u) => [u.serial, u.part]));
    const partOf = (serial: string) => parts.get(serial);
    process.stdout.write(
      values.json ? jsonReport(report) : values.md ? traceMd(report, partOf) : values.csv ? traceCsv(report, partOf) : traceText(report),
    );
    return report.notFound.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`genealogy-check: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
