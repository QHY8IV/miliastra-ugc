# miliastra-ugc

面向 agent 的「千星奇域 / 千星沙箱」（原神 UGC）**全平台创作技能**。

覆盖面：关卡与地形 · 实体与元件 · 战斗与技能 · 单位状态 · 道具经济 · 界面控件 · 服务端节点图 · 外围系统 · 存档与发布 · **客户端 Lua UI 脚本**（带静态检查器 + **离线 Lua 模拟器**：没有真机也能把脚本整局跑一遍） · **存档文件 `.gia` / `.gil` 直读直写**（带读写工具与检查器）。

技能本体是 `AGENTS.md`（规则）+ `SKILL.md`（Claude/DSH 格式适配）+ `references/`（正文），
**一份内容三边共用**，可整目录安装到任意 agent 技能根，也可直接把 `AGENTS.md` 放进工作区根给 GPT 系用。

---

## 一、这份技能解决什么

千星奇域是**编辑器配置 + 图形化节点图 + 受限 Lua 脚本**三层叠起来的。它的共同特征是：**名字逐字匹配，错了不报错**——控件名、信号名、变量名、标签名、阵营名对不上，结果就是"配好了但没反应"；客户端 Lua 里字段**写**错才报错，**读**错只是 nil，补间字段写错动画干脆不动。

本技能把这件事变成可核对的流程：

- **定位**：先过 `references/index.md` 的全平台语料路由表，再回 341 篇官方文档镜像，不遍历、不凭记忆拼路径。
- **写**：客户端脚本按六步落地（控件树 → 数据流 → 生命周期 → 逐字核对 → 兜底日志 → 过检查）；配置类产物交逐字核对表。
- **审**：`scripts/check-lua-ui.mjs` 把客户端 Lua 的"读一遍看看"变成可重复执行的机械检查。
- **离线跑**：`scripts/sim-lua.mjs` 是一个 Lua 5.3 解释器加一套「客户端 API 模型」（控件树、布局、补间、生命周期、光标 / 按键 / 信号事件、虚拟时钟）。`smoke` 一条命令把脚本整局跑一遍并给出带证据标签的诊断，`test` 跑你写的游戏规则断言。**它是模型不是引擎**——通过 ≠ 真机通过，边界与保真度表见 `references/formats/lua-sim.md`。
- **排错**：按静默失效的典型成因逐层收敛，而不是重写一遍。
- **直写存档**：`scripts/gi.mjs` 直接读写 `.gil`（关卡存档）与 `.gia`（资产包）——把 Lua 写进关卡、拿存档里的控件树核对 Lua 的控件名、生成服务器节点图 `.gia`、把任意存档变成可编辑 JSON 再写回。协议来自对 **50 个官方教学存档**的逆向，并用它们逐项核对（见「五·B」）。

**它替不了你做的事**（写在最前面，别误会）：在编辑器里点、调手感、试玩，以及**在真机上导入验证**。
存档工具生成的文件**没有在真机上验证过**——交付时必须这样声明，导入前请备份存档（`references/formats/README.md` §6）。

## 二、资料来源与时效

| 项 | 值 |
|---|---|
| 主要来源 | 米哈游官方教程站 `https://act.mihoyo.com/ys/ugc/tutorial/` 及其条目 |
| 语料载体① | 第三方整理镜像 `https://github.com/1475505/Miliastra-knowledge` → `references/corpus/` |
| 语料载体② | **官方站直接抓取** → `references/live/`（镜像没有的条目、官方工程文件） |
| 镜像抓取时间 | **2026-09-25T17:54:09.605Z**（写入各文档 front matter 的 `crawledAt`） |
| 语料规模 | 341 篇 md + 76 张界面示意图 SVG（镜像）；另有 `live/` 若干篇 |
| 镜像最后同步 | 见 `references/corpus/Miliastra-knowledge` 的 git 提交时间 |
| 核心 API 文档 | `客户端控件API文档`，官方条目 id `mhtakr07vej4` |
| 官方完整示例代码 | `references/live/mh47p30a87qo_official-sample-main.lua`（教程 3.21 工程文件提取） |
| 官方教学存档（逆向 `.gil/.gia` 的依据） | 50 个（48 `.gil` + 2 `.gia`，约 2.4 MB）→ `references/samples/`，`node scripts/fetch-official-samples.mjs` 抓取；索引见 `references/formats/samples.md` |
| 第三方逆向资料（线索，须样本核对） | 社区 MIT 项目 Wu-Yijun/…Node-Editor-Pack、script-1024/genshin-miliastra-file-format → `references/community/`，`node scripts/fetch-community-refs.mjs` 抓取；出处与许可证见 `references/formats/schema/THIRD_PARTY_LICENSES.md` |

