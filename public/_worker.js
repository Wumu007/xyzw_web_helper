/**
 * 快乐咸鱼 - Cloudflare Pages 高级模式 Worker（经 public/ 复制为 dist/_worker.js）
 *
 * 职责：
 *   1. POST /api/verify-key —— 一次性密钥激活 + 激活起算有效期（KV: ACCESS_KV）
 *      - 首次验证成功即消耗密钥（KV 记录 used:<sha256(密钥)>），此后任何终端
 *        （含原终端）再次输入均被拒绝
 *      - 有效期从激活时刻起算；终身卡永久
 *   2. 其余全部请求透传给静态资源（env.ASSETS）
 *
 * 部署要求（一次性）：
 *   Cloudflare 控制台 → Workers & Pages → 项目 → Settings → Functions →
 *   KV namespace bindings：变量名 ACCESS_KV，绑定任意 KV 命名空间。
 *   未绑定时接口返回 503，前端自动降级为本机模式（单机限制仍生效）。
 *
 * 注意：public/access-keys.json 为服务端读取的密钥哈希清单，
 * 新增/作废密钥时需与 src/config/access-keys.json 保持同步。
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
  const meta = keys.find((k) => k.hash === hash);
  if (!meta) {
    return json({ ok: false, reason: "invalid" });
  }

  const kv = env.ACCESS_KV;
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
