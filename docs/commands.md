# Commands

mediaXG uses slash commands. Type `/help` for the full list.

## Core

- `/help`, `/status`, `/doctor`, `/exit`, `/clear`, `/cancel`
- `/mode plan|build|review`, `/think`, `/response`, `/temperature`, `/output-limit`

## Models and providers

- `/models`, `/model <id>`, `/provider`, `/connect`, `/disconnect`, `/auth`

## Sessions

- `/session`, `/resume`, `/search`, `/usage`, `/budget`

## Context

- `/context` (profile listing/selection, explicit token requests)
- `/context pin <path>` / `/context unpin <path>` (always include a file)
- `/context auto` (runtime-determined profile)
- `/context compact` (delegates to compaction)
- `/context inspect`, `/context budget`
- `/compact preview|run|restore|summaries [--keep=<n>]`

## Skills

- `/skills`, `/skills show|on|off|references|reference|diagnostics|reload`

## MCP

- `/mcp`, `/mcp list|add|show|test|enable|disable|remove|tools|resources|prompts|permissions|auth|logs`

## Workspace

- `/diff`, `/undo`, `/instructions`, `/review`, `/commit-message`, `/test`, `/lint`, `/tools`

## Memory

- `/memory`, `/memory add|inspect|search|remove|clear`

## Plan

- `/plan show|cancel|clear`

## Permissions

- `/permissions`

See the master prompt and `docs/ARCHITECTURE.md` for full details.
