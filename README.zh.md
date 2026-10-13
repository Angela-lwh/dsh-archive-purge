# dsh-archive-purge —— 给已归档的 DSH 会话加一个删除按钮

English | [中文]

DeepSeek Harness 能把会话归档，却从来不能删除会话。本工作区包含一个可用插件，为它补上这个动作，
外加一套调研与测试工具——它们确定了怎么在一个正在运行的 Harness 上安全地做这件事。

**状态：已在本机安装并验证**（`desktop` profile，GUI 位于 `http://127.0.0.1:19387`）。

| | |
|---|---|
| 宿主行 | 活动 Loader 行 `archive-purge-<revision>` → `fiberPhase: active` |
| 菜单项 | `sidebar.workspaces.session.menu.item` → `archive-purge.delete`，order 500（排在官方 Archive 400 之后）→ `active` |
| 悬停按钮 | `sidebar.workspaces.session.row.action` → `archive-purge.delete`，order 300（排在官方 Archive 100、Pin 200 之后）→ `active` |
| 路由 | `POST /api/archive-purge/deleteSession` → 走鉴权，全部探针通过 |
| 补丁行 | `$DSH_HOME/profiles/desktop/cordis.patch.yml`，标记包裹的块，保留带时间戳的备份 |

**延后删除在生产路径上跑通了**：你确认删除的那个真实归档会话（标题不在此公开），在本次启动时由插件自动从磁盘移除 ——
`$DSH_HOME/archive-purge/pending.json` 已清空，归档集合已清空，该会话目录已不存在。整个过程无需你再次点击。

## 首次真实使用，以及它暴露了什么

第一次点真实归档会话时被拒绝，错误码 `archive-purge/session-live`。诊断这个问题的绕路是值得的：

- 该会话仍被宿主**加载**着（空闲，没有在跑），因为你刚打开过它 —— 而**只要被加载过，宿主就会持有它直到进程结束**。
  实测：`tools/watch-liveness.mjs` 连续轮询 6 分钟，已加载集合一次都没变；
- 插件**无法卸载它**：对已在存储里的 id，`ctx.sessions.enter()` 直接抛错；客户端的释放根本不会到达宿主；
  Agent 的注册被 `agents` 服务内部的 Cordis effect 持有；
- 那就硬删日志也不行：`sessionQuery.listSessions()` 是「内存存储 ∪ 已持久化 header」的并集，
  所以那一行会在下次刷新**回来**，而且因为没有日志而点不开。

于是插件长出了一个**延后模式**：被加载的会话，其删除会被**登记**（历史原样不动；归档标记保留，
它既是授权也是撤销开关），并在下次宿主启动、无人持有时自动完成。弹窗用中英双语明确说明这一点。
本次启动正是这样把它删掉的。

但延后只是半个答案：所谓「下次启动」等于「为了一个你已经确认过的删除去重启 DSH」。继续实测后
发现，**卸载入口其实是插件够得着的**：`ctx.sessions` 的 store 条目与 `ctx.agents` 的注册条目各自
暴露了持有其生命周期边的 `detach` 闭包，两者都调用之后会话确实不再被加载（在运行中的桌面宿主上
实测 `loaded after both detaches: false`）。所以现在确认删除会**直接释放已归档且空闲的会话并当场删除**；
延后路径只留给「正在干活」或插件释放不掉的会话。

同一趟绕路还挖出两个较小的事实，两者都已写进插件：桌面宿主**不会**把 `DSH_HOME` 导出给它自己的进程；
而 `!!js dshHomePath(...)` 的 Loader 行在配置里保留着**未求值的** `{"__jsExpr": …}` 标记 ——
因此 Harness home 改为从持久化层自己 `locate()` 出来的真实路径反推。

## 怎么用

先作为 profile bundle 安装（两种安装形态见 `plugin/README.md`）：

```powershell
dsh plugin --profile desktop add file:D:/Project/dsh-archive-purge/plugin
```

然后，要在某个已归档会话上看到按钮：

