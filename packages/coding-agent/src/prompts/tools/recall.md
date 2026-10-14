Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}`: specific facts or entries. `{{toolRefs.reflect}}`: synthesized answer across many memories.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`. With the wiki backend, hits are relevance-gated — a note must cover at least half of the query's terms, or hit one term rare in the vault, so fewer hits than the cap means fewer qualified (never padding) — and each line carries its capture suffix `[captured-at · scope · channel/status]` before the memory:// link.