### 时效声明

> **⚠️ 更正**：本文件此前写着"官方教程站正文由前端渲染，直接抓取只能拿到空壳"。
> **这句是错的**，已推翻。页面确实渲染不出内容，但**正文以静态文件挂在 CDN 上**，路径规律已经逆出来：

```
https://act-webstatic.mihoyo.com/ugc-tutorial/course/cn/zh-cn/<条目id>/content.html
目录：.../course/cn/zh-cn/catalog.json   （指南换 knowledge/cn，FAQ 换 faq/cn）
```

抓取工具是 `scripts/fetch-official-doc.mjs`，零依赖：

```sh
node scripts/fetch-official-doc.mjs --list          # 列全部条目
node scripts/fetch-official-doc.mjs <条目id>         # 抓一篇到 references/live/
```

**这意味着不必再等镜像更新。** 镜像仓库会漏条目——例如 `mh47p30a87qo`（教程 3.21 客户端脚本），
本技能包最相关的一篇，镜像停在 `c1e4a2c`（2026-09-26）时**根本没有它**，是从官方站直接抓下来的。
细节与边界见 `references/live/README.md`。

**API 以编辑器内的实际行为为准**；发现不一致时，以真机实测结果修正本技能，并记回 `references/api/runtime-contract.md`。

**版权声明**：`references/corpus/` 下的文档版权归米哈游（miHoYo / HoYoverse）所有，此处仅作个人学习与创作辅助使用。本仓库自身的 `SKILL.md`、`references/` 下的速查与索引文件、`scripts/` 下的脚本为原创整理。

## 三、安装

### 1. 拉取语料（可选，但强烈建议）

语料不随仓库分发，需自行克隆到指定位置：

```sh
cd F:\genshin\miliastra-ugc
git clone --depth 1 https://github.com/1475505/Miliastra-knowledge.git references/corpus/Miliastra-knowledge
```

克隆后应存在 `references/corpus/Miliastra-knowledge/AGENTS.md`（全库条目总目录）。

> **不拉也能用。** 技能核心（`SKILL.md` + `references/index.md` + `references/lua-ui-playbook.md` + `references/api/*` + `scripts/`）是自包含的；只有需要官方原文、操作步骤、节点语义时才会用到 `references/corpus/`。拉完语料后再执行一次下面的安装命令即可补齐。

### 2. 安装：一份内容，多个入口

技能包有**两个入口文件，指向同一套 `references/`**：

| 入口 | 谁读它 | 说明 |
|---|---|---|
| **`AGENTS.md`** | OpenAI Codex / Cursor / Zed / Jules 等（**仓库根自动读取**） | **规则以它为准**，含四条硬规则、域划分、交付要求、跨 agent 注意事项 |
| `SKILL.md` | Claude 系（Claude Code / claude.ai Skills）、DSH | Claude Agent Skills 格式头部（YAML frontmatter）+ 最短路由，**正文规则不在这里重复维护** |

> 两份入口**不会漂移**：`SKILL.md` 只保留格式要求与指针，"规则改哪里"是写死的单向依赖。

**GPT 系（Codex CLI / Cursor / Zed）**：`AGENTS.md` 放在**工作区根**即可自动生效。
把技能包整个复制过去，或者只把 `AGENTS.md` 放到项目根、`references/` 放到它旁边：

```sh
# 从技能包源码目录执行；目标目录按你的工作区调整
robocopy . "<你的工作区>\miliastra-ugc" /E /XD .git samples community
```

**Claude 系 / DSH**：按 `SKILL.md` 的英文短横线名安装为 `miliastra-ugc`：

