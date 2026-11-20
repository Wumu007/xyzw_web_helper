# 高可用方案（High Availability）

目标：**让线上尽可能一直可运行**。不靠“不出错”，而靠“错了也进不来、进来了也挡得住、挂了立刻知道、退了能马上退回去”。

> **当前状态（2026-11-20）**：L1–L5 已全部就位。产物契约校验已在 Pages 生产构建中实测生效（`[PASSED] 7 项通过、0 项警告`）；GitHub 分支保护已配置（`main` + Require status checks `构建与测试`，**未**启用 Require a pull request）。

---

## 一、五层防线

| 层 | 机制 | 解决的失效模式 | 落地文件 |
|---|---|---|---|
| L1 变更准入 | 每次 push/PR 跑 lint + 单测 + 构建 + **产物契约校验** | 语法错、测试回归、构建失败、关键产物缺失 | `.github/workflows/ci.yml`、`scripts/verify-dist.mjs` |
| L2 同步门禁 | 自动同步前，先在本仓库试合并上游并构建，不通过则**拒绝推送** | 上游提交坏代码被快进直推 main | `.github/workflows/sync-upstream.yml`（`verify` 作业） |
| L3 上线自检 | 每 30 分钟探测线上 5 项指标，失败自动开 Issue，恢复自动关闭 | “部署显示成功但实际打不开”的假存活 | `.github/workflows/healthcheck.yml` |
| L4 运行时降级 | KV 缺失 → 前端降级本机校验；官方配置 404 → 回退权威版本 | 外部依赖异常导致整体不可用 | `worker.js`、`src/utils/dailyTaskState.js`、`AccessGate.vue` |
| L5 快速回滚 | Cloudflare 控制台部署回滚（秒级）；或手动触发 workflow 生成 revert 提交 | 坏版本已上线 | 控制台 + `healthcheck.yml`（`rollback` 作业） |

关键点：**L2 是 main 分支唯一的自动化防线**。因为 `auto-sync-upstream` 是直接 `git push` 到 main（快进/合并），完全不经过 PR；而分支保护的 `Require status checks` 只约束 PR 合并，不拦直推。所以直推路径上真正把关的是 L2。

---

## 二、产物契约校验（`scripts/verify-dist.mjs`）

`pnpm build` 成功 ≠ 线上能用。2026-11-20 的 405 故障就是典型：构建“成功”，但 `dist/_worker.js` 里没有 `/api/verify-key` 路由，接口退化为静态资源 405。

因此把“能不能跑”变成构建期硬检查（**已在 Pages 生产构建中实测生效**：`[PASSED] 7 项通过、0 项警告`）：

| 检查 | 缺失后果 |
|---|---|
| `dist/index.html` 含 `#app` 且引用的 `/assets/*` 均存在 | 白屏 |
| `dist/_worker.js` 存在、含 `export default`、含 `/api/verify-key` 路由 | 卡密接口 405，全部降级本机模式 |
| `dist/access-keys.json` 为非空数组且每条含 64 位 sha256 | 所有卡密失效 |
| `dist/assets/` 存在 | 前端脚本未产出 |
| `_worker.js` 保留 `env.ASSETS` 透传 | 接口通、页面全挂 |

### 已内嵌进构建脚本（关键，2026-11-20 落地）

校验不是“额外一步、可选步骤”，而是 `package.json` 里 `build` 的组成部分：

```json
"build": "vite build && node scripts/verify-dist.mjs",
"build:raw": "vite build",
"verify": "node scripts/verify-dist.mjs"
```

这样 **CI、自动同步门禁、Cloudflare Pages 三处共用同一个事实来源**：

| 触发方 | 执行的命令 | 校验到的是哪份产物 |
|---|---|---|
| GitHub Actions CI | `pnpm build` | CI 自己构建的 `dist` |
| 自动同步 `verify` 作业 | `pnpm build` | 试合并上游后的 `dist` |
| Cloudflare Pages | `npm run build` | **Pages 自己构建、真正要部署的那份 `dist`** |

最后一行是重点：**Pages 的构建命令保持 `npm run build` 不动即可**，无需在控制台额外拼接校验命令。校验失败 → 构建命令以非 0 退出 → Pages 判定构建失败 → **不切换生产别名，线上继续跑上一个版本**。

Pages 构建日志里的关键特征（用于人工确认门禁确实在跑）：

```
[copy-worker] worker.js copied to dist/_worker.js
构建产物校验：/opt/buildhome/repo/dist
  OK    index.html 含 #app 挂载点
  ...
[PASSED] 7 项通过、0 项警告。
Found _worker.js in output directory. Uploading.
```

其中 `Found _worker.js in output directory` 说明高级模式由 `dist/_worker.js` 决定，**与 `wrangler.toml` 无关**（这也是早期 `functions/` 目录始终不生效的原因）。

单独运行（排查时用）：

```bash
npm run verify                            # 校验 ./dist
node scripts/verify-dist.mjs path/to/dist
```

### 为什么不用「CI 直传 Pages」

CI 直传（`wrangler pages deploy dist`）需要 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 两个 secret，并要断开 Pages 的 Git 集成。它相对本方案唯一的增量是“依赖安装环境完全一致”；而本方案让校验直接作用于 Pages 自己的产物，已覆盖「产物残缺」这一类真实故障。投入产出不划算，暂不实施。

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

## 四、控制台配置

### 1. GitHub 分支保护（✅ 已于 2026-11-20 配置）

> ⚠️ 这是 **GitHub 仓库** 的设置（合并前要求 CI 通过），不是 Cloudflare Pages 的「分支控制」（那个管的是哪些分支自动部署）。

路径（两种界面任选）：

