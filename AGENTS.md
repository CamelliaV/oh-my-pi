# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support                                        |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/coding-agent` | Main CLI application (primary focus)                                                    |
| `packages/tui`          | Terminal UI library with differential rendering                                         |
| `packages/natives`      | Bindings for native text/image/grep operations                                          |
| `packages/stats`        | Local observability dashboard (`omp stats`)                                             |
| `packages/omptype`      | ArkType-compatible schema validation with a lazy JIT runtime                            |
| `packages/utils`        | Shared utilities (logger, streams, temp files)                                          |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops                                       |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

## GitHub

Unless user tells you exactly what to write:

- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the omp CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `omp --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: git/jj operations go through the native
  `@oh-my-pi/pi-natives/vcs` binding (`import * as vcs from "@oh-my-pi/pi-natives/vcs"`,
  then `vcs.git(cwd)` / `vcs.repo(cwd)` handles — upstream v18.0.9 deleted
  `src/utils/git.ts`/`jj.ts`); rendering goes through the helpers in TUI Sanitization below
  (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

Prefer Bun APIs: `Bun.file()`, `Bun.write()`, `Bun.sleep()`, `$`cmd``, `bun:sqlite`, `Bun.hash()`. Use `node:*` only for what Bun doesn't cover. Never spawn shell commands for operations with proper APIs.


### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Model/Provider Policy Lives in KDL

**NEVER hard-code model- or provider-conditional policy in TypeScript.** No `id.includes("claude")`, no model-name regexes, no per-model lookup tables (effort ladders, pricing, context windows, modalities, API routing, quirk flags). All of it belongs in the KDL rule tree at `packages/catalog/src/compat/rules/`, compiled by `bun run gen:compat` into the committed `rules.json` and resolved at build time via `resolveModelPolicy`/`buildModel`.

Ownership strata (see `src/compat/rules/README.md`):

- `taxonomy/*.kdl` — identity: class membership, families, revision extraction, reviewed overrides, suffix collapse.
- `classes/*.kdl` — model-lineage truths (behavior inherent to a model line, on any host).
- `providers/*.kdl` — deployment contracts (behavior a host imposes), plus documented exact-id residue.
- `runtime/behavior.kdl` — heuristics that run before/outside exact model lookup (`api-routes`, `model-limits`, `exclude-models`, `pricing-peer`, hosted defaults).

Rules for TS code:

- Branching on model identity in TS is allowed **only** through structured facts from `classifyModel()` (`class`/`family`/`revision`/effort facts) — never through string matching on ids, and prefer a KDL axis when one can express the policy.
- Discovery mappers map authoritative upstream fields as reported; seed neutral values only for fields the upstream omits or misreports **and** KDL explicitly owns via a correction axis (`input-modalities`, `cost-patch`, `limits-patch`, `context-window-floor`, thinking axes). Assert rule-owned corrections through `buildModel`; raw discovery specs remain the right assertion surface for parsing/normalization contracts.
- An id that no selector can isolate gets an exact-id `models` residue rule with a comment — never a special case in TS.
- Equal-rank rule overlaps throw `AmbiguousOverlapError` at resolve time; fix with an explicit `priority=` in KDL, not code.
- After editing rules: `bun run gen:compat` and commit `rules.json` alongside the `.kdl` change.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen. The same applies to `packages/catalog/src/compat/rules.json`, compiled from the KDL tree by `bun run gen:compat`.

To change an entry, fix the source:

- **Model/provider policy** (identity, thinking ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) → the KDL tree in `packages/catalog/src/compat/rules/` (see the section above).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Discovery/request plumbing** (endpoint shapes, auth, response parsing) → the mappers in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Generator wiring** (upstream merges, premium multipliers, post-processing order) → `packages/catalog/scripts/generate-models.ts`.

Regenerate with `bun run gen:compat` and/or `bun run gen:models` and commit the generated files alongside the source change. Add a regression test against the **rule/descriptor/mapper**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- Never run `cargo test` directly for Rust tests — use `bun run test:rs`. It runs `cargo nextest run` (config: `.config/nextest.toml`) followed by a `cargo test --doc` pass, because nextest does not execute doctests. The doctest pass currently executes nothing (pi-natives is a `cdylib`, which rustdoc skips; pi-builtins' examples are `ignore`d vendored uutils docs) and exists so the first runnable doctest added to a lib crate is actually run.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.
## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. |
| `release` | Shipping build: fat LTO, 1 codegen unit, stripped. |
| `local` | Fast local release iteration: thin LTO, 16 codegen units, incremental. |
| `profiling` | `release` codegen with symbols kept, for `perf`/`samply`/Instruments. |
| `ci` | Thin LTO, no debuginfo, stripped. |

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib — measured 196 MB → 130 MB on a reqwest-sized graph at identical build times. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`.

Rejected, with measurements, so nobody re-litigates them: **sccache** (cannot cache incremental, bin, or proc-macro crates — measured slower than not using it), **mold** (ELF-only; no Mach-O support), and **`panic = "abort"` on `dev`** (Cargo ignores `panic` for the test profile, so the whole dep graph builds twice — 131 MB → 214 MB).

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.

### Good vs. bad test filter

- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it.
- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses.

- **Good**: transformation, branch/boundary, external contract, precedence, regression.

- **Bad**: static echo, success passthrough, wording/defaults, duplicate rows, placeholder tests.

- Prefer contract-level tests over implementation details.

- Tests must be full-suite safe. No `mock.module()` (leaks globally). Never source-grep.


## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

1. Ensure all changes since last release are in each affected package's `[Unreleased]` section.
2. Run `bun run release`.

The script handles version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

---

## Local Fork Workflow (cindy's build)

This checkout at `~/code/oh-my-pi` is a **patch fork** of upstream used to build
a customized `omp` binary. The system `omp` (`/usr/bin/omp`, pacman `omp-bin`)
stays untouched; the patched binary installs to `~/.local/bin/omp-patched`,
and BOTH `~/.local/bin/omp` and `~/.fzf/bin/omp` are symlinks to it (PATH
precedence beats `/usr/bin`; `~/.zshrc` also pins `hash omp=...` because
oh-my-zsh plugins pre-hash `/usr/bin/omp` at startup). `omp update` MUST NOT
be run — it would overwrite omp-patched with a stock release; upgrading is a
source-level rebase (below).

### Layout

- Baseline commit = pristine upstream tag source (from the release **tarball**,
  not a git clone — GitHub cloning is unreliable from this network; use
  `aria2c -x8 <tarball-url>`). Every commit after it is a local patch; keep
### Build

```bash

bun install --frozen-lockfile  # first time

RELEASE_TARGETS='linux-x64' bun run ci:release:build-binaries

install -Dm755 packages/coding-agent/binaries/omp-linux-x64 ~/.local/bin/omp-patched

```



**Upgrading**: Synthetic-commit merge (see `omp-fork-upstream-recon` skill). Copy new natives from `~/.omp/natives/<version>/`.

### Patch list (v18.1.10 baseline)

See `docs/fork-patches.md` for the full 31-patch rationale and verification recipes.

31. `feat(ai)` models.yml multi-key pools per provider (`apiKeys: string[]` + `apiKeyRotation: first-fill|round-robin`, default first-fill) synced as `source:"config"` rows into the AuthStorage credential pool — block-aware rotation, persisted usage-limit blocks, stable row ids across config reloads — `ai/auth-storage.ts, ai/auth/sqlite-credential-store.ts, config/{models-config-schema-bundle,models-config,model-registry}.ts, test/{auth-storage-config-api-key-pool,model-registry-api-key-pool}.test.ts`