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
 * 访问密钥门禁（软门禁）
 *
 * 规则：
 *  - 密钥清单在 src/config/access-keys.json，仓库只存 SHA-256 哈希与有效期，明文不公开
 *  - 验证通过后记录到 localStorage，每次启动重新校验有效期，过期自动回到验证页
 *  - access-keys.json 为空数组时门禁自动关闭（逃生开关）
 *  - 前端门禁能挡住普通访客；如需对抗懂技术的访问，请叠加 Cloudflare Access
 */
import { onMounted, ref } from "vue";
import { useMessage } from "naive-ui";

import ACCESS_KEYS from "@/config/access-keys.json";

const STORAGE_KEY = "xyzw_access_record";

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

function findEntryByHash(hash) {
  return ACCESS_KEYS.find((k) => k.hash === hash) || null;
}

function isExpired(entry) {
  return (
    !!entry.expiresAt && Date.now() > new Date(entry.expiresAt).getTime()
  );
}

function persist(entry, hash) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      hash,
      type: entry.type,
      expiresAt: entry.expiresAt || null,
    }),
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
    if (!entry) return; // 密钥清单变动（如已删除）则重新要求验证
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

async function verify() {
  const input = keyInput.value.trim();
  if (!input) {
    errorMsg.value = "请输入密钥";
    return;
  }
  verifying.value = true;
  errorMsg.value = "";
  try {
    const hash = await sha256Hex(input);
    const entry = findEntryByHash(hash);
    if (!entry) {
      errorMsg.value = "密钥无效，请检查后重试";
      return;
    }
    if (isExpired(entry)) {
      errorMsg.value =
        "该密钥已过期（有效期至 " +
        new Date(entry.expiresAt).toLocaleString() +
        "）";
      return;
    }
    persist(entry, hash);
    locked.value = false;
    keyInput.value = "";
    message.success("验证成功，欢迎回来！");
  } finally {
    verifying.value = false;
  }
}

onMounted(checkStored);
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