1. 把侧栏视图筛选切到 **仅显示已归档**（或 全部对话）；
2. 悬停该行点**垃圾桶图标**，或打开它的 `...` 菜单选 **删除会话**；
3. 在弹窗里确认。**已归档且空闲**的会话会当场删除，即使宿主此刻仍把它持在内存里：插件先释放这份
   持有（宿主推送 `api-session/removed`），随后移除日志目录。正在干活的会话会被拒绝；插件释放不掉的
   才会被**登记**、留到下次启动移除 —— 两种情况弹窗都会如实写明。

如果按钮没出现，刷新一次页面（Ctrl+R）。宿主侧不需要重启：该 profile 是热补丁 profile，行已经是 `active`。

已登记的删除记在 `$DSH_HOME/archive-purge/pending.json`，下次启动的延后执行会把它清空。
在此之前**取消归档即可撤销**一次已登记的删除。想从命令行登记一个会话，用
`node tools/purge.mjs <sessionId>`；想看当前登记了什么，读那个 JSON 文件。

### 不重启也能完成已登记的删除

正常情况下已经不会再产生登记项，但登记项仍可能存在 —— 来自更早的运行，或来自插件释放不掉的会话。
它不必再等下次启动：

1. 打开任意会话行的 `...` 菜单，选 **完成待删除清理**；
2. 弹窗会读取待删除登记，告诉你有多少个会话在等待；
3. 点 **立即清理**。

此时能释放的条目会**当场释放并删除**；仍释放不掉的会继续留在登记里，弹窗会如实说明。这里不会
放宽任何可删范围：每个条目都重新走同一条删除路径，重新校验归档标记、运行中的 Agent、目标目录与
加载状态。同样的这一遍也会在每次宿主启动时自动执行。

### 迭代插件（热部署）

浏览器半包是普通产物、没有构建步骤，而宿主每次变化都会重新快照它，所以改完不用重启 app。
具体跑什么命令取决于插件的安装形态：

**作为 profile bundle（推荐）**：`dsh plugin --profile <名字> add file:<plugin/ 的绝对路径>`
会写入依赖、把 `dsh-archive-purge` 加进 `dsh.profile.bundles`，并由 pnpm 把该包链接回 profile 的
`node_modules` —— 因此在 `plugin/` 下的编辑**立刻可见，无需重新安装**：

| 你改了什么 | 怎么做 | app 会怎样 |
|---|---|---|
| `plugin/lib/client.js` | 直接改，然后刷新一次页面 | 宿主重新快照产物，启动图里该条目的 revision 变化，`/plugins/events` 广播出去，页面随即抓取新的 bundle |
| `plugin/index.js` | 直接改；刷新页面，若已导入的模块必须重新导入则重启 DSH | 宿主下一次导入读到的就是新字节 |
| `plugin/package.json` 的 `dsh.client` | 直接改，然后刷新一次页面 | 条目列表按声明重建 |

bundle 形态还会让插件出现在侧栏的 **Plugins** 页里，可以像其他组合包一样开关。开关会重新组合
profile 并重新挂载该行 —— 这同时也是「某一行激活失败」之后的恢复手段。

**作为文件 URL 的 Loader 行**（`node install.mjs`，即第一版的路线）：行 id 与 URL 带上由
`index.js` 字节推出的 revision，宿主会导入一个真正新的模块代。循环一样，只是多一条命令：

| 你改了什么 | 怎么做 |
|---|---|
| `plugin/lib/client.js` | `node install.mjs`，然后刷新一次页面 |
| `plugin/index.js` | `node install.mjs` |
| `plugin/package.json` 的 `dsh.client` | `node install.mjs` |

三个坑都值得知道（做这次改动时都踩到了）：

- `install.mjs` 会把 `plugin/` **整体拷贝覆盖**到 `$DSH_HOME/plugins/dsh-archive-purge`
  （先 `rm -rf`）。请改 `plugin/` 下的源文件，不要改已装副本 —— 下一次安装会把它覆盖掉。
  这也是更该用 bundle 形态的理由之一：那种形态下根本不存在第二份拷贝。
- `index.js` **内容没变**时 revision 也不会变，所以重跑 `install.mjs` 对宿主半是空操作。
  这是预期行为而非故障：改字节才会改 revision。
- 要先装 bundle、**再**退役文件 URL 行。两行都会注册
  `/api/archive-purge/deleteSession`，而路由是组合级契约：第二行会激活失败，于是你随后退役第一行
  就再也没有行持有该路由。此时把 bundle 关掉再打开（或重启 DSH）即可干净重挂。

