#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

struct Backend(Mutex<Option<CommandChild>>);
struct Pending(Mutex<Vec<String>>);

const FALLBACK_LOGICAL: (f64, f64) = (1323.0, 860.0);
const MIN_LOGICAL: (f64, f64) = (980.0, 640.0);
const SCREEN_FRACTION: f64 = 0.9;

fn kill_backend(handle: &tauri::AppHandle) {
    if let Some(child) = handle.state::<Backend>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn close_splash(handle: &tauri::AppHandle) {
    if let Some(splash) = handle.get_webview_window("splash") {
        let _ = splash.close();
    }
}

fn openable(path: &std::path::Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
}

fn hand_over(handle: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    match handle.get_webview_window("main") {
        Some(window) => {
            let list = serde_json::to_string(&paths).unwrap_or_else(|_| "[]".into());
            let _ = window.eval(&format!(
                "(function f(n){{if(window.__formpdfOpen)window.__formpdfOpen({list});else if(n<60)setTimeout(function(){{f(n+1)}},250)}})(0)"
            ));
            let _ = window.set_focus();
        }
        None => handle.state::<Pending>().0.lock().unwrap().extend(paths),
    }
}

fn check_for_updates(handle: tauri::AppHandle) {
    let configured = handle
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map_or(false, |key| !key.is_empty());
    if !configured {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = handle.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };
        let install = handle
            .dialog()
            .message(format!("formpdf {} is available. Install it and restart?", update.version))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if install && update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            kill_backend(&handle);
            handle.restart();
        }
    });
}

#[tauri::command]
async fn print_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window labeled {label}"))?;
    window.print().map_err(|e| e.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = argv
                .into_iter()
                .skip(1)
                .map(|arg| {
                    let path = std::path::PathBuf::from(&arg);
                    if path.is_absolute() { path } else { std::path::Path::new(&cwd).join(path) }
                })
                .filter(|path| openable(path))
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            hand_over(app, paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![print_window])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Backend(Mutex::new(None)))
        .manage(Pending(Mutex::new(Vec::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            let (mut rx, child) = app
                .shell()
                .sidecar("formpdf-engine")
                .expect("sidecar binary is bundled")
                .env("FORMPDF_PORT", "0")
                .spawn()
                .expect("the formpdf engine failed to spawn");
            app.state::<Backend>().0.lock().unwrap().replace(child);
            let from_args: Vec<String> = std::env::args()
                .skip(1)
                .map(std::path::PathBuf::from)
                .filter(|path| openable(path))
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            app.state::<Pending>().0.lock().unwrap().extend(from_args);

            tauri::async_runtime::spawn(async move {
                let pattern = regex::Regex::new(r"http://127\.0\.0\.1:(\d+)").unwrap();
                let mut port: Option<u16> = None;
                while let Some(event) = rx.recv().await {
                    let line = match event {
                        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                            String::from_utf8_lossy(&bytes).into_owned()
                        }
                        CommandEvent::Terminated(_) => break,
                        _ => continue,
                    };
                    if let Some(captures) = pattern.captures(&line) {
                        port = captures[1].parse().ok();
                        if port.is_some() {
                            break;
                        }
                    }
                }
                match port {
                    Some(found) => {
                        let mut url: tauri::Url = format!("http://127.0.0.1:{found}")
                            .parse()
                            .expect("loopback url");
                        let waiting: Vec<String> = handle.state::<Pending>().0.lock().unwrap().drain(..).collect();
                        if !waiting.is_empty() {
                            let mut query = url.query_pairs_mut();
                            for path in &waiting {
                                query.append_pair("open", path);
                            }
                        }
                        let (width, height) = handle
                            .primary_monitor()
                            .ok()
                            .flatten()
                            .map(|monitor| {
                                let size = monitor.size();
                                let scale = monitor.scale_factor();
                                (
                                    (size.width as f64 / scale) * SCREEN_FRACTION,
                                    (size.height as f64 / scale) * SCREEN_FRACTION,
                                )
                            })
                            .unwrap_or(FALLBACK_LOGICAL);
                        let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                            .title("formpdf")
                            .inner_size(width, height)
                            .min_inner_size(MIN_LOGICAL.0, MIN_LOGICAL.1)
                            .center()
                            .build();
                        close_splash(&handle);
                        check_for_updates(handle.clone());
                    }
                    None => {
                        close_splash(&handle);
                        handle
                            .dialog()
                            .message("The formpdf engine failed to start. Please relaunch the app.")
                            .blocking_show();
                        kill_backend(&handle);
                        std::process::exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app should build");

    app.run(|handle, event| match event {
        RunEvent::Exit => kill_backend(handle),
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter(|path| openable(path))
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            hand_over(handle, paths);
        }
        _ => {}
    });
}
