/**
 * client-api.mjs —— 读取 references/formats/data/client-api.json（官方「客户端控件API文档」的机械解析产物）
 *
 * 产物由 scripts/build-client-api.mjs 生成；这里只做查询，不手抄任何表。
 * 证据等级：【文档】。文档没写的行为（默认值、校验严格程度）在 world.mjs / control.mjs 里单独标注。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_PATH = join(HERE, '..', '..', '..', 'references', 'formats', 'data', 'client-api.json');
export const API = JSON.parse(readFileSync(API_PATH, 'utf8'));
export const ENUMS = API.enums;

const BASE = 'ClientUIBaseControl';
const cache = new Map();

/** 某个控件类型的完整字段表 / 方法表（基类 + 自身），键为名字 */
export function controlSpec(typeName) {
  let spec = cache.get(typeName);
  if (spec) return spec;
  const own = API.types[typeName];
  const base = API.types[BASE];
  if (!own || !base) return undefined;
  spec = {
    typeName,
    fields: new Map([...Object.entries(base.fields), ...Object.entries(typeName === BASE ? {} : own.fields)]),
    methods: new Map([...Object.entries(base.methods), ...Object.entries(typeName === BASE ? {} : own.methods)]),
  };
  cache.set(typeName, spec);
  return spec;
}

/** 控件类型名（具体控件；不含基类） */
export const CONTROL_TYPES = new Set(API.controlTypes);

/** 给树描述（DSL / 命令行）用的别名 → 官方类型名 */
export const TYPE_ALIASES = {
  container: 'ClientUIContainerControl', 容器: 'ClientUIContainerControl', 容器节点: 'ClientUIContainerControl',
  image: 'ClientUIImageControl', 图片: 'ClientUIImageControl',
  text: 'ClientUITextBoxControl', 文本: 'ClientUITextBoxControl', 文本框: 'ClientUITextBoxControl',
  textwindow: 'ClientUITextWindowControl', 文本视窗: 'ClientUITextWindowControl',
  button: 'ClientUIPresetButtonControl', 按钮: 'ClientUIPresetButtonControl', 预设按钮: 'ClientUIPresetButtonControl',
  area: 'ClientUICursorEventAreaControl', cursor: 'ClientUICursorEventAreaControl', 光标检测区域: 'ClientUICursorEventAreaControl', 检测区: 'ClientUICursorEventAreaControl',
  grid: 'ClientUIGridScrollerControl', 网格视窗: 'ClientUIGridScrollerControl',
  keyhint: 'ClientUIKeyHintControl', 按键提示: 'ClientUIKeyHintControl',
  anim: 'ClientUIAnimationControl', 界面动效: 'ClientUIAnimationControl',
  fullscreen: 'ClientUIFullscreenAnimationControl', 全屏动效: 'ClientUIFullscreenAnimationControl',
  reference: 'ClientUIReferenceControl', 模板引用: 'ClientUIReferenceControl',
};

export function resolveTypeName(s) {
  if (CONTROL_TYPES.has(s)) return s;
  return TYPE_ALIASES[s] ?? TYPE_ALIASES[String(s).toLowerCase()];
}
