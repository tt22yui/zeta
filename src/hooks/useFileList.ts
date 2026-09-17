import { useCallback, useDeferredValue, useMemo, useState } from "react";
import type { FileEntry } from "../types";
import { filterAndSortEntries } from "../util";
import type { SortKey } from "../util";

/**
 * 文件列表的视图派生：搜索过滤、排序、标签计数与文件夹/文件统计。
 * 过滤+排序走 useDeferredValue，避免每敲一个字符都同步阻塞主线程重排全表。
 */
export function useFileList(entries: FileEntry[], search: string) {
  // 排序：key 为字段（name/size/modified），desc 为升序/降序
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const visibleEntries = useMemo(
    () => filterAndSortEntries(entries, deferredSearch, sortKey, sortDesc),
    [entries, deferredSearch, sortKey, sortDesc]
  );

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const folders = useMemo(() => {
    let n = 0;
    for (const e of entries) if (e.is_dir) n++;
    return n;
  }, [entries]);
  const files = entries.length - folders;

  /** 切换排序：点同字段反向，切字段时大小/时间默认降序、名称默认升序 */
  const applySort = useCallback(
    (k: SortKey) => {
      setSortKey(k);
      if (sortKey === k) setSortDesc((d) => !d);
      else setSortDesc(k === "size" || k === "modified");
    },
    [sortKey]
  );

  return { sortKey, sortDesc, applySort, visibleEntries, tagCounts, folders, files };
}