## 目录结构

| 路径 | 说明 |
|---|---|
| `plugin/` | 插件本体：`index.js`（宿主半）、`lib/client.js`（手写的浏览器 bundle）、`package.json`、`cordis.patch.yml`、`README.md` |
| `plugin/README.md` | 插件自己的文档 —— 设计、扩展点、删什么不删什么、限制 |
| `install.mjs` | 单 profile 的安装 / 卸载 / dry-run，Loader 行带 revision |
| `tools/test-host.mjs` | 宿主半对临时会话根：所有拒绝分支 + 一次真实的递归删除 |
| `tools/test-client.mjs` | 浏览器 bundle 对假的 `__ModuleLoader__`、模块表、React 与 `fetch` |
| `tools/test-route.mjs` | **正在运行**的宿主端到端：信任栅栏、cookie、路由、JSON 契约 |
| `tools/e2e-delete.mjs` | 用产品自己的 API 建一个一次性会话并归档，然后探测各条保护 |
| `tools/e2e-immediate-delete.mjs` | **确认删除的正常路径**：建一个仍被宿主持有的已归档会话，一次调用删掉，并核验响应、磁盘、归档标记、待删除登记与 `session/list` |
| `tools/e2e-forged-delete.mjs` | **真实破坏性测试**（`--staged` 走延后路径）：制造一个真实存储的会话，交给插件删除，核验磁盘与全部持久状态并清理 |
| `tools/purge.mjs` | 从命令行调用删除路由 |
| `tools/remote.mjs` | 从命令行调用任意 Remote namespace/method（用文件传参，避免 PowerShell 引号把 JSON 弄坏） |
| `tools/watch-liveness.mjs` | 观察宿主是否会自行释放已加载的会话 |
| `tools/verify-paths.mjs` | 会话目录推导，对照每一个真实会话 header |
| `tools/cycle.mjs` | 在热 profile 上强制一次全新的宿主侧导入 |
| `tools/asar.mjs` | 列出 / 读取 / 提取发行版 `app.asar` 内部文件 |
| `vendor/` | 本次工作依赖的 DSH 包的只读提取 |
| `REPORT-host-rpc.md`、`REPORT-delete-archived-session.md` | 两份调研报告：客户端→宿主扩展点，以及会话/Workspace 的持久状态 |

## 调研确认了什么

以下几条都不在 DSH 的公开文档里，而每一条都改变了设计：

**1. DSH 文档自己指向的扩展点 `ctx.connection.rpc.handle()`，在这个版本里是坏的。**
它通过 Connection *服务自身*的 Context 去读 `webServer`，而那个 Context 的 `inject` 里没有声明该服务，
于是被 Cordis 的严格断言在 `register()` 内部直接拒绝：
`cannot get property "webServer" without inject`（`dsh-client-connection/lib/index.js:656`）。
表现是整条插件行变成 `FAILED` fiber，且**任何地方都看不到原因**。可用的是
`ctx.connection.fetch.register()`：挂在共享 `/api` Fetch handler 上的**精确**路由 ——
在 Gateway 的 Remote 拦截器之前匹配，并且**免费继承鉴权**，因为 `/api` 前缀路由在分发前会先跑
`connection.admit()`（Host/Origin 栅栏 → 签名 cookie）。

**2. 删除会话＝删掉那个目录，而且只能是那个目录。** 全库没有任何删除 API：
`sessionPersistence` 的接口只有 `create/open/stat/list/flush`；`workspaceRegistry.delete()`
删的是 Workspace 注册。一个会话恰好拥有
`<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/` —— 里面只有日志世代，Windows 上连锁文件都没有。
真正需要一并修改的持久存储只有 `$DSH_HOME/storages/workspace.json`（`workspace` 域：成员关系、
归档集合、置顶集合），通过 `Workspace.detachSession()` 与 `workspaceRegistry.unarchiveSession()` 触达。
SQLite 搜索索引在本机是 `:memory:` / `openAt: never`，启用时也会自愈；投影缓存行是惰性的；
附件是共享的内容寻址对象，**绝不能**碰。

