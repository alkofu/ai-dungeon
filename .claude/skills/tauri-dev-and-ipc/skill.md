---
name: tauri-dev-and-ipc
description: >
  Apply this skill when adding or modifying Tauri commands, writing IPC calls
  from the frontend, working with Tauri events, debugging build errors,
  managing capabilities/permissions, or performing any task that touches
  `src-tauri/` in the ai-dungeon project.
---

# Tauri Dev and IPC

<!-- Convention note (F-1): No prior skill.md files were found in either sibling
worktree (define-ipc-surface-auditor-skill, define-testing-and-qa-claude-code-skill)
at the time this file was created. The structure follows the issue #15 specification
directly, as no project precedent existed to defer to. -->

## Goal

After reading this skill you will be able to:

1. Navigate the Tauri project file structure and locate the right file for any IPC change.
2. Add a new Tauri command end-to-end: Rust definition, registration, and TypeScript call site.
3. Add a Tauri event end-to-end: Rust emit and TypeScript listener with proper cleanup.
4. Start and interpret the dev server output.
5. Debug the five most common IPC failures without consulting additional sources.

## Project Structure

```
ai-dungeon/
├── package.json                    # "tauri" script → pnpm tauri dev
├── src/                            # React/TypeScript frontend
│   └── components/Terminal/        # Only frontend IPC consumer today
├── src-tauri/
│   ├── Cargo.toml                  # tauri = "2", portable-pty, base64, serde
│   ├── tauri.conf.json             # beforeDevCommand: "pnpm dev", devUrl: "http://localhost:1420"
│   ├── capabilities/
│   │   └── default.json            # Tauri v2 capability file — all permissions live here
│   ├── gen/schemas/
│   │   └── desktop-schema.json     # Auto-generated; $schema target for capability files
│   └── src/
│       ├── main.rs                 # 7-line shim — calls ai_dungeon_lib::run(). DO NOT ADD LOGIC HERE.
│       ├── lib.rs                  # Entry point: registers State and all command handlers
│       └── pty.rs                  # PTY session management — the only command module today;
│                                   # new modules can sit alongside it
```

`lib.rs` currently registers four commands:

```rust
.invoke_handler(tauri::generate_handler![
    pty::pty_spawn,
    pty::pty_write,
    pty::pty_resize,
    pty::pty_kill,
])
```

## Adding a Tauri Command

Follow these five steps in order.

### Step 1 — Choose the right attribute

Tauri 2 has two command attributes and the choice matters:

| Attribute                  | Function kind | When to use                                             |
| -------------------------- | ------------- | ------------------------------------------------------- |
| `#[tauri::command]`        | `async fn`    | Naturally async work (I/O, spawning, awaiting futures)  |
| `#[tauri::command(async)]` | plain `fn`    | Blocking/sync work that must not run on the main thread |

Live examples from `pty.rs`:

- `pty_spawn` is `#[tauri::command]` on an `async fn` — it awaits nothing itself but the runtime expects `async`.
- `pty_write` and `pty_resize` are `#[tauri::command(async)]` on plain `fn` — they do blocking I/O and the `(async)` annotation moves them off the main thread into the blocking pool.
- `pty_kill` is `#[tauri::command]` on a plain sync `fn` — short, non-blocking.

### Step 2 — Define the function in a module file

Add the function to an existing module (e.g., `pty.rs`) or create a new `src-tauri/src/my_module.rs`:

```rust
// Async variant (I/O-heavy, uses await inside, or Tauri expects async fn)
#[tauri::command]
pub async fn my_command(
    app: AppHandle,
    state: State<'_, MyState>,
    session_id: String,
    some_arg: String,
) -> Result<ReturnType, String> {
    // implementation
    Ok(value)
}

// Blocking sync variant (runs in the blocking thread pool, NOT on main thread)
#[tauri::command(async)]
pub fn my_blocking_command(
    state: State<'_, MyState>,
    session_id: String,
    data_b64: String,
) -> Result<(), String> {
    // blocking implementation
    Ok(())
}
```

Rules:

- Return `Result<T, String>` — Tauri serialises `Ok(v)` as a success payload and `Err(s)` as an error string to the frontend.
- Inject `AppHandle` only when you need to emit events from the handler.
- Inject `State<'_, T>` for any shared application state. The state type must implement `Send + Sync`.

### Step 3 — Register the command in `lib.rs`

Open `src-tauri/src/lib.rs` and append your command to `generate_handler!`. If you created a new module, also add a `mod my_module;` declaration at the top of `lib.rs`.

Before:

```rust
mod pty;

pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

After adding a hypothetical `pty::pty_info`:

```rust
.invoke_handler(tauri::generate_handler![
    pty::pty_spawn,
    pty::pty_write,
    pty::pty_resize,
    pty::pty_kill,
    pty::pty_info,   // ← appended
])
```

If you are adding state for a new module, chain a `.manage(my_module::MyState::default())` call before `.invoke_handler(...)`.

### Step 4 — Call from TypeScript

```typescript
import { invoke } from "@tauri-apps/api/core";

