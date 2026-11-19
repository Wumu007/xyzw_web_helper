#!/usr/bin/env node
/**
 * 访问密钥生成器
 *
 * 用法：
 *   node scripts/generate-keys.mjs --type week --count 1 --note "给朋友的"
 *
 * 类型（--type）：week=7天 | month=30天 | quarter=90天 | year=365天 | lifetime=永久
 *
 * 输出：
 *   1. 明文密钥（仅自己保存，勿公开、勿提交到仓库）
 *   2. 可直接粘贴进 src/config/access-keys.json 的条目（只含哈希，可公开）
 *
 * 明文只出现在运行终端里；仓库永远只保存 SHA-256 哈希。
 */
import { createHash, randomBytes } from "node:crypto";

const DURATIONS = { week: 7, month: 30, quarter: 90, year: 365, lifetime: null };

function parseArgs(argv) {
  const args = { type: "month", count: 1, note: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--type") args.type = argv[++i];
    else if (argv[i] === "--count") args.count = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === "--note") args.note = argv[++i] || "";
  }
  return args;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function genKey() {
  const seg = () => randomBytes(3).toString("hex");
  return `KL-${seg()}-${seg()}-${seg()}`;
}

const { type, count, note } = parseArgs(process.argv.slice(2));

if (!(type in DURATIONS)) {
  console.error(`未知类型: ${type}（可选: week | month | quarter | year | lifetime）`);
  process.exit(1);
}

const createdAt = new Date();
const days = DURATIONS[type];
const expiresAt =
  days === null ? null : new Date(createdAt.getTime() + days * 86400000).toISOString();

const entries = [];

console.log("========================================");
console.log(`类型: ${type}  有效期: ${days === null ? "永久" : days + " 天"}`);
console.log("⚠️  以下明文密钥请立即保存，不要公开或提交到仓库");
console.log("========================================");

for (let i = 0; i < count; i++) {
  const key = genKey();
  const hash = sha256(key);
  entries.push({
    id: `${type}-${createdAt.toISOString().slice(0, 10)}-${i + 1}`,
    type,
    note,
    createdAt: createdAt.toISOString(),
    expiresAt,
    hash,
  });
  console.log(`  ${key}`);
}

console.log("========================================");
console.log("以下是可追加到 src/config/access-keys.json 的条目（可公开）：");
console.log(JSON.stringify(entries, null, 2));
