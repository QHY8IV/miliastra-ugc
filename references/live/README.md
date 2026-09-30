# references/live/ —— 官方正文直取区

> **这里放语料镜像里没有、但直接从官方教程站抓到的东西。**
> 与 `references/corpus/`（第三方 git 镜像）**物理隔离**——那边 `git pull` 不会碰到这里，
> 这边也永远不写回镜像目录。

---

## 一、为什么需要这一层

原本 `README.md` 里写着：

> 官方教程站正文由前端渲染，直接抓取只能拿到空壳

**这句现在被推翻了。** 页面确实渲染不出内容，但**正文本身以静态文件挂在 CDN 上**，只是路径不在页面里。逆出来的规律见下节。

镜像仓库 `1475505/Miliastra-knowledge` 会漏条目——例如 `mh47p30a87qo`（3.21 客户端脚本），本技能包最相关的一篇，镜像停在 `c1e4a2c`（2026-09-26）时**根本没有它**。

---

## 二、抓取规律（已逆出，可直接用）

页面走的是 `act-webstatic.mihoyo.com` 上的静态资源，语言段 `zh-cn`（另有 `en-us` 等）：

| 用途 | URL |
|---|---|
| 教程总目录 | `https://act-webstatic.mihoyo.com/ugc-tutorial/course/cn/zh-cn/catalog.json` |
| 教程标题锚点 | `.../course/cn/zh-cn/headingsMap.json` |
| **某一篇正文** | `.../course/cn/zh-cn/<条目id>/content.html?v=1016` |
| 综合指南正文 | 同上，把 `course/cn` 换成 `knowledge/cn` |
| FAQ 正文 | 同上，把 `course/cn` 换成 `faq/cn` |

- `catalog.json` 是嵌套树，每个节点有 `path_id` / `real_id` / `title` / `updated_at`。**`real_id` 就是拼正文路径要的那个 id。**
- 正文是 HTML 片段（不是整页），标签结构简单：`h1`–`h4` / `p` / `table` / `pre` / `img`。
- 教程里提到的辅助课件（`.gil` 等）挂在 `.../<条目id>/<uuid>.gil`，从正文 HTML 里就能取到链接。
- **`.gil` 不是压缩包**，Lua 源码以明文嵌在里面。**用工具取，别再手搜标记**：`node scripts/gi.mjs lua get <.gil> -o main.lua`
  按 protobuf 结构取出脚本（`client_scripts.scripts[i].source`），连空行都不丢。
  （早先手搜 `main.lua` 标记再截取的做法丢过 33 个空行——代码无差别，但行号对不上官方脚本，已用 `gi.mjs` 重新提取修正。）
  取样本：`node scripts/fetch-official-samples.mjs --only mh47p30a87qo`。

### 用脚本抓

```sh
node scripts/fetch-official-doc.mjs --list                      # 列全部条目（教程/指南/FAQ）
node scripts/fetch-official-doc.mjs <条目id>                     # 抓一篇 → 本目录 .md + .html
node scripts/fetch-official-doc.mjs <条目id> --section guide     # 抓综合指南里的条目
node scripts/fetch-official-doc.mjs <条目id> --raw               # 只要原始 HTML 快照
node scripts/fetch-official-doc.mjs <条目id> --out <目录>         # 换个输出目录
```

抓取会同时落两份：`.md`（自动转换，便于阅读与检索）和 `.html`（原始快照，便于核对转换是否失真）。
**自动转换的 Markdown 有排版瑕疵**（源站正文里本身就混着字面量 `**` 等），重要条目建议人工过一遍。

> ⚠️ 脚本默认输出到本目录，**同 id 会直接覆盖**。要重抓一篇已人工整理过的条目，先 `--out` 到别处比对。

---

## 三、本目录现有内容

| 文件 | 是什么 |
|---|---|
| `mh47p30a87qo_3.21客户端脚本——制作点击收集玩法.md` | 官方教程正文（自动转换） |
| `mh47p30a87qo_….html` | 同一篇的原始 HTML 快照 |
| `mh47p30a87qo_official-sample-main.lua` | **从该课辅助课件 `.gil` 里提取的官方完整实现**（正文 225 行含空行，带全中文注释，逐字未改；文件头另有 15 行来源说明） |

### 为什么 `official-sample-main.lua` 值得单独留

它是本技能包里**唯一一份「官方亲手写的、可直接抄的」客户端 Lua 完整实现**。相比教程正文里贴的片段，这个文件多出的才是真正值钱的东西：

- **生命周期范式**：`OnStart` 只做 `EnableUpdate(true)`，真正的初始化放在 `OnUpdate` 里逐帧重试——因为 `game.GetUICanvasSize()` 在 `OnStart` 时**可能还没就绪**，官方给了 60 次重试预算。
- **控件树范式**：点击判定控件（光标检测区域）与显示控件（图片）放进**同一个容器**，移动容器 = 两者同步移动；用 `raycastTarget` 开关来做「同一次点击只处理一次」。
- **一批此前没进速查表的 API**：`SetImage` / `SetSizeDelta` / `SetPivot` / `SetAsFirstSibling` / `SetAsLastSibling` / `imageType` / `imageColor` / `control.alive` / `debug.traceback` 的用法。

该文件同时被 `scripts/check-lua-ui.mjs` 当作**回归样本**：官方代码必须零 error、零 warning。
（这条真的抓到过一个误报——见 `scripts/check-lua-ui.mjs` 的 LX013 与对应自检用例。）

---

## 四、边界

- 抓取是**只读**的：不登录、不带凭据、不改动官方任何东西，只 GET 公开静态资源。
- 抓下来的正文**版权归米哈游（miHoYo / HoYoverse）**，此处仅作个人学习与创作辅助；对外分发时请注意这一点。
- 这里的 `.md` 是**自动转换产物**，可能被重新抓取覆盖。要写人工整理的内容，请另起文件名（或写到 `references/` 的其他位置），别直接编辑自动产物。
