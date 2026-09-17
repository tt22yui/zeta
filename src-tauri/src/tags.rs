use std::sync::Mutex;

use crate::model::FileEntry;

/// Windows 上不允许出现在文件名中的字符；分隔符校验时排除，避免打标签产生非法文件名。
pub(crate) const SEP_FORBIDDEN: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 校验并规范化标签分隔符：返回首个合法字符；空/空白/非法字符序列则返回 None。
/// 纯逻辑：可独立单元测试。
pub(crate) fn sanitize_sep(input: &str) -> Option<char> {
    input
        .chars()
        .find(|c| !c.is_whitespace() && !SEP_FORBIDDEN.contains(c))
}

/// 校验并规范化标签：trim → 剔除分隔符字符；空标签或含非法文件名字符则返回 None。
/// 非法字符跨平台一律拒绝（即使 macOS 允许 `:` 等），避免同一标签在不同系统表现不一致。
/// 纯逻辑：可独立单元测试。
pub(crate) fn sanitize_tag(tag: &str, sep: char) -> Option<String> {
    if tag.chars().any(|c| SEP_FORBIDDEN.contains(&c)) {
        return None;
    }
    let cleaned: String = tag.trim().chars().filter(|c| *c != sep).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned)
}

/// 文件名中是否已含该标签。用于打标签的幂等去重，避免写出 `a#x#x`。
pub(crate) fn tag_already_present(entry: &FileEntry, tag: &str) -> bool {
    entry.tags.iter().any(|t| t == tag)
}

/// 标签分隔符配置（内存态）。持久化由前端 `zeta.settings` 负责；
/// 应用启动后由前端 `set_tag_separator` 命令同步，默认 `#`。
pub(crate) struct TagSettings {
    pub(crate) sep: Mutex<char>,
}

impl TagSettings {
    pub(crate) fn new() -> Self {
        Self {
            sep: Mutex::new('#'),
        }
    }
}

/// 约定：文件名中从第一个 `sep` 开始，每个 `sep`xxx` 段都是一个标签。
/// base 为第一个 `sep` 之前的部分（去掉扩展名）。
pub(crate) fn parse_tags(file_stem: &str, sep: char) -> (String, Vec<String>) {
    let parts: Vec<&str> = file_stem.split(sep).collect();
    if parts.is_empty() {
        return (String::new(), Vec::new());
    }
    let base = parts[0].to_string();
    let tags: Vec<String> = parts[1..]
        .iter()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    (base, tags)
}

/// 构造改名后的新文件名：base + 现有标签 + 新标签 + 扩展名。
pub(crate) fn build_new_name(entry: &FileEntry, add_tag: &str, sep: char) -> String {
    let mut stem = entry.base.clone();
    for t in &entry.tags {
        stem.push(sep);
        stem.push_str(t);
    }
    stem.push(sep);
    stem.push_str(add_tag);
    if !entry.ext.is_empty() {
        stem.push('.');
        stem.push_str(&entry.ext);
    }
    stem
}

