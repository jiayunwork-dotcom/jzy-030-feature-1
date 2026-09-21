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

25 个自动化测试锁住以下行为：

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

## 架构与模块划分

### 后端 `server/src/`

| 模块 | 职责 |
| --- | --- |
| `connection.ts` | WebSocket 连接与广播：房间管理、presence（光标/选中框）、拖动预览（ephemeral）、角色变更广播 |
| `engine.ts` | 定序合并引擎：所有写操作串行定序（seq），属性级应用与合并，forward/inverse 效果对，撤销/重做栈，操作日志 |
| `router.ts` | 连线路由：最近锚点选择（4×4 组合取距离最小，固定优先级打破平局），正交路径，纯函数可复现 |
| `permissions.ts` | 角色（owner/editor/viewer）与权限判定，统一的可读拒绝原因 |
| `snapshot.ts` | 快照与增量：完整快照 + `deltasSince(lastSeq)` 断线续传 |
| `persistence/store.ts` | 持久化抽象 + 内存实现（测试/本地开发） |
| `persistence/pgStore.ts` | PostgreSQL 16 实现：canvases/members/shapes/connectors/op_log 五张表 |
| `index.ts` | 入口：HTTP（健康检查/快照查询）+ WS 挂载，数据库重试初始化 |

### 前端 `web/src/`

| 模块 | 职责 |
| --- | --- |
| `components/CanvasView.tsx` | SVG 画布：图元/连线/便签渲染，选择、拖动、缩放、框选新建、连线交互 |
| `components/PresenceLayer.tsx` | 协作者光标与名字标签 |
| `components/Toolbar.tsx` / `MembersPanel.tsx` | 工具栏（工具/颜色/撤销重做）、成员列表与角色切换 |
| `state/client.ts` | WebSocket 连接层：自动重连，重连时带 `lastSeq` |
| `state/store.ts` | 协作者状态层：权威状态镜像、乐观应用与拒绝回滚、拖拽生命周期（降级立即回滚）、预览与 presence |

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

**持久化。** 图元、连线、成员角色、操作日志全部落 PostgreSQL；重启后从表中重建
画布状态、全局 `seq` 与每人撤销/重做栈。
