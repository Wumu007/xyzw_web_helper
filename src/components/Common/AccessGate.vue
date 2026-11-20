<template>
  <div v-if="locked" class="access-gate">
    <div class="gate-card">
      <img src="/icons/xiaoyugan.png" alt="logo" class="gate-logo" />
      <h2 class="gate-title">快乐咸鱼 · 访问验证</h2>
      <p class="gate-tip">请输入访问密钥（支持周 / 月 / 季 / 年 / 终身）</p>
      <p class="gate-hint">清理过浏览器数据？在同一台设备上重新输入原密钥即可恢复，不会重新计时。</p>

      <n-input
        v-model:value="keyInput"
        size="large"
        :disabled="verifying"
        placeholder="例如：KL-xxxxxx-xxxxxx-xxxxxx"
        @keyup.enter="verify"
      />

      <n-button
        type="primary"
        size="large"
        block
        :loading="verifying"
        class="gate-btn"
        @click="verify"
      >
        验证并进入
      </n-button>

      <p v-if="errorMsg" class="gate-error">{{ errorMsg }}</p>
    </div>
  </div>
</template>

<script setup>
/**
 * 访问密钥门禁（v4：一密一次性 + 激活起算 + 同设备幂等恢复 + 服务端复核）
 *
 * 规则：
 *  - 首次进入必须先通过密钥验证（全屏置顶弹窗，首个弹窗）
 *  - 密钥一次性使用：验证成功即被消耗；**同一设备**（同一 deviceId）再次输入
 *    属于恢复，服务端返回原有效期，不重新计时；换到另一台设备则返回 used
 *    （需要卖家通过 /api/admin/rebind 换绑）
 *  - 有效期从输入（激活）时刻起算；到期后自动回到验证页
 *  - 服务端：/api/verify-key（Cloudflare KV，强限制，跨终端生效）；
 *    服务端不可用时降级本机模式（本机一次性 + 本机激活起算仍然生效）
 *  - 已激活设备的复核：启动时最多每 6 小时调一次 /api/check，
 *    让卖家的「延期 / 停用 / 换绑」能传达到已激活设备；失败一律不锁人（fail-open）
 *  - 密钥清单：src/config/access-keys.json（只存哈希），为空时门禁关闭
 */
import { onMounted, onUnmounted, ref } from "vue";
import { useMessage } from "naive-ui";

import ACCESS_KEYS from "@/config/access-keys.json";

const STORAGE_KEY = "xyzw_access_record";
const USED_KEY = "xyzw_used_keys";
const DEVICE_KEY = "xyzw_device_id";
const VERIFY_API = "/api/verify-key";
const CHECK_API = "/api/check";
const HEARTBEAT_KEY = "xyzw_heartbeat_at";
// 最多每 6 小时向服务端复核一次：太频繁没必要，太久则「停用」生效太慢。
// 想彻底关掉心跳（出问题时的逃生阀）把它改成 false 即可。
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_ENABLED = true;

const DURATIONS_DAYS = {
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
  lifetime: null,
};

const locked = ref(true);
const keyInput = ref("");
const verifying = ref(false);
const errorMsg = ref("");
const message = useMessage();

const gateEnabled = ACCESS_KEYS.length > 0;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "d" +
          Math.random().toString(36).slice(2) +
          Date.now().toString(36);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function findEntryByHash(hash) {
  return ACCESS_KEYS.find((k) => k.hash === hash) || null;
}

function persist(hash, type, expiresAt) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ hash, type, expiresAt: expiresAt || null }),
  );
}

function getUsedList() {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) || "[]");
  } catch {
    return [];
  }
}

function markUsed(hash) {
  const list = getUsedList();
  list.push(hash);
  localStorage.setItem(USED_KEY, JSON.stringify(list.slice(-500)));
}

/**
 * 服务端复核（心跳）：把「延期 / 停用 / 换绑」同步到已经激活的设备。
 *
 * 本项目的访问控制是「激活时校验一次，之后凭本地记录用到到期」，所以服务端改了状态，
 * 已激活的设备本来感知不到。这里做一次轻量复核（只传 hash + deviceId，不传明文）。
 *
 * 判定原则是「宁可放过，不可误杀」：
 *   只对 revoked / expired / rebound 三个明确状态锁回门禁；
 *   网络失败、超时、503、unbound、unknown 一律保持本地记录，
 *   否则一次 KV 抖动或用户断网就会把付过费的人挡在门外。
 */
async function revalidate(rec) {
  if (!rec?.hash) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(CHECK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: rec.hash, deviceId: getDeviceId() }),
      signal: controller.signal,
    });
    if (!res.ok) return; // 503 等 → 保持本地
    const data = await res.json();
    if (!data || !data.ok) return; // invalid 等 → 保持本地，不误锁

    if (data.status === "active") {
      // 顺带同步最新有效期：服务端「延期」后，用户下次打开就生效
      if (data.expiresAt !== rec.expiresAt || data.type !== rec.type) {
        persist(rec.hash, data.type || rec.type, data.expiresAt ?? null);
      }
      return;
    }
    if (data.status === "revoked") {
      localStorage.removeItem(STORAGE_KEY);
      locked.value = true;
      errorMsg.value = "该密钥已被停用，如有疑问请联系卖家";
      return;
    }
    if (data.status === "expired") {
      localStorage.removeItem(STORAGE_KEY);
      locked.value = true;
      message.warning("访问密钥已过期，请输入新密钥");
      return;
    }
    if (data.status === "rebound") {
      localStorage.removeItem(STORAGE_KEY);
      locked.value = true;
      errorMsg.value = "该密钥已在其他设备激活，如需换回请联系卖家";
      return;
    }
    // unbound / unknown：服务端记录缺失，保持本地可用
  } catch {
    // 断网 / 超时 → 保持本地，不锁
  } finally {
    clearTimeout(timer);
  }
}

