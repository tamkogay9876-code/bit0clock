# mediaXG Architecture

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│ CLI Entry (src/cli.ts)                                   │
│  - Argument parsing, mode dispatch                       │
├─────────────────────────────────────────────────────────┤
│ TUI Layer (src/ui/)                                      │
│  - Ink/React components, interaction state               │
├─────────────────────────────────────────────────────────┤
│ Command Registry (src/commands/)                         │
│  - Slash commands, validation, dispatch                  │
├─────────────────────────────────────────────────────────┤
│ Agent Orchestration (src/agent/)                         │
│  - Agent loop, plan/build workflow, tool calling         │
├─────────────────────────────────────────────────────────┤
│ Provider Layer (src/providers/)                          │
│  - Adapters (OpenAI/Anthropic/xKiro), streaming          │
├─────────────────────────────────────────────────────────┤
│ Model Catalog (src/models/)                              │
│  - Capability registry, discovery, caching               │
├─────────────────────────────────────────────────────────┤
│ Context Engine (src/context/)                            │
│  - Assembly, budgeting, compaction, token estimation     │
├─────────────────────────────────────────────────────────┤
│ Tools (src/tools/)                                       │
│  - Native tool registry, workspace safety, shell         │
├─────────────────────────────────────────────────────────┤
│ Permissions (src/permissions/)                           │
│  - Single policy engine, prompts, audit trail            │
├─────────────────────────────────────────────────────────┤
│ Skills (src/skills/)                                     │
│  - Discovery, validation, activation                     │
├─────────────────────────────────────────────────────────┤
│ MCP (src/mcp/)                                           │
│  - Client lifecycle, transports, capability discovery    │
├─────────────────────────────────────────────────────────┤
│ Sessions (src/session/)                                  │
│  - Persistence, search, resume, export                   │
├─────────────────────────────────────────────────────────┤
│ Credentials (src/credentials/)                           │
│  - Environment refs + 0600 file store; no OS keychain    │
├─────────────────────────────────────────────────────────┤
│ Budget (src/budget/)                                     │
│  - Usage accounting, pricing, spend gates                │
├─────────────────────────────────────────────────────────┤
│ Foundation                                               │
│  - Config (src/config/), Logger (src/logger/),           │
│    Errors (src/errors/), Utils (src/utils/),             │
│    Types (src/types/), Diagnostics (src/diagnostics/)    │
└─────────────────────────────────────────────────────────┘
```

## Key Constraints

1. **No circular dependencies** — layers only depend downward.
2. **Provider-agnostic agent loop** — providers translate to/from internal types; the agent loop never sees vendor wire formats.
3. **Single permission engine** — every consequential action (native tool, MCP call, shell) passes through `src/permissions/`.
4. **Plan mode is read-only** — enforced at the tool registry + permission engine level, not by prompt text.
5. **Never fabricate data** — costs, quotas, token counts labeled when estimated; "unknown" when unverified.
6. **Secrets never logged/exported** — credential refs only; redaction in logger; no secrets in session files. Credentials resolve from environment variables or a local `0600` file; OS keychain integration is not implemented.
7. **Strict TypeScript** — `strict: true`, `noUncheckedIndexedAccess: true`.

## Data Flow (request lifecycle)

```
User input
  → Command registry (slash?) or agent loop
  → Context assembly (budget check, token estimate)
  → Budget gate (cost estimate, spend limits)
  → Provider adapter (streaming request)
  → Stream events → TUI
  → Tool calls → validation → permission → execution → results
  → Loop until completion / limit / cancel
  → Session persistence
