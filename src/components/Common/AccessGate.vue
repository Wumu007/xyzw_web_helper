<template>
  <div v-if="locked" class="access-gate">
    <div class="gate-card">
      <img src="/icons/xiaoyugan.png" alt="logo" class="gate-logo" />
      <h2 class="gate-title">快乐咸鱼 · 访问验证</h2>
      <p class="gate-tip">请输入访问密钥（支持周 / 月 / 季 / 年 / 终身）</p>

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
 * 访问密钥门禁
 *
 * 规则：
 *  - 首次进入必须先通过密钥验证（全屏置顶弹窗，首个弹窗）
 *  - 密钥有效期内不弹窗；过期后再次进入自动弹窗
 *  - 一密一机：优先调用 /api/verify-key（Cloudflare KV 绑定 deviceId），
 *    已绑定其他设备的密钥会被拒绝；接口不可用时降级为本地验证
 *  - 密钥清单：src/config/access-keys.json（只存哈希），为空时门禁自动关闭
 */
import { onMounted, onUnmounted, ref } from "vue";
import { useMessage } from "naive-ui";

import ACCESS_KEYS from "@/config/access-keys.json";

const STORAGE_KEY = "xyzw_access_record";
const DEVICE_KEY = "xyzw_device_id";
const VERIFY_API = "/api/verify-key";

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

function isExpired(entry) {
  return (
    !!entry.expiresAt && Date.now() > new Date(entry.expiresAt).getTime()
  );
}

function persist(hash, type, expiresAt) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ hash, type, expiresAt: expiresAt || null }),
  );
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
    const entry = findEntryByHash(rec.hash);
    if (!entry) return; // 密钥清单变动（如已作废）则重新要求验证
    if (isExpired(entry)) {
      localStorage.removeItem(STORAGE_KEY);
      message.warning("访问密钥已过期，请重新输入");
      return;
    }
    locked.value = false;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function onError(reason, expiresAt) {
  switch (reason) {
    case "invalid":
      errorMsg.value = "密钥无效，请检查后重试";
      break;
    case "expired":
      errorMsg.value =
        "该密钥已过期（有效期至 " +
        (expiresAt ? new Date(expiresAt).toLocaleString() : "未知") +
        "）";
      break;
    case "bound":
      errorMsg.value = "该密钥已绑定其他设备，无法在此设备使用";
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
    try {
      const res = await fetch(VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input, deviceId: getDeviceId() }),
      });
      if (res.ok) result = await res.json();
    } catch {
      // 接口不可用，走本地降级
    }

    if (result && result.ok) {
      const hash = await sha256Hex(input);
      persist(hash, result.type, result.expiresAt);
      locked.value = false;
      keyInput.value = "";
      message.success(
        result.binding === "enforced"
          ? "验证成功，本设备已绑定该密钥！"
          : "验证成功，欢迎回来！",
      );
      return;
    }

    if (result && !result.ok) {
      onError(result.reason, result.expiresAt);
      return;
    }

    // 降级：本地哈希校验（无设备绑定）
    const hash = await sha256Hex(input);
    const entry = findEntryByHash(hash);
    if (!entry) {
      onError("invalid");
      return;
    }
    if (isExpired(entry)) {
      onError("expired", entry.expiresAt);
      return;
    }
    persist(hash, entry.type, entry.expiresAt);
    locked.value = false;
    keyInput.value = "";
    message.warning("验证成功（服务端绑定暂不可用，按本机模式激活）");
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

.gate-btn {
  margin-top: 12px;
}

.gate-error {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--error-color, #d03050);
}
</style>
