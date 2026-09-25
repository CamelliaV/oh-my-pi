# External Wiki Compile

Compile the vault at `{{vault}}`. Follow `AGENTS.md` in that directory.

Process the oldest files in `raw/inbox/`. A file is eligible only when it is a durable user preference, a verified reusable procedure, or a user-confirmed decision. Leave task progress, temporary state, tool output, and unverified speculation in inbox and record why.

For each accepted file, update the matching topic or create one. Update its `_index.md` and `wiki/_master-index.md`. Append one line to `wiki/_compile-log.md`. Move the source to the same scope under `raw/processed/` and set `status: processed`.

Do not delete rejected files. Stop after the summary.
