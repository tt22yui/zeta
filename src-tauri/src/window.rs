use tauri::Manager;

// Windows DWM：移除无边框窗口的原生边框（DWMWA_BORDER_COLOR），
// 避免三边出现取系统强调色的细边框（Win11 22H2+ 生效）。
#[cfg(windows)]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: isize,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

/// 启动期窗口逻辑：按显示器缩放(物理像素)与工作区分辨率将窗口居中；
/// 若窗口任一维度超过可用工作区则自动最大化，避免窗口被截断。
pub(crate) fn setup_window(app: &mut tauri::App) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("main") {
        #[cfg(windows)]
        {
            // 无边框窗口会带一圈原生 resize 边框（颜色取系统强调色、各边不一致），
            // 这里用 DWM 移除边框但保留阴影与缩放命中区
            const DWMWA_BORDER_COLOR: u32 = 34;
            const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;
            if let Ok(hwnd) = win.hwnd() {
                let none: u32 = DWMWA_COLOR_NONE;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd.0 as isize,
                        DWMWA_BORDER_COLOR,
                        &none as *const u32 as *const std::ffi::c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                }
            }
        }
        if let Ok(Some(monitor)) = win.current_monitor() {
            if let Ok(wsize) = win.outer_size() {
                // 显示器尺寸与左上角，单位物理像素，已含 DPI 缩放
                let mpos = monitor.position();
                let msize = monitor.size();
                let needs_maximize = wsize.width > msize.width || wsize.height > msize.height;
                if needs_maximize {
                    win.maximize()?;
                } else {
                    // 居中：左上角 = 工作区左上角 + (工作区尺寸 - 窗口尺寸) / 2
                    let w_w = wsize.width as i32;
                    let w_h = wsize.height as i32;
                    let x = (mpos.x + (msize.width as i32 - w_w) / 2).max(mpos.x);
                    let y = (mpos.y + (msize.height as i32 - w_h) / 2).max(mpos.y);
                    win.set_position(tauri::PhysicalPosition::new(x, y))?;
                }
            }
        }
        // 失败兜底：窗口以 visible:false 启动，由前端在首帧渲染后调用 show()。
        // 若前端因异常一直未触发，5 秒后强制显示，避免窗口永久隐藏；
        // 正常路径下 show() 幂等，无副作用。
        let win = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = win.show();
        });
    }
    Ok(())
}
