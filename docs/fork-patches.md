# Fork patch list

Detailed rationale, wire measurements, and verification notes for every local
patch on top of upstream. `AGENTS.md` carries only the index; read this file
before rebasing, before touching a patched region, or when a patch's
reasoning matters.

## Patch list (v18.0.10 baseline; merged 2026-08-29 from v18.0.9 fork, merge commit recorded below)


1. `feat(tui)` user message bubble rounded frame — `user-message.ts` Box +
   `theme.boxRound`, `borderAccent`, `setIgnoreTight(true)`; OSC 133 markers
   open on the first frame row, close on the last.
2. `fix(ai)` zh relay thinking-effort 400 fallback —
   `openai-reasoning-fallback.ts` 不支持/请使用 patterns; guard keeps a
   still-allowed effort from downgrading (drop field = null).
3. `fix(ai)` misrouted-relay [1210] auto-retry, 3 layers —
   `fetch-retry.ts` dedicated `retryNonRetryableResponse` option opts
   non-retryable bodies into the retry loop (2xx never consults it — clone()
   would drain streaming bodies; ordinary 400s surface immediately so the
   reasoning-effort fallback layer owns them); `openai-http.ts` passes that
   opt-in for 400+[1210]/始终思考 bodies while `shouldRetryResponse` stays
   upstream's exact admission-rejection opt-out (v18.0.7 had overloaded the one
   gate — every OpenAI-wire 200 was transport-retried with backoff and its
   stream drained before return; caught by upstream v18.0.9's
   openai-reasoning-effort-fallback tests, fixed in 61c7f8b);
   `flags.ts` classifyText + `retryable.ts` mark the fingerprint Transient
   (turn-level auto-retry with retry budget/UI); `openai-completions.ts` strips
   `<think>` history once on always-thinking 400 (helpers:
   isAlwaysThinkingRejection / stripThinkTagsFromCompletionsParams /
   completionsParamsContainThinkTags). Regression driver:
   `test/reasoning-fallback-zh.ts` (resolver cases + transport cases: [1210]
   retries, plain 400 and 200 do not).
4. `feat(tui)` Ctrl+R rename in session picker — session-selector ctrl+r
   branch + HookInputComponent dialog-swap; persistence via
   `FileSessionStorage.updateSessionTitle` (source "user"); initialQuery
   prefill plumbing (selectSession → component → SessionList).
5. `feat(tui)` error/pending cards as frames without solid bg —
   output-block state=error/pending/running skips bg; default-renderer error
   text red; tool-execution wrapper drops tint (benign-skip keeps pending).
6. `feat(cli)` fuzzy `--resume <term>` — `fuzzyMatchResumableSessions`
   (title+firstMessage, substring>subsequence, local>global, dedup); single
   hit resumes directly, several open prefilled picker; wired in main.ts.
7. `feat(tui)` turn-level token usage aggregate — work-usage machinery in
   `work-usage.ts` (WorkUsageAccumulator/SessionUsageAccumulator) + dim
   aggregate row (`⏱ turn N req ⤵ in ⤴ out 💾 cache ⚡ span`); flushed on next
   user message / transcript end; wired into chat-transcript-builder,
   ui-helpers rebuild, event-controller live path. Esc-aborted requests count
   (provider billed them). v18.0.9 merge (ae8456d): upstream's per-row turn
   elapsed time (`display.showTurnTime`, `turnElapsedMs`, `#turnStartedAt`)
   coexists — union at all five call sites — and its `attribution !== "agent"`
   guard is adopted into `workUsage.begin` so an advisor tool-loop redirect no
   longer splits one work into two.
