# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alvaschul/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alvaschul/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

An entry for the [mend bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

One patch tool that applies AI-written edits in all four formats models
actually produce:

- **unified diffs** — including hunks whose line numbers are wrong: the
  hunk is located by its lines, at the first matching tier, nearest the
  stated position;
- **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` form;
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with Add /
  Delete / Update / Move sections, anchors, cursors and end-of-file
  chunks;
- **JSON tool calls** — `create`, `str_replace` and `insert`, as one
  array or as JSON Lines.

Matching is three-tiered: exact lines first, then lines equal once
trailing whitespace is ignored, then lines equal once all surrounding
whitespace is ignored — with re-indentation of the replacement at the
loosest tier, so an edit still lands when the model drifted the
indentation. `--strict` turns the looser tiers off.

Every edit in a patch is checked and applied in order, and the patch is
atomic: if any edit fails, nothing is written and every failure is
reported. Paths are confined to the working tree.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or standard input when it is absent or `-`.
`--format` is one of `unified`, `search-replace`, `v4a`, `json`, or
`auto` (the default) to detect the format. `--check` reports what would
change without writing anything.

Exit codes: `0` when the patch applied (followed by one line per changed
file and an `ok:` summary), `1` when one or more edits failed (one
`error:` line per failed edit), `2` for usage, unreadable-patch, format
and parse errors.

## Layout

- `main.ts` — the CLI itself, Node 22 standard library only.
- `runner.ts` — the trial runner from the kit, kept as shipped: when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

## License

MIT — see `LICENSE`.
