/**
 * worker.js 的单元测试（node --test）
 *
 * 覆盖收钱链路最容易静默坏掉的地方：
 *  - 一次性消耗、激活起算、终身卡不过期
 *  - 同设备幂等恢复（清缓存后取回访问权）、异设备仍是 used、已过期返回 expired
 *  - KV 缺失 / 命名空间读取失败 / 卡密清单读取失败 三种故障要能区分开
 *  - 巡检探针不消耗卡密、能同时回报清单与 KV 状态
 *  - 管理接口默认关闭（未配置 token 时 404）、令牌校验、换绑保留原有效期
 *  - 代理接口拒绝跨站浏览器调用
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import worker from "../worker.js";

const SITE = "https://site.test";
const PROBE_KEY = "__healthcheck_probe__";

async function sha256(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 最小可用 KV 假实现：够覆盖 get / put / list 的语义 */
class FakeKV {
  constructor() {
    this.store = new Map();
    this.getCalls = 0;
    this.failGet = false;
  }

  async get(key) {
    this.getCalls += 1;
    if (this.failGet) throw new Error("kv get failed");
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  async put(key, value, options = {}) {
    this.store.set(key, {
      value,
      options,
      expiration: options.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : null,
    });
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const names = [...this.store.keys()].filter((name) => name.startsWith(prefix));
    const start = cursor ? Number(cursor) : 0;
    const slice = names.slice(start, start + limit);
    return {
      keys: slice.map((name) => ({
        name,
        metadata: this.store.get(name).options?.metadata ?? null,
        expiration: this.store.get(name).expiration,
      })),
      list_complete: start + limit >= names.length,
      cursor: String(start + limit),
    };
  }
}

function makeEnv({ keys, kv = new FakeKV(), env = {} } = {}) {
  return {
    env: {
      ASSETS: {
        async fetch(input) {
          const url = typeof input === "string" ? input : input.url;
          if (url.endsWith("/access-keys.json")) {
            if (keys === null) return new Response("boom", { status: 500 });
            return new Response(JSON.stringify(keys), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
      ACCESS_KV: kv,
      ...env,
    },
    kv,
  };
}

function verifyRequest(payload, init = {}) {
  const { headers, ...rest } = init;
  return new Request(`${SITE}/api/verify-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...rest,
  });
}

async function callVerify(env, payload, init) {
  const res = await worker.fetch(verifyRequest(payload, init), env);
  return { status: res.status, body: await res.json() };
}

const DAY_MS = 86400000;
let KEYS;
let WEEK_KEY;
let LIFE_KEY;

beforeEach(async () => {
  WEEK_KEY = "KL-aaaaaa-bbbbbb-cccccc";
  LIFE_KEY = "KL-111111-222222-333333";
  KEYS = [
    { hash: await sha256(WEEK_KEY), type: "week" },
    { hash: await sha256(LIFE_KEY), type: "lifetime" },
  ];
});

describe("卡密验证 · 基本路径", () => {
  test("非 POST 返回 405", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const res = await worker.fetch(
      new Request(`${SITE}/api/verify-key`, { method: "GET" }),
      env,
    );
    assert.equal(res.status, 405);
    assert.equal((await res.json()).reason, "method_not_allowed");
  });

  test("非法 JSON 返回 400，且不触碰 KV", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(env, "{not json");
    assert.equal(status, 400);
    assert.equal(body.reason, "bad_request");
    assert.equal(kv.getCalls, 0);
  });

  test("缺 deviceId 返回 400", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(env, { key: WEEK_KEY });
    assert.equal(status, 400);
    assert.equal(body.reason, "bad_request");
  });

  test("超大请求体返回 413", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(
      env,
      { key: WEEK_KEY, deviceId: "d1" },
      { headers: { "Content-Length": "999999" } },
    );
    assert.equal(status, 413);
    assert.equal(body.reason, "payload_too_large");
  });

  test("不存在的密钥返回 invalid，不写 KV", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(env, {
      key: "KL-000000-000000-000000",
      deviceId: "d1",
    });
    assert.equal(status, 200);
    assert.equal(body.reason, "invalid");
    assert.equal(kv.store.size, 0);
  });
});

describe("卡密验证 · 激活与消耗", () => {
  test("周卡激活：有效期 7 天，记录 TTL 为 7 天 + 1 天缓冲", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(env, {
      key: WEEK_KEY,
      deviceId: "device-a",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "week");

    const activatedAt = new Date(body.activatedAt).getTime();
    const expiresAt = new Date(body.expiresAt).getTime();
    assert.equal(expiresAt - activatedAt, 7 * DAY_MS);

    const stored = kv.store.get(`used:${await sha256(WEEK_KEY)}`);
    assert.ok(stored, "消耗记录必须落库");
    assert.equal(stored.options.expirationTtl, 7 * 86400 + 86400);
    assert.equal(stored.options.metadata.deviceId, "device-a");
    assert.equal(stored.options.metadata.type, "week");
  });

  test("终身卡：expiresAt 为 null 且不设置 TTL", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const { body } = await callVerify(env, { key: LIFE_KEY, deviceId: "device-a" });
    assert.equal(body.ok, true);
    assert.equal(body.type, "lifetime");
    assert.equal(body.expiresAt, null);

    const stored = kv.store.get(`used:${await sha256(LIFE_KEY)}`);
    assert.equal(stored.options.expirationTtl, undefined);
  });

  test("同设备再次输入：幂等恢复原有效期，不重新计时", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const first = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    const second = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });

    assert.equal(second.body.ok, true);
    assert.equal(second.body.resumed, true);
    assert.equal(second.body.expiresAt, first.body.expiresAt);
    assert.equal(second.body.activatedAt, first.body.activatedAt);
  });

  test("异设备再次输入：返回 used（一次性消耗语义不变）", async () => {
    const { env } = makeEnv({ keys: KEYS });
    await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    const { body } = await callVerify(env, { key: WEEK_KEY, deviceId: "device-b" });
    assert.equal(body.ok, false);
    assert.equal(body.reason, "used");
  });

  test("同设备但卡密已过期：返回 expired 与到期时间", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const hash = await sha256(WEEK_KEY);
    const expiresAt = new Date(Date.now() - DAY_MS).toISOString();
    await kv.put(
      `used:${hash}`,
      JSON.stringify({
        deviceId: "device-a",
        type: "week",
        activatedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
        expiresAt,
      }),
      { expirationTtl: 60 },
    );

    const { body } = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    assert.equal(body.ok, false);
    assert.equal(body.reason, "expired");
    assert.equal(body.expiresAt, expiresAt);
  });

  test("未知类型不改变用户权益：按 30 天处理", async () => {
    const weird = "KL-dddddd-eeeeee-ffffff";
    const { env } = makeEnv({
      keys: [{ hash: await sha256(weird), type: "mystery" }],
    });
    const { body } = await callVerify(env, { key: weird, deviceId: "d1" });
    assert.equal(body.ok, true);
    const days = (new Date(body.expiresAt) - new Date(body.activatedAt)) / DAY_MS;
    assert.equal(Math.round(days), 30);
  });
});

describe("卡密验证 · 故障区分", () => {
  test("KV 未绑定返回 503 kv_unavailable（前端据此降级）", async () => {
    const { env } = makeEnv({ keys: KEYS, kv: null });
    const { status, body } = await callVerify(env, { key: WEEK_KEY, deviceId: "d1" });
    assert.equal(status, 503);
    assert.equal(body.reason, "kv_unavailable");
  });

  test("KV 绑定存在但读失败：同样是 503", async () => {
    const kv = new FakeKV();
    kv.failGet = true;
    const { env } = makeEnv({ keys: KEYS, kv });
    const { status, body } = await callVerify(env, { key: WEEK_KEY, deviceId: "d1" });
    assert.equal(status, 503);
    assert.equal(body.reason, "kv_unavailable");
  });

  test("卡密清单读不到返回 503 config_unavailable，不再伪装成 invalid", async () => {
    const { env } = makeEnv({ keys: null });
    const { status, body } = await callVerify(env, { key: WEEK_KEY, deviceId: "d1" });
    assert.equal(status, 503);
    assert.equal(body.reason, "config_unavailable");
  });

  test("KV 缺失优先于清单查找暴露：无效密钥也返回 503（巡检盲区的修复）", async () => {
    const { env } = makeEnv({ keys: KEYS, kv: null });
    const { status, body } = await callVerify(env, {
      key: "__definitely_not_a_key__",
      deviceId: "d1",
    });
    assert.equal(status, 503);
    assert.equal(body.reason, "kv_unavailable");
  });
});

describe("巡检探针", () => {
  test("探针回报清单条数与 KV 状态，且不写 KV", async () => {
    const { env, kv } = makeEnv({ keys: KEYS });
    const { status, body } = await callVerify(env, { key: PROBE_KEY, deviceId: "healthcheck" });
    assert.equal(status, 200);
    assert.equal(body.reason, "probe");
    assert.equal(body.keyList, "ok");
    assert.equal(body.keys, KEYS.length);
    assert.equal(body.kv, "ok");
    assert.equal(kv.store.size, 0, "探针不能写入任何记录");
  });

  test("探针能发现 KV 缺失", async () => {
    const { env } = makeEnv({ keys: KEYS, kv: null });
    const { body } = await callVerify(env, { key: PROBE_KEY, deviceId: "healthcheck" });
    assert.equal(body.reason, "probe");
    assert.equal(body.kv, "unavailable");
  });

  test("探针能发现清单损坏", async () => {
    const { env } = makeEnv({ keys: null });
    const { body } = await callVerify(env, { key: PROBE_KEY, deviceId: "healthcheck" });
    assert.equal(body.keyList, "unavailable");
    assert.equal(body.keys, -1);
  });
});

describe("卡密清单不对外公开", () => {
  test("默认 404", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const res = await worker.fetch(new Request(`${SITE}/access-keys.json`), env);
    assert.equal(res.status, 404);
  });

  test("SERVE_KEY_LIST=1 时恢复公开（排障逃生阀）", async () => {
    const { env } = makeEnv({ keys: KEYS, env: { SERVE_KEY_LIST: "1" } });
    const res = await worker.fetch(new Request(`${SITE}/access-keys.json`), env);
    assert.equal(res.status, 200);
  });
});

describe("管理接口", () => {
  const TOKEN = "admin-token-for-test";

  async function seedActivation() {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    return { env, kv };
  }

  test("未配置 ADMIN_TOKEN：接口整体 404（失败关闭）", async () => {
    const { env } = makeEnv({ keys: KEYS });
    for (const path of ["/api/admin/activations", "/api/admin/keys", "/api/admin/rebind"]) {
      const res = await worker.fetch(
        new Request(`${SITE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
        env,
      );
      assert.equal(res.status, 404, `${path} 应返回 404`);
    }
  });

  test("令牌错误返回 401", async () => {
    const { env } = await seedActivation();
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/activations`, {
        headers: { Authorization: "Bearer wrong" },
      }),
      env,
    );
    assert.equal(res.status, 401);
  });

  test("激活列表返回类型、设备、剩余天数", async () => {
    const { env } = await seedActivation();
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/activations`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.items[0].type, "week");
    assert.equal(body.items[0].deviceId, "device-a");
    assert.equal(body.items[0].daysLeft, 7);
    assert.equal(body.items[0].lifetime, false);
  });

  test("旧记录（没有 metadata）要从记录值里读出真实类型，不能误判成终身卡", async () => {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    const hash = await sha256(WEEK_KEY);
    // 模拟旧版 worker 写入：只有值，没有 metadata
    await kv.put(
      `used:${hash}`,
      JSON.stringify({
        deviceId: "device-old",
        type: "week",
        activatedAt: "2026-11-19T10:34:50.000Z",
        expiresAt: "2026-11-26T10:34:50.000Z",
      }),
      { expirationTtl: 8 * 86400 },
    );

    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/activations`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const item = body.items[0];
    assert.equal(item.type, "week", "must read type from the record value");
    assert.equal(item.lifetime, false, "missing metadata must not imply lifetime");
    assert.equal(item.deviceId, "device-old");
    assert.equal(item.expiresAt, "2026-11-26T10:34:50.000Z");
    assert.equal(item.legacy, true);
    assert.equal(item.hash, hash, "full hash must be exposed so repairs need no plaintext key");
  });

  test("按 hash 修复终身卡：无需明文密钥，也不改变设备绑定", async () => {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    const hash = await sha256(WEEK_KEY);
    // 历史 bug 留下的记录：type 是 lifetime，却带着 30 天到期时间
    await kv.put(
      `used:${hash}`,
      JSON.stringify({
        deviceId: "device-old",
        type: "lifetime",
        activatedAt: "2026-11-19T10:26:12.000Z",
        expiresAt: "2026-12-19T10:26:12.000Z",
      }),
      { expirationTtl: 31 * 86400 },
    );

    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/rebind`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN },
        body: JSON.stringify({ hash, expiresAt: null }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expiresAt, null);
    assert.equal(body.deviceId, "device-old", "omitting deviceId keeps the old binding");

    const stored = kv.store.get(`used:${hash}`);
    assert.equal(stored.options.expirationTtl, undefined, "TTL must be removed");
    assert.equal(stored.options.metadata.type, "lifetime");
  });

  test("换绑：改 deviceId 且保留原有效期", async () => {
    const { env, kv } = await seedActivation();
    const before = JSON.parse(kv.store.get(`used:${await sha256(WEEK_KEY)}`).value);

    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/rebind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": TOKEN,
        },
        body: JSON.stringify({ key: WEEK_KEY, deviceId: "device-new" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deviceId, "device-new");
    assert.equal(body.expiresAt, before.expiresAt);

    // 换绑后：新设备可恢复访问，老设备变成 used
    const resumed = await callVerify(env, { key: WEEK_KEY, deviceId: "device-new" });
    assert.equal(resumed.body.resumed, true);
    const old = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    assert.equal(old.body.reason, "used");
  });

  test("换绑可顺手修复被误写成 30 天的终身卡（expiresAt: null）", async () => {
    const { env, kv } = await seedActivation();
    const usedKey = `used:${await sha256(WEEK_KEY)}`;
    // 模拟历史 bug 留下的记录：type 是 lifetime，但带着 30 天到期时间
    await kv.put(
      usedKey,
      JSON.stringify({
        deviceId: "device-a",
        type: "lifetime",
        activatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      }),
      { expirationTtl: 31 * 86400 },
    );

    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/rebind`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN },
        body: JSON.stringify({
          key: WEEK_KEY,
          deviceId: "device-a",
          expiresAt: null,
        }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expiresAt, null);
    assert.equal(
      kv.store.get(usedKey).options.expirationTtl,
      undefined,
      "修复后不应再带 TTL",
    );

    const resumed = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    assert.equal(resumed.body.ok, true);
    assert.equal(resumed.body.expiresAt, null);
  });

  test("全量卡密状态：清单里每张卡都要出现，未激活的算 unused", async () => {
    const { env } = await seedActivation();
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary.total, 2);
    assert.equal(body.summary.active, 1);
    assert.equal(body.summary.unused, 1);
    assert.equal(body.summary.expired, 0);
    assert.equal(body.summary.byType.week.total, 1);
    assert.equal(body.summary.byType.lifetime.unused, 1);
    assert.equal(body.orphan, 0);

    const life = body.items.find((x) => x.type === "lifetime");
    assert.equal(life.status, "unused");
    assert.equal(life.deviceId, null);
    assert.equal(life.deviceId === null, true);

    const week = body.items.find((x) => x.type === "week");
    assert.equal(week.status, "active");
    assert.equal(week.deviceId, "device-a");
    // 未使用排在后面
    assert.equal(body.items[0].status, "active");
  });

  test("已过期的卡显示为 expired，而不是 active", async () => {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    const hash = await sha256(WEEK_KEY);
    const past = new Date(Date.now() - 3 * DAY_MS).toISOString();
    await kv.put(
      `used:${hash}`,
      JSON.stringify({ deviceId: "device-old", type: "week", activatedAt: past, expiresAt: past }),
      { metadata: { type: "week", deviceId: "device-old", activatedAt: past, expiresAt: past } },
    );

    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    const body = await res.json();
    const week = body.items.find((x) => x.type === "week");
    assert.equal(week.status, "expired");
    assert.equal(body.summary.expired, 1);
    assert.equal(body.summary.active, 0);
  });

  test("KV 里存在但清单里没有的记录计入 orphan", async () => {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    await kv.put(`used:${"f".repeat(64)}`, JSON.stringify({ type: "week", deviceId: "ghost" }), {
      metadata: { type: "week", deviceId: "ghost", activatedAt: null, expiresAt: null },
    });
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    const body = await res.json();
    assert.equal(body.orphan, 1);
    assert.equal(body.summary.total, 2);
  });

  test("清单读不到时全量状态返回 503，而不是「全部未使用」", async () => {
    const { env } = makeEnv({ keys: null, env: { ADMIN_TOKEN: TOKEN } });
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, "config_unavailable");
  });

  test("全量状态不接受非 GET", async () => {
    const { env } = await seedActivation();
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    assert.equal(res.status, 405);
  });

  test("换绑未激活的卡密返回 404", async () => {    const { env } = await seedActivation();
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/rebind`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN },
        body: JSON.stringify({ key: LIFE_KEY, deviceId: "device-x" }),
      }),
      env,
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, "not_activated");
  });

  // ---- 停用 / 撤销停用 ----
  const adminPost = (env, path, body) =>
    worker.fetch(
      new Request(`${SITE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      }),
      env,
    );

  const adminGet = (env, path) =>
    worker.fetch(
      new Request(`${SITE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env,
    );

  test("停用后：即使同设备原密钥也返回 revoked（优先于幂等恢复）", async () => {
    const { env } = await seedActivation();
    const res = await adminPost(env, "/api/admin/revoke", { key: WEEK_KEY, reason: "退款" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.revoked, true);
    assert.equal(body.reason, "退款");

    const again = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, false);
    assert.equal(again.body.reason, "revoked");
  });

  test("撤销停用后恢复原有权益（仍返回原有效期，不重新计时）", async () => {
    const { env } = await seedActivation();
    await adminPost(env, "/api/admin/revoke", { key: WEEK_KEY });
    const undo = await adminPost(env, "/api/admin/unrevoke", { key: WEEK_KEY });
    assert.equal((await undo.json()).revoked, false);

    const again = await callVerify(env, { key: WEEK_KEY, deviceId: "device-a" });
    assert.equal(again.body.ok, true);
    assert.equal(again.body.resumed, true);
  });

  test("停用不消耗 KV 的 used 记录：撤销后无需重新激活", async () => {
    const { env, kv } = await seedActivation();
    const hash = await sha256(WEEK_KEY);
    await adminPost(env, "/api/admin/revoke", { key: WEEK_KEY });
    assert.ok(kv.store.has(`used:${hash}`), "used 记录应保留");
    assert.ok(kv.store.has(`revoked:${hash}`), "停用标记应写入");
    await adminPost(env, "/api/admin/unrevoke", { key: WEEK_KEY });
    assert.ok(kv.store.has(`used:${hash}`), "撤销停用后 used 记录仍在");
    assert.equal(kv.store.has(`revoked:${hash}`), false);
  });

  test("全量状态里停用的卡显示为 revoked，且计入 summary", async () => {
    const { env } = await seedActivation();
    await adminPost(env, "/api/admin/revoke", { key: WEEK_KEY });
    const res = await worker.fetch(
      new Request(`${SITE}/api/admin/keys`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env,
    );
    const body = await res.json();
    const week = body.items.find((x) => x.type === "week");
    assert.equal(week.status, "revoked");
    assert.equal(body.summary.revoked, 1);
    assert.equal(body.summary.active, 0);
  });

  // ---- 延期 ----
  test("延期 30 天：到期时间顺延，KV TTL 同步变长", async () => {
    const { env, kv } = await seedActivation();
    const hash = await sha256(WEEK_KEY);
    const before = JSON.parse(kv.store.get(`used:${hash}`).value).expiresAt;

    const res = await adminPost(env, "/api/admin/rebind", { key: WEEK_KEY, extendDays: 30 });
    assert.equal(res.status, 200);
    const body = await res.json();
    const delta = (new Date(body.expiresAt) - new Date(before)) / DAY_MS;
    assert.equal(Math.round(delta), 30);

    // TTL 也要跟着走，否则记录会被提前清掉，卡就变成「未使用」白送了
    const ttlDays = (kv.store.get(`used:${hash}`).expiration * 1000 - Date.now()) / DAY_MS;
    assert.ok(ttlDays > 30, `TTL 应超过 30 天，实际 ${ttlDays.toFixed(1)} 天`);
  });

  test("已过期的卡续期：从当前时间起算完整天数，不吃亏", async () => {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv, env: { ADMIN_TOKEN: TOKEN } });
    const hash = await sha256(WEEK_KEY);
    const expiredAt = new Date(Date.now() - 10 * DAY_MS).toISOString();
    await kv.put(
      `used:${hash}`,
      JSON.stringify({ deviceId: "device-a", type: "week", activatedAt: expiredAt, expiresAt: expiredAt }),
      { metadata: { type: "week", deviceId: "device-a", activatedAt: expiredAt, expiresAt: expiredAt } },
    );

    const res = await adminPost(env, "/api/admin/rebind", { key: WEEK_KEY, extendDays: 30 });
    const body = await res.json();
    const left = (new Date(body.expiresAt) - Date.now()) / DAY_MS;
    assert.ok(left > 29.9, `应还剩约 30 天，实际 ${left.toFixed(2)} 天`);
  });

  test("终身卡不接受延期（没有到期时间可延）", async () => {
    const { env } = await seedActivation();
    await adminPost(env, "/api/admin/rebind", { key: LIFE_KEY, expiresAt: null });
    await callVerify(env, { key: LIFE_KEY, deviceId: "device-life" });
    const res = await adminPost(env, "/api/admin/rebind", { key: LIFE_KEY, extendDays: 30 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "already_lifetime");
  });

  test("extendDays 与 expiresAt 同时传：拒绝，避免语义打架", async () => {
    const { env } = await seedActivation();
    const res = await adminPost(env, "/api/admin/rebind", {
      key: WEEK_KEY,
      extendDays: 30,
      expiresAt: null,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "conflict_expires_at");
  });

  test("备注：写入后出现在全量状态里，并可清空", async () => {
    const { env } = await seedActivation();
    const hash = await sha256(WEEK_KEY);

    const saved = await adminPost(env, "/api/admin/rebind", { hash, note: "  张三 · 手机尾号 8888  " });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).note, "张三 · 手机尾号 8888");

    let list = await adminGet(env, "/api/admin/keys");
    let item = (await list.json()).items.find((i) => i.hash === hash);
    assert.equal(item.note, "张三 · 手机尾号 8888");
    // 备注不能顺带改掉别的东西
    assert.equal(item.status, "active");
    assert.equal(item.deviceId, "device-a");

    const cleared = await adminPost(env, "/api/admin/rebind", { hash, note: "" });
    assert.equal((await cleared.json()).note, "");

    list = await adminGet(env, "/api/admin/keys");
    item = (await list.json()).items.find((i) => i.hash === hash);
    assert.equal(item.note, "");
  });

  test("备注过长会被截断（防止把 KV metadata 撑爆）", async () => {
    const { env } = await seedActivation();
    const hash = await sha256(WEEK_KEY);
    const res = await adminPost(env, "/api/admin/rebind", { hash, note: "备".repeat(200) });
    const body = await res.json();
    assert.equal(body.note.length, 120);
  });

  test("全量状态返回完整 hash，供管理页面直接调用运营接口", async () => {
    const { env } = await seedActivation();
    const res = await adminGet(env, "/api/admin/keys");
    const item = (await res.json()).items[0];
    assert.match(item.hash, /^[0-9a-f]{64}$/);
    assert.equal(item.hash.slice(0, 8), item.hashPrefix);
  });
});

