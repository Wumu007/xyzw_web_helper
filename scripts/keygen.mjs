#!/usr/bin/env node
/**
 * 卡密生成 / 校验工具
 *
 * 卡密 = 72 bit 随机（KL- + 3 段 6 位十六进制），清单里只存 sha256。
 * 生成后必须把 public/ 与 src/config/ 两份清单一起更新并推送，否则：
 *   - public/access-keys.json 是 Worker 校验用的（服务端认不认）
 *   - src/config/access-keys.json 是前端离线降级用的（断网时认不认）
 *
 * 用法（在仓库根目录执行）：
 *   node scripts/keygen.mjs --type week --count 10
 *   node scripts/keygen.mjs --type lifetime --count 3
 *   node scripts/keygen.mjs --check                # 体检：两份清单是否一致、有无重复
 *   node scripts/keygen.mjs --type month --count 5 --dry-run
 *
 * 类型：week(7天) / month(30) / quarter(90) / year(365) / lifetime(永久)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC_LIST = path.join(ROOT, "public", "access-keys.json");
const BUNDLE_LIST = path.join(ROOT, "src", "config", "access-keys.json");
const PLAIN_DIR = path.join(ROOT, "keys");

const DURATIONS_DAYS = { week: 7, month: 30, quarter: 90, year: 365, lifetime: null };
const NOTES = {
  week: "周卡",
  month: "月卡",
  quarter: "季卡",
  year: "年卡",
  lifetime: "终身卡",
};

/** 同时支持 `--count=3` 与 `--count 3` 两种写法 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");

/** 与仓库现有清单保持逐字节一致的排版（换行、冒号后空格、对象间逗号加空格） */
function serialize(list) {
  const one = (obj) =>
    "{" +
    Object.entries(obj)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(", ") +
    "}";
  return "[" + list.map(one).join(", ") + "]";
}

function readList(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function genKey() {
  const hex = crypto.randomBytes(9).toString("hex"); // 18 位十六进制 = 72 bit
  return `KL-${hex.slice(0, 6)}-${hex.slice(6, 12)}-${hex.slice(12, 18)}`;
}

// ---------- 体检 ----------
if (args.check) {
  const a = readList(PUBLIC_LIST);
  const b = readList(BUNDLE_LIST);
  const problems = [];

  if (serialize(a) !== serialize(b)) problems.push("两份清单内容不一致（public 与 src/config）");
  const hashes = a.map((x) => x.hash);
  const dup = hashes.filter((h, i) => hashes.indexOf(h) !== i);
  if (dup.length) problems.push(`清单内有 ${dup.length} 条重复 hash：${dup.slice(0, 3).join(", ")}`);
  const bad = a.filter((x) => !/^[0-9a-f]{64}$/.test(String(x.hash)));
  if (bad.length) problems.push(`${bad.length} 条 hash 格式非法`);
  const badType = a.filter((x) => !Object.hasOwn(DURATIONS_DAYS, x.type));
  if (badType.length) problems.push(`${badType.length} 条类型未知：${[...new Set(badType.map((x) => x.type))].join(",")}`);

  const byType = a.reduce((m, x) => ((m[x.type] = (m[x.type] || 0) + 1), m), {});
  console.log(`清单共 ${a.length} 张：${Object.entries(byType).map(([t, n]) => `${NOTES[t] || t} ${n}`).join("、")}`);
  if (problems.length) {
    console.log("\n发现问题：");
    for (const p of problems) console.log("  ✗ " + p);
    process.exit(1);
  }
  console.log("✓ 两份清单一致，无重复，格式合法");
  process.exit(0);
}

// ---------- 生成 ----------
const type = typeof args.type === "string" ? args.type : "";
if (!Object.hasOwn(DURATIONS_DAYS, type)) {
  console.error(`用法：node scripts/keygen.mjs --type <${Object.keys(DURATIONS_DAYS).join("|")}> --count <数量>`);
  process.exit(1);
}
const count = Number(args.count ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 500) {
  console.error("--count 必须是 1~500 的整数");
  process.exit(1);
}

const list = readList(PUBLIC_LIST);
const now = new Date();
const days = DURATIONS_DAYS[type];
const createdAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
// 清单里的 expiresAt 只是「这张卡最晚可激活到什么时候」的备忘，真正有效期在激活时起算
const expiresAt =
  days === null ? null : new Date(now.getTime() + days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");

const stamp = createdAt.slice(0, 10).replace(/-/g, "");
const existingIds = new Set(list.map((x) => x.id));
const existingHashes = new Set(list.map((x) => x.hash));

const batchBase = `${type}-${stamp}`;
const created = [];
let n = 0;
while (created.length < count) {
  n += 1;
  const key = genKey();
  const hash = sha256(key);
  if (existingHashes.has(hash)) continue; // 撞车概率 2^-72，纯保险
  let id = count === 1 && !existingIds.has(batchBase) ? batchBase : `${batchBase}-${String(n).padStart(2, "0")}`;
  if (existingIds.has(id)) continue;
  existingIds.add(id);
  existingHashes.add(hash);
  created.push({ id, type, note: NOTES[type], createdAt, expiresAt, hash, key });
}

const nextList = [...list, ...created.map(({ key, ...rest }) => rest)];

if (args["dry-run"]) {
  console.log(`[dry-run] 将新增 ${count} 张${NOTES[type]}，清单 ${list.length} → ${nextList.length}`);
  for (const c of created) console.log(`  ${c.key}  ${c.hash.slice(0, 8)}…`);
  process.exit(0);
}

// 两份清单一起写，避免「服务端认、前端降级不认」
fs.writeFileSync(PUBLIC_LIST, serialize(nextList));
fs.writeFileSync(BUNDLE_LIST, serialize(nextList));

fs.mkdirSync(PLAIN_DIR, { recursive: true });
const plainFile = path.join(PLAIN_DIR, `${NOTES[type]}-${stamp}.txt`);
const header =
  `# ${NOTES[type]}（${type}）\n` +
  `# 生成时间：${createdAt}\n` +
  `# 共 ${created.length} 张；有效期从用户激活那一刻起算${days === null ? "（永久）" : `（${days} 天）`}\n` +
  `# 本文件含明文，已被 .gitignore 忽略，请自行保存好\n\n`;
const body =
  created
    .map((c, i) => `${String(i + 1).padStart(2, "0")}. ${c.key}    hash:${c.hash.slice(0, 8)}`)
    .join("\n") + "\n";
fs.writeFileSync(plainFile, header + body, "utf8");

console.log(`已生成 ${created.length} 张${NOTES[type]}：`);
for (const c of created) console.log(`  ${c.key}`);
console.log(`\n清单：${list.length} → ${nextList.length} 张（已同时写入 public/ 与 src/config/）`);
console.log(`明文：${path.relative(ROOT, plainFile)}`);
console.log(`
下一步（必须推上去才生效）：
  git add public/access-keys.json src/config/access-keys.json
  git commit -m "feat(keys): 新增 ${created.length} 张${NOTES[type]}"
  git push
推送后 Cloudflare Pages 会自动重建，约 1 分钟生效。`);