8. `feat(web)` codex-affinity search chain gating — codex search follows the
   running model's family: a GPT-family active model (api
   codex-responses/responses/completions + GPT id) prepends the codex provider
   ahead of `webSearchOrder`; any other active model drops codex from the auto
   chain entirely (explicit per-request `provider: codex` and sessionless
   `omp search` still work; `webSearchExclude` still wins). Predicate moved to
   `web/search/providers/codex-affinity.ts` (light, importable by the lazy
   registry). Regression driver: `test/web-search-affinity-driver.ts` (local
   mock codex relay; affinity → codex first, GLM → codex not attempted).
   Anthropic dimension (2026-08-29): an `anthropic-messages` active model whose
   id parses as Claude promotes the `anthropic` provider instead, and hosted
   search then reuses THAT model's transport — `baseUrl`, provider credential,
   `requestModelId`, cloak state, provider headers — via fork-local
   `web/search/providers/anthropic-affinity.ts`
   (`isAnthropicSearchAffinityModel` / `resolveAnthropicSearchTransport`).
   Scope is NARROWER than codex on purpose, because reusing the running model is
   a cost decision too: official `api.anthropic.com` models are EXCLUDED (the
   standalone path already reaches them, on the cheap `ANTHROPIC_SEARCH_MODEL`
   default — promoting affinity there would bill hosted search at Opus rates and
   silently reorder a working chain), and an explicit `ANTHROPIC_SEARCH_API_KEY` /
   `ANTHROPIC_SEARCH_BASE_URL` wins outright. Net blast radius: only Claude
   models on a custom Messages endpoint, where hosted search previously could
   not work at all. Also asymmetric with codex in the other direction: anthropic
   is NEVER suppressed for a foreign active model, because its standalone path
   targets official Anthropic with its own credentials and stays a valid
   fallback. Note `setSearchProviderOrder` never DROPS unlisted providers
   (unlisted ones keep built-in relative order), so promotion reorders rather
   than injects; removal is `webSearchExclude`, which still wins. Two facts the
   mocked unit tests could not have caught: the relay key lives in
   ModelRegistry's `#configOverrides` overlay (models.yml `apiKey`), NOT as an
   `auth_credentials` row — so availability and key resolution must go through
   `modelRegistry.authStorage` (same precedence codex.ts:945 applies; the
   standalone path deliberately keeps the caller's storage), and
   `isOAuth` must come from the resolved model, not `isOAuthToken()`, since relay
   keys are never `sk-ant-oat` yet still route to a CC-gated group. Wire-verified
   live against zzzcoding through a forwarding capture proxy with an isolated
   HOME carrying ONLY the zzzcoding-claude provider (no other search source has
   credentials, so "anthropic served it" is itself the discriminator): the search
   request was `/v1/messages?beta=true` at the relay, `model claude-opus-5` (not
   the haiku default), exactly one `web_search_20250305` hosted tool, claude-cli
   UA + CC billing system block, and a JSON `metadata.user_id` sharing the LLM
   turn's `session_id`/`device_id`. Tests: `test/web/search/provider-chain.test.ts`
   (anthropic promotion, official-endpoint and explicit-search-key exclusion,
   no-suppression asymmetry, codex precedence, bedrock-Claude rejection,
   transport reuse).
9. `feat(tui)` tool intent as highlighted card annotation — intent label
   (toolCall.intent / wire `i`) threaded through event-controller live path,
   ui-helpers + chat-transcript-builder rebuilds (incl. per-readCall group
   intents), rendered as first row inside the tool card frame in
   `tool-execution.ts` (`#renderBodyWithIntent`: accent `tool.intent` marker
   (new symbol key, ✦/*) + bold accent text, frame-width clamped; body wrapped
   in `#bodyBox` for injection). Same annotation in `read-tool-group.ts` rows.
   Gallery fixtures expose intent. Tests: gallery-cli, read-tool-group,
   tool-execution, event-controller-args-reveal.
10. `feat(extensions)` session-nav user-turn viewport jump — runtime extension
   at `extensions/session-nav.ts`, deployed by symlink to
   `~/.omp/agent/extensions/session-nav.ts` (rebase-immune, no binary rebuild).
   Alt+U or `/turns`: fuzzy picker of user messages on the active branch;
   Enter opens a fullscreen viewer rendering the branch through the REAL
   pipeline (ChatTranscriptBuilder via subpath import + TranscriptContainer
   assembly rules), viewport jumps to the selected block (n/p block-to-block,
   SGR wheel 3 rows/notch, ctrl+o tool-output expansion, turn/line footer
   synced from scroll offset, ⊕/☰ icons + accent numbers). ctrl+r rewind /
   ctrl+b branch are explicit isIdle-guarded secondary actions. Viewer leaves
   overlay mouseTracking off (selection-first: plain drag selects/copies text;
   kitty translates wheel to arrow keys on the alt screen). PTY-verified
   marker/jump/expansion/rewind + no-mouse-tracking-bytes paths.
11. `feat(extensions)` history_search recall over full session history —
   runtime extension at `extensions/recall.ts`, deployed by symlink to
   `~/.omp/agent/extensions/recall.ts` (rebase-immune, no binary rebuild).
   Compaction never deletes data: old entries stay on the branch tree, so a
   stateless `history_search` tool reads `ctx.sessionManager.getBranch()` and
   queries pre-compaction / pre-`/clear` messages directly (zero I/O, no JSONL
   parsing). BM25 with tier weights (user > assistant > tool I/O > thinking) +
   CJK bigram tokenizer for Chinese sessions; regex mode (`/re/` or
   `regex:true`); turn-grouped excerpts with 8k char budget + pagination;
   `expand:[entryId]` renders full originals and `include_images:true`
   re-attaches persisted image blobs (screenshots) the model lost to
   compaction. `loadMode: "essential"`, `approval: "read"`. Driver-tested on
   synthetic + real session JSONL; PTY-registered via live `/tools`.
12. `feat(extensions)` desktop-pet companion (bypasses disabled KDE notifications) —
   runtime extension `extensions/pet-bridge.ts` (deployed by symlink to
   `~/.omp/agent/extensions/`) + independent GTK4 layer-shell daemon
   `desktop-pet/omp_pet.py` launched via `desktop-pet/omppet` wrapper (LD_PRELOADs
   libgtk4-layer-shell; without it layer init fails and the window degrades to a
   plain toplevel). KDE autostart: `~/.config/autostart/omp-pet.desktop`; hub name
   `omp-pet`. Bridge pushes lifecycle state over `$XDG_RUNTIME_DIR/omp-pet.sock`
   (JSON lines: hello/state/settle/poke/bye); `agent_end.willContinue` ignored;
   esc-abort settles calm, error settles alert; open `ask` call or final
   assistant message ending in ？/? settles as waiting("ask") NOT done — a
   turn parked on user input is not a completion (verified live);
   queued steering holds the working pose instead of flashing done;
   terminal auto-retry failures (empty-stop retry cap etc.) settle as ERROR —
   turn-recovery drops the failed assistant turn from the branch, so the
   bridge remembers auto_retry_end{success:false,finalError} and agent_end
   consumes it before the stopReason classification can celebrate.
   waiting/done/error poses persist until clicked (`acknowledge_all`); working
   states are ambient motion; idle >3min sleeps with zzz; multi-session aggregate,
   newest-active wins, ×N badge. Model interaction: `pet_poke` tool (approval
   "read", default discoverable) + `/pet` command + alt+p shortcut return one-line
   reactions; plain click = local petting; right-click = context menu with
   退出 (quit action in a widget-level "win" SimpleActionGroup — plain
   Gtk.Window has no action map in GTK4). Position/mood persist in
   `~/.local/state/omp-pet.json`. PangoCairo.show_layout takes exactly (cr, layout)
   — position via ctx.move_to first. Read-only session supervision: daemon scans /proc every 3s for omp/omp-patched
   processes (excludes __omp_worker_* helpers and zombies), so the ×N badge counts
   REAL sessions including ones started before the bridge existed (they render as
   `○ pid … · <proj> · 未桥接` until restarted with the extension loaded); hover
   opens the supervision panel listing every session (bridged: glyph+state+tool+
   elapsed; unbridged: pid+proj). Clock semantics: TURN clock (monotonic since
   prompt) not state age — bridge marks the first working frame of each turn
   `fresh:true`; tool flips within a turn never reset the timer; `ask` tool maps
   to waiting, not a churning tool. Window drag tracks the pointer by PER-UPDATE
   DELTAS (GtkGestureDrag offsets are cumulative from the press point — deltas
   cancel constant compositor discrepancies) with layer-shell anchors FROZEN for
   the whole gesture: flipping anchors mid-drag re-places the surface under the
   grabbed pointer and corrupts all later surface-local offsets, which is why a
   one-shot drag across the screen midpoint used to die. Nearest-edge re-anchor
   + clamp happen once on release; wlr-layer-shell margins apply only on ANCHORED
   edges, so set_anchor must flip LEFT/TOP together with RIGHT/BOTTOM and margins
   go on the matching pair. The omppet wrapper must readlink -f BASH_SOURCE:
   symlink invocation (~/.local/bin/omppet) otherwise resolves omp_pet.py in
   ~/.local/bin and dies.
   PTY-verified live turn: bash + pet_poke round
   trip, `/pet status` 在线, parallel-session badge matched /proc ground truth;
   replay-verified all poses. Skins: `desktop-pet/skins.py` plugin module —
   `--skin cat|image:<png>|frames:<dir>|live2d:<model-dir>` (persisted in
   `~/.local/state/omp-pet.json`; bad asset/deps fall back to cat with a stderr
   notice). image = one cutout PNG animated by the shared pose dict; frames =
   `<state>-<n>.png` sequences with alias chain (done→idle etc.), ~7fps; live2d =
   live2d-py + GtkGLArea overlay (chrome drawn on a DrawingArea above GL),
   optional per-model `motions.json` mapping pet states→motion/expression.
   Launcher prefers `~/.local/share/omp-pet/venv/bin/python` when it can import
   gi+live2d. Cairo gotcha: clip() consumes the path — pixbuf draw must end in
   paint_with_alpha(), fill() after clip() is a no-op; PyCairo has NO
   ctx.global_alpha; ImageSurface.create_for_data needs a WRITABLE buffer
   (bytearray, not bytes). live2d mode RUNTIME-VERIFIED with Hiyori sample
   (~/.local/share/omp-pet/models/Hiyori + motions.json state→motion map):
   build recipe = PyPI sdist (GitHub main branch lacks Live2D/CMakeLists) +
   pre-place CubismSdkForNative zip into cubism_sdk_temp.zip + inject
   `#include <cstdint>` into .hpp/.cpp only (NOT Glad .c/khrplatform.h —
   <cstdint> is C++ and breaks the C build) + venv pip wheel; system python
   3.14 has no cp314 wheel so venv is mandatory. Rendering goes through an
   EGL pbuffer + OpenGL 2.1-compat context blitted to Cairo as premultiplied
   BGRA — GtkGLArea CANNOT host Cubism (GDK only offers core/ES; Cubism
   shaders are GLSL 120 → silent empty draw). ctypes c_int arrays reject
   float sizes (BODY_BOX must be int()). KWin logical coords ≠ spectacle
   physical pixels under 1.5× scale — locate windows by color-clustering the
   screenshot, not by geometry math.

   Tab-focus auto-ack (2026-08-29): switching the terminal to a session's
   tab/window clears THAT session's waiting/done/error pose (the per-session
   analogue of acknowledge_all's click). Signal chain: terminal.ts enables
   DEC 1004 focus reporting in #attachInput (disables in stop() +
   emergency restore) and consumes CSI I/O in the stdin handler (they must
   never reach the editor as keystrokes), dispatching via module-level
   `onActiveTerminalFocusChange()` — runtime extensions importing
   `@oh-my-pi/pi-tui` observe the SAME module instance the running TUI
   dispatches to (bundled-module loader uses literal `import()` of the
   canonical specifier; verified wire-level). pet-bridge sends `{"t":"focus"}`
   on focus-in only (blur carries no action; reports arrive only on real
   transitions — a session that never leaves its tab sees no events and needs
   none); omp_pet.py apply_frame clears that conn's attention. kitty 0.48
   delivers ESC[I/ESC[O on plain tab switches (verified with an isolated
   kitty + own rc socket); terminals/multiplexers without 1004 stay silent.
   New omp sessions only (extension loads at start) + daemon restart for
   python changes.

   Background-session hierarchy (2026-08-29, second half): task subagents
   re-bind pet-bridge's factory in the PARENT process (executor forwards
   preloadedPreparedExtensions; hasUI=false — their approvals auto-deny),
   so every background task used to bridge as a FLAT sibling session whose
   done/error pose could never be cleared (no tab to switch to). Bridge now
   marks hello with `bg: !ctx.hasUI` (both initial and reconnect identify)
   and bg bridges never subscribe to focus. omp_pet.py: bg views have
   attention=None (never poses/bubbles; panel-visible ambient state only —
   done/error show as "后台 · 完成/出错" rows), primary() prefers foreground
   sessions for the working pose (bg working shows only when no fg session
   runs), total_live() counts foreground pids only (bg views share the
   parent's pid — the ×N badge no longer inflates during task fan-outs),
   and supervision_rows nests bg views under the same-pid foreground view
   (↳ + dim, sorted by recency; orphan bg — print runs, dropped parent conn
   — get a top-level 后台 row). Note: ALL task subagents run in-process
   ("isolation" is git-worktree isolation, not process isolation). Verified:
   daemon model driver (attention gating, nesting, badge, primary
   preference), bun fake-pi driver (hello bg flag both ways + bg settle),
   PTY focus tests re-run green.

13. `fix(tui)` kitty per-screen graphics store retransmit — kitty 0.48.2 keeps
   one graphics store per screen buffer: `a=t` data sent on the main screen is
   ENOENT to alt-screen placements (and vice versa; neither store is destroyed
   by the switch). Resume floods transmit images on main, so the session-nav
   viewer (fullscreen overlay on the alt buffer) bound placeholders to nothing —
   empty frames, no terminal error, because `encodeKittyVirtualPlacement`
   hardcodes q=2 which on kitty 0.48.2 suppresses even error replies (q=1
   reports errors, no-q reports errors; verified empirically). Fix (0a6703c):
   ImageBudget tracks transmitted ids per screen (`#transmittedMain/Alt` +
   `#screen` flipped by TUI on 1049h/1049l in `#doRender`); ids first sent on
   the other screen re-transmit once per crossing; purges/forgets clear both
   ledgers; no re-send when the target store already has the data (main-screen
   repaint after an overlay round-trip costs nothing). Viewer's first open
   re-sends ~1.5 MB (376×4096 chunk chain) — a visible sub-second delay is
   expected and correct. Diagnostics kept: OMP_IMG_DEBUG=1 upgrades q=2→q=1 on
   all graphics commands (kittyQuietFlag) + kimg: logger.debug lines in
   image.ts render/emit paths. Debug recipe that cracked it: minimized-kitty
   instance running a python tty probe (DSR sanity + q=1 graphics commands,
   replies file-logged — q=2 silence masks ENOENT), capture-slice bisection
   (full stream blank vs chain+tail renders), popup windows sized in cells
   (`--override initial_window_width=110c`) with rc-socket focus + spectacle -a,
   user as visual oracle. PTY pyte traps: pyte lacks APC/colon-SGR support
   (prints payload tails as text — artifact, not evidence); pyte cell data can
   be multi-char (combining diacritics) — width checks must handle len>1.

14. `feat(tui)` read-only Workspace Inspector — `workspace-inspector/`
   (component.ts, index.ts, git-snapshot.ts). Ported to the native vcs binding
   in the v18.0.9 merge (ae8456d): `vcs.git(cwd)` handle;
   statusPorcelain/head/numstat/diffText/diffNoIndex/logOnelines/showCommit;
   the old `allowFailure` diff option became caught `VcsError` (unborn HEAD →
   empty diff/numstat); branch label `head.branch ?? head.refName ?? "HEAD"`.
   Module-level smoke verified status/head/numstat/history/commitDiff plus
   modified (diffText) and untracked (diffNoIndex) paths.
15. `feat(tui)` bash-mode Ctrl+R command history search — with a `!` / `!!`
   prefix in the composer, Ctrl+R opens a "Command History" picker over the
   user's shell history (HISTFILE / zsh extended format with backslash
   multiline continuation, bash fallback; 4MB tail cap + mtime cache in
   `session/shell-history.ts`) merged with the session's `!` / `!!`
   commands from the branch (omp-run commands never enter the shell history —
   non-interactive shell). Session-sourced rows carry an accent `omp` tag;
   the typed fragment seeds the query; selection preserves the `!` / `!!`
   prefix. HistorySearchComponent generalized to a `HistorySearchSource`
   interface (HistoryStorage satisfies it structurally) + title/initialQuery
   options; dispatch branch in selector-controller.showHistorySearch. Tests:
   test/shell-history.test.ts (16); PTY-verified with fake + real HISTFILE.
16. `feat(tui)` bash-mode Tab completion + history ghost text —
   `modes/bash-autocomplete.ts` wraps the base autocomplete provider
   (stacked below extension factories in #applyAutocompleteProvider): Tab on
   the first token completes PATH executables + shell aliases (one-shot
   `zsh -ic 'alias -L'`, 300ms Tab budget, 5s kill cap; `-g`/`-s` aliases
   skipped; real output has the `alias ` prefix), later/path-like tokens get
   cwd-anchored path completion (own implementation — the prompt-action
   wrapper never exposed getForceFileSuggestions, so bare-path Tab completion
   doesn't exist upstream; dirs get trailing `/` + no space, files a space).
   Ghost text suggests the newest matching history command (same merged
   source as patch 15, preloaded at construction so the first render has it),
   accepted with →; pi-tui gained a `getInsertableHint` provider contract so
   only insertable ghosts are accepted (slash-arg hints stay display-only).
   Tests: test/bash-autocomplete.test.ts (17); PTY-verified 6/6 (ghost render,
   → accept, popup, apply+execute, file completion, alias completion).
17. `fix(ai)` Claude Code cloak seam + relay `device_id` enrichment — real CC
   always pairs `session_id` with a non-empty `device_id` in the JSON
   `metadata.user_id` envelope, and sub2api `claude_code_only` groups reject
   envelopes missing it (503 "this group only allows Claude clients"), so an
   OAuth-shaped caller supplying session-stable JSON now gets one filled in from
   the install id (scoped by the envelope's own `account_uuid`) rather than
   having the whole id regenerated, which would churn backend session
   attribution (commit fc0c59d). The helper lives in fork-local
   `packages/ai/src/providers/claude-code-cloak.ts`, NOT inside upstream's
   ~4.4k-line `providers/anthropic.ts`, which keeps only a one-line import plus
   a three-line call site in `resolveAnthropicMetadataUserId` — cloak conflict
   surface there dropped 27 → 4 lines. The device-id deriver is injected instead
   of imported to avoid an import cycle back into `anthropic.ts` (which owns
   `deriveClaudeDeviceId`); compiled-binary cycles risk TDZ. Also threaded an
   optional `modelHeaders` through `AnthropicAuthConfig` /
   `buildAnthropicSearchHeaders` so a caller reusing a configured model's
   transport can forward relay headers on non-streaming Messages requests.
   Future body-shape cloak divergences belong in that module. Rationale for NOT
   minting an `Api` kind for CC-cloaked Messages (considered and rejected
   2026-08-29): `buildCompat`'s `default: return undefined` would silently drop
   the whole `AnthropicCompat` (14 fields incl. `allowAnthropicHeaderOverrides`,
   `streamIdleTimeoutMs`, `supportsCacheRetention`), and `model-thinking.ts`'s
   `needsDisplay` / `getAnthropicAdaptiveEfforts` hard-gate on
   `anthropic-messages` | `bedrock-converse-stream`, so opus ≥4.7 would lose
   adaptive thinking display even with explicit `thinking.efforts` — silent
   degradation across 152 comparison sites, all upstream. If the cloak ever needs
   a first-class flag, add an `AnthropicCompat` field (beside
   `escapeBuiltinToolNames` / `allowAnthropicHeaderOverrides`), which is 1 field
   + 1 resolver default and also splits `isOAuth`'s two meanings (credential
   mechanism vs fingerprint persona). Tests: `test/anthropic-alignment.test.ts`.
18. `fix(ai)` relay prompt-cache restored by scoping the `cch` attestation —
   the CC billing header lives in `system[0]` and its `cch` was
   `xxHash64(whole body)`, so it changed every turn and invalidated the entire
   cached prefix on any endpoint that forwards the block as ordinary system
   text. Official `api.anthropic.com` is immune (its edge strips the block
   before the cache layer, which is why real CC gets away with a per-request
   value), but every relay pays full `cache_creation` on every request.
   Fork-local fix in `providers/claude-code-cloak.ts`
   (`selectClaudeCchHashRegion`): off-official endpoints hash only the
   session-stable region — from `"system":[` to end of body, clipped at
   `"messages":[` if key order ever inverts — so `cch` changes exactly when the
   cached prefix does. `patchCch` / `wrapFetchForCch` take a `stableCch` flag;
   both call sites gate on `!isOfficialAnthropicApiUrl` (streaming
   `anthropic.ts`, and hosted search `web/search/providers/anthropic.ts`).
   Upstream declined the same report (anthropics/claude-code#68900, closed not
   planned). Omitting the block — what `CLAUDE_CODE_ATTRIBUTION_HEADER=0` does
   in real CC, and what claude-code-router/braintrust-lingua do — is NOT
   available here: `claude_code_only` groups reject CC-scoped credentials whose
   request lacks it, and the gist-documented placement contract requires it to
   be `system[0]` with no `cache_control`. Safe because such relays validate the
   header's *shape*, not the hash (they cannot recompute it without the seed) —
   wire-verified: a deliberately bogus constant `cch` still served fine.
   Live A/B through a forwarding capture proxy, same prompt, same 5-call tool
   loop, before/after binaries: 6 distinct `cch` → 1 constant `cch`, 0/6 → 4/6
   cache hits, 329,463 → 109,827 cache-write tokens, 80.8s → 43.4s wall, ≈61%
   cheaper per session at catalog rates. Second, independent breaker found and
   deliberately NOT addressed: cross-session hits never happen because the
   relay routes by `metadata.user_id.session_id` to different upstream accounts
   (proved by pinning `cch` at the proxy and observing two runs with
   byte-identical `system`/`tools`/`msg[0]` still miss) — that is relay-side,
   not ours. Tests: `test/anthropic-cch-cache-stability.test.ts` (stability
   across turns, invalidation on system/tools change, official-endpoint
   fidelity, 5-hex wire shape, API-key passthrough).
19. `feat(ai)` provider-declared Anthropic betas via `compat.extraBetas` — a
   relay can require a beta the generated chain never carries: anyrouter 400s
   every opus-class request ("1m 上下文已经全量可用，请启用 1m 上下文后重试")
   without `context-1m-2025-08-07`, which upstream deliberately never advertises
   because official OAuth subscriptions have no long-context credit and hard-429
   on beta-gated 1M models regardless of prompt size (#7238). Wire-measured on
   one relay, three spellings: a models.yml `headers: { anthropic-beta: … }`
   entry is DEAD (the key is in `enforcedHeaderKeys`, stripped in BOTH cloak and
   api-key modes — 10 betas / 2 betas, no 1M); `compat.allowAnthropicHeaderOverrides`
   does deliver it but `mergeHeaders` is whole-value replacement per key, so the
   10-beta cloak chain collapses to 1, losing `oauth-2025-04-20` and
   `effort-2025-11-24`; `compat.extraBetas` unions through the existing
   `buildBetaHeader` dedupe — 11 betas, full chain + 1M, 400 gone. Field lives on
   `AnthropicCompat` (catalog `types.ts`, defaulted `[]` in `buildAnthropicCompat`,
   declared in the STRICT models.yml schema bundle beside the other
   anthropic-messages compat flags) and is unioned inside
   `buildAnthropicClientOptions`, NOT at the stream call site, so every client
   build carries it; the `github-copilot` early-return branch is excluded on
   purpose (that proxy rejects Anthropic betas outright). Hosted search builds
   its own headers and never sees `model.compat`, so a relay that gates chat
   gates search too: threaded `AnthropicSearchTransport.extraBetas` →
   `AnthropicAuthConfig.extraBetas` → unioned with `web-search-2025-03-05`.
   Residual anyrouter 503/429 is upstream capacity, not request shape — plain
   curl bypassing omp entirely, no cloak, only that beta, returns 503 while the
   beta-specific 400 is gone; the codex-side sibling reports
   "当前模型 … 负载已经达到上限" WITH a request id, i.e. shape accepted. Trap: a
   compat field declared in the wrong schema block makes
   `ModelsConfigFile.tryLoad()` return an issue whose `message` is `undefined` —
   diagnose by locating the right block, not by reading the error. Tests:
   `test/anthropic-alignment.test.ts` (union keeps the chain, 1M still absent by
   default), `test/web/search/provider-chain.test.ts` (transport carries
   provider betas).
20. `fix(tui)` draft-image preview strip follows the active composer shape —
   v18.0.10 added the `band` composer (`sideBorders: false`,
   `sideChromeWidth() === 0`) and made it the schema default, which exposed a
   latent bug in the fork's leading-rows hook: it hardcoded `box.vertical` +
   `paddingX` on BOTH sides while padding the text to `contentAreaWidth`, so on
   every borderless shape the strip came out `width + 2` cells and misaligned
   against the frameless text rows. It now renders through
   `style.renderRow({ …chromeCtx, gutter: <blanked>, isLastRow: false })` exactly
   like a content row, and the `#borderVisible` gate is gone because
   `#effectiveStyle()` already substitutes `borderlessComposerStyle` when the
   border is hidden — so previews survive in borderless mode instead of
   vanishing. The prompt gutter is blanked, not repeated: its `╰─ ` cue belongs
   to the input line but its cells still belong to the content budget. Verified
   with a throwaway driver over all 8 shapes (box/band/borderless/rule/field/
   rail/pi/claude): strip present, every row ≤ width, box keeps `│ … │`, band and
   friends render flush. Note for future confusion: cindy's own config pins
   `composer.shape: box` in `~/.omp/agent/config.yml` (NOT `settings.json`, and
   the `settings` table in `agent.db` is empty), so the band default never
   reached her — the fix is for shape switching and the borderless shapes.

   Merge adjudications (v18.0.9 → v18.0.10, 41 upstream commits / 159 files):
   the only textual conflict was `event-controller.ts`'s import block, where
   upstream deleted `interruptHint` (definition and call site — the interrupt cue
   moved into the new status line, `setWorkingMessage(trimmed)`) right beside the
   fork's `work-usage` imports; resolution keeps ours minus the now-dead import.
   Everything else auto-merged, including two overlaps worth knowing: (a)
   upstream's `→`-accepts-completion (`#acceptWordCompletion`, end of LINE) and
   the fork's `→`-accepts-provider-ghost (`#getInsertableHint`, end of BUFFER)
   form a fallback chain rather than double-inserting, and the fork's hook is
   still required because history ghosts come from the provider, not the built-in
   word completion; (b) `turn-recovery.ts` / `agent-loop.ts` grew only additive
   helpers (`toolReplayStart`, `hasAbortedToolCallTail`, `unpairedToolCallTail`),
   so pet-bridge's `auto_retry_end` → ERROR settle is unaffected — though the new
   idle "F5 to Retry" state is not yet a pose the daemon knows.
   NATIVES ARE A HARD PREREQUISITE for this tag: `execReplace` (`/restart`) and
   `VcsGitRepo.mergeBase` (`/review` PR mode) are new and BOTH call sites are
   unguarded, so v18.0.9 `.node` files give a degraded `/restart` and a
   `TypeError` on `/review`.
21. `fix(ai)` Anthropic user turns always serialize as content blocks —
   `applyPromptCaching` can only attach `cache_control` to a block, so a
   string-content user message was rewritten into `[{type:"text",…}]` while it
   held the rolling cache anchor and serialized back to a bare string once the
   window moved past it. Every user turn therefore rewrote a byte in the middle
   of the cached prefix, truncating the reusable region there.
   `convertAnthropicMessages` now emits block form unconditionally (the
   synthetic `Continue.` pad stays a string — upstream tests pin it and
   `applyPromptCaching`'s pad detection compares against that exact string), and
   the now-dead string branch in `applyPromptCaching` is gone.
   MEASURED WORTH, stated plainly because it is smaller than it looks: on a
   ~96 KB body, `system` (55,980 B) + `tools` (39,854 B) are 99% of the prompt
   and were ALREADY byte-identical across turns, so the flip only truncated the
   *messages* region — 386 B on turn 1→2, 25 B after. Live A/B (old vs new
   binary, same 3-call loop, same relay): shape flips 1 → 0, reusable leading
   messages 0/1 → 1/1, total prompt tokens unchanged. It is a correctness fix,
   NOT the reason a relay session shows five-digit cache writes.
   Blast radius accepted deliberately: this changes the wire for every
   `anthropic-messages` backend. A single text block is the API's documented
   equivalent of string content and token counts are identical, but four
   upstream tests asserted the old string shape and were updated
   (`anthropic-mid-conversation-system` ×2, `anthropic-prefill`,
   `anthropic-alignment`, `issue-967-vision-guard`) — that is rebase conflict
   surface. Tests: two cases in `anthropic-cch-cache-stability.test.ts` assert a
   user turn serializes identically anchored vs interior, and that every
   interior turn stays byte-stable as a loop grows.

   WHAT THIS DID NOT EXPLAIN, and the evidence, so nobody re-runs it: cindy's
   screenshots showed omp writing five-digit cache tokens per request while real
   Claude Code wrote three-digit. Both clients point at the SAME relay
   (`~/.claude/settings.json` sets `ANTHROPIC_BASE_URL=https://api.zzzcoding.org`),
   so "CC is on official Anthropic" is false. The dominant cause is the relay,
   not request shape: a BYTE-IDENTICAL body replayed against it scored 4/10 cache
   hits at ~13:00 and 0/10 at ~15:20 the same day, and real Claude Code measured
   through its own session JSONL at ~15:40 got 0/5 hits with 17,978–20,768
   cache-write tokens per request — i.e. five-digit writes too. Anchor placement
   is also a dead end: adding CC-style static breakpoints on `system` and the
   last tool moved 11,964 tokens from `cache_creation` to plain `input` and left
   the TOTAL prompt tokens bit-for-bit identical (46,854 either way), with 0 hits
   both ways. The one durable client-side difference is prompt SIZE: omp ~46,900
   tokens/request vs CC ~20,700 for the same task, so on any miss omp pays ~2.3×.
   That is what shrinking the injected context attacks (see the AGENTS.md split
   in this commit series), not breakpoint geometry.
