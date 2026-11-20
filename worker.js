/**
 * Cloudflare Pages 高级模式入口（构建时由 vite 插件 copy-worker 复制到 dist/_worker.js）
 *
 * 职责：
 *  1. POST /api/verify-key   卡密验证（一次性消耗 + 激活起算 + 同设备幂等恢复）
 *  2. /api/admin/*           运营接口（激活列表 / 换绑），需 ADMIN_TOKEN，未配置则整体 404
 *  3. /api/hortor*, /api/weixin*  代理（可选 Origin 白名单）
 *  4. 其余请求交给 env.ASSETS 静态资源
 *
 * 环境变量（Cloudflare Pages → 设置 → 环境变量）：
 *  - ACCESS_KV               KV 命名空间绑定（必需，缺失时激活接口返回 503，前端降级本机模式）
 *  - ADMIN_TOKEN             管理接口令牌（不配置 = 管理接口整体不可见）
 *  - SERVE_KEY_LIST=1        允许公开下载 /access-keys.json（默认禁止；仅排障时临时开）
 *  - PROXY_ALLOW_ALL=1       关闭代理 Origin 校验（默认开启校验）
 *  - PROXY_ALLOWED_ORIGINS   额外放行的 Origin，逗号分隔，支持 *.example.com
 *
 * 设计要点见 .github/HIGH-AVAILABILITY.md
 */
const DURATIONS_DAYS = {
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
  lifetime: null,
};

/** 巡检专用密钥：不消耗任何卡密、不返回任何可用信息，只回报清单条数与 KV 状态 */
const PROBE_KEY = "__healthcheck_probe__";
const KEY_LIST_PATH = "/access-keys.json";
const USED_PREFIX = "used:";
const MAX_BODY_BYTES = 4096;

/** 代理接口默认放行的来源：null（file:// 与部分 WebView）、本机调试、安卓壳、本项目预览域 */
const DEFAULT_PROXY_ORIGINS = [
  "null",
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "https://localhost",
  "https://appassets.androidplatform.net",
  "capacitor://localhost",
  "*.xyzw-web-helper-2dx.pages.dev",
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
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

/**
 * 读取卡密清单。
 * 明确区分「读不到」与「没有匹配项」：读不到时返回 ok:false，
 * 让调用方回 503 config_unavailable，而不是伪装成 invalid（用户会以为卡密是假的）。
 */
async function loadKeyList(env, origin) {
  try {
    const res = await env.ASSETS.fetch(origin + KEY_LIST_PATH);
    if (!res.ok) return { ok: false, list: [] };
    const list = await res.json();
    if (!Array.isArray(list)) return { ok: false, list: [] };
    return { ok: true, list };
  } catch {
    return { ok: false, list: [] };
  }
}

/** KV 绑定是否可用 + 命名空间是否真的可读（绑定存在但命名空间被删时 get 会抛错） */
async function checkKv(kv) {
  if (!kv || typeof kv.get !== "function") return "unavailable";
  try {
    await kv.get("__probe__");
    return "ok";
  } catch {
    return "error";
  }
}

function recordMetadata(record) {
  return {
    deviceId: record.deviceId,
    type: record.type,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
  };
}

async function handleVerifyKey(request, env) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, reason: "payload_too_large" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const key = String(body?.key || "").trim();
  const deviceId = String(body?.deviceId || "").slice(0, 64);
  if (!key || !deviceId || key.length > 128) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  const origin = new URL(request.url).origin;

  // 巡检探针：只读，不写 KV、不消耗卡密，用来回答「清单还在吗 / KV 还能读吗」
  if (key === PROBE_KEY) {
    const { ok: listOk, list } = await loadKeyList(env, origin);
    const kvState = await checkKv(kv);
    return json({
      ok: false,
      reason: "probe",
      keyList: listOk ? "ok" : "unavailable",
      keys: listOk ? list.length : -1,
      kv: kvState,
    });
  }

  const kvState = await checkKv(kv);
  if (kvState !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const { ok: listOk, list } = await loadKeyList(env, origin);
  if (!listOk) {
    return json({ ok: false, reason: "config_unavailable" }, 503);
  }

  const hash = await sha256Hex(key);
  const meta = list.find((item) => item && item.hash === hash);
  if (!meta) {
    return json({ ok: false, reason: "invalid" });
  }

  const usedKey = USED_PREFIX + hash;
  const used = await kv.get(usedKey);
  if (used) {
    let record = null;
    try {
      record = JSON.parse(used);
    } catch {
      record = null;
    }

    // 同设备幂等恢复：清缓存 / 换浏览器后本地记录丢失，凭原密钥 + 原 deviceId 取回访问权，
    // 不重新计算有效期，也不改变「一次性消耗」语义（异设备仍然是 used）。
    if (record && record.deviceId === deviceId) {
      if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) {
        return json({ ok: false, reason: "expired", expiresAt: record.expiresAt });
      }
      return json({
        ok: true,
        resumed: true,
        type: record.type,
        expiresAt: record.expiresAt ?? null,
        activatedAt: record.activatedAt ?? null,
      });
    }

    return json({ ok: false, reason: "used" });
  }

  const activatedAt = new Date();
  if (!(meta.type in DURATIONS_DAYS)) {
    // 清单里出现未知类型时不静默改变用户权益，按 30 天处理但留下痕迹便于排查
    console.warn(`[verify-key] 未知卡密类型 "${meta.type}"，按 30 天处理（hash=${hash.slice(0, 8)}）`);
  }
  // 注意：不能用 ?? 兜底——DURATIONS_DAYS.lifetime 的值就是 null，
  // `null ?? 30` 会把终身卡算成 30 天（历史 bug，已由单测锁死）。
  const days = Object.hasOwn(DURATIONS_DAYS, meta.type)
    ? DURATIONS_DAYS[meta.type]
    : 30;
  const expiresAt =
    days === null
      ? null
      : new Date(activatedAt.getTime() + days * 86400000).toISOString();

  const record = {
    deviceId,
    type: meta.type,
    activatedAt: activatedAt.toISOString(),
    expiresAt,
  };
  const options = { metadata: recordMetadata(record) };

  if (expiresAt) {
    const ttl = Math.ceil(
      (new Date(expiresAt).getTime() - activatedAt.getTime()) / 1000,
    );
    // 消耗记录保留到到期后 1 天；KV 最小 TTL 60s
    options.expirationTtl = Math.max(60, ttl + 86400);
  }

  await kv.put(usedKey, JSON.stringify(record), options);

  return json({
    ok: true,
    type: record.type,
    expiresAt,
    activatedAt: record.activatedAt,
  });
}

