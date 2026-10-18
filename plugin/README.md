# dsh-archive-purge

[English](README.en.md) | **中文**

补上 DeepSeek Harness 唯一没有的动作：**真正删除一个已归档会话**。

DSH 能把会话归档，却从来不能删除。它自己的文档说了两次：

- `@deepseek-ai/dsh-session-persistence-jsonl` —— *"Nothing deletes session files — logs
  accumulate under `root` until removed externally; the seam has no deletion API."*
- `@deepseek-ai/dsh-client-ui-workspace` —— *"No Session deletion — sessions can be
  archived but never deleted."*

`ctx.workspaceRegistry.delete()` 不是那块缺失的拼图：它移除的是 Workspace 的*注册*，并且刻意
保留每一个会话日志。

## 你会得到什么

在任意**已归档**的会话行上：

- 行内 `...` 菜单多一项 **删除会话 / Delete session**，排在官方 Archive 之后（`order: 500`，
  Archive 是 `400`），以危险色渲染；
- 行的悬停操作条多一个**垃圾桶按钮**，排在 Archive（`100`）与 Pin（`200`）之后；
- 两者都会先弹出确认框，写明会话名并声明删除不可撤销。只有已归档的行才会出现这两个入口 ——
  正在使用的、或仅仅未归档的会话永远不是目标。

第二个菜单项 **完成待删除清理 / Finish pending deletions**（`order: 600`）打开延后清理的入口：
它读取待删除登记、按需执行那一遍清理，并报告每个条目做了什么。

两个按钮都附带简体中文与英文，跟随 app 语言；以组合包形态安装时，插件在 Plugins 页上的卡片会读
`locale/en.json` 与 `locale/zh.json` 作为标题与描述。

## 安装

两种形态都可用。**组合包（bundle）**形态是 DSH 官方文档给出的路线，也是这里推荐的，因为它不需要
第二份拷贝、也不需要带 revision 的行：

```powershell
# ① 直接填 GitHub 地址 —— 插件页的安装框或命令行都行
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge

# ② 固定到某个 commit（来源不随 main 漂移）
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge#<40 位完整 commit>

# ③ Release 的 tarball
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge/releases/download/v1.0.2/dsh-archive-purge-1.0.2.tgz

# ④ 本机已有检出；路径必须是绝对路径
dsh plugin --profile desktop add file:<本仓库的绝对路径>/plugin
```

① ② 之所以可用，是因为**仓库根目录也是一个真正的包**：根 `package.json` 是壳清单，`main` 指向
`plugin/index.js`、`dsh.bundle.patch` 指向 `plugin/cordis.patch.yml` —— 而"填仓库地址"装的正是仓库根。
`tools/verify-package.mjs` 保证壳清单与本包的共享字段、以及双方声明的路径都一致。

> **`github:owner/repo#<sha>&path:/子目录` 这种写法不可用**：pnpm 会把依赖别名解析成
> `dsh-archive-purge#<sha>` 并拒绝（`ERR_PNPM_INVALID_DEPENDENCY_NAME`）。要固定 commit 用上面的 ②。

它会把这个依赖写进 profile 的 `package.json`、把 `dsh-archive-purge` 加进 profile 的
`dsh.profile.bundles`，并把包装进 profile 的 `node_modules`。本包自身已声明为组合包
（见下方 `dsh.bundle.patch`），所以它的行随后会像其他组合包一样由 `cordis.patch.yml` 组合出来，
插件也会出现在侧栏 **Plugins** 页上。

> **卡片的标题与描述要求 `locale/` 出现在 `exports` 里。** app-boot 是按
> `包名/locale/<语言>.json` 经 Node 解析器读取的，也就是走 `package.json#exports`；没有导出时它
> 静默回退到 `package.json` 的 `name`/`description`（英文），卡片就只会显示英文。本包的
> `exports` 显式导出了 `./locale/en.json` 与 `./locale/zh.json`。改动 `package.json` 或新增
> `locale/` 之后要重新物化（删掉 `node_modules/<包名>` 再 `add`）并重挂该 bundle，元数据才会重新读取。

这次物化是**安装那一刻冻结的硬链接农场**，不是指向本目录的活动窗口。实测：pnpm 硬链接过的文件
能看到之后对源的**原地写入**；但源被"替换式改写"过的文件会一直保留旧字节；而安装之后**新增**
的文件（如 `locale/`）根本不会出现。要让改动进入 profile 就重新物化一次 —— 不先删就重装是空操作
（`Already up to date`）：

