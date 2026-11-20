#!/usr/bin/env node
/**
 * scripts/verify-dist.mjs —— 构建产物契约校验
 *
 * 目的：把「线上能不能跑」的关键前提，变成构建期就能失败的硬检查。
 * 背景：本项目的 /api/verify-key 依赖 vite 的 copy-worker 插件把根目录 worker.js
 *       拷贝为 dist/_worker.js，一旦该产物缺失，接口会退化为静态资源 405，
 *       而构建本身仍然"成功"，导致故障在部署后才暴露。
 *
 * 用法：node scripts/verify-dist.mjs [dist 目录，默认 ./dist]
 * 退出码：0 全部通过；1 存在致命问题（不应部署）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.argv[2] || join(root, 'dist'));

const errors = [];
const warnings = [];
const passed = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const ok = (msg) => passed.push(msg);

const read = (p) => readFileSync(p, 'utf8');

/** 相对 dist 的路径是否存在 */
const inDist = (rel) => existsSync(join(dist, rel.replace(/^\//, '')));

if (!existsSync(dist)) {
  console.error(`[FATAL] 构建产物目录不存在: ${dist}`);
  process.exit(1);
}

// ---------- 1. 入口页 ----------
const indexPath = join(dist, 'index.html');
if (!inDist('index.html')) {
  fail('dist/index.html 缺失：构建未产出入口页');
} else {
  const html = read(indexPath);
  if (/id=["']app["']/.test(html)) ok('index.html 含 #app 挂载点');
  else fail('index.html 缺少 #app 挂载点，页面会白屏');

  const refs = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(
    (m) => m[1],
  );
  const missing = refs.filter((r) => !inDist(r));
  if (missing.length) fail(`index.html 引用的资源不存在：${missing.join(', ')}`);
  else if (refs.length) ok(`index.html 引用的 ${refs.length} 个资源均存在`);
  else warn('index.html 未引用任何 /assets/ 资源，可能构建异常');
}

// ---------- 2. Worker 入口（卡密接口的命脉） ----------
if (!inDist('_worker.js')) {
  fail('dist/_worker.js 缺失：/api/* 会退化为 405，卡密校验将完全失效');
} else {
  const w = read(join(dist, '_worker.js'));
  if (w.includes('/api/verify-key')) ok('_worker.js 含 /api/verify-key 路由');
  else fail('_worker.js 未包含 /api/verify-key 路由（前端会降级本机模式）');

  if (/export\s+default/.test(w)) ok('_worker.js 含 export default 入口');
  else fail('_worker.js 缺少 export default，不是合法的 Pages Worker');

  if (/env\.ASSETS/.test(w)) ok('_worker.js 保留静态资产透传');
  else warn('_worker.js 未引用 env.ASSETS，静态资源可能无法访问');
}

// ---------- 3. 卡密清单 ----------
if (!inDist('access-keys.json')) {
  fail('dist/access-keys.json 缺失：所有卡密将无法校验');
} else {
  const raw = read(join(dist, 'access-keys.json'));
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) {
      fail('access-keys.json 不是数组');
    } else if (list.length === 0) {
      fail('access-keys.json 为空数组，所有卡密将失效');
    } else {
      const bad = list.filter(
        (k) => !k || typeof k.hash !== 'string' || !/^[0-9a-f]{64}$/.test(k.hash),
      );
      if (bad.length) fail(`access-keys.json 有 ${bad.length} 条记录缺少合法的 sha256 hash`);
      else ok(`access-keys.json 含 ${list.length} 条合法卡密记录`);
    }
  } catch (e) {
    fail(`access-keys.json 不是合法 JSON：${e.message}`);
  }
}

// ---------- 4. 前端资源分片 ----------
const assetsDir = join(dist, 'assets');
if (!existsSync(assetsDir)) {
  fail('dist/assets 目录缺失：前端脚本/样式未产出');
} else {
  ok('dist/assets 目录存在');
}

// ---------- 5. 关键产物不全时的假存活提示 ----------
if (!inDist('access-keys.json') || !inDist('_worker.js')) {
  warn('关键产物不全，Pages 端可能出现「首页正常但功能失灵」的假存活');
}

// ---------- 输出 ----------
console.log(`\n构建产物校验：${dist}\n`);
for (const m of passed) console.log(`  OK    ${m}`);
for (const m of warnings) console.log(`  WARN  ${m}`);
for (const m of errors) console.log(`  FAIL  ${m}`);

if (errors.length) {
  console.error(`\n[FAILED] ${errors.length} 项致命问题、${warnings.length} 项警告。不应部署。\n`);
  process.exit(1);
}
console.log(`\n[PASSED] ${passed.length} 项通过、${warnings.length} 项警告。\n`);
