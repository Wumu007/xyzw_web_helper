# 高可用方案（High Availability）

目标：**让线上尽可能一直可运行**。不靠“不出错”，而靠“错了也进不来、进来了也挡得住、挂了立刻知道、退了能马上退回去”。

---

## 一、五层防线

| 层 | 机制 | 解决的失效模式 | 落地文件 |
|---|---|---|---|
| L1 变更准入 | 每次 push/PR 跑 lint + 单测 + 构建 + **产物契约校验** | 语法错、测试回归、构建失败、关键产物缺失 | `.github/workflows/ci.yml`、`scripts/verify-dist.mjs` |
| L2 同步门禁 | 自动同步前，先在本仓库试合并上游并构建，不通过则**拒绕推送** | 上游提交坏代码被快进直推 main | `.github/workflows/sync-upstream.yml`（`verify` 作业） |
| L3 上线自检 | 每 30 分钟探测线上 5 类指标，失败自动开 Issue，恢复自动关闭 | “部署显示成功但实际打不开”的假存活 | `.github/workflows/healthcheck.yml` |
| L4 运行时降级 | KV 缺失 → 前端降级本机校验；官方配置 404 → 回退权威版本 | 外部依赖异常导致整体不可用 | `worker.js`、`src/utils/dailyTaskState.js`、`AccessGate.vue` |
| L5 快速回滚 | Cloudflare 控制台部署回滚（秒级）；或手动触发 workflow 生成 revert 提交 | 坏版本已上线 | 控制台 + `healthcheck.yml`（`rollback` 作业） |

关键点：**L2 是 main 分支唯一的自动化防线**。因为 `auto-sync-upstream` 是直接 `git push` 到 main（快进/合并），完全不经过 PR 与分支保护，L1 对它是失效的。

---

## 二、产物契约校验（`scripts/verify-dist.mjs`）

`pnpm build` 成功 ≠ 线上能用。2026-11-20 的 405 故障就是典型：构建“成功”，但 `dist/_worker.js` 里没有 `/api/verify-key` 路由，接口退化为静态资源 405。

因此把“能不能跑”变成构建期硬检查：

| 检查 | 缺失后果 |
|---|---|
| `dist/index.html` 含 `#app` 且引用的 `/assets/*` 均存在 | 白屏 |
| `dist/_worker.js` 存在、含 `export default`、含 `/api/verify-key` 路由 | 卡密接口 405，全部降级本机模式 |
| `dist/access-keys.json` 为非空数组且每条含 64 位 sha256 | 所有卡密失效 |
| `dist/assets/` 存在 | 前端脚本未产出 |

本地或 CI 均可运行：

```bash
node scripts/verify-dist.mjs          # 校验 ./dist
node scripts/verify-dist.mjs path/to/dist
```

---

## 三、巡检覆盖项与判定

| 检查 | PASS | FAIL / WARN |
|---|---|---|
| 首页 HTML | 200 且含 `#app` | 非 200 或缺挂载点 → FAIL |
| 前端 JS 分片 | 抽样 3 个均 200 | 任一不可访问 → FAIL |
| 卡密清单 | 200 且非空数组 | 非法 → FAIL |
| 卡密接口 | POST 无效密钥返回 200 + `invalid` | 405 → FAIL（Worker 未接管）；503 → WARN（KV 未绑定） |
| 官方数据源 | `version.json` 可读且对应 `config.json` 200 | 不可用 → WARN（工具自动回退，不影响站点存活） |

- **FAIL**：我方站点真的坏了 → 开 Issue（label `healthcheck`），重复失败只在同一 Issue 追加评论，不刷屏。
- **WARN**：外部依赖异常 → 记录但不告警，避免被官方波动淹没。
- 全部 PASS 且有未关闭的 `healthcheck` Issue → 自动评论并关闭。

探测用的无效密钥 `__healthcheck_probe_invalid__` 不在卡密清单中，**不会消耗任何真实卡密**。

---

## 四、需要在控制台完成的配置（一次性）

### 1. 给 main 加分支保护（强烈建议）

`Settings → Branches → Add branch protection rule`

