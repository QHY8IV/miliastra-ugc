/**
 * enums.mjs —— Enum 表与 EnumItem
 *
 * 【文档】枚举值是 EnumItem，字段 Name / FullName / EnumType（官方原文 §10，注意首字母大写）。
 * 【真机】Enum.EaseType 用 pairs 枚举恰好 31 项，成员是 EnumItem 不是字符串（契约 §9）。
 * 【未确认】FullName 的具体写法、tostring(EnumItem) 的输出。这里取 "Enum.组名.值名"（Roblox 风格），脚本不应依赖。
 */

import { Host, LuaTable, utf8Decode, utf8Encode } from '../lua/value.mjs';

export class EnumItem extends Host {
  constructor(group, name) {
    super('EnumItem');
    this.group = group;
    this.name = name;
  }

  index(key) {
    const k = typeof key === 'string' ? utf8Decode(key) : '';
    if (k === 'Name') return utf8Encode(this.name);
    if (k === 'FullName') return utf8Encode(`Enum.${this.group}.${this.name}`);
    if (k === 'EnumType') return utf8Encode(this.group);
    return undefined;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }

  tostring() { return utf8Encode(`Enum.${this.group}.${this.name}`); }
}

/** @param {Record<string,string[]>} enums  枚举组 → 值名列表（来自 client-api.json） */
export function buildEnums(enums) {
  const table = new LuaTable();
  const items = new Map();                 // "组.值" → EnumItem
  for (const [group, names] of Object.entries(enums)) {
    const t = new LuaTable();
    for (const n of names) {
      const it = new EnumItem(group, n);
      items.set(`${group}.${n}`, it);
      t.set(utf8Encode(n), it);
    }
    table.set(utf8Encode(group), t);
  }
  return { table, item: (group, name) => items.get(`${group}.${name}`) };
}