```sh
# 跨宿主通用技能根
robocopy . "%USERPROFILE%\.agents\skills\miliastra-ugc" /E /XD .git samples community

# 或 DSH 专用根
robocopy . "%USERPROFILE%\.dsh\skills\miliastra-ugc" /E /XD .git samples community
```

> `/XD .git samples community`：`.git` 是语料镜像的版本库元数据（约 1.2MB），源码目录保留它以便 `git pull` 更新，安装副本不需要；
> `samples`（官方教学存档）与 `community`（第三方原始资料）**版权不归本技能，不随技能分发**——装好后按需用 `fetch-official-samples.mjs` / `fetch-community-refs.mjs` 重新抓取（回归与重建节点表才用得到，日常读写存档不需要）。
> 若同时安装到多个技能根，改一处需全部同步；两个根都装会让同名技能在注册表里按 rank 二选一。

**ChatGPT 网页版 / Claude 网页版**（没有文件系统，读不到上面两个入口）：
把 `AGENTS.md` 的正文直接粘进 Project 指令 / 自定义指令，再按需贴 `references/` 里对应那一篇。
这类场景下**优先贴 `references/live/` 的官方示例代码**——它是可直接照抄的完整实现，比任何摘要都硬。

### 3. 验证安装

在安装副本里跑这两条，都应通过：

```sh
node scripts/check-lua-ui.mjs --selftest    # 应输出「全部 19 项通过」
node scripts/check-gia-gil.mjs --selftest   # 应输出「全部 13 项通过」（没有 references/samples/ 时是 12 项，并提示跳过样本回归）
node scripts/check-lua-sim.mjs              # 离线 Lua 模拟器自检，应输出「全部 N 项通过」（没有 references/samples/ 时少跑「存档样本」几条）
```

再新开一个会话问一句：

> 千星奇域里，客户端脚本的补间动画怎么做？

回答里应出现 `game.Tween(对象, {字段=目标值}, 时长)` 的**点号**调用，并知道 `Tween:Play()` 要另调、缩放字段是 `localScaleX/Y` 而不是 `scale`。答不出来说明技能没被加载。

## 四、目录结构