describe("客户端心跳 /api/check", () => {
  async function seed() {
    const kv = new FakeKV();
    const { env } = makeEnv({ keys: KEYS, kv });
    const hash = await sha256(WEEK_KEY);
    return { env, kv, hash };
  }

  const check = (env, body) =>
    worker.fetch(
      new Request(`${SITE}/api/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

  test("正常激活的卡返回 active 与最新有效期", async () => {
    const { env, hash } = await seed();
    await callVerify(env, { key: WEEK_KEY, deviceId: "dev-1" });
    const body = await (await check(env, { hash, deviceId: "dev-1" })).json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "active");
    assert.equal(body.type, "week");
    assert.ok(body.expiresAt);
  });

  test("延期后心跳能拿到新有效期（这是「延期即时生效」的关键）", async () => {
    const { env, kv, hash } = await seed();
    await callVerify(env, { key: WEEK_KEY, deviceId: "dev-1" });
    const before = JSON.parse(kv.store.get(`used:${hash}`).value).expiresAt;
    await worker.fetch(
      new Request(`${SITE}/api/admin/rebind`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-for-test" },
        body: JSON.stringify({ key: WEEK_KEY, extendDays: 7 }),
      }),
      { ...env, ADMIN_TOKEN: "admin-token-for-test" },
    );
    const body = await (await check(env, { hash, deviceId: "dev-1" })).json();
    assert.ok(new Date(body.expiresAt) > new Date(before));
  });

  test("停用的卡心跳返回 revoked", async () => {
    const { env, hash } = await seed();
    await callVerify(env, { key: WEEK_KEY, deviceId: "dev-1" });
    await env.ACCESS_KV.put(`revoked:${hash}`, JSON.stringify({ at: new Date().toISOString() }));
    const body = await (await check(env, { hash, deviceId: "dev-1" })).json();
    assert.equal(body.status, "revoked");
  });

  test("换绑后原设备心跳返回 rebound", async () => {
    const { env, hash } = await seed();
    await callVerify(env, { key: WEEK_KEY, deviceId: "dev-old" });
    await env.ACCESS_KV.put(
      `used:${hash}`,
      JSON.stringify({
        deviceId: "dev-new",
        type: "week",
        activatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      }),
      { metadata: { type: "week", deviceId: "dev-new" } },
    );
    const body = await (await check(env, { hash, deviceId: "dev-old" })).json();
    assert.equal(body.status, "rebound");
  });

  test("过期的卡心跳返回 expired", async () => {
    const { env, kv, hash } = await seed();
    const past = new Date(Date.now() - DAY_MS).toISOString();
    await kv.put(
      `used:${hash}`,
      JSON.stringify({ deviceId: "dev-1", type: "week", activatedAt: past, expiresAt: past }),
      { metadata: { type: "week", deviceId: "dev-1", activatedAt: past, expiresAt: past } },
    );
    const body = await (await check(env, { hash, deviceId: "dev-1" })).json();
    assert.equal(body.status, "expired");
  });

  test("KV 里没有记录时返回 unbound（前端应保持本地，不锁人）", async () => {
    const { env, hash } = await seed();
    const body = await (await check(env, { hash, deviceId: "dev-1" })).json();
    assert.equal(body.status, "unbound");
  });

  test("清单里没有的 hash 直接判 invalid", async () => {
    const { env } = await seed();
    const body = await (await check(env, { hash: "a".repeat(64), deviceId: "dev-1" })).json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, "invalid");
  });

  test("KV 不可用返回 503，让前端走 fail-open", async () => {
    const { env, hash } = await seed();
    const res = await check({ ...env, ACCESS_KV: null }, { hash, deviceId: "dev-1" });
    assert.equal(res.status, 503);
  });

  test("参数非法返回 400", async () => {
    const { env } = await seed();
    assert.equal((await check(env, { hash: "short", deviceId: "d" })).status, 400);
    assert.equal((await check(env, { hash: "a".repeat(64) })).status, 400);
  });
});

describe("代理接口来源校验", () => {
  test("跨站浏览器调用返回 403，且不发起上游请求", async () => {
    const { env } = makeEnv({ keys: KEYS });
    let upstreamCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return new Response("ok");
    };
    try {
      const res = await worker.fetch(
        new Request(`${SITE}/api/hortor/login`, {
          headers: { Origin: "https://evil.example.com" },
        }),
        env,
      );
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "origin_not_allowed");
      assert.equal(upstreamCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("同源调用放行", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("upstream-ok", { status: 200 });
    try {
      const res = await worker.fetch(
        new Request(`${SITE}/api/hortor/login`, { headers: { Origin: SITE } }),
        env,
      );
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "upstream-ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("无 Origin（curl / 原生客户端）放行", async () => {
    const { env } = makeEnv({ keys: KEYS });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("upstream-ok", { status: 200 });
    try {
      const res = await worker.fetch(new Request(`${SITE}/api/hortor/login`), env);
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("PROXY_ALLOW_ALL=1 时关闭校验", async () => {
    const { env } = makeEnv({ keys: KEYS, env: { PROXY_ALLOW_ALL: "1" } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("upstream-ok", { status: 200 });
    try {
      const res = await worker.fetch(
        new Request(`${SITE}/api/hortor/login`, {
          headers: { Origin: "https://evil.example.com" },
        }),
        env,
      );
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
