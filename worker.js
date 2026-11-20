/**
 * Cloudflare Pages 高级模式入口（构建时由 vite 插件 copy-worker 复制到 dist/_worker.js）
 *
 * 职责：
 *  1. POST /api/verify-key   卡密验证（一次性消耗 + 激活起算 + 同设备幂等恢复 + 停用拦截）
 *  2. POST /api/check        客户端心跳复核（让延期/停用/换绑能作用于已激活设备）
 *  3. /api/admin/*           运营接口（keys 全量状态 / activations 激活列表 / rebind 换绑与延期 /
 *                            revoke 停用 / unrevoke 撤销停用），需 ADMIN_TOKEN，未配置则整体 404
 *  4. /api/hortor*, /api/weixin*  代理（可选 Origin 白名单）
 *  5. 其余请求交给 env.ASSETS 静态资源
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
const REVOKED_PREFIX = "revoked:";
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
    note: record.note || "",
  };
}

/**
 * 消耗记录的 put 选项：metadata 用于列表快速读取，TTL 必须跟着 expiresAt 走。
 * 延期/缩短/改永久后都要重新算 TTL——否则会出现「卡还能用但 KV 记录已被清掉」，
 * 清掉之后该卡会退回未使用状态，等于白送一张。
 */
/** 停用标记：存在即视为作废。与 used: 分开存，删掉标记即可恢复（不必重建消耗记录） */
async function isRevoked(kv, hash) {
  try {
    return Boolean(await kv.get(REVOKED_PREFIX + hash));
  } catch {
    // 读失败不能当成「已停用」（否则 KV 抖动会把所有用户锁在门外）
    return false;
  }
}

