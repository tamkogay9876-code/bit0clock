# Troubleshooting

- **No model selected**: run `/models` then `/model <id>`.
- **Provider connection fails**: check credentials with `/connect`; verify
  the base URL and that the key is not expired.
- **Context exceeds the model window**: `/context <tokens>` keeps intent and
  warns; use `/context auto` or a smaller profile; `/compact` to summarize.
- **Budget block**: read the reason (size/limit/spend/balance); adjust
  `/budget` limits or use `--yes` for confirmation (never bypasses blocks).
- **MCP server won't connect**: `/mcp test <name>` shows the error; check
  command/URL/env; servers are added disabled by default (`/mcp enable`).
- **Skill not discovered**: check roots and that `SKILL.md` starts with
  `---`; run `/skills reload`; `/skills diagnostics`.
- **Permission denied in non-interactive runs**: use `--yes` or add an
  allow rule; read-only modes still block.
- **Corrupt session/config**: mediaXG falls back with a warning and rebuilds
  the index; inspect logs.
- **TUI won't start**: requires a TTY; use `-p`/positional prompt for
  non-interactive execution.
- **Prettier/format**: run `bun run format` (if defined) or `npx prettier --write .`.
