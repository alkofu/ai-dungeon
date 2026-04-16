# Security Notes

The app ships with a restrictive Content Security Policy that limits sources to `'self'` and the Tauri IPC/asset origins. Tauri capabilities are scoped to `core:default` only — no filesystem, shell, or HTTP client permissions are granted by default. Both are intentional baselines; extend them in `src-tauri/capabilities/` and `tauri.conf.json` as features are added.
