fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["print_window", "set_window_title", "app_ready", "text_edit"]),
    ))
    .expect("the tauri build step failed");
}