function usagePutOptions(record) {
  const options = { metadata: recordMetadata(record) };
  if (record.expiresAt) {
    const remaining = Math.ceil(
      (new Date(record.expiresAt).getTime() - Date.now()) / 1000,
    );
    // 记录保留到到期后 1 天；KV 最小 TTL 60s
    options.expirationTtl = Math.max(60, remaining + 86400);
  }
  return options;
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

  // 停用优先于一切：作废的卡不能再激活、不能幂等恢复、不能续期
  if (await isRevoked(kv, hash)) {
    return json({ ok: false, reason: "revoked" });
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

  await kv.put(usedKey, JSON.stringify(record), usagePutOptions(record));

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

const LEGACY_LOOKUP_LIMIT = 200;

/**
 * 扫描 KV 中全部已消耗记录，返回 hash -> 记录信息 的 Map。
 *
 * 注意：早期 worker 写入的记录**没有 metadata**，只能回读记录值拿真实字段。
 * 不能把「metadata 缺失」当成「终身卡」——旧版本正是这样把周卡/月卡误显示成 lifetime 的。
 * 回读有次数上限（LEGACY_LOOKUP_LIMIT），避免记录多时把单次请求拖死。
 */
async function scanUsage(kv) {
  const byHash = new Map();
  let legacyLookups = 0;
  let cursor;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await kv.list({ prefix: USED_PREFIX, limit: 1000, cursor });
      for (const entry of page.keys) {
        const meta = entry.metadata || {};
        const hasMeta = Boolean(meta.type);
        let record = null;
        let legacy = false;

        if (!hasMeta && legacyLookups < LEGACY_LOOKUP_LIMIT) {
          legacyLookups += 1;
          try {
            const raw = await kv.get(entry.name);
            if (raw) {
              record = JSON.parse(raw);
              legacy = true;
            }
          } catch {
            record = null;
          }
        }

        const hash = entry.name.slice(USED_PREFIX.length);
        byHash.set(hash, {
          hash,
          hashPrefix: hash.slice(0, 8),
          type: hasMeta ? meta.type : (record?.type ?? null),
          deviceId: hasMeta ? (meta.deviceId ?? null) : (record?.deviceId ?? null),
          activatedAt: hasMeta ? (meta.activatedAt ?? null) : (record?.activatedAt ?? null),
          expiresAt: hasMeta ? (meta.expiresAt ?? null) : (record?.expiresAt ?? null),
          // 人工备注（谁在用这张卡），由 /api/admin/rebind 写入
          note: hasMeta ? (meta.note ?? "") : (record?.note ?? ""),
          // KV 记录自身的过期时间 = 卡到期 + 1 天缓冲，不是卡到期时间
          kvExpiresAt: entry.expiration
            ? new Date(entry.expiration * 1000).toISOString()
            : null,
          legacy,
        });
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  }
  return { ok: true, byHash };
}

/** 扫出全部停用标记（revoked:<hash>）。读失败按「没有停用」处理，避免误锁。 */
async function scanRevoked(kv) {
  const set = new Set();
  let cursor;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await kv.list({ prefix: REVOKED_PREFIX, limit: 1000, cursor });
      for (const entry of page.keys) {
        set.add(entry.name.slice(REVOKED_PREFIX.length));
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch {
    return new Set();
  }
  return set;
}

/**
 * GET /api/admin/activations —— 已激活/已用掉的卡（只含被用过的记录）
 */
async function handleAdminActivations(request, env, url) {
  const denied = guardAdmin(request, url, env);
  if (denied) return denied;

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const scanned = await scanUsage(kv);
  if (!scanned.ok) {
    return json({ ok: false, reason: "kv_list_failed", message: scanned.message }, 502);
  }

  const now = Date.now();
  const items = [...scanned.byHash.values()].map((row) => ({
    ...row,
    daysLeft: row.expiresAt
      ? Math.ceil((new Date(row.expiresAt).getTime() - now) / 86400000)
      : null,
    lifetime: row.type === "lifetime",
  }));

  items.sort((a, b) => (a.activatedAt || "").localeCompare(b.activatedAt || ""));
  return json({ ok: true, count: items.length, items });
}

const STATUS_ORDER = { revoked: 0, active: 1, expired: 2, unused: 3 };

/**
 * GET /api/admin/keys —— 全量卡密状态（清单里每一张卡 + 它现在处于什么状态）
 *
 * 与 `/activations` 的区别：那个只看 KV 里「被用过的」，没激活的卡完全不在结果里，
 * 所以没法回答「我卖出去/生成了 55 张，还剩几张没用」。这个接口以清单为基准做左右合并：
 *   revoked 已停用（手动作废，优先级最高）
 *   unused  未使用（KV 里没有记录）
 *   active  已激活且未到期
 *   expired 已激活但已过期
 * 只输出 hash 前缀，不输出明文；明文本身服务端从来没有过。
 */
async function handleAdminKeys(request, env, url) {
  const denied = guardAdmin(request, url, env);
  if (denied) return denied;

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const origin = new URL(request.url).origin;
  const { ok: listOk, list } = await loadKeyList(env, origin);
  if (!listOk) {
    return json({ ok: false, reason: "config_unavailable" }, 503);
  }

  const scanned = await scanUsage(kv);
  if (!scanned.ok) {
    return json({ ok: false, reason: "kv_list_failed", message: scanned.message }, 502);
  }

  const revoked = await scanRevoked(kv);
  const now = Date.now();
  const manifestHashes = new Set(list.map((e) => e.hash));
  const items = list.map((entry) => {
    const hash = String(entry.hash || "");
    const used = scanned.byHash.get(hash) || null;
    let status = "unused";
    if (revoked.has(hash)) {
      status = "revoked";
    } else if (used) {
      const expiredByTime = used.expiresAt
        ? new Date(used.expiresAt).getTime() <= now
        : false;
      status = expiredByTime ? "expired" : "active";
    }
    return {
      // 完整 hash 只给运营接口（需 ADMIN_TOKEN），管理页面靠它调 rebind/revoke
      hash,
      hashPrefix: hash.slice(0, 8),
      type: entry.type ?? null,
      status,
      deviceId: used?.deviceId ?? null,
      activatedAt: used?.activatedAt ?? null,
      expiresAt: used?.expiresAt ?? null,
      daysLeft: used?.expiresAt
        ? Math.ceil((new Date(used.expiresAt).getTime() - now) / 86400000)
        : null,
      note: used?.note ?? "",
      legacy: used?.legacy ?? false,
    };
  });

  const summary = {
    total: items.length,
    unused: 0,
    active: 0,
    expired: 0,
    revoked: 0,
    byType: {},
  };
  for (const item of items) {
    summary[item.status] += 1;
    const bucket = (summary.byType[item.type] ||= {
      total: 0,
      unused: 0,
      active: 0,
      expired: 0,
      revoked: 0,
    });
    bucket.total += 1;
    bucket[item.status] += 1;
  }

  // 清单换过批次时，KV 里可能存在清单中已不存在的历史记录
  const orphan = [...scanned.byHash.keys()].filter((h) => !manifestHashes.has(h)).length;

  items.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      String(a.type).localeCompare(String(b.type)) ||
      a.hashPrefix.localeCompare(b.hashPrefix),
  );

  return json({ ok: true, summary, orphan, items });
}

/**
 * POST /api/admin/rebind —— 换绑设备 / 修复到期时间
 *
 * 入参二选一：`key`（明文卡密）或 `hash`（64 位 sha256，来自 activations 列表）。
 * 用 hash 是为了修「明文已经找不到」的历史记录——老的批次卡密未必还留着。
 * `deviceId` 可省略（省略即保持原设备不变）；`expiresAt: null` 表示改为永久有效。
 */
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
  const hashInput = String(body?.hash || "").trim().toLowerCase();
  const nextDeviceId =
    body?.deviceId === undefined || body?.deviceId === null
      ? null
      : String(body.deviceId).slice(0, 64);

  // 备注（谁在用这张卡）：传字符串即写入，传空字符串即清空，不传即不动。
  const nextNote =
    body?.note === undefined || body?.note === null
      ? null
      : String(body.note).trim().slice(0, 120);

  if (!key && !/^[0-9a-f]{64}$/.test(hashInput)) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }
  if (nextDeviceId !== null && !nextDeviceId) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const hash = key ? await sha256Hex(key) : hashInput;
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

  if (nextDeviceId !== null) {
    record.deviceId = nextDeviceId;
  }

  if (nextNote !== null) {
    record.note = nextNote;
  }

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

  // 延期 / 缩短：以 max(现在, 原到期) 为基准加天数。
  // 用 max 而不是直接用原到期，是为了让「已过期再续费」得到完整的天数，
  // 而不是被已过期的那几天先扣掉。
  if (body?.extendDays !== undefined && body?.extendDays !== null) {
    if (Object.hasOwn(body, "expiresAt")) {
      return json({ ok: false, reason: "conflict_expires_at" }, 400);
    }
    const days = Number(body.extendDays);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 3650) {
      return json({ ok: false, reason: "bad_extend_days" }, 400);
    }
    if (!record.expiresAt) {
      // 终身卡没有到期时间可延，改短也没有意义
      return json({ ok: false, reason: "already_lifetime" }, 409);
    }
    const base = Math.max(Date.now(), new Date(record.expiresAt).getTime());
    record.expiresAt = new Date(base + days * 86400000).toISOString();
  }

  await kv.put(usedKey, JSON.stringify(record), usagePutOptions(record));

  return json({
    ok: true,
    hash,
    type: record.type,
    deviceId: record.deviceId ?? null,
    activatedAt: record.activatedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    note: record.note ?? "",
    expired: record.expiresAt ? new Date(record.expiresAt).getTime() < Date.now() : false,
  });
}