```
miliastra-ugc/
├── README.md                          ← 本文件（来源、安装、维护）
├── AGENTS.md                          ← ★ 全 agent 统一入口（规则唯一事实源）
├── SKILL.md                           ← Claude/DSH 适配层（frontmatter + 最短路由）
├── references/
│   ├── index.md                       ← 全平台语料路由表（先学 §0 的查找方法）
│   ├── lua-ui-playbook.md             ← 客户端 Lua UI 实战手册（官方控件树范式/六步/骨架/排错阶梯/冲突表）
│   ├── api/
│   │   ├── client-ui-api.md           ← 客户端 Lua UI API 逐条速查（含签名与枚举全表）
│   │   ├── runtime-contract.md        ← 带证据分级的实测契约（纠正了官方文档若干处）
│   │   └── pitfalls.md                ← 静默失效成因清单（写/审/排错共用）
│   ├── live/                          ← ★ 官方站直接抓取区（镜像没有的条目 + 官方工程文件）
│   │   ├── README.md                  ← 抓取规律与命令
│   │   ├── mh47p30a87qo_*.md / .html  ← 教程 3.21 正文（正文 + 原始快照）
│   │   └── mh47p30a87qo_official-sample-main.lua  ← ★ 官方完整实现，可直接抄
│   ├── formats/                       ← ★ 存档文件（.gil/.gia）直读直写：手册 + schema + 数据表
│   │   ├── README.md                  ← 入口：能做什么、工作流、证据、导入检验流程
│   │   ├── container.md · gia.md · gil.md · node-graph.md · lua-and-ui.md   ← 协议与图规格
│   │   ├── lua-sim.md                 ← ★ 离线 Lua 模拟器：命令、诊断码、保真度表（每条行为的依据）、真机结果回填流程
│   │   ├── verification-ledger.md     ← 各能力的验证状态（真机结果往这里记）
│   │   ├── samples.md                 ← 50 个官方样本索引（脚本生成）
│   │   ├── schema/                    ← gia.proto（改编自社区 MIT）· gil.proto（自有）· THIRD_PARTY_LICENSES.md
│   │   └── data/
│   │       ├── nodes.json             ← 精简节点表（558 节点、94 枚举类型、kernelFix）
│   │       └── client-api.json        ← 官方「客户端控件API文档」的结构化解析（模拟器的 API 表，不手抄）
│   ├── examples/
│   │   └── circle-challenge/          ← ★ 完整示例：main.lua（游戏）· tree.txt（控件树）· scenario.mjs（整局场景测试）
│   ├── samples/                       ← 官方教学存档 50 个（抓取得到，不随技能分发，不入库）
│   ├── community/                     ← 第三方原始资料（抓取得到，不随技能分发，不入库）
│   └── corpus/                        ← 克隆的镜像（不入库）
│       └── Miliastra-knowledge/
├── scripts/
│   ├── check-lua-ui.mjs               ← 客户端 Lua UI 静态检查（Node ≥22，零依赖）
│   ├── sim-lua.mjs                    ← ★ 离线 Lua 模拟器命令行（lint / smoke / run / test / tree / eval）
│   ├── check-lua-sim.mjs              ← ★ 模拟器自检（Lua 语义用例表 · 世界契约 · API 表 · 官方示例校准 · 示例场景）
│   ├── build-client-api.mjs           ← 官方 API 文档 → references/formats/data/client-api.json（--check 校验过期）
│   ├── gi.mjs                         ← ★ .gil/.gia 读写命令行（info/dump/json/build/diff/verify/ui/lua/graph/nodes）
│   ├── check-gia-gil.mjs              ← ★ 存档静态检查器（规则 GG***，--selftest）
│   ├── lib/                           ← wire · proto · codec · container · gifile · gil · ui · graph · nodes · check · diff · dump
│   │   ├── lua/                       ← Lua 5.3 解释器：lexer · parser · resolve · interp · stdlib · lib-string · cfloat · lint · value · cases
│   │   └── sim/                       ← 千星奇域世界：world · control · hosts · tween · easing · enums · level · smoke · scenario · selftest-*
│   ├── fetch-official-doc.mjs         ← 官方站正文抓取
│   ├── fetch-official-samples.mjs     ← 官方教学存档抓取（.gil/.gia，50 个）
│   ├── fetch-community-refs.mjs       ← 第三方逆向资料抓取（钉在具体 commit，记录 sha256）
│   ├── build-node-table.mjs           ← 由第三方节点表 + 官方样本 生成精简节点表
│   └── index-samples.mjs              ← 生成 references/formats/samples.md
└── probes/
    └── settle-doc-conflicts.lua       ← 真机探针：钉死三个「文档 vs 实测」冲突项
```

## 五、静态检查脚本

### A. 客户端 Lua UI：`check-lua-ui.mjs`

```sh
node scripts/check-lua-ui.mjs --selftest        # 先确认检查器本身正常
node scripts/check-lua-ui.mjs <你的脚本.lua>     # 检查一个文件
cat draft.lua | node scripts/check-lua-ui.mjs -  # 从标准输入读（不落盘）
```

支持标准输入是为了化解一条自相矛盾：技能规则二说「没明确要求不要往工作区写文件」，规则三又说「交稿前跑检查」——没有 `-` 时，查一份草稿必须先落一个临时文件。有了 `-`，草稿可以不落盘就过检查。

只做静态检查：不需要 Lua 解释器、不联网、不改动你的文件。退出码 `0` 无 error / `1` 有 error / `2` 用法错误或自检失败。

覆盖 13 条规则（LX001–LX013）：生命周期名与参数个数、被裁掉的标准库、`game` 点号/冒号、枚举值白名单、Tween 可补间字段、只读字段赋值、`SendSignal`、信号参数下标、`showCursor`、事件监听引用、`traceback` 输出。

两个已知特性，别误读：

- 它先把**字符串与注释置空**再扫，所以 `print("io.write")` 这类不会误报。
- 「Tween 结果被外传（`return` 或作为实参）」只给**提示**不给警告——静态跟不进闭包，不硬判。

**官方实现是回归样本。** `references/live/mh47p30a87qo_official-sample-main.lua` 必须零 error、零 warning：