const result = await invoke<ReturnType>("my_command", {
  sessionId: "abc-123", // ← camelCase key for Rust snake_case param session_id
  someArg: "value", // ← camelCase key for Rust snake_case param some_arg
});
```

**Critical naming rule — the command name string is the original Rust snake_case:**
The string passed as the first argument to `invoke()` is the unmodified Rust function name.
Write `invoke("my_command", ...)` — NOT `invoke("myCommand", ...)`.

Only the **argument keys** follow camelCase: Rust `data_b64: String` becomes `{ dataB64: "..." }` in TypeScript.

From the live test suite (`Terminal.test.tsx`):

```typescript
expect(invoke).toHaveBeenCalledWith("pty_write", {
  sessionId: "00000000-0000-0000-0000-000000000001",
  dataB64: "YQ==",
});
```

The command name is `"pty_write"` (snake_case), but the argument key `data_b64` is `dataB64` (camelCase).

### Step 5 — The camelCase pitfall (cite: PR #14)

> **WARNING — highest-frequency bug in this project.**
>
> Tauri v2 serialises Rust parameter names from `snake_case` to `camelCase` when passing arguments from TypeScript. This means:
>
> - Rust `data_b64: String` must be passed as `{ dataB64: "..." }` from TypeScript.
> - Rust `session_id: String` must be passed as `{ sessionId: "..." }` from TypeScript.
>
> The **command name itself** (first argument of `invoke()`) is NOT converted — it must remain `snake_case`, matching the Rust function name exactly.
>
> PR #14 (`fix(terminal): use camelCase for dataB64 key in pty_write invocation`) in this project's history is direct evidence that this bug has already shipped once. When `invoke("pty_write", { data_b64: "..." })` was used instead of `{ dataB64: "..." }`, the Rust handler received a null/missing argument and the command silently failed.
>
> This intentionally contradicts any documentation that suggests Tauri auto-converts command names to camelCase — it does NOT. Only argument keys are converted.

## Adding a Tauri Event

### Rust side — emitting

Two emit forms exist. Choose based on context:

**Inside a `Result`-returning function body** — use the `?` propagation form:

```rust
// lib.rs / any command handler that returns Result<_, _>
app.emit("my-event", payload)?;
```

**Inside a fire-and-forget background thread** — use `let _ =` to suppress the unused-`Result` warning without propagating:

```rust
// pty.rs reader loop — inside tauri::async_runtime::spawn_blocking(move || { ... })
let _ = app_clone.emit(&format!("pty:output:{sid}"), encoded);
let _ = app_clone.emit(&format!("pty:exit:{sid}"), ());
```

The `let _ =` pattern is the one used throughout `pty.rs` (lines 142, 150, 154) because the reader loop cannot propagate errors — there is no caller to receive them.

The payload type must implement `serde::Serialize + Clone`. For a string payload like `encoded` above, both are already satisfied. For custom types, derive them:

```rust
#[derive(serde::Serialize, Clone)]
struct MyPayload {
    field: String,
}
```

Event name convention in this project: colon-separated namespaces with a trailing session id for per-session events: `pty:output:{sid}`, `pty:exit:{sid}`. Follow the same pattern for any new per-session event.

### TypeScript side — listening

```typescript
import { listen } from "@tauri-apps/api/event";

// Register listener — must be awaited before events can fire.
const unlisten = await listen<string>("pty:output:" + sessionId, (event) => {
  console.log(event.payload); // typed as `string` here
});

// In cleanup (useEffect return, unmount handler, etc.):
unlisten();
```

Key points:

- `listen()` is async — `await` it before sending any messages that might trigger the event.
- Always call `unlisten()` during component cleanup. Forgetting this leaks a listener across re-renders and tab switches.
- Event name strings are **case-sensitive** and must match exactly between the Rust emitter and the TypeScript listener — including every colon and the trailing session id. A mismatch produces no error; the listener simply never fires.

## Capabilities (Tauri v2)

Capabilities replaced the Tauri v1 `allowlist` in `tauri.conf.json`. **Do not use v1 `allowlist` patterns — they are silently ignored in Tauri v2.**

All frontend permissions are declared in JSON files under `src-tauri/capabilities/`. The project currently has one file:

`src-tauri/capabilities/default.json` (exact contents):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default", "core:event:default"]
}
```

Field reference:

- `$schema` — points to the auto-generated desktop schema relative to the capability file's location (`src-tauri/capabilities/`). Keep new capability files in the same directory or adjust the relative path accordingly (F-6).
- `identifier` — unique string identifying this capability bundle.
- `description` — human-readable label.
- `windows` — list of window labels this capability applies to. `"main"` is the only window in this project.
- `permissions` — list of Tauri permission identifiers. `core:default` enables the standard Tauri core APIs; `core:event:default` enables the event system used by `listen()`.

**If a frontend `invoke()` call fails with a permission/capability error**, the fix is almost always to add a permission string to the `permissions` array — not to change Rust code. For example, adding shell open support would require `"shell:allow-open"`. Do not modify existing capability files if only adding a new command (commands do not require explicit permission entries beyond `core:default`).

You may create additional capability files (e.g., `src-tauri/capabilities/shell.json`) for logical grouping, but must keep the `$schema` path correct relative to the new file's location.