/** 取请求携带的管理令牌（Authorization: Bearer / X-Admin-Token / ?token=） */
function readAdminToken(request, url) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("X-Admin-Token") || url.searchParams.get("token") || "";
}

/**
 * 管理接口守卫：未配置 ADMIN_TOKEN 时整体返回 404（不暴露接口存在），
 * 令牌不匹配返回 401。管理面必须失败关闭。
 */
function guardAdmin(request, url, env) {
  const expected = env?.ADMIN_TOKEN;
  if (!expected) return json({ ok: false, reason: "not_found" }, 404);
  const given = readAdminToken(request, url);
  if (!given || given.length !== expected.length || given !== expected) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  return null;
}

/** GET /api/admin/activations —— 激活/到期清单（默认只返回最近 1000 条） */
async function handleAdminActivations(request, env, url) {
  const denied = guardAdmin(request, url, env);
  if (denied) return denied;

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const now = Date.now();
  const items = [];
  let cursor;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await kv.list({ prefix: USED_PREFIX, limit: 1000, cursor });
      for (const entry of page.keys) {
        const meta = entry.metadata || {};
        const expiresAt = meta.expiresAt ?? null;
        const recordExpiresAt = entry.expiration
          ? new Date(entry.expiration * 1000).toISOString()
          : null;
        items.push({
          hashPrefix: entry.name.slice(USED_PREFIX.length, USED_PREFIX.length + 8),
          type: meta.type ?? null,
          deviceId: meta.deviceId ?? null,
          activatedAt: meta.activatedAt ?? null,
          expiresAt,
          recordExpiresAt,
          daysLeft: expiresAt
            ? Math.ceil((new Date(expiresAt).getTime() - now) / 86400000)
            : null,
          lifetime: !expiresAt,
        });
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch (error) {
    return json({ ok: false, reason: "kv_list_failed", message: String(error?.message || error) }, 502);
  }

  items.sort((a, b) => (a.activatedAt || "").localeCompare(b.activatedAt || ""));
  return json({ ok: true, count: items.length, items });
}

/** POST /api/admin/rebind —— 把已激活卡密的设备绑定改到新 deviceId（保留原有效期） */
async function handleAdminRebind(request, env, url) {
  const denied = guardAdmin(request, url, env);
  if (denied) return denied;

  if (request.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

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
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const hash = await sha256Hex(key);
  const usedKey = USED_PREFIX + hash;
  const raw = await kv.get(usedKey);
  if (!raw) {
    return json({ ok: false, reason: "not_activated" }, 404);
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: "record_corrupt" }, 409);
  }
  if (!record?.type || !(record.type in DURATIONS_DAYS)) {
    return json({ ok: false, reason: "record_corrupt" }, 409);
  }

  record.deviceId = deviceId;

  // 支持显式修复到期时间（历史 bug：终身卡曾被写成 30 天）。传 expiresAt: null 表示永久。
  if (Object.hasOwn(body, "expiresAt")) {
    if (body.expiresAt === null) {
      record.expiresAt = null;
    } else if (
      typeof body.expiresAt === "string" &&
      !Number.isNaN(Date.parse(body.expiresAt))
    ) {
      record.expiresAt = new Date(body.expiresAt).toISOString();
    } else {
      return json({ ok: false, reason: "bad_expires_at" }, 400);
    }
  }

  const options = { metadata: recordMetadata(record) };
  let ttl = null;
  if (record.expiresAt) {
    const remaining = Math.ceil(
      (new Date(record.expiresAt).getTime() - Date.now()) / 1000,
    );
    ttl = Math.max(60, remaining + 86400);
    options.expirationTtl = ttl;
  }

  await kv.put(usedKey, JSON.stringify(record), options);
  return json({
    ok: true,
    type: record.type,
    deviceId,
    activatedAt: record.activatedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    expired: record.expiresAt ? new Date(record.expiresAt).getTime() < Date.now() : false,
  });
}

