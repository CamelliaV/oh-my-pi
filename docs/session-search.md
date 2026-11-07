# Session search extension

The runtime entry is `extensions/recall.ts`, normally loaded through
`~/.omp/agent/extensions/recall.ts`. Restart OMP to load changed extension modules;
no CLI binary rebuild is required. Shared extraction/BM25/branch code is in
`extensions/recall/core.ts`; cross-session search is in `recall/session-search.ts`.

`history_search` reads the current in-memory branch, including entries outside the
context window. `session_search` scans other persisted JSONL sessions, including
nested subagent transcripts, with a case-insensitive conservative prefilter,
source-weighted BM25, best-hit session ordering and match-centered snippets.

## Query and follow-up operations

- `query`, `scope:"project"|"all"`, `days` (30 by default, 0 for all time).
- `match:"any"` preserves OR ranking; `all` requires every ASCII token and every
  contiguous CJK query run in one fragment; `phrase` matches a literal continuous
  string ignoring case. Regex continues to operate on lowercased tokens.
- `sources:"conversation"` restricts to user/assistant text. `all` includes tools,
  thinking, tasks and summaries. Direct history/session search calls and results
  are excluded unless `include_search_results:true`; embedded copies in other
  tool outputs are not heuristically deleted.
- `nextPageCursor` pages session groups; each group has `nextMatchCursor` to page
  its matching fragments. `continueScanCursor` resumes a bounded scan and
  reranks, invalidating the previous revision's page and match cursors.
- Copy a result's `expandArgs` verbatim: it includes `scope`, `query`, `match`
  and the complete project/path `sessionRef#entryId`. The expansion starts near
  the match. Without a query or explicit offset, expansion starts at the beginning.
- Expansion accepts `context:0..5`, `offset` and `limit:2..12000`. Offsets are
  UTF-16 positions in rendered, tab-normalized original content. Follow
  `nextArgs` / `previousArgs` in structured details or `nextContent` /
  `previousContent` in text. These include a `contentRevision` hash, preventing
  pages of different content generations from being spliced together.
- `include_images:true` attaches images only from the requested entry, not its
  neighbors. Text expansion has a shared output budget; read one reference at a
  time for long content.

## Snapshot and branch semantics

Search results explicitly describe **historical evidence captured per file**,
not a continuously refreshed assertion about every file's current branch. Each
file's stable byte prefix is hashed when read; continuation of that file reads
and verifies that prefix. Later appends are excluded from that capture. Files not
yet scanned are captured when reached; this is not an atomic whole-corpus snapshot.
A new search includes newer content and newly created files.

Unrelated writes do not invalidate cached pages or continuation. If a partially
scanned file is truncated, replaced, or its captured prefix is rewritten, only
that file's collected fragments are dropped and rescanned; `changedFiles`
identifies it. A file changing during capture is reported as incomplete if a
stable prefix cannot be verified. Completed files' results remain snapshots.

Expansion rereads the current transcript and verifies its active parent chain.
It refuses a withdrawn entry, an unreadable branch or a file that changed during
that read. A snapshot hit therefore remains inspectable as a search result but
cannot silently be expanded as current evidence after it was rewound.

## Budgets and limitations

Each scan call has a 6,000 parsed-candidate-entry budget and an approximate
5-second work budget, checked between files and lines. Files are capped at
64 MiB. File reading, branch extraction, parsing a large line and JavaScript
regex matching are not preemptible at that deadline. Cache size is estimated and
bounded to four queries / 64 MiB, with a 10-minute TTL; a single query stops
collecting at its document/memory cap and reports the reason. This is not a
persistent index or a semantic search system.

Ranking is cached within a scan revision so result pagination does not rerun
BM25. `complete` describes processing of the candidate manifest and captures;
`evidenceState:"captured-snapshot"` and per-session `capturedAt` describe freshness.
The current session is excluded to avoid searching the tool's own new output;
use `history_search` for it.

## Validation

```sh
bun test packages/coding-agent/test/recall-search.test.ts \
  packages/coding-agent/test/recall-search-continuation.test.ts
bun run check:ts
```

These tests cover case/escaping, ranking/snippets, nested references, source and
query modes, session and fragment pagination, file-internal continuation,
concurrent appends, prefix replacement, withdrawal checks, long content paging,
UTF-16 page boundaries and content revisions. The original manual driver remains
available at `packages/coding-agent/test/recall-extension-driver.ts`.
