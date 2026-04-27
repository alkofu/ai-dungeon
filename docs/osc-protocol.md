# OSC Protocol Reference

This document describes the three OSC escape sequences that the AI Dungeon terminal
intercepts — OSC 6800 (Claude session metadata), OSC 7 (shell working directory),
and OSC 7337 (git context) — and the two-slot card context model they feed into.

---

## 1. Overview

Each tab card holds two independent context slots:

| Slot           | Source OSC | TypeScript type  | Contents                             |
| -------------- | ---------- | ---------------- | ------------------------------------ |
| SessionContext | 6800       | `SessionContext` | Full session snapshot from an AI CLI |
| ShellContext   | 7 + 7337   | `ShellContext`   | Shell-derived CWD and git context    |

**Rendering precedence** in `SessionCard.tsx`:

```
sessionContext ?? shellContext ?? getMockSessionContext(cardId)
```

SessionContext (OSC 6800) is authoritative when present. ShellContext (OSC 7/7337) fills
the display when no AI CLI session is running. Mock fixtures are shown until either real
slot is populated.

### TypeScript aggregate type

The full per-card context is represented in ai-dungeon's TypeScript codebase as:

```typescript
CardContext { sessionContext?: SessionContext; shellContext?: ShellContext }
```

The rendering rule is `sessionContext ?? shellContext ?? mock`. `CardContext` is defined in
`src/types/session.ts` and is the canonical aggregate for ai-tpk implementers who need to
reason about the full per-card state.

---

## 2. OSC 6800 — Claude session metadata

Emitted by an AI CLI (e.g. the TPK toolkit) whenever a new Claude session begins or its
metadata changes.

### Wire format

```
ESC ] 6800 ; <JSON payload> BEL
```

Encoded as `\033]6800;<json>\007`.

### Payload fields

All fields are validated by `parseSessionContextPayload()` in `src/types/sessionPayload.ts`
before entering app state. The payload must be valid JSON, a plain object, and ≤ 64 KB.

| Wire field          | Required | Type           | Constraints                                         | Maps to `SessionContext` field |
| ------------------- | -------- | -------------- | --------------------------------------------------- | ------------------------------ |
| `SESSION_TS`        | yes      | string         | Format `YYYYMMDD-HHMMSS`                            | `sessionTs`                    |
| `SESSION_SLUG`      | yes      | string         | 1–256 chars, no control chars                       | `slug`                         |
| `WORKING_DIRECTORY` | yes      | string         | 1–1024 chars, no control chars                      | `workingDirectory`             |
| `BRANCH`            | see note | string         | 1–256 chars, no control chars                       | `branch`                       |
| `WORKTREE`          | see note | string         | 1–256 chars, no control chars                       | `branch` (fallback)            |
| `REPO`              | yes      | string         | `owner/name` format, no bare dots, no control chars | `repo`                         |
| `PR_NUM`            | no       | number \| null | Positive integer ≥ 1, or omitted/null               | `prNumber`                     |
| `ISSUE_NUM`         | no       | number \| null | Positive integer ≥ 1, or omitted/null               | `issueNumber`                  |

### BRANCH vs WORKTREE

At least one of `BRANCH` or `WORKTREE` must be present and valid. `BRANCH` takes
precedence when both are provided. Both map to the same `branch` field on `SessionContext`.

**Producer guidance:**

- Emit `BRANCH` when the shell's HEAD is a regular branch (e.g. `git rev-parse --abbrev-ref HEAD`).
- Emit `WORKTREE` when the working tree is a `git worktree` checkout that is detached from a named
  branch (i.e. `git rev-parse --abbrev-ref HEAD` returns `HEAD`). In that case, emit the worktree
  name or the ref it tracks instead. Example: `"WORKTREE": "wt/feature-x"`.
- If your shell always has a named branch, emitting only `BRANCH` is correct and sufficient.

### Example

```json
{
  "SESSION_TS": "20260425-120000",
  "SESSION_SLUG": "refactor-auth-flow",
  "WORKING_DIRECTORY": "~/projects/ai-dungeon",
  "BRANCH": "feat/session-card",
  "REPO": "acme-corp/ai-dungeon",
  "PR_NUM": 42,
  "ISSUE_NUM": 17
}
```

---

