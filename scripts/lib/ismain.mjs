/**
 * ismain.mjs —— 「这个模块是不是被当作命令行入口运行的」
 *
 * 不能直接比字符串：Windows 上路径大小写、符号链接、盘符大小写不同都会让两边不相等，
 * 结果是命令行「什么都不做就退出 0」——对检查器来说这是最坏的失败方式。所以两边都走 realpathSync.native 再比。
 * （import.meta.main 要 Node 22.18 / 24.2 以上，技能要求的是 Node >= 22，不能依赖它。）
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const canon = (p) => { try { return realpathSync.native(p); } catch { return p; } };
  const a = canon(entry);
  const b = canon(fileURLToPath(metaUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
