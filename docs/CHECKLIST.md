# mediaXG Implementation Checklist

Tracked against the 60-section master prompt. Updated after each phase.

## Phase A — Repository audit and foundation ✅ (complete)

- [x] Project scaffold (package.json, tsconfig, prettier, gitignore, README)
- [x] Core type definitions (`src/types/`)
- [x] Config schema with Zod validation + defaults (`src/config/schema.ts`)
- [x] Config manager: user/project merge, save, migrate, directories (`src/config/manager.ts`)
- [x] Structured logger with secret redaction + rotation (`src/logger/`)
- [x] Structured error model with 18 categories + factories + normalization (`src/errors/`)
- [x] Utilities: paths, token estimation, formatting, async helpers (`src/utils/`)
- [x] CLI entry with --help/--version/--config/--doctor (`src/cli.ts`)
- [x] Basic TUI shell (status bar, message view, input, /help /status /mode /clear) (`src/ui/`)
- [x] Diagnostics/doctor workflow (`src/diagnostics/`)
- [x] Architecture documentation (`docs/ARCHITECTURE.md`)
- [x] Unit tests: schema, utils, errors, types (55 passing)
- [x] Typecheck clean (`tsc --noEmit`)

## Phase B — Providers and streaming ✅ (complete)

- [x] Provider adapter interface — vendor-neutral types (`src/providers/types.ts`)
- [x] SSE parser: chunk boundaries, CRLF, comments, multiline, multibyte (`src/providers/sse.ts`)
- [x] URL composition without /v1 duplication (`src/providers/url.ts`)
- [x] HTTP error mapping: both dialect shapes, documented retryability (`src/providers/http-errors.ts`)
- [x] OpenAI-compatible adapter: streaming, tools reassembly, usage frames, reasoning_content, mid-stream errors, truncation detection
- [x] Anthropic-compatible adapter: named events, tool_use input_json_delta, thinking shapes (enabled/adaptive/disabled), required max_tokens, temperature dropped under thinking
- [x] xKiro first-class provider: documented endpoints, Bearer + x-api-key, public model catalog, count_tokens, 402/403/429/529 handling — verified against docs.xkiro.com
- [x] Adapter registry from ProviderConfig (`src/providers/registry.ts`)
- [x] Retry policy: bounded, idempotency-aware (never retries after stream data) (`src/providers/retry.ts`)
- [x] collectCompletion helper for non-streaming use (`src/providers/collect.ts`)
- [x] Model catalog: discovery, cache TTL, staleness flags, manual models, suffix match, never infers limits from names (`src/models/catalog.ts`)
- [x] Credentials: env + file (0600) + chain, masking, no secret logging (`src/credentials/`)
- [x] 116 new tests (171 total): SSE, URLs, both adapters, xKiro, retry safety, catalog, credentials
- [x] All adapter tests use deterministic mock fetch — no live network calls

## Phase C — CLI and TUI ✅ (complete)

- [x] Slash-command core: registry with categories, aliases, hidden commands, duplicate rejection, generation-availability gate, edit-distance suggestions, prefix completions, grouped help (`src/commands/`)
- [x] Input parser: quoting, `--flag=value`/boolean flags, `//text` and leading-space escapes for literal `/` messages
- [x] `/help`, `/status`, `/doctor`, `/exit`, `/clear`, `/cancel` [§8]
- [x] `/models`, `/model`, `/provider`, `/connect`, `/disconnect`, `/auth` [§9] — connect validates credentials _before_ saving; disconnect `--forget` needs `--yes`
- [x] `/mode`, `/think*` (aliases `/thinking`, `/thinks`), `/response`, `/temperature`, `/output-limit` [§10-11] — unhonored settings are kept but labeled inactive
- [x] `/session*`, `/resume`, `/search`, `/usage`, `/budget` [§12] — JSON sessions, versioned schema, prefix IDs, two-step delete
- [x] `/context` profile listing/selection, explicit token requests, reset; warns (never silences) when a request exceeds the model window [§13 partial]
- [x] Versioned session store: atomic writes (tmp+rename), index rebuild on corruption, migration hook, export, spend tracking (`src/session/`)
- [x] AppState composition: adapter cache, model resolution (resolved/ambiguous/not-found — never guesses), catalog-priced cost estimates, usage recording, interrupted-run flag
- [x] Chat service shared by TUI and non-interactive runs: request building, streaming, partial-output persistence, cancellation (`src/agent/chat.ts`)
- [x] TUI rewrite: streaming transcript (40 ms batched flush), slash autocomplete incl. subcommands, model/session pickers, connection wizard with masked key entry, status bar, input history, Esc cancel, Ctrl+C exit, multi-line paste handling (`src/ui/`)
- [x] Non-interactive runner: commands or single prompts, streaming stdout, exit codes 0/1/130 (`src/run/non-interactive.ts`)
- [x] CLI wiring: `-p/--prompt`, positional prompt, `--model/--provider/--mode` validation, TTY detection with clear errors
- [x] 186 new tests (357 total): parser, registry, session manager, app state, connect service, chat service, non-interactive, UI logic, all builtin commands
- [x] Verified: typecheck clean; CLI command smoke tests; TUI boot/execute/exit verified in a real PTY

