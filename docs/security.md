# Security Notes

The app ships with a restrictive Content Security Policy that limits sources to `'self'` and the Tauri IPC/asset origins. Tauri capabilities are scoped to `core:default` only — no filesystem, shell, or HTTP client permissions are granted by default. Both are intentional baselines; extend them in `src-tauri/capabilities/` and `tauri.conf.json` as features are added.

## OSC Session-Context Trust Boundary

Any process running inside a terminal tab can emit OSC 6800, OSC 7, or OSC 7337 sequences. The data is therefore fully untrusted. `parseSessionContextPayload()` in `src/types/sessionPayload.ts` is the sole entry point for OSC 6800 data into app state; it rejects payloads that exceed 64 K, fail JSON parsing, are not a plain object, or fail per-field validation (format, length, control characters, path-traversal patterns).

OSC 7 and OSC 7337 are validated by dedicated exported parsers in `src/types/sessionPayload.ts` (`parseOsc7Payload` and `parseOsc7337Payload`), keeping that module the single audit entry point for all inbound OSC data. `parseOsc7Payload` checks that the URL parses, that its scheme is exactly `file:` (rejecting `javascript:`, `data:`, `ftp:`, `https:`, etc.), and that the resulting workingDirectory is ≤ 1024 chars and free of ASCII control characters. `parseOsc7337Payload` caps the branch field at 256 chars and rejects ASCII control characters; in the alternative `owner/name` case it additionally caps each segment at 256 chars, rejects control characters, requires each segment to match `/^[A-Za-z0-9._-]+$/`, and rejects bare-dot segments (`.` and `..`). Validated data enters app state only via the `setClaudeContext` and `setShellContext` reducer actions, which are no-ops when the card id is not in `state.cards`.

Fields that pass validation are stored as `ClaudeContext` (OSC 6800) or `ShellContext` (OSC 7/7337) and must only ever be rendered as plain text — they must not be passed to `dangerouslySetInnerHTML`, assigned to `document.title`, or interpolated into shell commands.
