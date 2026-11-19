/**
 * 快乐咸鱼 - Cloudflare Workers 入口（wrangler.toml main 字段指向本文件）
 *
 * 职责：
 *   1. POST /api/verify-key —— 密钥激活：一次性使用 + 有效期从激活时刻起算
 *      KV 记录 used:<sha256(密钥)>，激活后任何终端（含原终端）再输入均拒绝
 *   2. 其余请求透传给静态资产（env.ASSETS，wrangler.toml 已配置 SPA 回退）
 *
 * 绑定要求（一次性，Cloudflare 控制台 → 项目 → 设置 → 绑定）：
 *   KV 命名空间变量：ACCESS_KV
 *   未绑定时接口返回 503，前端自动降级为本机模式（单机限制仍生效）。
 *
 * 密钥清单：public/access-keys.json（随静态资产发布，与 src/config/access-keys.json 同步维护）
 */

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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
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

async function loadKeyList(env, origin) {
  try {
    const res = await env.ASSETS.fetch(origin + "/access-keys.json");
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function handleVerify(request, env) {
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

  const hash = await sha256Hex(key);
  const keys = await loadKeyList(env, new URL(request.url).origin);
  const meta = Array.isArray(keys)
    ? keys.find((k) => k && k.hash === hash)
    : null;
  if (!meta) {
    return json({ ok: false, reason: "invalid" });
  }

  const kv = env?.ACCESS_KV;
  if (!kv || typeof kv.get !== "function") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const usedKey = "used:" + hash;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/verify-key") {
      if (request.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }
      return handleVerify(request, env);
    }
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return fetch(request);
  },
};
