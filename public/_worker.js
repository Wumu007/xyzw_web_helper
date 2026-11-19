/**
 * 快乐咸鱼（xyzw-web-helper）— Cloudflare Pages 高级模式 Worker
 *
 * 高级模式说明：dist/_worker.js 存在时接管所有请求（functions/ 目录被忽略）。
 *  - POST /api/verify-key  卡密验证（一次性消耗 + 激活起算有效期）
 *  - 其余请求              透传给静态资产 env.ASSETS（保持 SPA 回退）
 *
 * KV 绑定（一次性配置，Cloudflare 控制台）：
 *   项目 Settings -> Functions -> KV namespace bindings
 *   变量名 ACCESS_KV，绑定任意 KV 命名空间。
 *   未绑定时本接口返回 503 kv_unavailable，前端自动降级本机模式。
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
  // 通过 ASSETS 绑定读取本站静态资源 /access-keys.json（不会回流自身 Worker）
  try {
    const res = await env.ASSETS.fetch(
      new URL("/access-keys.json", origin).toString(),
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data;
    }
  } catch {
    /* ignore */
  }
  return [];
}

async function handleVerifyKey(request, env) {
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
  const meta = keys.find((k) => k && k.hash === hash);
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
    if (!env || !env.ASSETS) {
      return new Response("ASSETS binding missing", { status: 500 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/verify-key") {
      if (request.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }
      return handleVerifyKey(request, env);
    }
    // 其余请求交给静态资产（保留 SPA not_found_handling 行为）
    return env.ASSETS.fetch(request);
  },
};
