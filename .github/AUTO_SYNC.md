# 上游自动同步（Auto Sync Upstream）

本仓库通过 GitHub Actions 定时自动同步上游 `w1249178256/xyzw_web_helper` 的更新，全程无需手动操作。

## 一、触发机制

| 触发方式 | 说明 |
| --- | --- |
| 定时 | 每 6 小时自动运行一次（`23 */6 * * *`，错开整点高峰） |
| 手动 | Actions 页 → Auto Sync Upstream → Run workflow，可勾选「仅检测(dry_run)」 |

> 首次使用请确认仓库 **Actions 标签页已启用** 本工作流（Settings → Actions → General 允许所有 actions）。

## 二、增量同步策略

脚本每次只对比「上次同步之后」的差异（`git rev-list` 计算落后/领先提交数），按四种场景处理：

| 场景 | 判定条件 | 动作 |
| --- | --- | --- |
| 已是最新 | 落后 0 | 无操作，记录日志 |
| 快进同步 | 落后 > 0 且领先 0 | `--ff-only` 快进后直推 `main`（不产生额外提交，历史与上游完全一致） |
| 自动合并 | 落后 > 0 且本地有独立提交、可干净合并 | 产生一个合并提交后推送 |
| 冲突转人工 | 自动合并冲突 | 把上游最新状态推到 `sync/auto-upstream` 分支，自动创建/更新 PR，PR 中列出冲突文件与上游新提交清单，人工解决后合并 |

推送 `main` 成功后，Cloudflare Pages 的自动部署流水线会随 push 触发，**同步即上线**。

## 三、失败重试

- 所有网络类操作（`git fetch` / `git push`）失败自动重试，默认 3 次，退避间隔 5s → 15s → 45s。
- 重试次数可通过配置 `max_retry` 或环境变量 `MAX_RETRY` 调整。

## 四、状态与日志记录

- **Job Summary**：每次运行在 Actions 运行页顶部生成「上游自动同步报告」（状态、上游 HEAD、落后/领先提交数、执行动作、时间、运行链接、增量提交清单、冲突文件清单）。
- **日志 Artifact**：`sync.log` 每次运行上传为 Artifact，保留 90 天。
- **失败 Issue**：工作流失败时自动创建（或追加评论到）带 `auto-sync` 标签的 Issue，附运行日志链接，问题解决前不会重复开新 Issue。
- **冲突 PR**：冲突时会创建/更新固定分支 `sync/auto-upstream` 上的 PR，避免反复开新 PR。

## 五、配置项

配置文件：`.github/sync-upstream.config.json`（环境变量优先级更高，可覆盖同名项）：

```json
{
  "upstream_repo": "w1249178256/xyzw_web_helper",
  "upstream_branch": "main",
  "target_branch": "main",
  "work_branch": "sync/auto-upstream",
  "auto_pr_on_conflict": true,
  "max_retry": 3
}
```

> 注意：`target_branch` 默认与工作流检出的默认分支一致；如需修改，请同步修改工作流中 checkout 的 ref。

## 六、可恢复性

- 快进同步不会产生额外提交，任何一次同步失败都不会破坏仓库状态；下一次运行自动从当前状态继续。
- 冲突场景下 `main` 保持不动，工作分支独立演进，随时可放弃（删除分支与 PR）重跑。
- 并发保护：`concurrency: auto-sync-upstream` 保证同一时间只有一个同步任务在跑，不会互相覆盖。

## 七、本地手动执行

```bash
bash scripts/sync-upstream.sh                 # 同步
DRY_RUN=true bash scripts/sync-upstream.sh    # 仅检测
```
