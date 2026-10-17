# Installation

## Requirements

- Bun 1.1+ (https://bun.sh)
- A terminal with TTY support for the interactive TUI (non-interactive mode
  works without a TTY)

## Install

```bash
git clone <repo>
cd mediaxg
bun install
```

## Run

```bash
bun run dev          # interactive TUI
bun run src/cli.ts --help
```

## Build

```bash
bun run build        # outputs dist/cli.js
bun run src/cli.ts --doctor
```

## Test

```bash
bun test             # full suite
bun run typecheck    # tsc --noEmit
```

## Supported runtimes

- Bun (primary). Node is not supported (Bun APIs and bun:sqlite-style
  behavior are assumed).
- Linux and macOS are the tested platforms; Windows is unverified.
