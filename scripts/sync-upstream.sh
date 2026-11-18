#!/usr/bin/env bash
#
# scripts/sync-upstream.sh —— 上游自动同步脚本（供 GitHub Actions 调用，也可本地手动执行）
#
# 职责：
#   1. 增量检测：只对比上次同步之后的差异（落后/领先/分叉三种状态）
#   2. 同步策略：无分叉 → 快进合并直推目标分支；有分叉但可干净合并 → 自动合并；
#      存在冲突 → 推送工作分支并自动创建/更新 PR，转人工处理
#   3. 失败重试：网络类操作（fetch/push）失败自动重试（指数退避，默认 3 次）
#   4. 状态与日志：输出结构化日志 + Job Summary，日志文件由工作流上传为 Artifact
#
# 用法：
#   bash scripts/sync-upstream.sh                 # 正常同步
#   DRY_RUN=true bash scripts/sync-upstream.sh    # 仅检测，不写入
#
# 配置优先级：环境变量 > .github/sync-upstream.config.json > 内置默认值
#
set -euo pipefail

# ---------- 配置 ----------
CONFIG_FILE=".github/sync-upstream.config.json"

_cfg() {
  if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$1" '.[$k] // empty' "$CONFIG_FILE" 2>/dev/null || true
  fi
}

UPSTREAM_REPO="${UPSTREAM_REPO:-$(_cfg upstream_repo)}"
UPSTREAM_REPO="${UPSTREAM_REPO:-w1249178256/xyzw_web_helper}"

UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-$(_cfg upstream_branch)}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

TARGET_BRANCH="${TARGET_BRANCH:-$(_cfg target_branch)}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"

WORK_BRANCH="${WORK_BRANCH:-$(_cfg work_branch)}"
WORK_BRANCH="${WORK_BRANCH:-sync/auto-upstream}"

AUTO_PR_ON_CONFLICT="${AUTO_PR_ON_CONFLICT:-$(_cfg auto_pr_on_conflict)}"
AUTO_PR_ON_CONFLICT="${AUTO_PR_ON_CONFLICT:-true}"

MAX_RETRY="${MAX_RETRY:-$(_cfg max_retry)}"
MAX_RETRY="${MAX_RETRY:-3}"

DRY_RUN="${DRY_RUN:-false}"

SYNC_LOG="sync.log"
UPSTREAM_REF="upstream/$UPSTREAM_BRANCH"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:+/$GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-manual}"

# ---------- 工具函数 ----------
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$SYNC_LOG"; }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$*"
  fi
}

# retry <命令...>：失败自动重试，5s/15s/45s 指数退避
retry() {
  local attempt=1 delay=5
  until "$@"; do
    if [ "$attempt" -ge "$MAX_RETRY" ]; then
      log "RETRY_FAIL: 命令重试 ${MAX_RETRY} 次后仍失败: $*"
      return 1
    fi
    log "RETRY: 第 ${attempt} 次失败，${delay}s 后重试: $*"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 3))
  done
}

render_summary() { # render_summary <状态> <执行动作>
  local status="$1" action="$2"
  summary ""
  summary "## 🔄 上游自动同步报告"
  summary ""
  summary "| 项目 | 值 |"
  summary "| --- | --- |"
  summary "| 结果状态 | **${status}** |"
  summary "| 上游仓库 | ${UPSTREAM_REPO}@${UPSTREAM_BRANCH} |"
  summary "| 上游 HEAD | ${UPSTREAM_SHA:-未知} |"
  summary "| 本地落后提交数 | ${BEHIND:-0} |"
  summary "| 本地领先提交数 | ${AHEAD:-0} |"
  summary "| 执行动作 | ${action} |"
  summary "| 触发时间 | $(date -u '+%Y-%m-%d %H:%M:%S UTC') |"
  summary "| 运行日志 | ${RUN_URL} |"
  if [ -n "${NEW_COMMITS:-}" ]; then
    summary ""
    summary "本次增量提交（最近 10 条）："
    summary ""
    summary '```'
    summary "$NEW_COMMITS"
    summary '```'
  fi
  if [ -n "${CONFLICT_FILES:-}" ]; then
    summary ""
    summary "冲突文件："
    summary ""
    summary '```'
    summary "$CONFLICT_FILES"
    summary '```'
  fi
}

# ---------- 主流程 ----------
log "SYNC_START: ${UPSTREAM_REPO}@${UPSTREAM_BRANCH} -> ${TARGET_BRANCH}（DRY_RUN=${DRY_RUN}）"

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "https://github.com/${UPSTREAM_REPO}.git"
else
  git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
fi

log "FETCH: 拉取上游最新代码..."
retry git fetch --no-tags upstream "$UPSTREAM_BRANCH"

UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REF")"
BEHIND="$(git rev-list --count "HEAD..${UPSTREAM_REF}")"
AHEAD="$(git rev-list --count "${UPSTREAM_REF}..HEAD")"
NEW_COMMITS="$(git log --oneline --no-decorate "HEAD..${UPSTREAM_REF}" | head -n 10 || true)"
log "DIFF: 落后=${BEHIND} 领先=${AHEAD} 上游HEAD=${UPSTREAM_SHA}"

# 场景 1：已是最新，直接结束（增量检测，零成本）
if [ "$BEHIND" -eq 0 ]; then
  log "UP_TO_DATE: 已是最新，无需同步。"
  render_summary "✅ 已是最新" "无（落后 0 个提交）"
  exit 0
fi

# 场景 2：DRY-RUN 仅检测
if [ "$DRY_RUN" = "true" ]; then
  log "DRY_RUN: 仅检测模式，不做任何写入。"
  render_summary "🔍 DRY-RUN 检测完成" "无（仅检测）"
  exit 0
fi

# 场景 3：无本地分叉 → 快进同步（不产生额外提交，历史与上游保持一致）
if [ "$AHEAD" -eq 0 ]; then
  log "FAST_FORWARD: 快进合并 ${BEHIND} 个提交..."
  git merge --ff-only "$UPSTREAM_REF"
  retry git push origin "HEAD:refs/heads/${TARGET_BRANCH}"
  log "PUSH_OK: ${TARGET_BRANCH} 已更新至 ${UPSTREAM_SHA}（推送将自动触发 Pages 部署流水线）"
  render_summary "✅ 同步成功（快进）" "快进合并 ${BEHIND} 个提交并推送 ${TARGET_BRANCH}"
  exit 0
fi

# 场景 4：本地有独立提交 → 尝试自动合并
log "DIVERGED: 本地有 ${AHEAD} 个独立提交，尝试自动合并..."
if git merge --no-edit "$UPSTREAM_REF" >/dev/null 2>&1; then
  retry git push origin "HEAD:refs/heads/${TARGET_BRANCH}"
  log "PUSH_OK: 自动合并成功并推送 ${TARGET_BRANCH}"
  render_summary "✅ 同步成功（自动合并）" "合并上游 ${BEHIND} 个提交并推送 ${TARGET_BRANCH}"
  exit 0
fi

# 场景 5：合并冲突 → 转人工（PR）
CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
git merge --abort 2>/dev/null || true
log "CONFLICT: 自动合并存在冲突，涉及文件：${CONFLICT_FILES//$'\n'/、}"

if [ "$AUTO_PR_ON_CONFLICT" != "true" ]; then
  render_summary "❌ 同步失败（冲突，未开启自动 PR）" "无（请人工处理）"
  exit 1
fi
if [ -z "${GH_TOKEN:-}" ]; then
  log "NO_TOKEN: 缺少 GH_TOKEN，无法创建 PR。"
  render_summary "❌ 同步失败（冲突，缺少 GH_TOKEN）" "无（请人工处理）"
  exit 1
fi

log "PR: 推送工作分支 ${WORK_BRANCH}（= 上游最新状态），并创建/更新 PR 交人工处理..."
retry git push origin "+${UPSTREAM_REF}:refs/heads/${WORK_BRANCH}"

export GH_TOKEN
PR_TITLE="🤖 上游同步存在冲突，需要人工处理"
PR_BODY=$(cat <<EOF
## 上游自动同步冲突报告

- **上游**：${UPSTREAM_REPO}@${UPSTREAM_BRANCH}（${UPSTREAM_SHA}）
- **落后** ${BEHIND} 个提交 / **本地领先** ${AHEAD} 个提交
- **状态**：自动合并失败，需人工解决冲突后合并本 PR
- **处理方式**：本 PR 的 head 分支即上游最新状态。可在 GitHub 网页编辑器或本地检出 ${WORK_BRANCH} 分支解决冲突，再合并回 ${TARGET_BRANCH}；合并完成后，下次自动同步将恢复正常快进。

**冲突文件：**

${CONFLICT_FILES}

**上游新提交（前 10 条）：**

${NEW_COMMITS}

---

> 由 auto-sync-upstream 工作流自动创建/更新。运行日志：${RUN_URL}
EOF
)

EXISTING_PR="$(gh pr list --head "$WORK_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
if [ -n "$EXISTING_PR" ]; then
  gh pr edit "$EXISTING_PR" --title "$PR_TITLE" --body "$PR_BODY" || true
  log "PR_UPDATED: 已更新既有 PR #${EXISTING_PR}"
  PR_REF="PR #${EXISTING_PR}"
else
  PR_URL="$(gh pr create --base "$TARGET_BRANCH" --head "$WORK_BRANCH" --title "$PR_TITLE" --body "$PR_BODY")"
  log "PR_CREATED: ${PR_URL}"
  PR_REF="${PR_URL}"
fi

render_summary "⚠️ 检测到冲突，已转人工（PR）" "推送 ${WORK_BRANCH} 并创建/更新 PR：${PR_REF}"
exit 0
