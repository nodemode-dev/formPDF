fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["print_window"]),
    ))
    .expect("the tauri build step failed");
}