```powershell
Remove-Item $env:DSH_HOME\profiles\<名字>\node_modules\dsh-archive-purge -Recurse -Force
dsh plugin --profile <名字> add file:<plugin/ 的绝对路径>
```

该行不带 `?rev=` 查询串，所以已经导入过的宿主模块只有在重启 DSH 之后才会重新导入；浏览器半只需
刷新一次页面。

**文件 URL 的 Loader 行**形态就是 `install.mjs` 写的那种，仍然受支持。这些命令要在仓库检出里跑：
`install.mjs` 随仓库提供，不在本包内，所以 npm 安装只有组合包这一种形态。

```powershell
# 默认 profile 取自 $env:DSH_PROFILE，否则为 "desktop"
node install.mjs
node install.mjs --profile web
node install.mjs --dry-run          # 只显示将要发生的改动
node install.mjs --uninstall        # 移除该行与拷贝过去的文件
```

安装器做两件事，且刻意绕开 profile 的包管理器：

1. 把本包拷贝到 `$DSH_HOME/plugins/dsh-archive-purge/`；
2. 往 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 写入一条标记包裹的 Loader 行，写之前先
   给该文件留一份带时间戳的备份。

它相对组合包形态的优势是 **revision**，也正是第一版选择它的原因：一个可能被 `pnpm install` 剪掉的
本地插件，就是一个会悄悄消失的插件。

该行用 `file:` URL 指向宿主半，其 `?rev=` 查询串是所发布字节的哈希，行自身的 id 带同一个 revision。
两者都重要，而且都是实测得出、而非假设的：

- Node 的 ESM 缓存以 URL 为键，所以复用同一个 URL 只会拿回*上一次*的构建；
- DSH 的 Loader 不会为一个它已认识的 entry id 重新求值模块 —— 复用了 id 却换了 URL，结果
  **一次导入都没发生**。

两者都带 revision 之后，重装才会在运行中的进程里生效，而未变的字节会保持同一行、不再搅动 Loader 树。

组合包与 Loader 行 **二选一，不要同时装**。两行都会注册 `/api/archive-purge/deleteSession`，
而路由是组合级契约，所以第二行会激活失败；此时你若再移除第一行，就再也没有行持有该路由了。
把组合包关掉再打开（或重启 DSH）即可干净重挂。

## 验证

测试工具住在与本包相邻的开发检出里，不在已安装的副本里：

```powershell
node tools/test-host.mjs        # 宿主半对临时会话根
node tools/test-client.mjs      # 浏览器 bundle 对假的模块加载器与页面
node tools/verify-paths.mjs     # 路径推导，对照每一个真实会话 header
node tools/test-route.mjs       # 正在运行的宿主，端到端
node tools/purge.mjs <sessionId>  # 从命令行调用删除路由
node tools/remote.mjs <ns>/<method> --args-file args.json --out out.json
node tools/watch-liveness.mjs   # 观察宿主是否会释放已加载的会话
node tools/cycle.mjs --variant x  # 在热 profile 上强制一次全新导入
```

`tools/test-route.mjs` 完全按 `BrowserAuth` 的方式铸造浏览器会话 cookie
（`dsh-auth-<base64url(sha256(authority))>`、`v1.<body>.<hmac>`，用持久化的
`client-connection/browser-session` 密钥签名），并断言整条链路：无 cookie → 401、
外来 `Host` → 403、跨站 → 403，然后才是真正的各条拒绝。它**不删除任何东西** —— 每个请求都指向
宿主必须拒绝的会话。加 `--token <launch token>` 可改用宿主自己签发的 cookie；宿主半需要时可以从
`ctx.connection.authenticatedUrl(...)` 打一个出来。

## 删什么，不删什么

针对一个已归档的会话 id，按此顺序：

1. 拒绝**正在干活**的会话（`ctx.agents.get(id).status === 'running'`）；
2. 拒绝未归档的会话 —— 那个标记就是删除的授权；
3. 定位会话目录：优先用 JSONL 后端自己的 `locate(meta)`，否则按
   `<root>/<projectKey(cwd)>/<encodeSegment(id)>/` 重新推导；两种方式都对照过本机每一个真实会话
   （`node tools/verify-paths.mjs`）；
4. 拒绝这样的目标：末段不是编码后的 id、父目录不是 project-key 目录、或其中没有任何
   `session*.jsonl*` 世代；
5. **短暂等待宿主释放**一个已加载的会话（默认 2 秒，`releaseWaitMs`）；若它仍被加载，则**把清理
   登记到下次启动**，而不是直接拒绝 —— 见下一节；
