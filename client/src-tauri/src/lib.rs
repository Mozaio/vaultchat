//! Umbra desktop shell.
//!
//! Deliberately thin: the entire product lives in the web bundle (`../dist`).
//! The native layer provides the window, a strict CSP (see `tauri.conf.json`),
//! OS-native notifications, and Discord-class desktop behavior — a system
//! tray, close-to-tray, single-instance focus and persisted window state.
//!
//! No custom Rust commands and no fs/shell/http capability is exposed to the
//! web context, keeping the native attack surface close to zero in line with
//! Umbra's Signal-level security goal.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Bring the main window back to the foreground (from tray / minimized).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be registered first: a second launch just
        // focuses the running window instead of opening a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        // Remember window size/position/maximized across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // System tray (only if an app icon is available; otherwise we skip
            // it and fall back to normal close-quits behavior — see below).
            if let Some(icon) = app.default_window_icon().cloned() {
                let show_i =
                    MenuItem::with_id(app, "show", "Show Umbra", true, None::<&str>)?;
                let quit_i =
                    MenuItem::with_id(app, "quit", "Quit Umbra", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                let _tray = TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("Umbra")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Discord-style: closing the window hides it to the tray instead
            // of quitting. The real quit is the tray's "Quit Umbra" item. Only
            // trap the close when a tray actually exists to restore from.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.tray_by_id("main-tray").is_some() {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Umbra desktop app");
}