Deferred on purpose (no stubs registered):

- `/compact`, `/memory*` — need the context engine (Phase E) and project memory (Phase G)
- `/diff`, `/review`, `/test`, `/lint` — need tools and git workflows (Phase D)
- Permission prompts — need the permission engine (Phase D); destructive commands use explicit `--yes` confirmations instead

## Phase D — Agent and coding tools ✅ (complete)

- [x] Bounded agent loop: iteration caps, sequential tool execution in model order, invalid/partially-streamed tool calls never execute, cancellation keeps the conversation protocol-valid (`src/agent/loop.ts`) [§44]
- [x] Native tool registry: 15 tools (13 from §40 + `glob_files` + `update_plan`), zod-validated inputs, permission class, timeout, output budget, mode filtering (`src/tools/`) [§40]
- [x] Workspace boundary and file safety: traversal/symlink escapes refused, sensitive credential files never readable/writable, `.git/**` blocked, atomic writes, binary/oversize handling (`src/tools/paths.ts`, `file-utils.ts`) [§41]
- [x] Controlled process execution: `spawn` with argument arrays (no shell), never-run list, timeout with SIGTERM→SIGKILL, output caps, secret redaction (`src/tools/exec-tools.ts`) [§42]
- [x] Patch/diff/undo/review: `apply_patch`, git status/diff tools, session change ledger with before/after snapshots, undo refuses files changed since the agent wrote them, `/diff`, `/undo`, `/review` (`src/tools/ledger.ts`, `undo.ts`, `git-tools.ts`) [§43]
- [x] Plan/Build/Review workflows: `update_plan` tool + real plan state in the session, `/plan show|cancel|clear`, read-only modes enforced by the registry and permission engine (`src/tools/plan-tools.ts`, `src/commands/builtin/plan.ts`, `review.ts`) [§45]
- [x] Permission engine: session > project (`.mediaxg/permissions.json`) > global > mode policy > safe defaults; exact beats wildcard, deny beats allow; interactive prompts; non-interactive denies with an actionable message; `--yes` auto-approves but never bypasses read-only modes; bounded in-session audit (`src/permissions/`) [§52]
- [x] Explicit user invocations (`/test`, `/lint`) satisfy the confirmation step while still respecting deny rules and read-only modes; audited as `approved-once`
- [x] Project instructions: `.mediaxg/INSTRUCTIONS.md` > `MEDIAXG.md` > `AGENTS.md` > `CLAUDE.md` plus the user-global file; dedupe by hash, 6 KB/file and 12 KB total caps, injected with a lower-trust label, `/instructions` (`src/context/instructions.ts`) [§47]
- [x] `/test` and `/lint` run the project's real detected scripts (never invented); `/tools` and `/permissions` expose registry and policy state (`src/tools/project.ts`) [§46 partial]
- [x] TUI wiring: tool transcript entries, permission overlay (y/a/n/Esc), `start-agent-turn` actions; non-interactive runs report tool activity on stderr
- [x] 180 new tests (537 total): workspace paths, tools, ledger/undo, process execution, project detection, instructions, permission engine, agent loop (scripted SSE), Phase D commands, session v2 migration, UI model, non-interactive tools
- [x] Verified: typecheck clean; full suite 537 pass / 0 fail; TUI boot/execute/exit in a real PTY (`/status` + `/exit`)

