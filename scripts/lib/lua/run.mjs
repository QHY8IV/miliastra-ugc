/**
 * run.mjs —— 在一个干净的 Lua 5.3 环境里跑一段代码，收集 print 输出（自检与 eval 用）
 */

import { Interp } from './interp.mjs';
import { createGlobals } from './stdlib.mjs';
import { LuaError, LuaSyntaxError, ScriptTimeout } from './value.mjs';

/**
 * @returns {{ out: string, error?: string, syntax?: string, timeout?: string, interp: Interp, G: object }}
 *   out = 所有 print 的行用 \n 拼起来（printerr 的行前面加 [err]）
 */
export function runLua(src, { chunk = 'main', ...opts } = {}) {
  const lines = [];
  const interp = new Interp({ onPrint: (lvl, text) => lines.push(lvl === 'error' ? `[err]${text}` : text), ...opts });
  const G = createGlobals(interp, chunk);
  const res = { out: '', interp, G };
  try {
    const { closure } = interp.load(src, chunk, G);
    interp.callFromHost(closure, []);
  } catch (e) {
    if (e instanceof LuaError) res.error = e.message;
    else if (e instanceof LuaSyntaxError) res.syntax = e.message;
    else if (e instanceof ScriptTimeout) res.timeout = e.message;
    else throw e;
  }
  res.out = lines.join('\n');
  return res;
}
