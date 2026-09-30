# .gia（资产导出包）

官方说明【文档】`mhxbd59urbfu`《资产导入导出》：把选中的已创作内容变成一份存档，供自己或他人导入复用；
多选导出成**组合资产**（单个 `.gia`）；元件导出时挂载的节点图**同步导出**；实体导出时其归属元件与挂载节点图同步导出。
可导出：地形/物件/造物实体、元件、服务器节点图、复合节点、技能、状态、道具等。

## 1. 载荷结构（schema/gia.proto 的 `AssetBundle`）

```
AssetBundle
  assets[]        (1)  玩家勾选导出的资产 —— 一个或多个
  related[]       (2)  被依赖、无法单独导出的关联资产（挂载的节点图、复合节点、信号、结构体……）
  export_info     (3)  导出元数据 "{UID}-{时间戳}-{文件GUID}-\{导出文件名}.gia"
  engine_version  (5)  较新的编辑器才写，如 "6.2.0"
```

【官方示例】`金币与节点图.gia` 顶层字段 1 出现 3 次（1 个元件 + 2 张节点图）→ 所以 `assets` 是 repeated。
`普通攻击.gia`：`assets[0]` 是技能（载荷字段 15），`related[0]` 是它的技能节点图。
`export_info`：【第三方】游戏似乎不校验它，乱填或省略都不影响加载；本工具生成时填 `0-<时间戳>-<GUID>-\<图名>.gia`。

## 2. 一个资产（`ResourceEntry`）

```
identity        (1)  { source_domain(1), service_domain(2), kind(3), asset_guid(4), runtime_id(5) }
reference_list  (2)  显式引用表
internal_name   (3)  资产名（编辑器里看到的名字）
resource_class  (5)  业务类型，见下表
payload         (11 元件/实体数据, 13 节点图, 14 接口(复合节点/信号), 15 配置(技能/状态/道具…), 22 结构体)
```

【官方示例】资产头 `identity` 形如 `{ service_domain: 5, asset_guid: 0x40000001 }`（节点图）或 `{ service_domain: 1, kind: 1, asset_guid: 0x40400001 }`（元件）。
本工具只解析载荷 **13（节点图）**、14、22 的结构；11、15 等在 `_u` 里原样保留。

### resource_class

【第三方】枚举取自社区 `gia.proto`；「样本」列是官方样本里实际见过的（【官方示例】）：

| 值 | 名字 | 含义 | 样本 |
|--:|---|---|:-:|
| 1 | OBJECT | 物件元件、掉落物元件、元件组 | ✓ |
| 2 | CREATION | 造物元件 | |
| 3 | OBJECT_ENTITY | 物件实体 | |
| 4 | CREATION_ENTITY | 造物实体 | |
| 5 | TERRAIN_ENTITY | 地形实体 | |
| 6 | PRESET_POINT | 预设点 | |
| 7 | UNIT_STATUS | 单位状态 | |
| 8 | SKILL | 技能 | ✓ |
| 9 | ENTITY_NODE_GRAPH | 实体节点图 | ✓ |
| 10 | BOOLEAN_FILTER_GRAPH | 布尔过滤器图 | |
| 11 | SKILL_NODE_GRAPH | 技能节点图（客户端） | ✓ |
| 12 | COMPOSITE_NODE_DECL | 复合节点声明（含监听信号、修改/拆分/拼装结构体） | |
| 13 | CAMERA | 镜头 | |
| 14 | SIGNAL_NODE_DECL | 信号节点声明 | |
| 15 | UI_CONTROL | 界面控件 | |
| 16 | SKILL_RESOURCE | 技能资源 | |
| 17 | CLASS | 职业 | |
| 18/19 | PLAYER_TEMPLATE / CHARACTER_TEMPLATE | 玩家/角色模板 | |
| 20/21 | INTERFACE_LAYOUT / UI_CONTROL_GROUP | 界面布局 / 界面控件组 | |
| 22 | STATUS_NODE_GRAPH | 状态节点图 | |
| 23 | CLASS_NODE_GRAPH | 职业节点图 | |
| 24 | GLOBAL_TIMER | 全局计时器 | |
| 25 | PROJECTILE | 投射物 | |
| 26 | ITEM | 道具 | |
| 28/29 | DECORATION / STRUCTURE | 装饰物 / 结构体定义 | |
| 30 | SHOP_TEMPLATE | 商店模板 | |
| 35 | CURRENCY | 货币 | |
| 37/38/39 | LEVEL_STRUCTURE / PATH / SHIELD | 关卡结构体 / 路径 / 护盾 | |
| 43/44/45 | ENTITY_DEPLOYMENT_GROUP / UNIT_TAG / SCAN_TAG | 布设组 / 单位标签 / 扫描标签 | |
| 46/47 | ITEM_NODE_GRAPH / INTEGER_FILTER_GRAPH | 道具节点图 / 整数过滤器图 | |
| 48/49 | LIGHT_SOURCE / ENVIRONMENT_CONFIGURATION | 光源 / 环境配置 | |

## 3. 节点图资产

```
ResourceEntry {
  identity:       { service_domain: SERVER_NODE_GRAPH(5), asset_guid: G }
  internal_name:  图名
  resource_class: ENTITY_NODE_GRAPH(9) …
  graph_data (13) → inner (1) → graph (1) = NodeGraph
}
NodeGraph {
  identity: { source_domain: USER_DEFINED(10000), service_domain: SERVER_BASIC(20000), kind: CUSTOM_GRAPH(21001), runtime_id: G }
  display_name, nodes[], blackboard[], evaluation_interval(101) …
}
```

图种类 → 身份常量【官方示例：entity、item 已被样本印证；status、class 为【第三方】】：

| spec.kind | resource_class | graph.identity.service_domain |
|---|---|---|
| entity | ENTITY_NODE_GRAPH | SERVER_BASIC (20000) |
| status | STATUS_NODE_GRAPH | SERVER_STATUS (20003) |
| class | CLASS_NODE_GRAPH | SERVER_CLASS (20004) |
| item | ITEM_NODE_GRAPH | SERVER_ITEM (20005) |

客户端图（过滤器 20001、技能 20002、整数过滤器 20006）在样本里见过，**只读**。
样本里还有类别 20007/20008/20009（“复杂造物”课：造物状态决策相关），schema 未收录，原样保留。

节点、引脚、连线、值的编码见 `node-graph.md`「生成的编码规则」。

## 4. GUID

- 【文档】`mhxbd59urbfu`：组合资产导出时，资产间通过 GUID 形成的引用关系被记录；导入时通过**替换**保持引用关系。
  所以 `.gia` 里的 GUID **只需要文件内自洽**，游戏导入时会重新分配。
- 【第三方】游戏似乎总是从 `0x40000000` 起分配。本工具生成图时用 `0x40000001` 起递增。
- 【官方示例】不同类别的资产 GUID 高位不同（样本里元件是 `0x4040_0001`，节点图是 `0x4000_0001`、`0x4000_0004`），只当观察，不要依赖。

## 5. 工具

```sh
node scripts/gi.mjs info x.gia
node scripts/gi.mjs graph ls x.gia                     # 列出图
node scripts/gi.mjs graph show x.gia --name 图名        # 反编译成图规格
node scripts/gi.mjs graph build 规格.json -o 新.gia
node scripts/gi.mjs graph extract x.gil --name 图名 -o 图.gia   # 把关卡里的图导出成 .gia
```