/**
 * POST /api/admin/revoke —— 停用作废
 *
 * 与「删掉 used: 记录」的区别：删记录只会让卡回到未使用状态（等于白送），
 * 所以停用单独写 revoked:<hash> 标记，不设 TTL（作废是永久的，直到 unrevoke）。
 * 停用优先于 used 判断：已激活的卡也会在下一次校验时被拒。
 */
async function handleAdminRevoke(request, env, url) {
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
  const hashInput = String(body?.hash || "").trim().toLowerCase();
  if (!key && !/^[0-9a-f]{64}$/.test(hashInput)) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const hash = key ? await sha256Hex(key) : hashInput;
  const reason = String(body?.reason || "").slice(0, 200);
  await kv.put(
    REVOKED_PREFIX + hash,
    JSON.stringify({ at: new Date().toISOString(), reason }),
  );

  return json({ ok: true, hash, revoked: true, reason: reason || null });
}

/** POST /api/admin/unrevoke —— 撤销停用（删除标记，卡恢复原有状态） */
async function handleAdminUnrevoke(request, env, url) {
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
  const hashInput = String(body?.hash || "").trim().toLowerCase();
  if (!key && !/^[0-9a-f]{64}$/.test(hashInput)) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const hash = key ? await sha256Hex(key) : hashInput;
  await kv.delete(REVOKED_PREFIX + hash);
  return json({ ok: true, hash, revoked: false });
}

