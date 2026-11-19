<template>
  <div v-if="visible" class="key-status-bar">
    <span class="ks-badge" :class="'ks-' + recordType">{{ typeLabel }}</span>
    <span class="ks-time">{{ timeText }}</span>
  </div>
</template>

<script setup>
/**
 * 密钥状态条：展示当前卡密类型 + 剩余时间倒计时
 *  - 终身卡显示「终身卡 · 永久有效」
 *  - 剩余时间按 分/时/天 展示，每 30 秒刷新
 *  - 到期后自动清除记录并广播事件，门禁重新弹窗
 */
import { computed, onMounted, onUnmounted, ref } from "vue";

const STORAGE_KEY = "xyzw_access_record";

const TYPE_LABELS = {
  week: "周卡",
  month: "月卡",
  quarter: "季卡",
  year: "年卡",
  lifetime: "终身卡",
};

const recordType = ref("");
const expiresAt = ref(null);
const now = ref(Date.now());
let timer = null;

const visible = computed(() => !!recordType.value);
const typeLabel = computed(() => TYPE_LABELS[recordType.value] || "密钥");

const timeText = computed(() => {
  if (!recordType.value) return "";
  if (recordType.value === "lifetime" || !expiresAt.value) {
    return "永久有效";
  }
  let ms = new Date(expiresAt.value).getTime() - now.value;
  if (ms <= 0) return "已到期";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `剩余 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `剩余 ${hours} 小时 ${minutes} 分`;
  return `剩余 ${minutes} 分钟`;
});

function loadRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      recordType.value = "";
      return;
    }
    const rec = JSON.parse(raw);
    if (!rec.hash || !rec.type) {
      recordType.value = "";
      return;
    }
    if (
      rec.type !== "lifetime" &&
      rec.expiresAt &&
      Date.now() > new Date(rec.expiresAt).getTime()
    ) {
      // 已过期：清除记录并通知门禁重新弹窗
      localStorage.removeItem(STORAGE_KEY);
      recordType.value = "";
      window.dispatchEvent(new Event("xyzw-access-expired"));
      return;
    }
    recordType.value = rec.type;
    expiresAt.value = rec.expiresAt || null;
  } catch {
    recordType.value = "";
  }
}

function tick() {
  now.value = Date.now();
  loadRecord();
}

onMounted(() => {
  loadRecord();
  timer = setInterval(tick, 30000);
  window.addEventListener("xyzw-access-expired", loadRecord);
});

onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("xyzw-access-expired", loadRecord);
});
</script>

<style scoped lang="scss">
.key-status-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px var(--spacing-md, 16px);
  background: var(--bg-primary, #fff);
  border-bottom: 1px solid var(--border-light, #e5e7eb);
}

.ks-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: #667eea;
}

.ks-week {
  background: #f0a020;
}

.ks-month {
  background: #2080f0;
}

.ks-quarter {
  background: #7c3aed;
}

.ks-year {
  background: #18a058;
}

.ks-lifetime {
  background: #d03050;
}

.ks-time {
  font-size: 12px;
  color: var(--text-secondary, #666);
  font-variant-numeric: tabular-nums;
}
</style>