```sh
node scripts/check-lua-ui.mjs references/live/mh47p30a87qo_official-sample-main.lua   # 应「未发现问题」
```

这条已经真的抓到过一个误报：LX013 原本只认 `print(debug.traceback())` 这种直连写法，
而官方是把 traceback 拼进 table、经 `table.concat` 交给 `printerr`——旧逻辑对官方代码报了假警。
现已改成「结果是否落在 `print`/`printerr` 的实参范围内」，并补了对应自检用例（自检从 15 项增至 17 项）。
**改检查器规则后，务必重跑这一条官方样本。**

**它只覆盖客户端 Lua UI 域。** 关卡、实体这些配置类产物没有检查器，只能交逐字核对表；存档文件与节点图见下面。

### A2. 离线 Lua 模拟器：`sim-lua.mjs`（语法 · 作用域 · 整局运行）

`check-lua-ui.mjs` 是正则规则，看不出语法错误，也不会运行脚本。模拟器补的正是这两块：

```sh
node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil       # lint + 整局运行 + 自动点击 + 带证据标签的诊断
node scripts/sim-lua.mjs smoke --gil 关卡.gil                 # 用存档里嵌着的脚本（验证的正是将要导入的东西）
node scripts/sim-lua.mjs test 脚本.lua --gil 关卡.gil --scenario 场景.mjs    # 跑游戏规则的断言
node scripts/sim-lua.mjs lint 脚本.lua                        # 只做静态（LS 语法树规则 + LX 正则规则）
node scripts/sim-lua.mjs eval 'print(7 // 2, 7 / 2)'          # 验证一小段代码在 Lua 5.3 下的语义
node scripts/check-lua-sim.mjs                                # 模拟器自检
```

- **Lua 5.3 语义是认真做的**：整数 / 浮点两个子类型（`"HP:" .. 100 / 2` 得到 `HP:50.0`）、64 位回绕、字节串（`#"圆"` 是 3）、元表、`goto`、`string.format` 对精确平局取偶（`%.1f` 的 0.25 → `0.2`）、照 C 源码移植的模式匹配与 `table.sort`、带变量名与行号的报错；`<const>` 这类 5.4 语法按 5.3 当作语法错误。
- **引擎 API 是建模**：字段 / 方法 / 枚举表由官方文档机械解析（`references/formats/data/client-api.json`），行为按契约文档里的真机回传、官方文档、官方示例建模，文档与真机都没写的地方按常理猜——**每条诊断带证据标签**（真机 / 文档 / 官方示例 / 模型 / 未确认）。
- **完整示例**：`references/examples/circle-challenge/`（游戏脚本 + 控件树 + 75 项断言的场景测试）。
- **边界**：通过 ≠ 真机通过。渲染 / 排版 / 手感 / 真实帧率、服务端节点图、多点触控都不在模型里；唯一对照过的引擎行为是官方 3.21 示例脚本。保真度逐条列在 `references/formats/lua-sim.md` §5，与真机不一致时的回填流程在 §7。

### B. 存档文件：`check-gia-gil.mjs` 与 `gi.mjs`

```sh
node scripts/check-gia-gil.mjs --selftest         # 先确认检查器本身正常（13 项，离线）
node scripts/check-gia-gil.mjs <文件.gil|.gia>     # 检查（规则 GG001–GG304，头部有清单）
cat x.gia | node scripts/check-gia-gil.mjs -       # 从标准输入读二进制（不落盘）
node scripts/check-gia-gil.mjs --samples           # 对 50 个官方样本全量回归（error 必须为 0）
node scripts/gi.mjs --help                         # 读写命令行
```

只做静态检查，不联网、不改文件。退出码 `0` 无 error / `1` 有 error / `2` 用法错误或自检失败。
**官方样本是标准答案**：检查器对它们必须 0 个 error（报了就是规则或数据表有问题）。

已用官方样本核对过的东西（都可以用工具复现）：50/50 容器合法；50/50「解码→JSON→编码」字节一致；
游戏写出的 protobuf 规范（字段升序、不写零值）；样本里 6091 个服务器节点引脚 100% 在节点表里；
139 张服务器节点图中 138 张「反编译→编译→反编译」规格不变、85 张与官方原图字节一致；
Lua 里的 GetChild 链能对着 `.gil` 的控件树核对。**这不等于真机通过**——见 `references/formats/verification-ledger.md`。

