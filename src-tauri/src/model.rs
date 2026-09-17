use serde::Serialize;

/// 目录条目（前端列表用）。
#[derive(Serialize)]
pub(crate) struct FileEntry {
    pub(crate) name: String,   // 含扩展名的完整文件名
    pub(crate) path: String,   // 绝对路径
    pub(crate) is_dir: bool,
    pub(crate) is_hidden: bool,
    pub(crate) ext: String,    // 扩展名（不含点）
    pub(crate) base: String,   // 去扩展名、去标签后的名称
    pub(crate) tags: Vec<String>,
    pub(crate) size: u64,      // 字节；目录为 0
    pub(crate) modified: u64,  // 修改时间（Unix 秒）
}

/// 文本预览结果：截断后的文本 + 是否被截断。
#[derive(Serialize)]
pub(crate) struct TextPreview {
    pub(crate) text: String,
    pub(crate) truncated: bool,
}