- **Branch protection（旧版）**：`Settings → Branches → Add classic branch protection rule`
- **Rulesets（新版）**：`Settings → Rules → Rulesets → New branch ruleset`

实际配置：

| 选项 | 取值 | 说明 |
|---|---|---|
| Branch name pattern | `main` | —— |
| Require status checks to pass | ✅ 勾选，选中 `构建与测试` | 人工 PR 必须过 CI 才能合并 |
| Require a pull request before merging | ❌ **未勾** | 自动同步是 `git push` 直推 main，一旦要求 PR，直推会被拒（GH006），定时同步会彻底失效 |
| 其余（线性历史 / 签名 / 锁分支 / 禁强推 / 禁删除） | 均未勾 | 保留应急弹性 |

如果将来确实需要「Require a pull request」，必须同时把 `github-actions[bot]` 加入 **bypass 列表**（仅 Rulesets 支持 bypass，classic 规则不支持），否则自动同步会断。

### 2. 确认 KV 绑定仍然有效

`Workers 和 Pages → xyzw-web-helper-2dx → 设置 → 绑定`：变量名 `ACCESS_KV`。

若被解绑，`/api/verify-key` 会返回 503，巡检会报 WARN（不是 FAIL，因为前端会自动降级本机模式，站点仍然能用）。

### 3. Cloudflare Pages 「分支控制」怎么设（参考）

`设置 → 构建 → 分支控制`：

- 生产分支 `main` + 启用「自动生产分支部署」 → 每次 push main 自动上线，✅ 保持
- 预览分支：选「所有非生产分支」会为任何分支（包括同步冲突时创建的 `sync-upstream/*`）生成预览部署，消耗构建次数；若不在意预览，可选「无」以省配额
- 构建命令保持 `npm run build`（校验已内嵌，见第二节）

### 4. GitHub Actions 额度

- 仓库为 **public** → Actions 分钟数免费，30 分钟一次的巡检成本可忽略。
- 若转为 **private**：巡检约 24 分钟/月、CI 每次约 3-5 分钟，注意 2000 分钟/月的额度。

---

## 五、各种“挂了”的处置路径

| 现象 | 大概率原因 | 处置 |
|---|---|---|
| Pages 构建**失败**，日志有 `[FAILED] N 项致命问题` | 产物残缺，被契约校验拦下 | 看具体 FAIL 项修复后重推；这属于**拦截成功**，线上跑的是上一版本，无需回滚 |
| 巡检报「卡密接口 405」 | 构建产物缺 `_worker.js` 或其中无该路由 | 看 CI 构建是否失败；用控制台回滚上一个部署 |
| 巡检报「首页 500 / 分片 404」 | Pages 构建失败或部署中断 | 看 Pages 构建日志；回滚上一个正常部署 |
| 巡检报「卡密接口 503」 | KV 绑定丢失 | 重新绑定 `ACCESS_KV`，重试部署 |
| 巡检只有「官方数据源 WARN」 | 官方换版本、资源未发布 | 无需操作，工具已自动回退；等官方补齐 |
| 自动同步连续失败 | 上游构建不过，**或误开了 Require a pull request** | 前者等上游修复；后者关掉该规则或给 bot 加 bypass |

**回滚优先用 Cloudflare 控制台**：`部署 → 选择上一个正常版本 → 回滚`，秒级生效且不产生新提交。
`healthcheck.yml` 的 `rollback_commits` 仅作为没有控制台权限时的应急手段（会生成 revert 提交，遇合并提交可能冲突）。

---

## 六、当前局限（诚实清单）

1. **双份构建（已降级为轻微）**：CI 与 Pages 各构建一次，依赖安装环境可能略有差异。但产物校验已内嵌进 `build` 脚本、**作用于各自构建的产物**，「产物残缺」这类致命问题在两端都会被拦截。剩余差异仅是依赖次要版本浮动可能造成「一边过、一边红」，属可接受范围。
2. **单点托管**：目前只有 Cloudflare Pages 一个入口。Cloudflare 账号/平台级故障无法自愈。备选是把同一 `dist` 同时部署到 EdgeOne 或 Vercel（上游已有 `edge-functions/` 与 EdgeOne 适配基础），并在 README/APP 里提供备用地址。
3. **巡检粒度 30 分钟**：故障最长可能 30 分钟才被发现（GitHub 定时任务不支持更细粒度）。
4. **无跨用户真实链路验证**：巡检只验证“服务在”，不验证“能登录、能跑任务”，后者需要真实账号。
5. **卡密服务仍依赖 KV**：KV 不可用时只能降级本机模式，“一机一密”的强度会下降。
6. **分支保护只覆盖 PR**：直推路径（自动同步、API 推代码）不受 `Require status checks` 约束，靠 L2 门禁与产物校验兼顾；这是为了不让自动同步失效而做的取舍。

---

## 七、后续可做（按性价比排序）

| 优先级 | 事项 | 收益 |
|---|---|---|
| P1 | 每日一次定时 `pnpm test`（当前只在 push 时跑） | 捕捉上游依赖漂移导致的隐性回归 |
| P2 | CI 直传 Pages（去掉双份构建） | 依赖安装环境完全统一；代价是 2 个 secret + 断开 Git 集成，主要风险已被内嵌校验覆盖 |
| P2 | 第二托管（EdgeOne/Vercel）+ APP 内置备用域名切换 | 扛住平台级故障 |
| 暂缓 | 配置快照兜底（IndexedDB 存最近一次成功配置） | 收益概率低，且**静默用过期配置跑批量任务会向游戏服发出错误指令**，风险高于收益；若要做必须是“只读降级 + 页面显式横幅提示” |