## 3. OSC 7 — shell working directory

Emitted by the shell (via `precmd` or equivalent) whenever the working directory changes.
This is a standard `file://` URI sequence supported by many terminal emulators.

### Wire format

```
ESC ] 7 ; file://<hostname><path> BEL
```

Example: `\033]7;file://hostname/Users/alex/code/frontend\007`

### Behaviour

`parseOsc7Payload()` validates the payload:

1. Must parse as a WHATWG URL.
2. `url.protocol` must be exactly `file:` — `javascript:`, `data:`, `ftp:`, `https:`, etc. are rejected.
3. `url.pathname` is percent-decoded (falling back to the raw pathname on decode error).
4. Resulting `workingDirectory` must be ≤ 1024 chars and free of ASCII control characters.

On success, the `workingDirectory` field of `lastShellContextRef` in `Terminal.tsx` is updated and
a new `ShellContext` is emitted via `onShellContextChange`. Branch and repo carry over from the
previous `ShellContext` (accumulated across OSC 7 and OSC 7337 events).

---

## 4. OSC 7337 — git context

Emitted by shell git-status tooling (e.g. `precmd` hooks) when the git context changes.
Carries the branch name and optionally the repo identity.

### Wire format

```
ESC ] 7337 ; <repoField> TAB <branch> BEL
```

Empty payload (cleared shape):

```
ESC ] 7337 ; BEL
```

### Three shapes

| Shape          | Data                       | Returned type                            | Effect                                                              |
| -------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **Cleared**    | `""` (empty string)        | `{ branch: undefined, repo: undefined }` | Clears branch and repo in `ShellContext`                            |
| **Bare name**  | `<basename>\t<branch>`     | `{ branch }`                             | Updates branch only; repo stays from previous OSC 6800 or unchanged |
| **Owner/name** | `<owner>/<name>\t<branch>` | `{ branch, repo }`                       | Updates branch and repo                                             |

The bare-name production case uses `basename "$repo_top"` — the short directory name of the
repository root — because the shell may not have access to the full `owner/name` identity.
Only the `branch` field is dispatched in that case; the `repo` field from a prior OSC 6800
SessionContext is not overwritten.

### Validation (owner/name case)

Each segment must: be non-empty, be ≤ 256 chars, contain no ASCII control characters,
match `/^[A-Za-z0-9._-]+$/`, and not be `.` or `..`.

### F-1 invariant — no empty-CWD ShellContext

The OSC 7337 handler only dispatches `onShellContextChange` if `lastShellContextRef.current`
already has a non-empty `workingDirectory` (i.e. OSC 7 has fired at least once for this card).
An OSC 7337 event received before any OSC 7 is silently ignored. This prevents a `ShellContext`
with an empty `workingDirectory` from being emitted.

---

## 5. Rendering precedence

`SessionCard.tsx` resolves what to display using:

```typescript
const meta = sessionContext ?? shellContext ?? getMockSessionContext(cardId);
```

| Scenario                                   | Display source                                 |
| ------------------------------------------ | ---------------------------------------------- |
| AI CLI session active (OSC 6800 received)  | `SessionContext`                               |
| Shell context available, no AI CLI session | `ShellContext`                                 |
| Neither slot populated                     | Deterministic mock fixture (keyed by `cardId`) |

When `ShellContext` is the source, the slug row shows `"(shell)"` instead of a session slug,
and `prNumber` / `issueNumber` are not shown (they only exist on `SessionContext`).

---

## 6. Data flow

The following six steps describe the path from PTY output to rendered UI.

1. **PTY** — the CLI or shell writes an OSC sequence to its stdout inside the pseudo-terminal.
2. **xterm.js** — intercepts the sequence via registered OSC handlers (`registerOscHandler`).
3. **`Terminal.tsx`** — the handler validates the payload via the appropriate parser, updates
   `lastShellContextRef` (for OSC 7/7337), and dispatches via `queueMicrotask` to avoid
   re-entering the parser synchronously. Calls `onSessionContextChange` (OSC 6800) or
   `onShellContextChange` (OSC 7/7337).
