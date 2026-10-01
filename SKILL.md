---
name: miliastra-ugc
description: >-
  Use when working on 千星奇域 / 千星沙箱（原神 UGC）——关卡与地形搭建、实体与元件、战斗与技能、单位状态、道具经济、界面控件、服务端节点图、外围系统、存档与发布，或其中任何一处「配好了但没反应」的排障。Also use for client-side Lua UI scripts (widget tree, lifecycle, canvas readiness, Tween, cursor/key input, server signals) and when such logic is silently dead: no error in the log, but the button, text, animation, or signal never fires. Also use when reading, generating or editing .gia / .gil files (asset packages and level saves): put a Lua script into a level, check Lua widget names against the level's control tree, extract or generate server node graphs as .gia, diff two exports, or turn a save into editable JSON. Also use to run, smoke-test or debug a client Lua script offline with the bundled Lua 5.3 simulator (lint, whole-round run with auto-clicks, scenario tests) when there is no game to try it in.
---

# 千星奇域 UGC 创作（Claude / DSH 适配层）

> **完整规则与作业说明见同目录 `AGENTS.md`——先读它。**
>
> 本文件只做 Claude Agent Skills 格式要求的头部与最短路由。
> **规则以 `AGENTS.md` 为准，正文不在这里重复维护**（避免两份漂移）。
> 其它宿主（OpenAI Codex / Cursor / Zed 等）直接读 `AGENTS.md`，`references/` 三边共用。

## 最短路由

| 你要做的 | 读什么 |
|---|---|
| 任何事的第一站 | `AGENTS.md`（规则 + 域划分 + 交付要求） |
| 怪物不走桥、平台边缘停滞、生成或修改 GIL 场景 | `references/scene-navigation-playbook.md`（场景类型、碰撞、导航烘焙与过桥验证） |
| 找某个主题在语料里的位置 | `references/index.md`（全平台路由表，先学它的 §0） |
| **官方正文之外的补充**（含官方完整示例代码） | `references/index.md` §1.6 → `references/live/` |
| 写/审客户端 Lua UI 脚本 | `references/lua-ui-playbook.md` + `references/api/*` |
| **离线跑 / 冒烟 / 场景测试客户端 Lua**（没有真机时；语法、拼写、控件名、补间、点击、整数浮点） | **`references/formats/lua-sim.md`**（工具：`node scripts/sim-lua.mjs --help`；完整示例 `references/examples/circle-challenge/`） |
| **读/写 `.gil` / `.gia` 存档文件**（Lua 写进关卡、生成节点图、控件名核对、diff） | **`references/formats/README.md`**（工具：`node scripts/gi.mjs --help`） |
| 写一张服务器节点图（生成 `.gia`） | `references/formats/node-graph.md`（图规格语法 + `gi.mjs nodes find` 查节点） |
| 查官方原文、操作步骤、节点语义 | `references/corpus/Miliastra-knowledge/`（341 篇镜像） |

## 一句话原则

> **每个名字都必须有出处。没有出处的名字不写进代码、不配进编辑器、不写进存档文件，写成不确定项。**

## 四条硬规则（摘要，全文见 `AGENTS.md`）

1. **结论带证据等级**：【文档】/【官方示例】/【第三方】/【实测】/【未确认】。禁止把模拟器观测说成官方确认，禁止编造 API 名、节点名、节点 ID。**离线模拟器的结果是「脚本在这个模型里怎样」，不是平台事实**：写成「离线模拟：…」，引用它的诊断时保留证据标签。
2. **作用域就是用户问的那件事**。没让写文件就别写；没跑过就别说"已验证"。
3. **交稿前跑检查**：脚本类跑 `scripts/check-lua-ui.mjs`（先 `--selftest`）再 `node scripts/sim-lua.mjs smoke` 离线试跑；存档类跑 `scripts/check-gia-gil.mjs`（先 `--selftest`）；配置类交逐字核对表。离线通过 ≠ 真机通过。
4. **写存档的红线**：不覆盖原文件（`-o` 新路径 + 先备份）、只写有出处的节点/字段、**必须声明「未在真机验证」并给导入检验步骤**、生成后回读校验。

## 动手前的两条硬提醒

**客户端 Lua UI 脚本这一域，先看 `references/live/mh47p30a87qo_official-sample-main.lua`**——
那是官方教程「3.21 客户端脚本」工程文件里提取的完整实现，逐字未改、可直接抄。
控件树嵌套、初始化逐帧重试、点击判定控件选型这几条范式都以它为准，不是推测。

**要动 `.gil` / `.gia`，先读 `references/formats/README.md`。** 这套工具没有在真机上导入验证过：
交付时必须写明"未在真机验证"，并让用户先备份存档、在测试关卡里试。