function maybeHeartbeat(rec) {
  if (!HEARTBEAT_ENABLED || !rec?.hash) return;
  try {
    const last = Number(localStorage.getItem(HEARTBEAT_KEY) || 0);
    if (Date.now() - last < HEARTBEAT_INTERVAL_MS) return;
    localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
  } catch {
    return;
  }
  // 不阻塞首屏：先放行，复核结果异步生效（停用/换绑会在几秒内把界面锁回去）
  revalidate(rec);
}

async function checkStored() {
  if (!gateEnabled) {
    locked.value = false;
    return;
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const rec = JSON.parse(raw);
    if (!rec.hash) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (
      rec.type !== "lifetime" &&
      rec.expiresAt &&
      Date.now() > new Date(rec.expiresAt).getTime()
    ) {
      localStorage.removeItem(STORAGE_KEY);
      message.warning("访问密钥已过期，请输入新密钥");
      return;
    }
    locked.value = false;
    maybeHeartbeat(rec);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function onError(reason, extra) {
  switch (reason) {
    case "invalid":
      errorMsg.value = "密钥无效，请检查后重试";
      break;
    case "used":
      errorMsg.value =
        "该密钥已被其他设备使用；换设备或清过缓存请联系卖家换绑";
      break;
    case "revoked":
      errorMsg.value = "该密钥已被停用，如有疑问请联系卖家";
      break;
    case "expired":
      errorMsg.value =
        "该密钥已过期（有效期至 " +
        (extra ? new Date(extra).toLocaleString() : "未知") +
        "）";
      break;
    case "kv_unavailable":
      errorMsg.value = ""; // 走本地降级，不显示错误
      break;
    default:
      errorMsg.value = "验证失败，请稍后重试";
  }
}

async function verify() {
  const input = keyInput.value.trim();
  if (!input) {
    errorMsg.value = "请输入密钥";
    return;
  }
  verifying.value = true;
  errorMsg.value = "";
  try {
    let result = null;
    let serverDown = false;
    try {
      const res = await fetch(VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input, deviceId: getDeviceId() }),
      });
      if (res.ok) {
        result = await res.json();
      } else {
        serverDown = true;
      }
    } catch {
      serverDown = true;
    }

    if (result && result.ok) {
      const hash = await sha256Hex(input);
      markUsed(hash); // 本机也记录已消耗，防止同机二次输入
      persist(hash, result.type, result.expiresAt);
      locked.value = false;
      keyInput.value = "";
      if (result.resumed) {
        // 同设备幂等恢复：不重新计时，沿用服务端记录的有效期
        message.success(
          result.expiresAt
            ? `已恢复访问，有效期至 ${new Date(result.expiresAt).toLocaleString()}`
            : "已恢复访问（长期有效）",
        );
      } else {
        message.success("激活成功，欢迎使用快乐咸鱼！");
      }
      return;
    }

    if (result && !result.ok && result.reason !== "kv_unavailable") {
      onError(result.reason, result.expiresAt);
      return;
    }

    // ---- 降级：本机模式（服务端不可用）----
    // 本机一次性 + 激活起算有效期仍然生效；跨终端限制需服务端
    const hash = await sha256Hex(input);
    if (getUsedList().includes(hash)) {
      onError("used");
      return;
    }
    const entry = findEntryByHash(hash);
    if (!entry) {
      onError("invalid");
      return;
    }
    // 不能用 ?? 兜底：DURATIONS_DAYS.lifetime 的值就是 null，`null ?? 30` 会把终身卡算成 30 天
    const days = Object.hasOwn(DURATIONS_DAYS, entry.type)
      ? DURATIONS_DAYS[entry.type]
      : 30;
    const expiresAt =
      days === null
        ? null
        : new Date(Date.now() + days * 86400000).toISOString();
    markUsed(hash);
    persist(hash, entry.type, expiresAt);
    locked.value = false;
    keyInput.value = "";
    message.warning("激活成功（服务端暂不可用，按本机模式生效）");
  } finally {
    verifying.value = false;
  }
}

function onAccessExpired() {
  localStorage.removeItem(STORAGE_KEY);
  locked.value = true;
}

onMounted(() => {
  checkStored();
  window.addEventListener("xyzw-access-expired", onAccessExpired);
});

onUnmounted(() => {
  window.removeEventListener("xyzw-access-expired", onAccessExpired);
});
</script>

<style scoped lang="scss">
.access-gate {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(8px);
}

.gate-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-primary, #fff);
  border-radius: 16px;
  padding: 28px 24px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  text-align: center;
}

.gate-logo {
  width: 56px;
  height: 56px;
  border-radius: 12px;
}

.gate-title {
  margin: 12px 0 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.gate-tip {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--text-secondary, #666);
}

.gate-hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary, #999);
}

.gate-btn {
  margin-top: 12px;
}

.gate-error {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--error-color, #d03050);
}
</style>
