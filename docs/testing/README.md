# Test records

The tests themselves live in `packages/engine/tests/` and `packages/tools/tests/`; how to run them is in [COMMANDS.md](../../packages/engine/docs/COMMANDS.md) and [architecture.md](../architecture.md) section 15.

This folder holds written records of test runs. The public repository keeps only the ones the README cites and the performance reference numbers:

| Record | What it is |
|---|---|
| [capability/](capability/) | 85 single tasks and the composite rounds, each judged by a script or a stated screenshot |
| [field/2026-11-05-city/](field/2026-11-05-city/) | The large-city acceptance run |
| [perf.md](perf.md) | How to measure performance, and the reference numbers |

Everything else (the run log `runs.md`, reviews, usability runs, other field tests and their screenshots) stays in the maintainer's copy. Comments in the code that name such a file point there.

## Maintainer copy

- Each full run, post-merge check or field test adds one row at the top of `runs.md`: date, engine commit, command, passed / failed counts, and what happened to each failure (fixed, known issue, or flaky under load with evidence).
- Conclusions and evidence only; quote the failing lines, never a whole log.
- A failure not fixed at the time names the piece of work it is queued in, so the next run can check it is gone.
