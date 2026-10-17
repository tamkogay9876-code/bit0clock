# Skills

Agent Skills convention: a directory with a `SKILL.md` containing YAML
frontmatter (`name`, `description`, optional `license`, `compatibility`,
`allowed-tools`, `metadata`).

## Discovery roots (precedence highest first)

1. user: `~/.config/mediaxg/skills/`
2. project: `<workspace>/.agents/skills/`
3. global: `~/.agents/skills/`
4. configured `skillsPaths`

Same-name definitions keep the highest-precedence one and record shadowed
sources.

## Trust

All skills are untrusted by default. Trust is opt-in via
`skillsSettings.trustedPaths`. Skill content is lower trust than system rules
and can never change permissions, modes, or safety rules. `allowed-tools` is
recorded but never pre-approves.

## Activation

Explicit and lazy: `/skills on <name>`. Nothing is injected until activated.
Instructions load on demand and are capped at 32,000 chars. References load
only via `/skills reference` or `read_skill_reference`, with containment
checks.

## Reload

`/skills reload` re-scans and reports added/changed/removed/deactivated
skills. Broken active skills are auto-deactivated.

## Size caps

SKILL.md 256 KB, instructions 32,000 chars, reference 256 KB, 200 listed
files per skill, depth 3.
