// Cloudflare Pages Function（自包含版，不依赖打包期 JSON 导入）：POST /api/verify-key
// 语义 v2：
//   1. 密钥一次性使用：首次验证成功即消耗（KV 记录 used:<sha256(密钥)>），
//      之后任何终端（含原终端）再次输入均被拒绝；
//   2. 有效期从输入（激活）时刻起算；终身卡永久。
//
// 部署要求（一次性，在 Cloudflare 控制台）：
//   Workers & Pages → 项目 → Settings → Functions → KV namespace bindings
//   新增：变量名 ACCESS_KV，绑定任意 KV 命名空间。
//   未绑定时返回 503，前端自动降级本机模式（单机限制仍生效）。
//
// 密钥清单来自站点自身的 /access-keys.json（与 src/config/access-keys.json 同步维护）。

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

  const hash = await sha256Hex(key);

  // 运行时从本站静态资源拉取密钥哈希清单（避免打包期路径问题）
  let keys = [];
  try {
    const listUrl = new URL("/access-keys.json", new URL(request.url).origin);
    const listRes = await fetch(listUrl.toString());
    if (listRes.ok) keys = await listRes.json();
  } catch {
    keys = [];
  }
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
