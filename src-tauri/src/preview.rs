use std::fs;
use std::io::Read;
use std::path::Path;

use crate::model::TextPreview;

/// 读取文本文件前 `max_bytes` 字节用于预览。超出则截断并标记 truncated。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
pub(crate) fn read_text_preview_inner(path: &Path, max_bytes: u64) -> Result<TextPreview, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let len = meta.len();
    let cap = len.min(max_bytes);
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; cap as usize];
    if cap > 0 {
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    }
    // UTF-8 失败时降级为 lossy 解码，保证不丢字节、不报错给前端
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(TextPreview {
        text,
        truncated: len > max_bytes,
    })
}

/// 读取文本文件前 1 MiB 用于预览面板。大文件只展示首段，避免内存爆涨。
#[tauri::command(async)]
pub(crate) async fn read_text_preview(path: String) -> Result<TextPreview, String> {
    read_text_preview_inner(Path::new(&path), 1 << 20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_text_preview_full_small_file() {
        let path = std::env::temp_dir().join("zeta_preview_small.txt");
        std::fs::write(&path, "hello preview").unwrap();
        let p = read_text_preview_inner(&path, 1024).unwrap();
        assert_eq!(p.text, "hello preview");
        assert!(!p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_truncates_large_file() {
        let path = std::env::temp_dir().join("zeta_preview_large.txt");
        let content: Vec<u8> = (0..100).map(|i| b'a' + (i % 26) as u8).collect();
        std::fs::write(&path, &content).unwrap();
        let p = read_text_preview_inner(&path, 30).unwrap();
        assert_eq!(p.text.len(), 30);
        assert_eq!(p.text.as_bytes(), &content[..30]);
        assert!(p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_empty_file() {
        let path = std::env::temp_dir().join("zeta_preview_empty.txt");
        std::fs::write(&path, "").unwrap();
        let p = read_text_preview_inner(&path, 1024).unwrap();
        assert_eq!(p.text, "");
        assert!(!p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_missing_file_errors() {
        let path = std::env::temp_dir().join("zeta_nonexistent_subdir_xyz").join("file.txt");
        let r = read_text_preview_inner(&path, 1024);
        assert!(r.is_err());
    }
}