6. 递归删除该目录 —— 会话的各个日志世代与任何迁移暂存文件，也就是全部；
7. 剪掉持久层里的工作区归属（`Workspace.detachSession`）与归档标记
   （`workspaceRegistry.unarchiveSession`），然后发出白名单内的 `api-session/removed` 事件，
   让每个已连上的 GUI 无需刷新就丢掉那一行。

**先删字节、后改元数据**是刻意的：如果文件已经没了而某次持久写入失败，结果是一个不可见的陈旧 id
（渲染会跳过没有 summary 的成员），而不是一行指向已不存在日志的可见记录。

刻意不碰的东西：附件对象（`$DSH_HOME/attachments`，内容寻址、跨会话共享）、投影缓存行（惰性；
读取需要一个会话已不再拥有的 header）、以及溢出文件（进程级，位于 `$DSH_HOME` 之外）。

## 当宿主仍持有该会话

这正是按钮第一次失败的情形，也是插件存在延后模式的原因。

宿主曾经加载过的会话，会一直被持有到宿主生命周期结束。在运行中的宿主上实测：
`tools/watch-liveness.mjs` 每 15 秒查一次 `session/list`，连续六分钟，已加载集合从未变化。
`ctx.sessions.enter()` 也会拒绝一个已在存储里的 id
（`if (this.store.has(id)) throw new Error('session "…" already exists')`），而客户端的释放
纯粹是浏览器侧的（`manager.drop` 永远不会到达宿主）。

不过它**是可以释放的** —— 这正是本插件第二版所立足的事实。持有每条生命周期边的 `detach` 闭包
住在*条目*上，而不是服务上：`ctx.sessions.store.get(id).detach()` 与
`ctx.agents.store.get(id)`，随后 `ctx.agents.detachEntered(entry)`。两者都调用之后，会话确实
不再被加载（在运行中的桌面宿主上实测 `loaded after both detaches: false`），而且每次 detach 都会
发出配对的 `session/disposed` / `agent/disposed` 边，所以观察这些事件的东西不会被绕过。之所以
去够条目、而不是直接调 `detachEntered`，正是为了这个原因。

所以现在确认删除会**释放一个已归档且空闲的会话并当场删除它**。守卫是在释放那一刻重新读取的，
而不是从调用方推断的：

| 情况 | 结果 |
|---|---|
| Agent 的 `status` 是 `running` | 永不释放 —— 会把该轮自己的历史销毁在飞行途中 |
| 工作区注册未把该会话列为已归档 | 永不释放（例如某条待删除登记对应的会话已被取消归档） |
| 配置里 `releaseLoaded: false` | 永不释放 |
| 会话被释放 | 同一次请求里移除它的日志目录 |
| 两次 detach 之后仍报告已加载 | 走原先的登记路径，行为不变 |

在一个**仍被加载**的会话底下删日志依然不可行：`sessionQuery.listSessions()` 是内存存储与已持久化
header 的并集，所以那一行会在下次刷新时回来 —— 而且因为日志没了，点不开。这就是为什么先尝试释放、
并把登记保留为兜底：

```
POST /api/archive-purge/deleteSession  { sessionId }
→ { ok:false, error:{ code:"archive-purge/session-deferred",
                      message:"… is loaded by the Host; its purge is staged for the next start" } }
```

- 会话历史原样不动；
- 归档标记保留 —— 它既是下次启动重新校验的授权，也是你自己的撤销开关：**取消归档即丢弃该登记**；
- 该 id 被记入 `$DSH_HOME/archive-purge/pending.json`；
- 下次宿主启动、无人持有时，插件自行完成这次清理。

弹窗用中英双语如实说明这一切，所以延后删除永远不会看起来像"默默成功"。把 `stageWhenLoaded`
设为 `false` 可改为直接返回 `archive-purge/session-loaded` 拒绝。

### 按需完成已登记的清理

"等下次启动"是第一版唯一的答案，它让每一个"宿主还持有它"的情形都要付出一次重启的代价。因此路由
多了两个动作，行菜单把它们呈现为 **完成待删除清理 / Finish pending deletions**：

```
POST /api/archive-purge/deleteSession  { action:"listPending" }
→ { ok:true, value:{ pendingFile:"…/pending.json", sessionIds:[…] } }

POST /api/archive-purge/deleteSession  { action:"retryPending" }
→ { ok:true, value:{ attempted:2, deleted:1, dropped:0, stillStaged:1,
                     remaining:[…], stillLoaded:[…], results:[…] } }
```