## 六、更新语料

**两条路，按需要选：**

```sh
# ① 更新镜像（要全量、要 git 历史时用）
cd references/corpus/Miliastra-knowledge
git pull --depth 1

# ② 直接从官方站抓某一篇（镜像漏了、或想立刻拿到最新版时用）
node scripts/fetch-official-doc.mjs --list           # 先看官方现在有哪些条目
node scripts/fetch-official-doc.mjs <条目id>          # 抓一篇到 references/live/

# ③ 存档相关资料（用于回归 / 重建节点表；日常读写存档不需要）
node scripts/fetch-official-samples.mjs --list       # 官方教学存档清单（.gil/.gia，50 个）
node scripts/fetch-official-samples.mjs              # 下载到 references/samples/（带 manifest.json 与 sha256）
node scripts/fetch-community-refs.mjs                # 第三方逆向资料 → references/community/（钉在具体 commit）
node scripts/build-node-table.mjs                    # 重建 references/formats/data/nodes.json（会用样本校正 kernel 序号）
node scripts/index-samples.mjs                       # 重建 references/formats/samples.md

# ④ 官方 API 文档更新后：重新解析成模拟器用的 API 表，再跑自检
node scripts/build-client-api.mjs                    # 镜像里的 mhtakr07vej4 → references/formats/data/client-api.json
node scripts/build-client-api.mjs --check            # 只校验产物是否过期（镜像在时）
node scripts/check-lua-sim.mjs                       # 文档里多出来的 API 没有实现时，这里会报
```

**② 是更可靠的兜底**：镜像仓库是第三方整理，会漏条目、会滞后。官方站的正文可以直接抓（见第二节的更正）。

更新后请在真机确认一次关键 API 是否仍然成立，并同步更新 `README.md` 第二节与 `references/index.md` 抬头里的抓取时间。

## 七、边界（别误解本技能能做什么）

- **客户端 Lua UI 脚本**：本技能最硬的一块——有 API 逐字速查、实测契约、静默失效清单和静态检查器。
- **其余各域**：本技能给的是**路由 + 查证纪律**，不是逐条抄录的答案。具体参数与操作步骤一律回语料原文（按 `references/index.md` §0 的方法找），并按 `SKILL.md` 规则一标注证据等级。
- **服务端节点图**：agent 不能在编辑器里替你点，但**能生成节点图 `.gia`**（服务器 实体/状态/职业/道具 图）让你走官方资产导入；也能查节点语义/引脚/可用范围、给连线方案与伪代码。信号、复合节点、结构体/字典引脚、客户端图**不能新建**（读得到、原样透传）。
- **存档文件（`.gia`/`.gil`）**：可读可 diff 任意存档、把 Lua 写进关卡、生成/反编译服务器节点图、JSON 无损往返。**不从零新建 `.gil`**，不解析实体/地形/关卡设置等板块，不处理协作模式文件。**生成的文件没有在真机导入验证过**；节点表是第三方的 game 6.2.0 数据，7.x 新增的节点可能缺失。
- **编辑器操作**：agent 伸不进编辑器界面，只能给「叫什么、配成什么、怎么核对」。
- **离线 Lua 模拟器**（`scripts/sim-lua.mjs`）：本技能自带的整局试跑。它是 Lua 5.3 解释器 + 对客户端 API 的建模，**不是引擎**：通过 = 「脚本在这个模型里是这样」，不能拿来证明引擎行为；它报出的诊断自带证据标签，引用时保留。模型只对照过官方 3.21 示例脚本。边界与保真度表见 `references/formats/lua-sim.md`。
- **外置沙箱**（`miliastra-beyond-simulator`）：**可选的本地自测面**（第三方，2D，服务端只模拟变量与信号），它的通过同样不等于真机通过。边界见 `references/api/pitfalls.md`。
- **静态检查 / 离线模拟通过 ≠ 真机通过**。这一条在任何情况下都不许省略。
