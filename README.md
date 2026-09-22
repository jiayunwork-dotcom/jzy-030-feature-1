# 多人实时协作白板

浏览器里多人同时在一张画布上拖动图形、拉连接线、写便签，画面实时一致。
前端 React + TypeScript，后端 Node.js 20（HTTP + WebSocket），持久化 PostgreSQL 16。

## 一键启动

```bash
docker compose up --build
```

- 页面：http://localhost （开两个浏览器窗口即可看到互相的光标与操作）
- 后端接口：http://localhost:8080/api/health 、 `/api/canvases/main/snapshot`
- WebSocket：`ws://localhost/ws`（经 nginx 代理到后端）

本地开发（无 Docker）：

```bash
cd server && npm install && npm run dev      # 后端 :8080（无 DATABASE_URL 时用内存存储）
cd web && npm install && npm run dev         # 前端 :5173，代理 /ws 与 /api 到 :8080
```

## 运行测试

```bash
cd server && npm install && npm test
```

36 个自动化测试锁住以下行为：

| 行为 | 测试文件 |
| --- | --- |
| 降级为只读时进行中的拖动立即回滚、脏位置不进权威状态、后续写与预览被拒 | `test/roles.test.ts` |
| 只读成员的创建/修改/删除/连线/撤销一律拒绝并给出可读原因 | `test/roles.test.ts` |
| 同图元不同属性并发修改（位置 vs 颜色）两个改动都保留 | `test/concurrency.test.ts` |
| 同属性并发按服务端接收顺序（seq）定序，所有客户端收敛到同一值 | `test/concurrency.test.ts` |
| 断线重连拿到完整快照 + 断线期间增量，重放后与在线者逐位一致 | `test/undo-reconnect.test.ts` |
| 撤销只回退本人那一步涉及的属性，他人对同图元的其它改动保留；重做同理 | `test/undo-reconnect.test.ts` |
| 撤销栈由服务端操作日志维护，重连/重启后续接 | `test/undo-reconnect.test.ts`、`test/persistence.test.ts` |
| 图元移动/缩放后连线端点贴合最近锚点、路径可复现、不穿过图元本体 | `test/connectors.test.ts`、`test/router.test.ts` |
| 删除图元时挂在它上面的连线级联删除，不留悬空端点 | `test/connectors.test.ts` |
| 连线锚到不存在的图元、坐标/尺寸越界、操作不存在的实体均被拒并说明原因 | `test/connectors.test.ts` |
| 重启后画布内容、成员角色、定序、撤销栈从持久层恢复 | `test/persistence.test.ts` |
| 房主打点后存档点出现在所有人列表，带独立稳定标识/名字/创建者/时刻/序列位置；重名互不影响 | `test/history.test.ts` |
| 非房主（可编辑/只读）打点被拒并给出可读原因 | `test/history.test.ts` |
| 恢复把整块画布切回存档点当时的图元/连线/成员角色，广播带自增 seq 与新纪元，所有人立即对齐 | `test/history.test.ts` |
| 恢复时进行中的拖动作废回弹，半截脏位置不落库、不盖在恢复画面上 | `test/history.test.ts` |
| 恢复不存在的 id、非房主恢复一律被拒并说明原因 | `test/history.test.ts` |
| 删除图元级联删连线后恢复，图元与连线一起回来且无悬空端点 | `test/history.test.ts` |
| 倒回旧点后仍可继续编辑、打新点、再倒回任意点，中间历史不被物理删除 | `test/history.test.ts` |
| 恢复与按人撤销语义自洽：恢复后无人能一撤销跨过恢复点，也不丢/串他人改动 | `test/history.test.ts` |
| 恢复与并发写共用同一串行通道，不产生交错脏状态 | `test/history.test.ts` |
| 同一存档点在任意实例多次重建结果逐字节一致 | `test/history.test.ts` |
| 重启后存档点与其历史内容仍在且可恢复，定序续接 | `test/history.test.ts` |

## 架构与模块划分

### 后端 `server/src/`

| 模块 | 职责 |
| --- | --- |
| `connection.ts` | WebSocket 连接与广播：房间管理、presence（光标/选中框）、拖动预览（ephemeral）、角色变更广播、存档点列表广播与整画布恢复广播（恢复前打断所有人进行中的拖动） |
| `engine.ts` | 定序合并引擎：所有写操作串行定序（seq），属性级应用与合并，forward/inverse 效果对，撤销/重做栈（按时间线纪元隔离），操作日志，存档点创建/恢复 |
| `history.ts` | 历史纯函数：权威状态规范化抽取/逐字节序列化（canonical JSON）/指纹、整状态差异 diff、恢复内容防悬空 |
| `router.ts` | 连线路由：最近锚点选择（4×4 组合取距离最小，固定优先级打破平局），正交路径，纯函数可复现 |
| `permissions.ts` | 角色（owner/editor/viewer）与权限判定（编辑/管角色/管历史），统一的可读拒绝原因 |
| `snapshot.ts` | 快照与增量：完整快照（含存档点列表、epoch）+ `deltasSince(lastSeq)` 断线续传 |
| `persistence/store.ts` | 持久化抽象 + 内存实现（测试/本地开发） |
| `persistence/pgStore.ts` | PostgreSQL 16 实现：canvases/members/shapes/connectors/op_log/checkpoints 六张表（新表新列以 `IF NOT EXISTS` 平滑升级旧库），恢复的日志与实体切换在同一事务 |
| `index.ts` | 入口：HTTP（健康检查/快照查询）+ WS 挂载，数据库重试初始化 |

