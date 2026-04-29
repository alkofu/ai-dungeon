#![deny(unused)]
mod dungeon;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(pty::PtyState::default())
        .manage(dungeon::DungeonState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            dungeon::dungeon_open,
            dungeon::dungeon_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
