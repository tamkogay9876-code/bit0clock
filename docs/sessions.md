# Sessions

Versioned JSON per file + `index.json`, atomic writes (tmp + rename), index
rebuild on corruption, migration hook.

- List, search, resume, rename, export, delete (two-step delete with `--yes`).
- Stores messages, provider/model ids, plans, tool-call records, summaries,
  usage estimates, timestamps, metadata.
- Secrets are never stored in session records.
- Interrupted runs leave an honest `interrupted` flag; the next startup
  reports it rather than pretending completion.
- Change ledger records agent-made file changes with before/after snapshots
  for `/undo`.
