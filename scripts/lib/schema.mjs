/**
 * schema.mjs —— 加载 references/formats/schema/ 下的 .proto，合并成一个 Schema（进程内缓存）
 *
 * gia.proto  改编自社区 MIT 项目（出处与改动清单在文件头），管 .gia 与节点图
 * gil.proto  本技能自有，管 .gil 顶层与已核对过的几个板块
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProto } from './proto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = join(HERE, '..', '..', 'references', 'formats', 'schema');
const FILES = ['gia.proto', 'gil.proto'];

let cached = null;

export function getSchema() {
  if (cached) return cached;
  cached = parseProto(FILES.map((f) => ({ file: f, text: readFileSync(join(SCHEMA_DIR, f), 'utf8') })));
  return cached;
}

/** 不同文件类型的根消息 */
export const ROOT_MESSAGE = Object.freeze({ gia: 'AssetBundle', gil: 'GilFile' });
