# Raw capture exports

Raw `bridge.stop()` JSON, one file per run, unedited.

Naming: `<YYYY-MM-DD>-<scenarioId>-<baseline|candidate>-<run>.json`, e.g.
`2026-09-06-stream-boundary-drive-baseline-1.json`.

Corrected run metadata goes in the baseline Markdown or a sidecar `<same-name>.meta.json`.
Never edit an export to fix its metadata: the runtime's `scenarioId`, `buildRevision`,
`warmupDurationMs`, `sampleDurationMs` and `rendererKind` are placeholders, and the
correction belongs beside the export, not inside it.

This directory is empty of captures. As of 2026-09-06 no hardware run has been recorded —
see [`../2026-09-06-baseline.md`](../2026-09-06-baseline.md).
