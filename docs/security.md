# Security Notes

The app ships with a restrictive Content Security Policy that limits sources to `'self'` and the Tauri IPC/asset origins. Tauri capabilities are scoped to `core:default` only — no filesystem, shell, or HTTP client permissions are granted by default. Both are intentional baselines; extend them in `src-tauri/capabilities/` and `tauri.conf.json` as features are added.

## OSC 6800 Trust Boundary

Any process running inside a terminal tab can emit an OSC 6800 sequence. The data is therefore fully untrusted. `parseSessionMetaPayload()` in `src/types/sessionPayload.ts` is the sole entry point for this data into app state; it rejects payloads that exceed 64 K, fail JSON parsing, are not a plain object, or fail per-field validation (format, length, control characters, path-traversal patterns). Fields that pass validation are stored as `SessionMeta` and must only ever be rendered as plain text — they must not be passed to `dangerouslySetInnerHTML`, assigned to `document.title`, or interpolated into shell commands.