- Branch name pattern：`main`
- 勾选 **Require status checks to pass before merging**
- 在状态检查里选 **`构建与测试`**（来自 CI 工作流）
- 建议同时勾选 **Require a pull request before merging**（对人工提交生效；自动同步是直推，不受此限制，靠 L2 兜底）

作用：人工改代码必须过 CI 才能合并。`lint` 特意设为非阻塞（`continue-on-error`），因为风格问题不影响运行；观察一周稳定后可改为阻塞。

### 2. 确认 KV 绑定仍然有效

`Workers 和 Pages → xyzw-web-helper-2dx → 设置 → 绑定`：变量名 `ACCESS_KV`。

若被解绑，`/api/verify-key` 会返回 503，巡检会报 WARN（不是 FAIL，因为前端会自动降级本机模式，站点仍然能用）。

### 3. GitHub Actions 额度

- 仓库为 **public** → Actions 分钟数免费，30 分钟一次的巡检成本可忽略。
- 若转为 **private**：巡检约 24 分钟/月、CI 每次约 3-5 分钟，注意 2000 分钟/月的额度。

---

## 五、各种“挂了”的处置路径

| 现象 | 大概率原因 | 处置 |
|---|---|---|
| 巡检报「卡密接口 405」 | 构建产物缺 `_worker.js` 或其中无该路由 | 看 CI 的「校验构建产物契约」是否失败；用控制台回滚上一个部署 |
| 巡检报「首页 500 / 分片 404」 | Pages 构建失败或部署中断 | 看 Pages 构建日志；回滚上一个正常部署 |
| 巡检报「卡密接口 503」 | KV 绑定丢失 | 重新绑定 `ACCESS_KV`，重试部署 |
| 巡检只有「官方数据源 WARN」 | 官方换版本、资源未发布 | 无需操作，工具已自动回退；等官方补齐 |
| 自动同步连续失败 | 上游代码构建不过 | 正常现象，线上停在旧版本；等上游修复，或手工挑选合并 |

**回滚优先用 Cloudflare 控制台**：`部署 → 选择上一个正常版本 → 回滚`，秒级生效且不产生新提交。
`healthcheck.yml` 的 `rollback_commits` 仅作为没有控制台权限时的应急手段（会生成 revert 提交，遇合并提交可能冲突）。

---

## 六、当前局限（诚实清单）

1. **双份构建**：CI 构建一次、Cloudflare Pages 再构建一次，环境不完全等价（Node/pnpm 版本可能不同）。彻底解法是 CI 构建后直传 Pages（需 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 两个 secret，用 `wrangler pages deploy dist`），可消除差异并把构建产物校验的有效性提升为 100%。
2. **单点托管**：目前只有 Cloudflare Pages 一个入口。Cloudflare 账号/平台级故障无法自愈。备选是把同一 `dist` 同时部署到 EdgeOne 或 Vercel（上游已有 `edge-functions/` 与 EdgeOne 适配基础），并在 README/APP 里提供备用地址。
3. **巡检粒度 30 分钟**：故障最长可能 30 分钟才被发现（GitHub 定时任务不支持更细粒度）。
4. **无跨用户真实链路验证**：巡检只验证“服务在”，不验证“能登录、能跑任务”，后者需要真实账号。
5. **卡密服务仍依赖 KV**：KV 不可用时只能降级本机模式，“一机一密”的强度会下降。

---

## 七、后续可做（按性价比排序）

| 优先级 | 事项 | 收益 |
|---|---|---|
| P0 | 配 branch protection（第四节第 1 条） | 人工提交的坏代码进不了 main |
| P1 | CI 直传 Pages（去掉双构建） | 构建产物校验的有效性 100%，不再有环境差异 |
| P1 | 配置快照兜底（IndexedDB 存最近一次成功的官方配置） | 官方数据源全挂时，批量日常仍能用旧快照运行 |
| P2 | 第二托管（EdgeOne/Vercel）+ APP 内置备用域名切换 | 扛住平台级故障 |
| P2 | 每日一次定时 `pnpm test`（当前只在 push 时跑） | 捕捉上游依赖漂移导致的隐性回归 |
