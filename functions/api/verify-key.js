// Cloudflare Pages Function：POST /api/verify-key
// 语义（v2）：
//   1. 密钥一次性使用：首次验证成功后即被消耗（KV 记录 used:<hash>），
//      之后任何终端（包括原终端）再次输入该密钥都会被拒绝；
//   2. 有效期从输入（激活）时刻起算：expiresAt = 激活时间 + 卡型时长；
//   3. 终身卡无到期时间。
//
// 部署要求（一次性，在 Cloudflare 控制台操作）：
//   Workers & Pages → 项目 xyzw-web-helper-2dx → Settings → Functions →
//   KV namespace bindings 新增：变量名 ACCESS_KV，绑定任意 KV 命名空间。
//   未配置 KV 时本接口返回 503，前端自动降级为本机模式（单机限制生效）。
//
// KV 存储结构：used:<sha256(密钥)> = JSON{deviceId, activatedAt, expiresAt}
//   - 有效期卡的消耗记录在到期后 1 天自动清理；终身卡永久保存
//   - 注意：KV 为最终一致，毫秒级并发激活存在极小概率双开，可忽略

import ACCESS_KEYS from "../../src/config/access-keys.json";

const DURATIONS_DAYS = {
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
  lifetime: null,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const key = String(body?.key || "").trim();
  const deviceId = String(body?.deviceId || "").slice(0, 64);
  if (!key || !deviceId) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  if (!kv || typeof kv.get !== "function") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const hash = await sha256Hex(key);
  const meta = ACCESS_KEYS.find((k) => k.hash === hash);
  if (!meta) {
    return json({ ok: false, reason: "invalid" });
  }

  const usedKey = `used:${hash}`;
  const used = await kv.get(usedKey);
  if (used) {
    return json({ ok: false, reason: "used" });
  }

  const activatedAt = new Date();
  const days = DURATIONS_DAYS[meta.type] ?? 30;
  const expiresAt =
    days === null
      ? null
      : new Date(activatedAt.getTime() + days * 86400000).toISOString();

  const record = JSON.stringify({
    deviceId,
    type: meta.type,
    activatedAt: activatedAt.toISOString(),
    expiresAt,
  });
  if (expiresAt) {
    const ttl = Math.ceil(
      (new Date(expiresAt).getTime() - activatedAt.getTime()) / 1000,
    );
    // 消耗记录保留到到期后 1 天；KV 最小 TTL 60s
    await kv.put(usedKey, record, {
      expirationTtl: Math.max(60, ttl + 86400),
    });
  } else {
    await kv.put(usedKey, record);
  }

  return json({
    ok: true,
    type: meta.type,
    expiresAt,
    activatedAt: activatedAt.toISOString(),
  });
}
