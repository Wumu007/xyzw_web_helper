import naive from "naive-ui";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router";
import { ensureGameEngine, isGameEngineReady } from "./utils/gameEngine";
import "@arco-design/web-vue/dist/arco.css";
import "virtual:uno.css";
import "./assets/styles/global.scss";
import "./assets/styles/mobile.scss";

// 创建应用实例
const app = createApp(App);

// 使用插件
app.use(createPinia());
app.use(router);
app.use(naive);

// Token 导入页依赖游戏引擎里的加密模块（cocos2d + xh SDK，约 4MB）。
// 进该路由前预加载一次：首次约一两秒，之后走浏览器缓存。
// 放在路由守卫而不是入口，是为了让首页 / 后台不必为它买单。
router.beforeEach(async (to) => {
  const path = String(to.path || "");
  const wantsEngine =
    to.name === "TokenImport" || path === "/tokens" || path.startsWith("/tokens/");
  if (!wantsEngine || isGameEngineReady()) return true;

  document.body.style.cursor = "progress";
  try {
    await ensureGameEngine();
  } catch (err) {
    // 不阻断导航：组件里会给出「游戏加密模块未加载」的明确提示
    console.warn("[gameEngine]", err?.message || err);
  } finally {
    document.body.style.cursor = "";
  }
  return true;
});

// 全局主题应用：从 localStorage 读取并设置 data-theme 属性
const applyTheme = () => {
  const saved = localStorage.getItem("theme") || "auto";
  if (saved === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else if (saved === "light") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    const prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark)
      document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");

    // 跟随系统变更
    if (window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", (e) => {
          const t = localStorage.getItem("theme") || "auto";
          if (t === "auto") {
            if (e.matches)
              document.documentElement.setAttribute("data-theme", "dark");
            else document.documentElement.removeAttribute("data-theme");
          }
        });
    }
  }
};

applyTheme();

// 挂载应用
app.mount("#app");
