// Cloudflare Pages Function：POST /api/verify-key
// 功能：密钥有效性校验 + 一密一机绑定（Cloudflare KV）
//
// 部署要求（一次性，在 Cloudflare 控制台操作）：
//   1. Workers & Pages → 项目 xyzw-web-helper-2dx → Settings → Functions
//   2. KV namespace bindings 新增：变量名 ACCESS_KV，绑定任意一个 KV 命名空间
//   3. 未配置 KV 时本接口自动降级为"不绑定设备"模式，前端仍可正常验证
//
// KV 存储结构：bind:<sha256(密钥)> = deviceId
//   - 有效期密钥的绑定记录会在到期后 1 天自动过期清理
//   - 终身卡永久保存

import ACCESS_KEYS from "../../src/config/access-keys.json";

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

  const hash = await sha256Hex(key);
  const meta = ACCESS_KEYS.find((k) => k.hash === hash);
  if (!meta) {
    return json({ ok: false, reason: "invalid" });
  }
  if (meta.expiresAt && Date.now() > new Date(meta.expiresAt).getTime()) {
    return json({ ok: false, reason: "expired", expiresAt: meta.expiresAt });
  }

  const kv = env?.ACCESS_KV;
  if (!kv || typeof kv.get !== "function") {
    // KV 未绑定：降级为不绑定设备，验证照常通过
    return json({
      ok: true,
      type: meta.type,
      expiresAt: meta.expiresAt,
      binding: "disabled",
    });
  }

  const bindKey = `bind:${hash}`;
  const bound = await kv.get(bindKey);
  if (bound && bound !== deviceId) {
    return json({ ok: false, reason: "bound" });
  }
  if (!bound) {
    let opts;
    if (meta.expiresAt) {
      const ttl = Math.ceil(
        (new Date(meta.expiresAt).getTime() - Date.now()) / 1000,
      );
      // 到期后绑定记录再多保留 1 天，便于提示"已过期"；KV 最小 TTL 60s
      opts = { expirationTtl: Math.max(60, ttl + 86400) };
    }
    await kv.put(bindKey, deviceId, opts);
  }

  return json({
    ok: true,
    type: meta.type,
    expiresAt: meta.expiresAt,
    binding: "enforced",
  });
}
