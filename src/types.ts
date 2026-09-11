export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  ext: string;
  base: string;
  tags: string[];
  size: number;
  modified: number;
}