**3. 被加载的会话无法移除，而它正是第一次真实点击失败的原因。** 宿主会把它曾经加载过的每个会话持有到进程结束
—— 实测：用 `tools/watch-liveness.mjs` 空闲轮询 6 分钟，已加载集合从未变化。没有任何插件可及的 API 能卸载它
（对已在存储里的 id，`ctx.sessions.enter()` 抛错；客户端的释放不会到达宿主），而硬删其日志会产生一行
「下次刷新就回来、且点不开」的坏行，因为 `sessionQuery.listSessions()` 是内存存储与已持久化 header 的并集。
这就是延后模式存在的原因。

**4. 宿主自己的进程里没有 `DSH_HOME`，Loader 行里也没有求值后的 config root。**
`process.env.DSH_HOME` 在宿主内部是 undefined（它只注入工具子进程）；`!!js dshHomePath('sessions')` 行在
`options.config` 里保留着**未求值**的 `{"__jsExpr":"dshHomePath('sessions')"}` 标记；运行时也不存在
`dshHomePath` 全局。因此路径改为从持久化层自己的 `locate()` 结果推导，并且每一层 `dirname` 都写在具名辅助函数里。

另外一条同样实测得到、并写进安装脚本的结论：DSH 的 Loader **不会**为一个它已认识的 entry id 重新求值模块，
而 Node 的 ESM 缓存以 URL 为键 —— 所以要让改动在运行中的进程里生效，**行的 id 与模块 URL 都必须带新 revision**。
调试时值得知道的一个推论：把同一行重写一遍**不会**重新执行 `apply`，`tools/cycle.mjs` 就是为此存在的。

## 复现验证

```powershell
node tools/test-host.mjs      # 宿主半：保护分支、登记、启动清账、真实递归删除
node tools/test-client.mjs    # 浏览器半：插槽、inject 面、组件输出、路由调用、文案
node tools/verify-paths.mjs   # 每个已存储会话都能解析到它自己的目录
node tools/test-route.mjs     # 运行中的宿主：401 / 403 / 403 / 200 + 各拒绝码
node tools/e2e-forged-delete.mjs --template <id>            # 真实破坏性测试
node tools/e2e-forged-delete.mjs --template <id> --staged    # 延后路径
```

### 破坏性测试，以及它的两个陷阱

通过 `session/create` 创建的会话**必然是活的**（`agents.ensureSession` 只返回活的普通 Agent），
而插件会（正确地）拒绝活会话 —— 所以第一次尝试返回 `archive-purge/session-live`，且什么都没删。
若为了「校验日志」去调 `session/rename`，同样会把它变成活的，因为「以写入方式打开一个已存储会话」就是加载它。
因此 `tools/e2e-forged-delete.mjs` 用一份合法日志制造出一个已存储、非活的会话（只改 header 里的 `id`），
用 `session/list` 校验它 —— 这与删除路径所需的 `stat()` 是同一次 header 读取 —— 然后交给插件真删：

```
ok  a stored log now exists under the new identity
ok  DSH lists the manufactured Session            (cwd=<project-dir>)
ok  it is reported as stored, not live
ok  workspace/archiveSession succeeds
ok  the plugin deleted it        ({deleted:true, directory:"…\--<project-slug>--\session-…"})
ok  the log directory is gone
ok  the archive mark was cleared
ok  the Workspace membership was pruned
ok  DSH no longer lists it
ok  the archive set holds exactly what it did before
```

如果 DSH 没有列出被制造的会话，脚本会在任何删除动作之前中止；无论发生什么，它的 `finally` 都会清掉目录并
撤销归档标记。事后核验所有既有会话完好（15/15 目录自洽，5/5 Workspace 注册未变）。

另外两条保护性拒绝也在真实数据上跑过：活会话，以及一个已归档的 subagent 会话
（`archive-purge/subagent`，通过先归档再撤销归档验证 —— 完全可逆）。

## 回滚

```powershell
# bundle 形态：移除组合包与依赖
dsh plugin --profile desktop remove dsh-archive-purge

# 文件 URL 形态：移除 Loader 行与 $DSH_HOME/plugins/dsh-archive-purge
node install.mjs --uninstall
```

每次安装前都会在 `cordis.patch.yml` 旁留一份带时间戳的副本（`cordis.patch.yml.bak-<timestamp>`），
仅凭那份文件就能回滚任何一次安装。