`action` 默认为 `"delete"`，所以原先的请求体形状照旧可用。重试跑的就是下次启动会跑的那一遍：
每个条目重新进入同一条清理路径，于是归档标记、运行中的 Agent、目标目录与加载状态都会被重新校验；
仍被加载的条目会留在登记里并以 `stillStaged` 报告，而不是被删掉或悄悄丢弃。**原先会被拒绝的，
不会因为重试而变得可删** —— 重试只是去掉了*重启*。

两个调用方共用同一份实现（`drainStagedPurges`）：启动那一遍记录报告，重试则把它返回。

`$DSH_HOME` 刻意**不**从环境变量读取来定位那个文件：桌面宿主不把它导出给自己的进程，`!!js
dshHomePath('storages')` 的 Loader 行保留着**未求值的** `{"__jsExpr":"dshHomePath('storages')"}`
标记，运行时也不存在 `dshHomePath` 全局 —— 三者都在运行中的宿主上验证过。home 改为从持久化层
自己 `locate()` 出来的路径推导（`resolveHarnessHome`）。

## 扩展点，以及一个不可用的扩展点

浏览器半碰不到文件系统，而第三方包也没有生成的 Remote namespace —— Client Remote 表是
`dsh-api-remotes` 里一份固定的构建期装配，Typert 生成器并未随包发布。所以两半通过
`ctx.connection.fetch.register()` 通信，那是共享 `/api` Fetch handler 上的一个**精确**路由：

- 它在 Gateway 的 Remote 拦截器之前匹配，因此不可能与生成的端点撞车；
- 它**免费继承鉴权**，因为 `/api` 前缀路由在桥分发之前会先跑 `connection.admit()`：
  先是 Host/Origin 栅栏（403），再是签名过的浏览器会话 cookie（401）。而裸的
  `ctx.webServer.register()` 路由两者都没有 —— 对一个不可逆的删除来说，那等于把它暴露给本机任何进程。

`ctx.connection.rpc.handle()` —— 相邻的通用 RPC 通道，也是 DSH 自己的文档首先建议的扩展点 ——
**在这个版本里不可用**。它通过 Connection *服务自身*的 Context 去读 `webServer`，而那个 Context 的
`inject` 里没有声明该服务，于是被 Cordis 的严格断言从 `register()` 内部抛出：

```
Error: cannot get property "webServer" without inject
    at HostConnectionService.register (dsh-client-connection/lib/index.js:656)
```

`/api` 路由本身是在插件的 `apply` 里注册的，那里**确实**声明了 inject —— 这正是 `/api` 那个位置
能用、而 `rpc.handle()` 不能的原因。失败表现为整条插件行变成 `FAILED` fiber，除了条目的 phase
之外没有任何诊断信息。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `sessionsRoot` | 由持久化层 locate 出来的路径推导 | 会话存储根，用于 documented-layout 兜底 |
| `releaseWaitMs` | `2000` | 在由我们自己释放之前，等宿主释放一个已加载会话的时长 |
| `releaseLoaded` | `true` | 释放已归档且空闲的会话，让删除当场完成，而不是登记延后 |
| `stageWhenLoaded` | `true` | 把已加载会话的清理登记到下次启动，而不是直接拒绝 |
| `pendingFile` | `$DSH_HOME/archive-purge/pending.json` | 登记的清理等待之处 |

```yaml
- id: archive-purge-<revision>
  name: 'file:///…/dsh-archive-purge/index.js?rev=<revision>'
  config:
    releaseWaitMs: 5000
    releaseLoaded: false
    stageWhenLoaded: false
```

把 `releaseLoaded` 设为 `false` 就完全不动宿主的持有 —— 即第一版的行为：每个已加载会话都被登记
（或在 `stageWhenLoaded: false` 时被拒绝）。

注意补丁行会替换目标行的整个 `config`。

## 限制

- **已归档且空闲的会话会被立即释放并清理。** 没被释放的 —— 正在干活、或释放没生效 —— 会留在登记里
  等下次启动，或从待删除弹窗重试。取消归档会撤销一条登记。
- **有正在进行的工作的会话，任何路径都删不掉**；先停下那件工作。
- **`projectKey` 的设计本身就是有损且会截断的**（它把 `/ \ :` 连写折叠，并把该段截到 251 个字符）。
  兜底推导镜像了它，由 `tools/verify-paths.mjs` 对照真实数据覆盖，且只有在后端不提供 `locate()`
  时才会走到。
- **删除不可逆，且不留回收站。** 这正是被要求的行为；确认弹窗是唯一的守卫，归档标记是授权。
- **没有批量删除、没有撤销、没有保留策略。**