/** 代理接口的来源校验：浏览器跨站调用一律拒绝；非浏览器（无 Origin）放行 */
function proxyOriginAllowed(request, requestOrigin, env) {
  if (env?.PROXY_ALLOW_ALL === "1") return true;
  const originHeader = request.headers.get("Origin");
  if (!originHeader) return true;
  if (originHeader === requestOrigin) return true;

  const extra = String(env?.PROXY_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return [...DEFAULT_PROXY_ORIGINS, ...extra].some((pattern) => {
    if (pattern.startsWith("*.")) {
      return originHeader.endsWith(pattern.slice(1));
    }
    return pattern === originHeader;
  });
}

const PROXIES = [
  {
    prefix: "/api/hortor-ucenter",
    target: "https://comb-platform.hortorgames.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; ALN-AL80 Build/HUAWEIALN-AL80; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36",
      Accept: "application/json",
      Host: "ucenter-app-server.hortorgames.com",
      "Content-Type": "application/json; charset=utf-8",
    },
  },
  {
    prefix: "/api/weixin-long",
    target: "https://long.open.weixin.qq.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN",
      Accept: "*/*",
      Referer: "https://open.weixin.qq.com/",
    },
  },
  {
    prefix: "/api/weixin",
    target: "https://open.weixin.qq.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      Referer: "https://open.weixin.qq.com/",
    },
  },
  {
    prefix: "/api/hortor",
    target: "https://comb-platform.hortorgames.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36",
      Accept: "*/*",
      Host: "comb-platform.hortorgames.com",
      Connection: "keep-alive",
      "Content-Type": "text/plain; charset=utf-8",
      Origin: "https://open.weixin.qq.com",
      Referer: "https://open.weixin.qq.com/",
    },
  },
].sort((a, b) => b.prefix.length - a.prefix.length); // 最长前缀优先

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Requested-With, X-Admin-Token",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== 卡密验证 API（必须先于代理与静态资产处理）=====
    if (url.pathname === "/api/verify-key") {
      if (request.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }
      return handleVerifyKey(request, env);
    }

    // ===== 运营接口（未配置 ADMIN_TOKEN 时整体 404）=====
    if (url.pathname.startsWith("/api/admin/")) {
      if (url.pathname === "/api/admin/activations") {
        if (request.method !== "GET") {
          return json({ ok: false, reason: "method_not_allowed" }, 405);
        }
        return handleAdminActivations(request, env, url);
      }
      if (url.pathname === "/api/admin/rebind") {
        return handleAdminRebind(request, env, url);
      }
      return json({ ok: false, reason: "not_found" }, 404);
    }

    // ===== 卡密清单不对外提供（哈希清单只给 Worker 内部读，防止一条 URL 抓走全量哈希与卡量）=====
    if (url.pathname === KEY_LIST_PATH && env?.SERVE_KEY_LIST !== "1") {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    // ===== 代理 =====
    const proxy = PROXIES.find((p) => url.pathname.startsWith(p.prefix));

    if (proxy) {
      if (!proxyOriginAllowed(request, url.origin, env)) {
        console.warn(
          `[proxy] 拒绝跨站调用 origin=${request.headers.get("Origin")} path=${url.pathname}`,
        );
        return json({ error: "origin_not_allowed" }, 403);
      }

      const targetUrl = new URL(proxy.target);
      targetUrl.pathname = url.pathname.replace(proxy.prefix, "") || "/";
      targetUrl.search = url.search;

      const newHeaders = new Headers(request.headers);
      Object.entries(proxy.headers).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });
      if (proxy.headers.Host) {
        newHeaders.set("Host", proxy.headers.Host);
      }

      const newRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        redirect: "follow",
      });

      try {
        const response = await fetch(newRequest);
        const newResponse = new Response(response.body, response);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          newResponse.headers.set(key, value);
        });
        return newResponse;
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 静态资源（Cloudflare Pages assets 绑定）
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