/// 移除某个标签，返回新文件名。若标签不存在则返回 None。
pub(crate) fn strip_tag(entry: &FileEntry, tag: &str, sep: char) -> Option<String> {
    let remaining: Vec<&String> = entry.tags.iter().filter(|t| t.as_str() != tag).collect();
    if remaining.len() == entry.tags.len() {
        return None; // 该标签不在文件名中
    }
    let mut stem = entry.base.clone();
    for t in remaining {
        stem.push(sep);
        stem.push_str(t);
    }
    if !entry.ext.is_empty() {
        stem.push('.');
        stem.push_str(&entry.ext);
    }
    Some(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按真实解析语义构造 FileEntry：base 为不含扩展名的主名，name 由 base+tags+ext 拼出。
    fn entry(base: &str, ext: &str, tags: Vec<&str>) -> FileEntry {
        let mut name = base.to_string();
        for t in &tags {
            name.push('#');
            name.push_str(t);
        }
        if !ext.is_empty() {
            name.push('.');
            name.push_str(ext);
        }
        FileEntry {
            name,
            path: format!("C:/tmp/{base}"),
            is_dir: false,
            is_hidden: false,
            ext: ext.to_string(),
            base: base.to_string(),
            tags: tags.into_iter().map(|s| s.to_string()).collect(),
            size: 0,
            modified: 0,
        }
    }

    #[test]
    fn parse_tags_splits_stem() {
        let (base, tags) = parse_tags("报告#工作#重要", '#');
        assert_eq!(base, "报告");
        assert_eq!(tags, vec!["工作", "重要"]);
    }

    #[test]
    fn parse_tags_no_tag_keeps_full_stem() {
        let (base, tags) = parse_tags("README", '#');
        assert_eq!(base, "README");
        assert!(tags.is_empty());
    }

    #[test]
    fn parse_tags_filters_empty_segments() {
        let (base, tags) = parse_tags("文档##脏标签", '#'); // 连续 # 的空段被过滤
        assert_eq!(base, "文档");
        assert_eq!(tags, vec!["脏标签"]);
    }

    #[test]
    fn parse_tags_uses_custom_separator() {
        let (base, tags) = parse_tags("笔记@工作@重要", '@');
        assert_eq!(base, "笔记");
        assert_eq!(tags, vec!["工作", "重要"]);
    }

    #[test]
    fn sanitize_sep_takes_first_legal_char() {
        assert_eq!(sanitize_sep("  "), None);
        assert_eq!(sanitize_sep(""), None);
        // 跳过开首空白/非法字符，取首个合法字符
        assert_eq!(sanitize_sep(" /#"), Some('#'));
        // 全为非法字符时应返回 None
        assert_eq!(sanitize_sep("/:"), None);
        assert_eq!(sanitize_sep("@"), Some('@'));
        assert_eq!(sanitize_sep("  @"), Some('@'));
    }

    #[test]
    fn build_new_name_appends_tag_before_ext() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(build_new_name(&e, "重要", '#'), "报告#工作#重要.md");
    }

    #[test]
    fn build_new_name_first_tag_no_ext() {
        let e = entry("笔记", "", vec![]);
        assert_eq!(build_new_name(&e, "读书", '#'), "笔记#读书");
    }

    #[test]
    fn build_new_name_uses_custom_separator() {
        let e = entry("笔记", "md", vec!["工作"]);
        assert_eq!(build_new_name(&e, "重要", '@'), "笔记@工作@重要.md");
    }

    #[test]
    fn strip_tag_removes_one_and_keeps_rest() {
        let e = entry("报告", "md", vec!["工作", "重要"]);
        assert_eq!(strip_tag(&e, "工作", '#'), Some("报告#重要.md".to_string()));
    }

    #[test]
    fn strip_tag_absent_returns_none() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(strip_tag(&e, "不存在", '#'), None);
    }

    #[test]
    fn strip_tag_last_removes_hash_and_ext_kept() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(strip_tag(&e, "工作", '#'), Some("报告.md".to_string()));
    }

    #[test]
    fn strip_tag_uses_custom_separator() {
        let e = entry("笔记", "md", vec!["工作", "重要"]);
        assert_eq!(strip_tag(&e, "工作", '@'), Some("笔记@重要.md".to_string()));
    }

    #[test]
    fn sanitize_tag_trims_and_strips_separator() {
        assert_eq!(sanitize_tag("工作", '#'), Some("工作".to_string()));
        assert_eq!(sanitize_tag("  工作  ", '#'), Some("工作".to_string()));
        // 手输 "a#b" 时分隔符被剔除，避免写出 a#b 这种被解析成两个标签的名字
        assert_eq!(sanitize_tag("a#b", '#'), Some("ab".to_string()));
        assert_eq!(sanitize_tag(" # ", '#'), None); // 只有空白与分隔符
    }

    #[test]
    fn sanitize_tag_rejects_empty_and_separator_only() {
        assert_eq!(sanitize_tag("", '#'), None);
        assert_eq!(sanitize_tag("   ", '#'), None);
        assert_eq!(sanitize_tag("###", '#'), None);
    }

    #[test]
    fn sanitize_tag_rejects_forbidden_chars() {
        for c in SEP_FORBIDDEN {
            let tag = format!("a{}b", c);
            assert_eq!(sanitize_tag(&tag, '#'), None, "应拒绝非法字符 {:?}", c);
            // 前后空白不能掩盖非法字符
            assert_eq!(sanitize_tag(&format!(" {} ", tag), '#'), None);
        }
    }

    #[test]
    fn sanitize_tag_uses_custom_separator() {
        assert_eq!(sanitize_tag("a@b", '@'), Some("ab".to_string()));
        // 非当前分隔符的字符应原样保留
        assert_eq!(sanitize_tag("a@b", '#'), Some("a@b".to_string()));
    }

    #[test]
    fn tag_already_present_detects_existing_tag() {
        let e = entry("报告", "md", vec!["工作", "重要"]);
        assert!(tag_already_present(&e, "工作"));
        assert!(!tag_already_present(&e, "新标签"));
        assert!(!tag_already_present(&e, "工")); // 部分匹配不算
    }
}