```

### Configuration loading (`src/config/`)

User config (`~/.config/mediaxg/config.json`) and project config
(`./.mediaxg/config.json`) may be complete or partial. Each file is validated
against a deep-partial schema; the project file overrides the user file key by
key for known sections (`contextEngine`, `spendingLimits`, …); defaults fill
everything unset; the merged result is re-validated against the full schema
before use. A malformed file is rejected as a whole with a warning — it never
takes down the defaults, and nothing is silently half-applied.

## Tools, Permissions, and Instructions (Phase D)

### Tool execution pipeline

Every tool call — from the model, a slash command, or (later) MCP — flows
through one path (`src/agent/tool-runner.ts`):

1. `ToolRegistry` lookup by name — unknown tools error, nothing executes
2. zod validation of arguments — invalid arguments error, nothing executes
3. `WorkspacePaths.resolve` guard: workspace-relative paths only, `..` and
   symlink escapes refused, sensitive credential files and `.git/**` never
   exposed to tools
4. `PermissionEngine.evaluate` (see below)
5. Execution with a timeout, cancellation propagation, and an output budget
   (no shell — `spawn` with argument arrays)
6. Results recorded in the session `toolHistory` (bounded); file mutations
   additionally recorded in the `changeLedger` for `/undo`

Partially streamed tool calls (malformed JSON arguments) are dropped before
step 1 and reported to the model as errors; the conversation stays valid.

### Permission model (`src/permissions/`)

Precedence, highest first (documented in `engine.ts`):

1. **Session scope** — "always allow" approvals granted during this session
2. **Project scope** — `.mediaxg/permissions.json` in the workspace
3. **Global scope** — `permissionRules` in the user configuration
4. **Mode policy** — read-only modes (plan, review) deny write/execute/git/
   content actions absolutely; rules cannot override this gate
5. **Safe defaults** — reads allowed; consequential actions confirmed
   interactively, denied in non-interactive runs (the message points to
   `--yes` or a rule), never silently allowed

Within a scope, an exact action rule beats a wildcard, and deny beats allow at
equal specificity. `--yes` auto-approves consequential actions but never
bypasses read-only modes or deny rules. An explicit user invocation (e.g.
`/test`, `/lint`) satisfies the confirmation step for that action only; mode
policy and deny rules still apply. Every decision is appended to a bounded
in-session audit trail, visible via `/permissions`.

### Change ledger and undo (`src/tools/ledger.ts`, `undo.ts`, `git-tools.ts`)

- Only agent-made changes are recorded, with before/after content snapshots
  (hashes only above 256 KB).
- `/undo` reverses the most recent changes only when the on-disk content still
  matches what the agent wrote; otherwise it refuses — user work is never
  overwritten silently.
- All writes are atomic (tmp file + fsync + rename).

### Project instructions (`src/context/instructions.ts`)

| File                                | Precedence  |
| ----------------------------------- | ----------- |
| `~/.config/mediaxg/instructions.md` | user-global |
| `.mediaxg/INSTRUCTIONS.md`          | 40          |
| `MEDIAXG.md`                        | 30          |
| `AGENTS.md`                         | 20          |
| `CLAUDE.md`                         | 10          |

All existing files are included in precedence order, deduplicated by content
hash, capped per file (6 KB) and in total (12 KB), and injected into the system
prompt with an explicit lower-trust label: instruction files can guide
conventions but never override system, safety, or permission rules.
`/instructions` shows what was discovered.

### Context engine (`src/context/`, `src/budget/`)

`prepareContextRequest` is the single request path used by the agent loop; the
pipeline never sends anything by itself and never silently changes the model,
provider, or requested context.

Per iteration it:

1. **Resolves the context target** — profile preset, `/context <tokens>` custom
   override, or `auto` (smallest tier covering the estimated need ×1.25 within
   the model window; never the largest by default).
2. **Optionally retrieves** repository snippets (§26) — bounded (4 files /
   1500-token snippets by default), explicit path mentions first, content
   always re-read from disk before extraction; off by default.
3. **Fits the conversation** — auto-compaction runs once (deterministic
   extractive summary, original payload restorable), then oldest-first
   omission adds an explicit system note; leading tool-result messages are
   dropped so the protocol stays valid. Original history is never deleted from
   the session file.
4. **Estimates input tokens** — chars/4 + framing → calibrated-local (median
   ratio of past provider-reported counts, clamped [0.5, 3]) → provider
   `count_tokens` endpoint when configured (`always`) or under pressure
   (≥70% of the effective budget).
5. **Computes the effective budget** (§23) from the strictest applicable
   limit: requested budget, model context window, provider input limit —
   minus the output reserve and safety margin, capped at 5,000,000. Unknown
   limits fall back conservatively and are labeled unverified. Nine values are
   kept separate and shown by `/context budget`.
6. **Evaluates the budget gate** (§30) — size/limit checks, per-request /
   per-session / daily / monthly local spend limits, large-context
   confirmation threshold, and the minimum-balance policy. `confirm` goes to
   the caller (TUI overlay `y`/`n`), then `--yes`/`autoApprove`; a `block`
   raises `BudgetGateError` before anything is sent, counted, or persisted.
7. **Persists a bounded assembly report** for `/context inspect` — every item
   with priority, provenance, token estimate, and the reason it was included
   or omitted.

`/compact` and automatic compaction share `planCompaction`/`applyCompaction`;
the summary is stored as a user-role message with `summaryMeta` (system-role
stored messages are never sent by `toInternalMessages`). Cost figures are
always local estimates from the cached pricing snapshot — never provider
billing; `/budget balance` queries only documented interfaces (xKiro
`GET /v1/usage`) and reports unknown shapes without inventing values.

## Implemented so far

- **Phase A**: config/logger/errors/utils/diagnostics, CLI shell, TUI shell.
- **Phase B**: provider adapters (OpenAI, Anthropic, xKiro), SSE, retry, model catalog, credentials.
- **Phase C**: command registry + builtin commands, session store, chat service, full TUI, non-interactive runner.
- **Phase D**: native tool registry (15 tools), workspace guard, controlled execution, change ledger + `/undo`, permission engine with audit, project instructions, plan state, `/diff` `/review` `/test` `/lint` `/tools` `/permissions` `/plan` `/instructions`, TUI tool transcript + permission overlay.
- **Phase E**: context engine (assembly/budget/profiles/retrieval/compaction/token calibration), budget gate + pricing/accounting, `/context`, `/compact`, real `/usage` and `/budget` (incl. xKiro `/v1/usage` balance), TUI budget overlay + context notices.
- **Phase F**: skills (discovery/validation/activation/lazy loading/references/reload, trust classification, size/containment caps, `read_skill_reference` tool) and MCP (client manager over the official SDK behind `McpClientLike`, streamable HTTP + stdio transports, ajv-validated tool wrappers, permission-gated execution, `/skills` and `/mcp` command families, `/context pin|unpin|auto|compact`); pinned files and skills feed the context pipeline as 'pinned'/'skill' candidates.

## Skills (`src/skills/`)

Discovery roots, in precedence order (highest first): `user`
(`~/.config/mediaxg/skills/`) > `project` (`<workspace>/.agents/skills/`) >
`global` (`~/.agents/skills/`), plus any `skillsPaths` from config. A skill is a
directory containing a `SKILL.md` with YAML frontmatter (`name`, `description`,
optional `license`/`compatibility`/`allowed-tools`/`metadata`); the frontmatter
parser is deliberately minimal (single-line scalars + the `metadata` map) and
fails loudly on anything else. Same-name definitions keep the winner and record
the shadowed sources.

All skills are **untrusted by default**; trust is opt-in via
`skillsSettings.trustedPaths`. Activation is explicit and lazy (`/skills on`);
instructions are loaded from disk only when a skill is active, capped at
32,000 chars. References are listed but never loaded until requested through
`read_skill_reference`, which re-validates containment (path traversal,
absolute paths, symlink escapes, binary files) on every call. `allowed-tools`
is recorded verbatim but never pre-approves. Reload re-stats by mtime+size and
auto-deactivates skills that became invalid.

## MCP (`src/mcp/`)

The official `@modelcontextprotocol/sdk` is isolated behind `McpClientLike` and
`McpClientFactory` in `src/mcp/client.ts` — no other module imports the SDK.
`MCPManager` owns lifecycle (connect / ensureConnected / ensureEnabledConnected
/ refreshMetadata / disconnect / closeAll), auth-header construction from the
credential store (config keeps only the ref), capability-gated discovery, and a
ring-buffered log. Two transports: streamable HTTP and stdio (env =
`getDefaultEnvironment()` + config env, stderr consumed line-by-line).

Every advertised tool is wrapped with `defineExternalTool` and validated against
its JSON Schema with ajv before any call. Names are `mcp__<server>__<tool>`
(sanitized, 64-char cap with a stable sha1 suffix). Permission class is `mcp`
and `mutating: true`, so plan/review modes never even see MCP tools, and every
call passes the same `PermissionEngine`. Server-reported `isError` is a tool
result; transport failures throw and are recorded. Output is capped (100k chars)
and wrapped with an untrusted-data header. URLs with secret-looking query
parameters or userinfo are rejected at config time; `oauth` auth is refused with
an honest "not implemented" error. Servers are added disabled by default;
`/mcp remove` requires `--yes`.

## Pinned context (`src/context/pipeline.ts`)

`/context pin <path>` stores a workspace-relative path in `session.pinnedPaths`
(default `[]`). `loadPinnedFiles` re-reads each file from disk on every request
(bounded by `PIN_MAX_BYTES=16000` per file and `PIN_MAX_FILES=20`), reports
read errors instead of throwing, and feeds 'pinned' assembly candidates (trust
`user`) plus a labeled block in the system prompt.

## Versioning

- Config: `version` field, migration in `ConfigManager.migrate()`.
- Sessions: versioned JSON per file + `index.json` (atomic writes, index rebuild on corruption, migration hook). SQLite remains a candidate in Phase G only if a real need appears (the JSON store already handles migrations and corruption).
