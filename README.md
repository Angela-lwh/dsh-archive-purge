# dsh-archive-purge

[English](README.en.md) | **中文**

给 DeepSeek Harness 的**已归档会话**加一个「真正删除」按钮。DSH 能把会话归档，却从来没有删除能力。

## 来源与形态

| 项 | 值 |
|---|---|
| 公开仓库 | `https://github.com/Angela-lwh/dsh-archive-purge`（PUBLIC） |
| 申报子路径 | `plugin/` |
| 版本 / 许可 | `1.0.0` · MIT（见 `LICENSE`） |
| 作者 | [Angela-lwh](https://github.com/Angela-lwh) |
| 接入形态 | DSH **Profile Bundle**（`dsh.manifestVersion: 1`、`dsh.bundle.patch: ./cordis.patch.yml`），另含 Web 客户端半（`dsh.client.platform: web`） |
| 宿主入口 | `plugin/index.js`（ESM；`export const name = 'archive-purge'`，`inject = ['connection','workspaceRegistry','sessionPersistence']`） |
| 客户端入口 | `plugin/lib/client.js`（手写的 lazy-CJS 浏览器 bundle） |
| 运行环境 | Node `>=22`；本机实测 DSH `0.2.1-rc.2` · desktop profile |
| 依赖 | 无运行时依赖，无 lockfile |

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

**安装**（在仓库根目录执行；路径必须是绝对路径）：

```powershell
dsh plugin --profile desktop add file:<本仓库的绝对路径>/plugin
```

**使用**：

1. 把侧栏视图筛选切到 **仅显示已归档**；
2. 悬停该行点**垃圾桶图标**，或打开它的 `...` 菜单选 **删除会话**；
3. 确认。宿主能释放的会话当场删除、那一行立即消失；被登记的会话会在下次启动完成，弹窗会如实说明。

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

## 状态与边界

- 本仓库**未**经过 DSH Hub Workshop 审核、认证或兼容性验证，Registry 权限为 0。本页任何内容都
  不构成「可安装」「安全」或「官方兼容」的结论。
- **收录申请尚未创建**：`plugin/package.json` 缺少 `dshWorkshop` 声明，intake 会在读取阶段阻断；
  作者补齐并推送新的固定 commit 之后才能提交申请。
- 仓库里的测试与报告由作者自行编写和运行，不是独立的第三方门禁；结论以独立审核与测试为准。
- 申请只使用公开、不可变的来源坐标与结构化清单，不含任何凭据、私有链接、个人绝对路径或本机配置。
- 删除不可逆：请先在**可丢弃**的会话上验证。
