/**
 * 游戏引擎按需加载
 *
 * 背景：`src/xyzw/` 下是 cocos2d 引擎 + xh SDK 打包，合计约 4MB。
 * 它们原本由 index.html 无条件加载（<script type="module" src="/src/xyzw/*">），
 * 结果每个打开首页的人都先下载并解析 4MB —— 压缩后仍有 1.3MB、国内实测 4 秒以上。
 *
 * 实际只有「Token 导入」页要用到：那里的登录凭据靠
 * `window.__require("13")`（@o4e/bon + lz4js 封装的加密模块）生成。
 * 所以改成进入该页时才注入。
 *
 * 用 `?url` 让 Vite 把这三个文件当静态资源原样输出（不参与打包与 tree-shaking），
 * 运行时再按需插入 <script>，避免它们被合并进主包。
 *
 * 注意加载顺序：cocos2d-js-min.js 提供 window.cc，index.js 内部会读它，
 * 必须串行，不能并发。
 */

import cocosUrl from "@/xyzw/cocos2d-js-min.js?url";
import definesUrl from "@/xyzw/game-defines.js?url";
import engineUrl from "@/xyzw/index.js?url";

const SCRIPTS = [cocosUrl, definesUrl, engineUrl];

let loading = null;

/** 引擎是否已就绪（以 __require 出现为准） */
export function isGameEngineReady() {
  return (
    typeof window !== "undefined" && typeof window.__require === "function"
  );
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false; // 保序执行
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      reject(new Error(`游戏引擎加载失败：${src}`));
    };
    document.head.appendChild(el);
  });
}

/**
 * 确保引擎已加载。
 * 并发调用共享同一个 Promise；失败时清空缓存以便下次重试。
 * @returns {Promise<true>}
 */
export function ensureGameEngine() {
  if (typeof window === "undefined") return Promise.resolve(true);
  if (isGameEngineReady()) return Promise.resolve(true);
  if (loading) return loading;

  loading = (async () => {
    for (const src of SCRIPTS) {
      // 若前面某个脚本已带出 __require，就无需再加载后续
      if (src === engineUrl && isGameEngineReady()) break;
      await injectScript(src);
    }
    if (!isGameEngineReady()) {
      throw new Error("游戏引擎已加载，但加密模块不可用");
    }
    return true;
  })().catch((err) => {
    loading = null;
    throw err;
  });

  return loading;
}
