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
    for (const path of ["/api/admin/activations", "/api/admin/rebind"]) {
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
