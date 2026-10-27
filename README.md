# dsh-archive-purge

[English](README.en.md) | **中文**

给 DeepSeek Harness 的已归档会话加一个真正可用的「删除」：连同它启动过的子代理会话，一起从磁盘移除。

## 安装

```powershell
# npm
dsh plugin --profile desktop add @angela_lwh/dsh-archive-purge

# GitHub
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge
```

装完重启 DSH：宿主半在启动时加载，之后已归档会话的行内 `...` 菜单和悬停区会出现「删除会话」。

## 限制

- 只能删除**已归档**的会话，未归档请先归档。
- 会话本身或它启动的子代理有任务在跑时拒绝；宿主仍持有该会话时先登记，下次启动或点「完成待删除清理」时完成。
- 删除不可逆、不进回收站；附件（跨会话共享）不动。删除会话时一并清掉它的 spill 溢出目录和投影缓存记录，历史遗留的孤儿缓存记录也会被顺手清掉（`sweepCache: false` 可关）。
- 子代理会话随父会话一起删除；父会话已不存在的遗留子代理，会在启动或下一次删除时自动清扫。
- 从未发过消息的空白会话（侧边栏本就不显示）**满 24 小时**后才会在启动、新建会话或任意一次删除时自动清理（`blankMinAgeMs` 可调），也不会再出现在 `@` 里；**对话框里还留着未发送草稿的会话永远不会被清理**（浏览器半会把有草稿的会话 id 报给宿主并落盘）。`sweepBlanks` / `filterBlankReferences` 可分别关闭这两项。
- 浏览器端带一个「长时间挂起后自动重连」的兜底：连接没有心跳，笔记本休眠会让 WebSocket 半开，工作区快照停在旧状态（表现为新会话显示「未分组」、选择器里缺工作区）；页面空闲 30 分钟后的第一次操作会重连一次，重新拉取投影。
- 只作用于本机 `$DSH_HOME/sessions`，删之前建议自行备份。