Deferred on purpose:

- `/memory*` — Phase G (project memory); `/compact` shipped in Phase E
- MCP-provided tools will reuse the same `executeToolCall` pipeline in Phase F; no separate execution path will be added

## Phase E — Context and budgeting

- [x] Context assembly pipeline with priority + provenance [§25] — 11 documented priority levels, system/policy and project instructions mandatory, lower-trust labeling, bounded assembly report for `/context inspect` (`src/context/assembly.ts`, `pipeline.ts`)
- [x] Effective budget calculation (9 separate values) [§23] — requested budget, model limit, provider input limit, reserved output, safety margin, estimated input, effective budget, headroom, capability source+timestamp; strictest limit wins; architectural cap 5,000,000; unknown limits use a conservative fallback (32k default) and are labeled unverified (`src/context/budget.ts`)
- [x] Context profiles incl. auto, 1m/2m/5m [§24] — profiles are presets, never promises; custom `/context <tokens>` keeps intent and warns when above the model window; `auto` picks the smallest tier covering need ×1.25, never the largest by default (`src/context/profiles.ts`)
- [x] Repository indexing/retrieval (ignore rules, extension filter, cache) [§26] — lazy per-run index, `.gitignore` with negation, built-in ignores, sensitive files never indexed, generated files de-ranked, snippets and search matches always re-read from disk, explicit path mentions first; default off with session override `/context retrieval on|off` (`src/context/retrieval.ts`)
- [x] Compaction with preservation rules + hierarchical summaries [§27] — deterministic extractive summary stored as a user-role record with `summaryMeta`; sections for requirements/constraints/decisions/errors/pending work/modified files/test results/tool-output first lines/open questions; `[direct]` vs `[inferred]` labels; auto-compaction runs once on overflow; origins restorable while retained; caps 5 chunks / 50 records (`src/context/compaction.ts`, `/compact preview|run|restore|summaries [--keep=<n>]`)
- [x] Token estimation + provider count_tokens calibration [§28] — chars/4 + framing heuristic, image allowance; calibration from provider-reported counts (median ratio, clamped [0.5, 3], persisted to the user config dir); provider count endpoint used only under pressure (≥70% of budget) or `always` when configured; a provider count above budget raises `BudgetExceededError` before sending (`src/context/tokens.ts`, `pipeline.ts`)
- [x] Usage accounting + pricing registry [§29] — estimated vs provider-reported input kept separate; local spend windows (today/month) from session records; worst-case request cost assumes the full output reserve; unknown components reported, never zero-costed; `/usage` (`src/budget/pricing.ts`, `accounting.ts`)
- [x] Budget gate (preflight, confirmation thresholds, unknown-balance policy) [§30] — size/limit checks, per-request/session/day/month local limits (80% warnings), large-context confirmation threshold, minimum-balance policy; `allow`/`confirm`/`block` with explicit reasons; confirm → TUI overlay / callback → `--yes` fallback; block raises before anything is sent, counted, or persisted (`src/budget/gate.ts`, `src/context/pipeline.ts`)
- [x] `/context inspect|budget`, `/usage`, `/budget` real state [§31] — including `/budget balance` which queries only documented interfaces (xKiro `GET /v1/usage`) and never invents a balance
- [x] TUI: budget confirmation overlay (y/n/Esc/Ctrl+C); notable context events (compaction/omission/retrieval/gate confirm) shown in the transcript; non-interactive reports the same on stderr only when notable
- [x] Xkiro `getAccountUsage` parses `/v1/usage` conservatively (`extractXKiroUsageValues`); unrecognized shapes return `available: false` with no values
- [x] 205 new tests (742 total): estimation/calibration, budget math, profiles/auto, assembly, retrieval, compaction/restore, pipeline (trim/auto-compact/retrieval/count-endpoint/gate paths), pricing/accounting/gate, Phase E commands, xKiro usage parsing, session migration defaults, loop integration (context event + calibration), non-interactive context reporting, config partial-load hardening
- [x] Config hardening while verifying: hand-written **partial** user/project config files now load (deep-partial validation → per-key section merge → full-schema re-validation); malformed files fall back with a warning; `ConfigManager` accepts explicit paths for tests (`src/config/manager.test.ts`, `mergeConfigSources` in `schema.ts`)
- [x] Verified: typecheck clean + `bun run build` clean; full suite 742 pass / 0 fail (46 files); TUI boot/commands/exit in a real PTY (`/context`, `/context budget`, `/usage`, `/budget`, `/compact summaries`, `/exit`) → exit 0; budget-confirmation overlay exercised in a real PTY (`y` → "budget confirmation was granted", `n` → "confirmation was denied by the user" + block message, nothing sent)

