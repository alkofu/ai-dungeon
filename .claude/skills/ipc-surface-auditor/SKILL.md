---
name: ipc-surface-auditor
description: >
  Apply this skill when auditing the IPC boundary between Rust and TypeScript
  in this Tauri project: when adding or modifying Tauri commands or events,
  when reviewing a PR that touches `src-tauri/src/` or TypeScript files that
  call `invoke()` or `listen()`, or when investigating runtime errors related
  to command invocation.
---

# IPC Surface Auditor

## Goal

Systematically audit the Tauri IPC surface to detect mismatches between the
Rust backend and the TypeScript frontend before they become runtime bugs.
By default, Tauri maps Rust `snake_case` **parameter names** to `camelCase`
on the TypeScript side (command function names are passed **verbatim** as
snake_case), and event names must match exactly — both classes of mismatch
are easy to introduce and hard to spot in review.

The audit has three parts:

1. **Command audit** — every Rust `#[tauri::command]` function has a
   matching TypeScript `invoke()` call with the function name passed
   verbatim (snake_case) and parameter keys in camelCase.
2. **Event audit** — every Rust `emit()` / `emit_to()` / `emit_filter()`
   call has a matching TypeScript `listen()` call with an identically-spelled
   event name.
3. **Registration audit** — every Rust command implementation is actually
   registered in `tauri::generate_handler![...]`. Unregistered commands
   compile cleanly but fail at runtime when invoked.

## Audit process

### Step 1 — Enumerate Rust commands

Find every `#[tauri::command]` annotation in the Rust source tree:

```bash
grep -rn "#\[tauri::command" src-tauri/src/
```

Note: the pattern intentionally omits the trailing `\]` so it also matches
attribute variants such as `#[tauri::command(async)]` and
`#[tauri::command(rename_all = "...")]`. A pattern that ends in `\]` will
silently skip those forms.

> **Discovery pass:** this grep is a starting point, not proof of
> completeness. If any commands are defined through macros, re-exports,
> or generated code, those paths require manual inspection.

For each match, read the function signature on the next line and extract:

- The function name (snake_case) — this is what gets passed **verbatim** as
  the first argument to `invoke()` on the TypeScript side. Tauri does
  **not** auto-convert command function names.
- The parameter names and their types. Ignore the `state: State<'_, ...>`
  parameter; Tauri injects it and it is not part of the IPC surface.
- The return type (typically `Result<T, String>`).
- Any attribute overrides: `#[tauri::command(rename_all = "...")]` on the
  command itself, or `#[serde(rename = "...")]` on the parameter struct
  fields. These overrides take precedence over the default conversion rule
  in Step 2 — inspect the attribute and any parameter struct definitions
  before applying the default.

### Step 2 — Determine the expected TypeScript names

Apply two fixed rules for the command name itself and its parameters.

**Command name (the string passed as the first argument to `invoke()`):**
Passed **verbatim** as snake_case. Tauri does **not** auto-convert function
names. Example: `fn pty_spawn` is invoked as `invoke("pty_spawn", ...)`,
not `invoke("ptySpawn", ...)`.

**Parameter keys (the keys of the argument object passed as the second
argument to `invoke()`):** Resolve the expected frontend key name using
this precedence, top wins:

1. **Field-level rename** — a `#[serde(rename = "customKey")]` attribute
   on the parameter's struct field overrides the command-level rule. Use
   the exact string from the attribute. (This follows serde's standard
   field-over-container precedence and is very likely correct for Tauri v2
   commands, which use serde for deserialization — but no official Tauri
   documentation page explicitly confirms this interaction. Verify against
   the `tauri-macros` source if precision is critical.)
2. **Command-level rename rule** — `#[tauri::command(rename_all = "...")]`
   on the command applies to all parameters without a field-level override.
   For example, `rename_all = "snake_case"` keeps keys as snake_case on
   the TypeScript side.
3. **Default Tauri behaviour** — when neither override is present, Tauri
   converts snake_case to camelCase. Examples: `session_id` → `sessionId`,
   `col_count` → `colCount`, `data_b64` → `dataB64`.

