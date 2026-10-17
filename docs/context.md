# Context and budgeting

mediaXG clamps the requested context budget by the real model/provider
limits. Nine budget values are kept separate and shown by `/context budget`:

requested budget, model limit, provider input limit, reserved output,
safety margin, estimated input, effective budget, headroom, capability
source + timestamp.

## Profiles

Presets, not promises. `auto` picks the smallest tier covering the estimated
need × 1.25 within the model window. Custom `/context <tokens>` keeps intent
and warns when above the model window.

## Assembly

11 documented priority levels (system → evidence). Lower-trust content
(skills, retrieved docs, file contents, tool output) is labeled and can never
override system rules. `/context inspect` shows provenance and
included/omitted reasons.

## Retrieval

Off by default. Lazy per-run index, `.gitignore` with negation, sensitive
files never indexed. `/context retrieval on|off`.

## Compaction

Deterministic extractive summary stored as a user-role record with
`summaryMeta`. Original history is never deleted. `/compact
preview|run|restore|summaries [--keep=<n>]`.

## Token estimation

chars/4 + framing heuristic, image allowance; calibrated against provider
counts (median ratio, clamped [0.5, 3]). Provider count endpoint used only
under pressure or when configured `always`.

## Budget gate

`allow` / `confirm` / `block`. Block raises before anything is sent,
counted, or persisted. Confirm goes to the TUI overlay (y/n) or `--yes`.
