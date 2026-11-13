# genealogy-check

Offline CLI (and TypeScript library) for **serial-number assembly genealogy** exported from an MES or
traceability system: which component serial went into which assembly serial.

- `check` finds what breaks traceability: a component built into more than one assembly (double consumption),
  cycles, a serial linked into itself, the same link recorded twice, and - with a units file and a BOM -
  assemblies with too few / too many components of a part, or components that are not in the assembly's BOM.
- `trace` answers recall questions: for each serial, every route up to the top-level unit (where used) and the
  tree of what it contains, plus the set of **affected top-level units** for a list of suspect serials
  (e.g. a bad component reel or lot).

No runtime dependencies, no network, reads local CSV files only.

## Install / build

```sh
npm ci
npm run build
node dist/cli.js --help
```

Node 20 or newer.

## Input

`links.csv` - one row per component built into an assembly. Multi-level genealogies are just more rows:
a sub-assembly is the child in one row and the parent in others. Extra columns are ignored.

```csv
parent,child,timestamp,station
MTR-0001,PCB-1001,2026-11-10 08:01:00,SMT-ASSY
PCB-1001,MCU-4001,2026-11-09 14:10:00,SMT
```

`units.csv` (optional) - part number of each serial: `serial,part`. Enables part labels and the BOM check.

`bom.csv` (optional, needs `--units`) - `parent_part,child_part,qty` components per assembly part number.
Every serial in the units file whose part has BOM lines is checked, also one that never appears in the links file
(it then shows as missing all its components); parts with no BOM lines are not BOM-checked. Serials are matched
exactly (case-sensitive).

Rework (optional): an `action` column with `add` (or empty) / `remove`. Rows are replayed in file order; a remove
row takes out the latest still-present add of the same parent and child, so "remove old part, add new part" leaves
only the replacement, and a part moved from one assembly to another is not double consumption. A remove row with
nothing to remove is a finding. Removed links are left out of every other check and count; `trace` lists the
assemblies a serial was removed from (they are not affected units). Export the file in the order things happened,
or use `--time-order` below. See `examples/rework-links.csv`.

```csv
parent,child,timestamp,station,action
PCB-1002,MCU-4002,2026-11-09 14:12:00,SMT,add
PCB-1002,MCU-4002,2026-11-11 09:40:00,REWORK,remove
PCB-1002,MCU-4006,2026-11-11 09:45:00,REWORK,add
```

Time order (optional, `--time-order`, for `check` and `trace`): every links row needs a timestamp
(`YYYY-MM-DD HH:MM[:SS[.fff]]`, `T` or space, optional `Z` / `+08:00` / `+0800`; all rows with a zone or all
without). Rows are then replayed by time (equal times keep file order) instead of file order, so an export sorted by
serial still applies rework correctly. `check` also reports a **late component**: a part that went into a
sub-assembly after that sub-assembly was already built into its assembly (for a repeated scan, the first time
counts). That is either a scan/clock problem or rework inside an installed sub-assembly; worth a look either way.
See `examples/time-order-links.csv` (`check examples/time-order-links.csv --time-order`).

Lots (optional): a `lot` column with the component lot, reel or batch. On a row with a child serial it just tags
that serial; a row with a lot and an **empty child** is a lot-tracked component with no serial of its own (capacitors,
screws, a case lot). Lot-only rows stay out of every serial check (they are counted in the summary as `lotRows` /
`lotOnlyRows`, and are not BOM-checked, so leave lot-tracked parts out of the BOM) and cannot be remove rows; with
`--time-order` they need no timestamp. `trace --lot <lot>` (repeatable) or `--lots <file>` traces every serial
carrying the lot and every assembly a lot-only row put it into; their top-level units are the affected set. An
assembly seen only in lot-only rows is its own top-level unit. A lot with no rows is listed as not found (exit 1).

```sh
node dist/cli.js trace examples/lot-links.csv --lot REEL-A17 --lot CAP-LOT-0915
```

```text
...
Lots:
  REEL-A17: serials MCU-6101, MCU-6102
  CAP-LOT-0915: lot-only rows in PCB-5101, PCB-5103

Affected top-level units (3): MTR-0101, MTR-0102, MTR-0103
```

Column names are matched without case; `--parent-column`, `--child-column`, `--action-column`, `--lot-column`, `--time-column`, `--serial-column` and `--part-column`
rename them. Row numbers in messages count CSV records with the header as row 1 (blank lines are skipped).

## Examples

```sh
node dist/cli.js check examples/links.csv --units examples/units.csv --bom examples/bom.csv
```

```text
Genealogy check
  serials 19, links 16 (17 rows), top-level units 4, components 15, deepest chain 3 levels
  units file: 19 serials; BOM: 4 lines, 8 assemblies checked

Findings: 4

Built into more than one assembly (double consumption) (1)
  - LCD-2002 is built into 2 assemblies: MTR-0002, MTR-0003 (rows 7, 11)

Fewer components than the BOM (1)
  - MTR-0004 (METER-1P) has 0 x LCD-SEG, BOM says 1

More components than the BOM (1)
  - PCB-1003 (PCBA-MAIN) has 2 x MCU-A, BOM says 1: MCU-4003, MCU-4004

Same link recorded more than once (1)
  - RLY-3003 into MTR-0003 is recorded 2 times (rows 12, 13)
```

```sh
node dist/cli.js trace examples/links.csv --serials examples/recall-serials.txt --units examples/units.csv
```

```text
MCU-4002 [MCU-A]
  top-level: MTR-0002
  used in:
    MCU-4002 -> PCB-1002 -> MTR-0002
  contains:
    (no components)

MCU-4003 [MCU-A]
  top-level: MTR-0003
  used in:
    MCU-4003 -> PCB-1003 -> MTR-0003
  contains:
    (no components)

Affected top-level units (2): MTR-0002, MTR-0003
```

`trace` also takes serials as arguments (`trace links.csv MTR-0003`) and draws the tree below each one
(`--max-depth`, default 50). Routes up are capped at 100 per serial (double consumption can multiply them); the
affected top-level set is always complete. `--json` gives the full report for both commands.

## Output formats

`--json` (everything), `--md` (Markdown tables for a ticket or wiki page) or `--csv`, one at a time:

- `check --csv`: one row per finding, every finding (`--limit` only trims text and Markdown), columns
  `type,serial,parent,parent_part,child_part,expected,actual,serials,rows,detail`; lists inside a cell are space
  separated.
- `trace --csv`: the recall list, one row per affected top-level unit with the traced serials inside it:

```sh
node dist/cli.js trace examples/links.csv --serials examples/recall-serials.txt --units examples/units.csv --csv
```

```text
top_level,part,traced_serials
MTR-0002,METER-1P,MCU-4002
MTR-0003,METER-1P,MCU-4003
```

CSV cells that start with `=`, `+` or `@` get a leading `'` so a spreadsheet does not run them as formulas.

## Exit codes

| code | meaning |
| ---- | ------- |
| 0 | no findings (`check`), every serial and lot found (`trace`) |
| 1 | findings (`check`), a serial or lot not in the links file (`trace`) |
| 2 | input error (file, header, empty serial, bad BOM qty, conflicting part, flags) |

## Development

```sh
npm run check   # lint + typecheck + tests
npm run build
npm run smoke   # built CLI: examples + a 300,000-link genealogy
```

## Not in scope (yet)

Vendor export presets. Real export samples are needed before adding presets.

## License

MIT
