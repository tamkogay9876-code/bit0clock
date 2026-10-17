# Modes

- **Plan**: read-only. Mutations are blocked at the tool-registry and
  permission-engine level, not by prompt text.
- **Build**: implements changes under the central permission engine.
- **Review**: read-only inspection of changes.

Mode policy is enforced for every tool source including MCP. Rules cannot
override read-only modes; `--yes` auto-approves consequential actions but
never bypasses read-only modes or deny rules.