## Phase F — Skills and MCP ✅ (complete)

- [x] Skills discovery (global/project/user), SKILL.md frontmatter validation [§32] — precedence user > project > global; same-name conflicts keep the winner and record shadowed sources; minimal single-line YAML parser + documented `metadata` map only; name/dir match, `[a-z0-9-]`, no leading/trailing/consecutive hyphens, ≤64; description 1–1024; compatibility ≤500 (`src/skills/frontmatter.ts`, `manager.ts`)
- [x] Skill manager: activation, lazy loading, references, reload [§33] — explicit `/skills on`, in-memory only, mtime+size invalidation, auto-deactivation of broken active skills, `/skills reload`, per-skill reference/asset listing, on-demand `read_skill_reference` tool (`src/skills/manager.ts`, `tools.ts`)
- [x] Skill trust: path traversal, size limits, no auto-exec [§34] — all skills untrusted by default; opt-in trust via config `skillsSettings.trustedPaths`; containment + realpath checks for references; binary refusal; SKILL.md 256 KB, instructions 32,000 chars, reference 256 KB, 200 listed files, depth 3; `allowed-tools` recorded verbatim but never pre-approves (`src/skills/manager.ts`)
- [x] MCP client manager over official SDK, isolated behind internal interface [§35] — `McpClientLike` + `McpClientFactory` only in `src/mcp/client.ts`; lifecycle (connect/ensureConnected/ensureEnabledConnected/refreshMetadata/disconnect/closeAll), auth header builder, `withDeadline`, ring-buffer logs (200), caps (200 tools/server, 100k output chars) (`src/mcp/manager.ts`)
- [x] Transports: streamable HTTP + stdio [§36] — stdio env = SDK `getDefaultEnvironment()` + config env; stderr consumed line-by-line; URLs with secret-looking query params or userinfo rejected; oauth auth type rejected with an honest "not implemented" error (`src/mcp/client.ts`)
- [x] MCP discovery, tool exposition with permission state [§37] — tools wrapped via `defineExternalTool` with ajv JSON-Schema validation; names `mcp__<server>__<tool>` (sanitized, 64-char cap + sha1 suffix); permission class `mcp`, `mutating: true` so plan/review modes exclude MCP tools; annotations shown but never trusted; `disabledTools` toggles exposure; capability gating (no list calls for unadvertised capabilities)
- [x] MCP security: schema validation, timeouts, output caps, untrusted data [§38] — ajv arg validation before any call; `isError` from the server is a tool result, transport failures throw; every call passes the permission engine; output wrapped with an untrusted-data header and meta; disabled servers/tools refused; removed servers drop tools (`src/mcp/manager.ts`, `tools/types.ts`)
- [x] `/mcp` command family + Context7/xKiro examples [§39] — list/add/show/test/enable/disable/remove/tools/resources/prompts/permissions/auth/logs; servers added disabled by default; `/mcp remove` requires `--yes`; `/mcp auth <name> <secret>` writes the credential store (config keeps only the ref); `defaultCredentialRef` derivation; Context7 + xKiro endpoints in the empty state (`src/commands/builtin/mcp.ts`)
- [x] `/skills` command family [§13] — list/show/on/off/references/reference/diagnostics/reload (`src/commands/builtin/skills.ts`)
- [x] `/context pin|unpin|auto|compact` [§13] — `pinnedPaths` in the session (default `[]`), pipeline adds 'pinned' assembly candidates, files re-read from disk each request, `PIN_MAX_BYTES=16000`, `PIN_MAX_FILES=20`; `/context auto` selects the 'auto' profile; `/context compact` delegates to `runDefaultCompaction` (`src/commands/builtin/context.ts`, `src/context/pipeline.ts`)
- [x] System prompt wiring: `buildSystemPrompt` options `skillsBlock`/`pinnedBlock`/`mcpServers` with labeled sections; pipeline `loadPinnedFiles`/`renderSkillsBlock`/`renderPinnedBlock` + 'skill'/'pinned' candidates + preview parity + `mcpServers` option (`src/agent/request.ts`, `src/context/pipeline.ts`, `src/agent/loop.ts`)
- [x] Config: `skillsSettings` (enabled/trustedPaths/maxFiles) + `MCPServerConfig.disabledTools` + server-name regex + defaults/merge (`src/config/schema.ts`, `src/types/index.ts`)
- [x] `RegisteredTool.zodSchema` → `validateArgs(): ToolArgValidation`; `defineExternalTool`/`ExternalToolSpec` added; `tool-runner.ts` uses `validateArgs` (error text now ends "The call was not executed.") (`src/tools/types.ts`, `registry.ts`, `tool-runner.ts`)
- [x] 110 new tests (852 total): frontmatter (19), skill manager (34), MCP manager fake-client (29), MCP stdio integration (5), Phase F commands (26), loop wiring (8), context pipeline pins/skills (5), config schema (4)
- [x] Verified: typecheck clean (`tsc --noEmit`); full suite 852 pass / 0 fail (52 files); non-interactive CLI smoke (`/skills`, `/mcp`, `/context`, `--doctor`) works; interactive TUI gated on a real TTY (unchanged)
- [x] Credential abstraction: OS keychain + documented fallback handled by the existing `CredentialStore` chain (`src/credentials/`); MCP writes secrets there via `/mcp auth` (config keeps only the ref) [§51]

