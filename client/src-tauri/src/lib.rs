//! Umbra desktop shell.
//!
//! Deliberately thin: the entire product lives in the web bundle (`../dist`).
//! The native layer only provides the window, a strict CSP (see
//! `tauri.conf.json`), and OS-native notifications via the notification
//! plugin. No custom Rust commands, no filesystem/shell access exposed to the
//! web context — keeping the native attack surface close to zero, in line with
//! Umbra's Signal-level security goal.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running the Umbra desktop app");
}
