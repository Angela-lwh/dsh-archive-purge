# dsh-archive-purge

[English](README.en.md) | **中文**

给 DeepSeek Harness 的**已归档会话**加一个「真正删除」按钮。DSH 能把会话归档，却从来没有删除能力。

## 插件如何工作

**界面**：每个**已归档**的会话行上会多出两个入口 —— 行内 `...` 菜单里的 **删除会话**，以及悬停时
出现的**垃圾桶按钮**。两者都先弹出确认框，写明会话名并声明不可撤销。正在使用的、或仅仅未归档的
会话上不会出现它们。

**一次删除按顺序做这些事**：

1. 拒绝**正在干活**的会话（有进行中的对话）；
2. 拒绝未归档的会话 —— 归档标记就是这次删除的授权；
3. 定位该会话的目录（`$DSH_HOME/sessions/<项目键>/<会话 id>/`），并校验里面确实是它的日志，
   确保路径不对就绝不删；
4. 若宿主此刻仍加载着这个会话，先**释放**宿主的持有（只有已归档且空闲的才会释放；正在干活的
   永不释放）；
5. 递归删除该目录 —— 这个会话的全部日志世代；
6. 清掉持久记录：工作区归属与归档标记，然后通知所有已连上的界面立刻移除那一行。

**当场删不掉的情况**：正在干活的会话任何情况都不删；暂时释放不掉的会被**登记**下来
（`$DSH_HOME/archive-purge/pending.json`），在下次 DSH 启动时自动完成，也可以随时手动完成（见下）。
登记期间会话历史原样不动，**取消归档即可撤销**这次登记。

**刻意不碰**：附件（`$DSH_HOME/attachments`，跨会话共享）与投影缓存。删除不可逆，不进回收站。

## 怎么使用

**安装**（把 `desktop` 换成你的 profile 名）：

```powershell
# ① 直接填 GitHub 地址 —— 插件页的安装框或命令行都行
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge

# ② 固定到某个 commit（来源不随 main 漂移，推荐给别人用）
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge#<40 位完整 commit>

# ③ Release 的 tarball（同样不需要 npm 账号）
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge/releases/download/v1.0.1/dsh-archive-purge-1.0.1.tgz

# ④ 本机已有检出 —— 改完代码即时生效，适合自己开发
dsh plugin --profile desktop add file:<本仓库的绝对路径>/plugin
```

四条路线都会写入 profile 依赖、把 `dsh-archive-purge` 加进 `dsh.profile.bundles`，并装进 profile 的
`node_modules`。**①②③④ 全部实测通过**（含插件行正常组合、插件卡片显示 1.0.1）。

仓库根目录是一个**真正的包**：根 `package.json` 是壳清单，`main` 与 `dsh.bundle.patch` 都指向
`plugin/`，所以"填仓库地址"能装。`tools/verify-package.mjs` 会校验壳清单与 `plugin/package.json`
在每个共享字段上一致、且各自声明的路径都存在（它在发布门禁里第一个跑）。

> **仍然不要用 `github:owner/repo#<sha>&path:/子目录` 这种写法**：pnpm 会把依赖别名解析成
> `dsh-archive-purge#<sha>` 这样的非法名字并拒绝（`ERR_PNPM_INVALID_DEPENDENCY_NAME`）。
> 要指定 commit 用 ② 那种 `#<commit>` 即可。

**使用**：

1. 把侧栏视图筛选切到 **仅显示已归档**；
2. 悬停该行点**垃圾桶图标**，或打开它的 `...` 菜单选 **删除会话**；
3. 确认。宿主能释放的会话当场删除、那一行立即消失；被登记的会话会在下次启动完成，弹窗会如实说明。

装好后侧栏 **Plugins** 页会出现「**归档会话清理**」卡片（中英双语标题与描述，跟随 app 语言），可以开关。

**手动完成被登记的删除**：任意会话行的 `...` 菜单 → **完成待删除清理** → **立即清理**。

**卸载**：

```powershell
dsh plugin --profile desktop remove dsh-archive-purge
```

**改动后如何生效**（实测行为）：

- 浏览器半 `plugin/lib/client.js`：刷新页面即可 —— 宿主会重新快照该产物，页面随即抓取新的 bundle；
- 宿主半 `plugin/index.js`：已导入的模块需要重启 DSH，或把该 bundle 关掉再打开以重新挂载。

## 权限与副作用（如实声明）

| 项 | 事实 |
|---|---|
| 文件系统 | 读取并**递归删除** `$DSH_HOME/sessions/<项目键>/<会话 id>/`；写入自有的 `$DSH_HOME/archive-purge/pending.json` |
| DSH 持久状态 | 经 DSH 的 Workspace API 移除该会话的工作区归属与归档标记（`$DSH_HOME/storages/workspace.json`） |
| 本地 HTTP | 在 DSH 已运行的 Web 服务上注册一个精确路由 `POST /api/archive-purge/deleteSession`，继承 DSH 自身的鉴权 |
| 界面 | 向两个侧栏插槽注册菜单项与悬停按钮；删除后经 `api-session/removed` 事件通知界面丢弃该行 |
| 网络 | **无**（`plugin/index.js` 只 import `node:` 内置模块） |
| 子进程 / 安装脚本 | **无**；包内没有任何 install/postinstall 脚本 |
| 外部副作用 | **不可逆地删除会话日志**，不进回收站 |
