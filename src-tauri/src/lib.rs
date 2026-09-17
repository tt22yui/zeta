mod browse;
mod file_ops;
mod folder_ops;
mod fs_util;
mod history;
mod model;
mod preview;
mod tags;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .manage(history::History::new())
        .manage(tags::TagSettings::new())
        .invoke_handler(tauri::generate_handler![
            browse::list_dir,
            browse::list_subdirs,
            browse::get_drives,
            browse::get_default_dir,
            browse::get_home_dir,
            file_ops::add_tag,
            file_ops::remove_tag,
            file_ops::set_tag_separator,
            file_ops::rename_file,
            file_ops::delete_file,
            history::undo,
            history::redo,
            history::can_undo,
            history::can_redo,
            folder_ops::dissolve_folder,
            folder_ops::collect_into_folder,
            folder_ops::move_into_folder,
            preview::read_text_preview
        ])
        // 启动期窗口逻辑：居中 / 必要时最大化 / 去边框 / 5 秒兜底显示
        .setup(|app| {
            window::setup_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running zeta application");
}