Build a table of the expected TypeScript surface:

| Rust function | Invoke name (verbatim snake_case) | Parameters (TS keys, resolved by precedence) | Return type |
| ------------- | --------------------------------- | -------------------------------------------- | ----------- |
| `pty_spawn`   | `pty_spawn`                       | `{ sessionId, command, rows, cols }`         | `void`      |
| ...           | ...                               | ...                                          | ...         |

### Step 3 — Enumerate TypeScript invoke calls

Find every `invoke(` call in the TypeScript source tree:

```bash
grep -rn "invoke(" src/
```

Filter out matches inside comments, test files (`*.test.*`, `*.spec.*`),
mock implementations, fixture snapshots, and string literals used in test
assertions — these are not real call sites.

> **Wrappers and indirection:** do not assume all IPC appears as inline
> `invoke()` calls. If the codebase wraps `invoke` in a helper function
> or client module, follow those wrappers until the actual command string
> and payload shape are resolved.

> **Discovery pass:** grep results are a first pass. A command absent
> from grep output is not necessarily absent from the codebase — it may
> be called through an alias, a constant, or a generated client.

For each remaining match, extract:

- The command name string (first argument to `invoke`). It should be the
  Rust function name verbatim in snake_case.
- The argument object keys (second argument — record exactly which keys are
  passed). These should be camelCase by default.
- The generic type parameter, if present (`invoke<T>(...)`).

### Step 4 — Cross-reference and flag mismatches

Compare the expected TypeScript table from Step 2 against the actual
TypeScript calls collected in Step 3. Report findings in two tiers:

**Definite mismatches** (must fix — these are IPC contract violations):

- **Command name mismatch** — the `invoke()` first argument does not
  exactly match the Rust function name in snake_case (e.g.,
  `invoke("ptySpawn", ...)` or `invoke("pty_spwn", ...")` instead of
  `invoke("pty_spawn", ...)`).
- **Missing parameter** — a Rust parameter has no corresponding key in
  the TypeScript argument object.
- **Extra parameter** — TypeScript passes a key the Rust function does
  not accept.
- **Parameter casing mismatch** — a parameter key uses the wrong case
  given the precedence rules in Step 2 (e.g., `session_id` where
  `sessionId` is expected, or vice versa when `rename_all` is active).

**Risk warnings** (worth noting — not definitive bugs, but worth review):

- **Numeric bounds** — Rust expects a bounded integer type (`u8`, `u16`,
  `u32`, `i32`, etc.) but TypeScript passes an unconstrained `number`
  with no runtime bounds check. Note the Rust type; the caller may need
  a validation wrapper.
- **Nullable / optional mismatch** — Rust expects `Option<T>` but
  TypeScript always passes a value, or vice versa.
- **Loosely-inferred payload shape** — the TypeScript argument is typed
  as `any`, `unknown`, or a cast rather than a concrete interface.
- **Generic return type omitted** — `invoke()` is called without a type
  parameter where the Rust return value is non-trivial. Noting the
  expected `Result<T, _>` return type helps reviewers catch
  deserialization surprises.

Label definite mismatches as **[MISMATCH]** and risk warnings as
**[WARNING]** in the output so a downstream agent can triage them
separately.

### Step 5 — Audit event names

Find Rust emission calls. In Tauri v2, the `Emitter` trait defines exactly
three emission methods — `emit`, `emit_to`, and `emit_filter`. Note that
`emit_all` does **not** exist in Tauri v2 (it was a Tauri v1 API); do not
flag its absence as an error. For high-throughput or ordered streaming,
Tauri v2 uses `Channel<T>` instead of events — `Channel` invocations are
not covered by this grep and require separate review if the codebase uses
them:

```bash
grep -rEn "\.(emit|emit_to|emit_filter)\(" src-tauri/src/
```

Find TypeScript `listen()` calls:

```bash
grep -rn "listen(" src/
```

> **Discovery pass:** these greps are a starting point. Event names
> constructed from constants, enums, or format strings require tracing
> to their definition before cross-referencing.