## Development Server

**Start the dev loop:**

```sh
pnpm tauri dev
```

Run this from the project root. It is the canonical entry point — `package.json` exposes `"tauri": "tauri"` as a script, so `pnpm tauri dev` resolves to the Tauri CLI.

**What happens internally:**

1. The Tauri CLI reads `src-tauri/tauri.conf.json` and finds `beforeDevCommand: "pnpm dev"`.
2. It starts Vite (`pnpm dev`) at `http://localhost:1420`.
3. Simultaneously, it compiles the Rust crate with `cargo`.
4. Once both are ready, the native window opens with the Vite dev server loaded.

**Hot reload behaviour:**

- TypeScript/React changes — Vite HMR reloads the webview instantly without restarting the Rust process.
- Rust changes — trigger a full `cargo` recompile. First build after dependency changes can take several minutes. Subsequent incremental builds are faster.

**Reading the output:**

- Rust compile errors appear in the terminal with standard `rustc` formatting (`error[E0...]`, file/line references).
- Vite errors appear on a separate line prefix and may also surface in the Tauri webview's DevTools console.
- A successful start shows both Vite's `VITE vX.X.X ready` message and Tauri's window opening.

## Common Failure Modes

### 1. `"command not found"` from `invoke()`

**Cause:** The command function exists in Rust but is not listed in `tauri::generate_handler![...]` in `lib.rs`.
**Fix:** Open `src-tauri/src/lib.rs` and add the command to the `generate_handler!` macro. If it is in a new module, also add `mod my_module;` at the top of `lib.rs`.

### 2. Argument unmarshalling errors or `null` argument received in Rust

**Cause:** TypeScript passed argument keys in `snake_case` instead of `camelCase`. This is the highest-frequency bug in this project — see PR #14.

Specifically: `invoke("pty_write", { data_b64: "..." })` must be `invoke("pty_write", { dataB64: "..." })`. Tauri v2 converts Rust `snake_case` parameter names to `camelCase` JSON keys. The frontend must match.

**Fix:** Convert all argument object keys to `camelCase`. Verify by cross-referencing the Rust parameter names: `session_id` → `sessionId`, `data_b64` → `dataB64`, `some_flag` → `someFlag`.

Note: the **command name string** (first argument of `invoke()`) is NOT converted — it stays `snake_case`.

### 3. Capability denied / permission error

**Cause:** The frontend is calling an API (e.g., filesystem, shell, dialog) whose permission is not listed in any capability file.
**Fix:** Add the required permission identifier to the `permissions` array in `src-tauri/capabilities/default.json`. Restart the dev server after changing capability files.

### 4. Rust compile error after adding a command

**Cause:** Missing trait implementations on types used in the command signature. Common cases:

- State type missing `Send + Sync` — required for `State<'_, T>`.
- Event payload type missing `serde::Serialize` — required for `app.emit(...)`.
- Event payload type missing `Clone` — also required by Tauri's emit signature.
- Command argument type missing `serde::Deserialize` — required for Tauri to deserialise frontend arguments.

**Fix:** Derive the missing traits. For most structs:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct MyPayload { ... }
```

For state types: ensure they implement `Send + Sync` (usually satisfied if all fields are `Send + Sync`).

### 5. Event listener never fires

**Cause:** Event name string mismatch between the Rust emitter and the TypeScript listener. Tauri event names are case-sensitive and matched byte-for-byte.
**Fix:** Log both the emit name and the listen name and compare character-by-character. Common mistakes: wrong capitalisation, missing colon separator, missing trailing session id, or using a hardcoded literal that does not interpolate the session id correctly.

## Output Expectations

When adding a new Tauri command, produce all of the following:

- [ ] **Rust function defined** — annotated with `#[tauri::command]` or `#[tauri::command(async)]` as appropriate, in the correct module file.
- [ ] **Registered in `lib.rs`** — appended to `tauri::generate_handler![...]`; new modules also declared with `mod`.
- [ ] **TypeScript invoke call written** — uses the Rust snake_case command name as the first argument, with all argument keys in camelCase. Return type is correctly typed with `invoke<ReturnType>(...)`.
- [ ] **Capability permissions noted** — if the command exposes a new Tauri API surface (filesystem, shell, dialog, etc.), the required permission string is identified and added to `src-tauri/capabilities/default.json`.
- [ ] **Dev server verified clean** — `pnpm tauri dev` starts without Rust compile errors or Vite errors after the change.

## Things Not To Do

- **Do not add logic to `src-tauri/src/main.rs`.** It is a 7-line shim that only calls `ai_dungeon_lib::run()`. All application logic belongs in `lib.rs` or in module files like `pty.rs`.
- **Do not use Tauri v1 `allowlist` patterns.** Capabilities in `src-tauri/capabilities/` replaced the v1 `allowlist` in `tauri.conf.json`. V1 patterns are silently ignored in Tauri v2.
- **Do not camelCase the command name in `invoke()`.** The first argument is always the original Rust snake_case function name (e.g., `"pty_write"`, not `"ptyWrite"`). Only the argument object's keys are camelCased.