4. **`AppLayout.tsx`** — receives the callback, forwards to `App.tsx` state via props.
5. **`App.tsx` reducer** — `setSessionContext` stores a validated `SessionContext` in
   `AppState.sessionContext[id]`; `setShellContext` stores a validated `ShellContext` in
   `AppState.shellContext[id]`. Both actions are no-ops if the card id is not in `state.cards`.
6. **`SessionCard.tsx`** — re-renders with the new context, applying the `sessionContext ??
shellContext ?? mock` precedence to produce the displayed slug, branch, repo, and badges.

OSC handler disposables are cleaned up on `Terminal` unmount, before `term.dispose()`.

---

## 7. Trust boundary and validation summary

All OSC data is fully untrusted — any process running inside a terminal tab can emit these
sequences. The single audit entry point is `src/types/sessionPayload.ts`, which exports:

| Function                     | Validates | Returns on success                   |
| ---------------------------- | --------- | ------------------------------------ |
| `parseSessionContextPayload` | OSC 6800  | `SessionContext`                     |
| `parseOsc7Payload`           | OSC 7     | `{ workingDirectory: string }`       |
| `parseOsc7337Payload`        | OSC 7337  | branch/repo partial or cleared shape |

None of these functions throw. All guard failures return `null` and emit a `console.warn`
in development mode only.

Fields that pass validation must only ever be rendered as plain text. They must not be
passed to `dangerouslySetInnerHTML`, assigned to `document.title`, or interpolated into
shell commands. See [security.md](security.md) for the full constraint.

---

## 8. Producer guidance

### When to emit OSC 6800

Emit OSC 6800 at the start of every Claude CLI session and whenever the session metadata
changes (e.g. when a PR is opened against the current branch). Emitting it more frequently
than necessary is harmless; each payload is a full replacement.

### BRANCH vs WORKTREE

See [Section 2](#2-osc-6800--claude-session-metadata) for the BRANCH/WORKTREE field choice.
The short rule: use `BRANCH` for normal branch checkouts and `WORKTREE` for detached-HEAD
worktree checkouts.

### Shell integration (OSC 7 + 7337)

OSC 7 and OSC 7337 are typically emitted by shell `precmd` / `PROMPT_COMMAND` hooks.
Standard integrations (e.g. iTerm2 shell integration, Starship) already emit OSC 7.
OSC 7337 requires a custom hook that queries `git rev-parse --abbrev-ref HEAD` and
`basename "$(git rev-parse --show-toplevel)"`. Emit the empty OSC 7337 payload
(`\033]7337;\007`) when the current directory is not inside a git repository.

---

## 9. Behavioural notes

### SessionContext is authoritative (F-2)

An empty OSC 7337 clear payload sets `ShellContext.branch` and `ShellContext.repo` to
`undefined`. However, because `sessionContext ?? shellContext` is evaluated at render time,
a card that already has a `SessionContext` continues to display its session branch and repo
unchanged — the cleared `ShellContext` is never consulted. This is intentional: transient
shell drift (e.g. `cd` into a non-git directory) does not erase the AI CLI session display.

### OSC 7337 before OSC 7 is silently dropped (F-1)

If a shell emits OSC 7337 before it has emitted OSC 7 (i.e. before the working directory
is known), the event is ignored. The `ShellContext` requires a non-empty `workingDirectory`
to be meaningful; the F-1 invariant in `Terminal.tsx` enforces this.

### CWD transitions

When the shell moves out of a git repository, ai-dungeon may briefly show stale branch/repo
context until OSC 7337 (cleared payload) arrives. This is expected — the shell resolves the
inconsistency within the same prompt cycle. No action is needed from the ai-tpk producer.

The sequence of events is:

1. OSC 7 fires with the new (non-git) CWD. The OSC 7 handler spreads the previous
   `branch`/`repo` from `lastShellContextRef` into the updated `ShellContext`, briefly
   showing stale git context alongside the new CWD.
2. OSC 7337 fires with an empty payload (cleared shape). The handler clears `branch` and
   `repo` from `ShellContext`, resolving the display to the correct state.

Both events are emitted within the same prompt cycle, so the stale display window is
sub-prompt in duration and self-corrects without any coordination required.

### Replacement semantics

Both `setSessionContext` and `setShellContext` are full replacements, not patches.
Each new SessionContext or ShellContext completely overwrites the previous value for that
card. There is no incremental merge within a slot.