Filter out matches inside comments, test files (`*.test.*`, `*.spec.*`),
mock implementations, fixture snapshots, and test assertions before
tabulating.

Event names are **not** converted by Tauri — they must match byte-for-byte.
Pay close attention to dynamic event names that interpolate session IDs or
other identifiers (e.g., `pty:output:{sid}` on the Rust side must be matched
by `pty:output:${sessionId}` on the TS side with identical literal segments).

Event name matching may be: (a) exact literal equality, (b) identical
template structure with matching interpolated segments, or (c) equivalent
string composition through a shared constant or helper function. Do not
mark constant-based event naming as unpaired when both sides provably
derive from the same source — follow the constant to its definition
before flagging.

Flag any event emitted but not listened to, listened to but never emitted, or
spelled differently between the two sides. Note that `emit_to(window_label,
event, payload)` targets a specific window — verify that the listening
TypeScript code is running in that window.

### Step 6 — Audit command registration

Open `src-tauri/src/lib.rs` and locate the
`tauri::Builder::default().invoke_handler(tauri::generate_handler![...])`
call. Every function annotated with `#[tauri::command]` (including
`#[tauri::command(async)]` and other attribute variants) must appear in the
`generate_handler!` list. A command that is defined but not registered will
compile cleanly and fail silently at runtime when invoked.

Cross-check the list of command function names from Step 1 against the
`generate_handler!` list and flag any missing entries.

Note that commands defined in submodules may be registered using their
full module path (e.g., `pty::pty_spawn` rather than `pty_spawn`).
Compare function identities — not just bare names — when the codebase
uses module-qualified registration.

### Step 7 — Dead IPC surface (optional)

Optionally flag IPC endpoints that exist on one side with no active
counterpart on the other. These are informational — dead surface often
reflects work in progress rather than a bug.

- **Commands with no frontend caller** — registered in
  `generate_handler!` but with no matching `invoke()` call site in the
  TypeScript source tree.
- **Events emitted but never listened to** — Rust emits the event; no
  TypeScript `listen()` call uses that event name.
- **Listeners for events never emitted** — TypeScript `listen()` call
  present; no Rust emit call uses that event name.

Label each finding as **[DEAD — may be intentional]** to distinguish it
from definite mismatches.

## Output format

Present audit findings in the following structured form so a downstream agent
can act on each item:

1. **Rust commands table** — every `#[tauri::command]` function (including
   `(async)` and other attribute variants) with its expected TypeScript
   invoke name (snake_case verbatim), parameter names (camelCase by default,
   or as overridden), and return type.
2. **TypeScript invoke table** — every `invoke()` call site with its command
   name string, argument keys, and source file:line.
3. **Mismatch diff** — per-row comparison, split into **[MISMATCH]**
   (definite IPC contract violations) and **[WARNING]** (risk signals
   that warrant review but are not confirmed bugs).
4. **Event pair list** — each Rust `emit` / `emit_to` / `emit_filter` paired
   with its matching TS listen (or marked as unpaired), with match/mismatch
   status.
5. **Registration check** — list of commands defined in `src-tauri/src/` but
   absent from `generate_handler![...]` in `src-tauri/src/lib.rs` (empty if
   all are registered).
6. **Summary line** — `"N commands audited. X [MISMATCH] findings, Y [WARNING] findings."` (append `, Z [DEAD] findings` when Step 7 was run), followed by a numbered remediation list — one item per `[MISMATCH]` entry with the specific file, line, and corrective action (e.g., "In `src/terminal/pty-client.ts:42`, change the argument key `data_b64` to `dataB64` to match the camelCase conversion of the Rust parameter `data_b64`."). `[WARNING]` items should follow as advisory notes, not numbered fixes.
7. **Dead surface list** (if Step 7 was run) — commands and events
   flagged as **[DEAD — may be intentional]**, one entry per item with
   the source location.

## When to run

- Before every PR that adds or modifies a Tauri command or event.
- After any refactor of `src-tauri/src/` that changes command signatures or
  event names.
- When investigating a runtime error originating from an `invoke()` call
  that returns an unexpected result, hangs, or rejects with a deserialization
  error.