## Phase G — Persistence and hardening ✅ (complete)

- [x] Project memory (facts vs inferences, provenance, inspect/refresh/clear) [§48] — `src/memory/store.ts` (`MemoryManager`), `/memory` command family, injection into the system prompt as lower-trust data with a bounded cap, assembly candidate type `memory` (`src/commands/builtin/memory.ts`)
- [x] Session store: versioned JSON + index, atomic writes, corruption handling, migration hook [§49] — existing store hardened with tests (`src/session/manager.ts`)
- [x] Config migration tests (version compatibility) [§50] — partial-load round trip through `validatePartialConfig` → `mergeWithDefaults` → `validateConfig` (`src/config/schema.test.ts`)
- [x] Cancellation propagation end-to-end [§55] — AbortSignal through provider requests, tool execution, streaming readers (existing loop tests + security/perf tests)
- [x] Failure recovery, interrupted task marking, resume [§55] — `markRequestStarted`/`markRequestFinished`, honest `interrupted` flag on startup (`src/app/state.ts`)
- [x] Git workflows: status/diff/review + proposed commit message (no auto-commit) [§58] — `/review`, `/diff`, `/commit-message` (`src/commands/builtin/review.ts`, `workspace.ts`, `tools/git-tools.ts`)
- [x] Security tests: injection, traversal, redaction, output caps [§53] — `src/security.test.ts`
- [x] Performance bounds: lightweight assembly/large-session and output-cap checks (`src/security.test.ts`, existing pipeline tests)
- [x] Verified: typecheck clean; full suite passing

## Phase H — Verification and release ✅ (complete)

- [x] Full test suite (unit/integration) — 852 pass / 0 fail across 52 files
- [x] Typecheck + lint + build all passing (`tsc --noEmit`, `prettier --check`, `bun build`)
- [x] Prettier mass-applied (115 files) and `format`/`format:check` scripts added
- [x] Documentation: installation, configuration, providers, xKiro, commands, modes, context, skills, MCP, permissions, sessions, diagnostics, troubleshooting, limitations (`docs/`)
- [x] Packaging workflow: `bun build` verified (887 modules, 3.14 MB); smoke of non-interactive CLI
- [x] Final report (`docs/REPORT.md`) per §60