### 前端 `web/src/`

| 模块 | 职责 |
| --- | --- |
| `components/CanvasView.tsx` | SVG 画布：图元/连线/便签渲染，选择、拖动、缩放、框选新建、连线交互 |
| `components/PresenceLayer.tsx` | 协作者光标与名字标签 |
| `components/TimelinePanel.tsx` | 时间线：存档点列表（名字/创建者/时刻/序列位置）、打点、恢复到此（非房主禁用） |
| `components/Toolbar.tsx` / `MembersPanel.tsx` | 工具栏（工具/颜色/撤销重做）、成员列表与角色切换 |
| `state/client.ts` | WebSocket 连接层：自动重连，重连时带 `lastSeq`（restore 同样推进 seq） |
| `state/store.ts` | 协作者状态层：权威状态镜像、乐观应用与拒绝回滚、拖拽生命周期（降级/恢复立即回滚）、预览与 presence、存档点列表、restore 整体对齐 |

## 关键设计

**定序与合并。** 所有写操作进入服务端串行队列，接收顺序即全局 `seq`。操作是
*属性级绝对值*语义（`shape.set {x, y}` 而非整体替换）：两人同时改同一图元的不同属性时
天然合并、互不覆盖；同时改同一属性时按 `seq` 后到者覆盖先到者，且所有客户端按同一
`seq` 顺序应用广播，晚到者基于新基线重放，最终逐位一致。

**降级立即生效。** 拖动过程只发 ephemeral 预览（不落库、不进日志）。房主把某人降级为
只读时：服务端立即广播 `role.changed` + 携带权威状态的 `preview.clear`，被降级客户端
马上回滚进行中的拖动；其后的提交与预览一律被拒（回包带权威状态与可读原因），
半截脏位置永远不会进入权威状态与操作日志。

**按人隔离的撤销。** 每次提交在操作日志里存 forward/inverse 效果对，inverse 只记录
该步触及属性的旧值。撤销 = 应用本人最近一条 normal 日志的 inverse：别人后来改的
其它属性不受影响。撤销栈完全由服务端日志推导，重连/重启后自然续接。

**连线路由。** 锚点取两边边界中点中"离对端最近"的一对（距离相同按固定优先级打破平局），
路径先沿锚点外法线走出图元再正交汇合，不穿过两个被连接图元的内部；纯函数实现，
重叠/同心时结果依然确定、可复现。图元几何变化后受影响连线随同一操作重算并广播；
删除图元时挂在上面的连线级联删除（撤销删除会连同连线一起恢复）。

**快照与增量。** 重连时客户端带 `lastSeq`，服务端回完整快照（权威当前态）+
`seq > lastSeq` 的增量列表；客户端以快照为准对齐，不靠本地缓存拼凑。

**持久化。** 图元、连线、成员角色、操作日志、存档点全部落 PostgreSQL；重启后从表中重建
画布状态、全局 `seq`、当前纪元与每人撤销/重做栈。`checkpoints` 表与 op_log 新列用
`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 补建，老画布缺字段时按默认值
（纪元 0、空存档点）平滑带起，不会读崩。恢复条目在 PgStore 单事务内同时写日志与切换
实体，崩溃不会出现"日志记了恢复、实体还是旧态"的错位。

**历史时间线（存档点与整画布恢复）。**

- *存档点不可变。* 房主可随时打点，存档点固化打点那一刻的完整权威状态（全部图元、
  连线、成员角色），内容按 id/userId 排序后以固定键序做 canonical JSON——同一存档点
  在任何实例、任何时刻重建都逐字节一致。存档点只增不改不删：之后画布怎么改都不影响
  已落定的内容；名字允许重复，每个点有独立稳定的 UUID 标识。打点本身不占 `seq`，
  记录它对应序列里的位置（当时的 seq 与纪元）。
- *恢复走同一条串行通道。* 房主恢复时，引擎在同一条写队列里计算"当前态 → 存档点态"
  的整体差异（图元/连线/成员，均以整条权威值 upsert/delete 表达），生成一条
  `kind='restore'` 的日志并占用新的全局 `seq`；服务端随后先打断房间内所有人进行中
  未提交的拖动（清预览 + 权威回弹），再一次性广播携带完整快照、新 seq 与新纪元的
  `restore` 消息，所有客户端不靠本地拼差异，直接整体对齐。恢复进行期间不会有别的写
  插入；存档内容自带的连线端点在当时都存在，恢复后不留悬空连线（另有一层防御性过滤）。
- *恢复是在历史后面接上新一段，而不是抹掉历史。* 每次恢复使时间线"纪元（epoch）"+1：
  旧操作日志与旧存档点一条不删，倒回旧点后仍可继续编辑、打新点、再倒回更早或更晚的
  任意点。按人撤销/重做只在*当前纪元*内查找本人的 normal 操作——恢复是跨所有人的整块
  状态跳变，不属于任何人的撤销栈，因此不会出现"某人一撤销把画面拽回恢复前"，恢复前
  他人尚未撤销的改动也不会在恢复后被某一步撤销凭空串改。
- *权限。* 打点与恢复都是房主专属能力，editor/viewer 发起时在服务端被明确拒绝并回
  可读原因；前端这两个动作对非房主禁用。恢复按"写"对待，与所有写共用权限与定序通道。
