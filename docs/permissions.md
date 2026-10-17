# Permissions

Single policy engine: session > project (`.mediaxg/permissions.json`) >
global > mode policy > safe defaults.

- Exact action beats wildcard; deny beats allow at equal specificity.
- Read-only modes (plan, review) deny write/execute/git/content actions
  absolutely; rules cannot override.
- `--yes` auto-approves consequential actions but never bypasses read-only
  modes or deny rules.
- Explicit user invocation (`/test`, `/lint`) satisfies confirmation for that
  action only.
- Every decision is appended to a bounded in-session audit trail, visible
  via `/permissions`.
- Non-interactive runs deny consequential actions with an actionable message
  pointing to `--yes` or a rule.