/**
 * POST /api/check —— 客户端心跳 / 重新校验（不是管理接口，前端每次启动会调一次）
 *
 * 为什么需要它：本项目的访问控制是「激活时校验一次，之后凭本地记录用到到期」。
 * 这带来一个副作用——你在服务端延期、停用、换绑，**已激活的设备感知不到**，
 * 要等它本地到期或清缓存重输才会重新问服务端。
 *
 * 这里用 hash + deviceId 做轻量复核，不重复传明文：
 *   active   正常（顺带下发最新 expiresAt，延期即时生效）
 *   expired  已过期
 *   revoked  已停用
 *   rebound  已换绑到别的设备（原设备应退出）
 *   unbound  KV 里没有消耗记录（记录被清或未激活）
 *
 * 前端约定：只有明确拿到 revoked / expired / rebound 才锁回门禁；
 * unbound、unknown、网络失败、503 一律保持本地记录（fail-open），
 * 避免 KV 抖动或断网把付过费的正常用户锁在门外。
 */
async function handleCheck(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

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

  const hash = String(body?.hash || "").trim().toLowerCase();
  const deviceId = String(body?.deviceId || "").slice(0, 64);
  if (!/^[0-9a-f]{64}$/.test(hash) || !deviceId) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }

  const kv = env?.ACCESS_KV;
  if ((await checkKv(kv)) !== "ok") {
    return json({ ok: false, reason: "kv_unavailable" }, 503);
  }

  const origin = new URL(request.url).origin;
  const { ok: listOk, list } = await loadKeyList(env, origin);
  if (!listOk) {
    return json({ ok: false, reason: "config_unavailable" }, 503);
  }
  if (!list.some((item) => item && item.hash === hash)) {
    return json({ ok: false, reason: "invalid" });
  }

  if (await isRevoked(kv, hash)) {
    return json({ ok: true, status: "revoked" });
  }

  let record = null;
  try {
    const raw = await kv.get(USED_PREFIX + hash);
    if (raw) record = JSON.parse(raw);
  } catch {
    return json({ ok: true, status: "unknown" });
  }

  if (!record) {
    return json({ ok: true, status: "unbound" });
  }
  if (record.deviceId && record.deviceId !== deviceId) {
    return json({ ok: true, status: "rebound" });
  }
  if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) {
    return json({ ok: true, status: "expired", expiresAt: record.expiresAt });
  }

  return json({
    ok: true,
    status: "active",
    type: record.type ?? null,
    activatedAt: record.activatedAt ?? null,
    expiresAt: record.expiresAt ?? null,
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

    // ===== 客户端心跳 / 重新校验（非管理接口，前端启动时调）=====
    if (url.pathname === "/api/check") {
      return handleCheck(request, env);
    }

    // ===== 运营接口（未配置 ADMIN_TOKEN 时整体 404）=====
    if (url.pathname.startsWith("/api/admin/")) {
      if (url.pathname === "/api/admin/activations") {
        if (request.method !== "GET") {
          return json({ ok: false, reason: "method_not_allowed" }, 405);
        }
        return handleAdminActivations(request, env, url);
      }
      if (url.pathname === "/api/admin/keys") {
        if (request.method !== "GET") {
          return json({ ok: false, reason: "method_not_allowed" }, 405);
        }
        return handleAdminKeys(request, env, url);
      }
      if (url.pathname === "/api/admin/revoke") {
        return handleAdminRevoke(request, env, url);
      }
      if (url.pathname === "/api/admin/unrevoke") {
        return handleAdminUnrevoke(request, env, url);
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
