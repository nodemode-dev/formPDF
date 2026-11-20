#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine_start;
mod reveal;
mod text_edit;
mod traffic_lights;
#[cfg(windows)]
mod win_job;

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

struct Backend(Mutex<Option<CommandChild>>);
struct Pending(Mutex<Vec<String>>);

const FALLBACK_LOGICAL: (f64, f64) = (1323.0, 860.0);
const MIN_LOGICAL: (f64, f64) = (980.0, 640.0);
const SCREEN_FRACTION: f64 = 0.9;

type EngineStep = Result<CommandEvent, Option<engine_start::Wait>>;

fn kill_backend(handle: &tauri::AppHandle) {
    if let Some(child) = handle.state::<Backend>().0.lock().unwrap().take() {
        #[cfg(windows)]
        win_job::end();
        let _ = child.kill();
    }
}

fn close_splash(handle: &tauri::AppHandle) {
    if let Some(splash) = handle.get_webview_window("splash") {
        let _ = splash.close();
    }
}

fn start_limit(late: &tauri::async_runtime::Sender<EngineStep>, limit: std::time::Duration, wait: Option<engine_start::Wait>) {
    let late = late.clone();
    std::thread::spawn(move || {
        std::thread::sleep(limit);
        let _ = late.blocking_send(Err(wait));
    });
}

fn engine_failed(handle: &tauri::AppHandle, failure: engine_start::Failure, tail: &engine_start::Tail) {
    let text = engine_start::message(&failure, &tail.lines(), engine_start::engine_log().as_deref());
    eprintln!("formpdf: {text}");
    let _ = handle
        .dialog()
        .message(text)
        .title(engine_start::APP)
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
    close_splash(handle);
    kill_backend(handle);
    std::process::exit(1);
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
    reveal::mark_launch();
    let app = tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    WindowEvent::Resized(_)
                        | WindowEvent::Focused(_)
                        | WindowEvent::ThemeChanged(_)
                        | WindowEvent::ScaleFactorChanged { .. }
                )
            {
                traffic_lights::place(window);
            }
        })
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
        .invoke_handler(tauri::generate_handler![print_window, traffic_lights::set_window_title, reveal::app_ready, text_edit::text_edit])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Backend(Mutex::new(None)))
        .manage(Pending(Mutex::new(Vec::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            reveal::round_splash(&handle);
            let engine = app.shell().sidecar("formpdf-engine").map_err(|_| engine_start::Failure::Missing);
            let started = engine.and_then(|engine| {
                engine
                    .env("FORMPDF_PORT", "0")
                    .env("FORMPDF_WINDOW_KEY_STDOUT", "1")
                    .env(engine_start::SHELL_ENV, std::process::id().to_string())
                    .spawn()
                    .map_err(|err| engine_start::Failure::NotStarted(err.to_string()))
            });
            let (mut rx, child) = match started {
                Ok(pair) => pair,
                Err(failure) => {
                    std::thread::spawn(move || engine_failed(&handle, failure, &engine_start::Tail::default()));
                    return Ok(());
                }
            };
            #[cfg(windows)]
            win_job::hold_pid(child.pid());
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
                let key_pattern = regex::Regex::new(r"formpdf-window-key: ([A-Za-z0-9_-]{32,})").unwrap();
                let (tx, mut events) = tauri::async_runtime::channel::<EngineStep>(64);
                let late = tx.clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        if tx.send(Ok(event)).await.is_err() {
                            break;
                        }
                    }
                    let _ = tx.send(Err(None)).await;
                });
                start_limit(&late, engine_start::Wait::Address.limit(), Some(engine_start::Wait::Address));
                let mut port: Option<u16> = None;
                let mut key: Option<String> = None;
                let mut key_asked = false;
                let mut stopped = false;
                let mut tail = engine_start::Tail::default();
                let mut failure = engine_start::Failure::Stopped(None);
                while let Some(step) = events.recv().await {
                    let text = match step {
                        Ok(CommandEvent::Stdout(bytes)) => {
                            let text = String::from_utf8_lossy(&bytes).into_owned();
                            if key.is_none() {
                                key = key_pattern.captures(&text).map(|found| found[1].to_string());
                            }
                            text
                        }
                        Ok(CommandEvent::Stderr(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
                        Ok(CommandEvent::Terminated(ended)) => {
                            failure = engine_start::Failure::Stopped(ended.code);
                            stopped = true;
                            start_limit(&late, engine_start::EXIT_WAIT, None);
                            continue;
                        }
                        Ok(_) => continue,
                        Err(None) => break,
                        Err(Some(_)) if stopped => break,
                        Err(Some(engine_start::Wait::Address)) if port.is_some() => continue,
                        Err(Some(wait)) => {
                            failure = engine_start::Failure::TimedOut(wait);
                            break;
                        }
                    };
                    for line in text.lines() {
                        tail.push(line);
                    }
                    if port.is_none() {
                        port = pattern.captures(&text).and_then(|found| found[1].parse::<u16>().ok());
                    }
                    if port.is_some() && key.is_some() {
                        break;
                    }
                    if port.is_some() && !key_asked {
                        key_asked = true;
                        start_limit(&late, engine_start::Wait::Key.limit(), Some(engine_start::Wait::Key));
                    }
                }
                drop(late);
                match port.filter(|_| key.is_some()) {
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
                        let builder = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                            .title("FormPDF")
                            .visible(reveal::BUILD_VISIBLE)
                            .background_color(reveal::BACKGROUND)
                            .inner_size(width, height)
                            .min_inner_size(MIN_LOGICAL.0, MIN_LOGICAL.1)
                            .center()
                            .disable_drag_drop_handler();
                        let origin = format!("http://127.0.0.1:{found}");
                        let builder = match &key {
                            Some(value) => builder.initialization_script(format!(
                                "if (window.location.origin === {origin:?}) {{ window.__FORMPDF_WINDOW_KEY = {value:?}; }}"
                            )),
                            None => builder,
                        };
                        #[cfg(target_os = "macos")]
                        let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
                        let builder = builder.on_page_load(|window, payload| {
                            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                                traffic_lights::place(&window.as_ref().window());
                            }
                        });
                        if let Ok(window) = builder.build() {
                            reveal::conceal(&window);
                            traffic_lights::place(&window.as_ref().window());
                        } else {
                            engine_failed(&handle, engine_start::Failure::Window, &engine_start::Tail::default());
                            return;
                        }
                        check_for_updates(handle.clone());
                    }
                    None => engine_failed(&handle, failure, &tail),
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
