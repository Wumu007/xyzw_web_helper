package com.wumu007.xyzwhelper;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

/**
 * 咸鱼之王助手 - 安卓壳应用
 *
 * 架构：WebView 加载线上网页版（同源复用全部处理流程），原生层提供：
 *  1. 启动引导：无 Token 时自动弹出「导入 BIN 文件」引导卡片
 *  2. 文件选择桥接：网页版 BIN 上传组件 ↔ 系统文件选择器（SAF）
 *  3. 底部一键执行快捷栏：日常任务 / 批量日常 / 游戏功能 / 备份恢复
 *  4. 加载进度条、主框架错误重试、备份文件下载（DownloadManager）
 */
public class MainActivity extends AppCompatActivity {

    /** 网页版地址；如后续绑定自定义域名，仅需修改此处 */
    private static final String BASE_URL = "https://xyzw-web-helper-2dx.pages.dev";

    private static final String URL_HOME = BASE_URL + "/";
    private static final String URL_BIN_IMPORT = BASE_URL + "/TokenImport/bin";

    private WebView webView;
    private ProgressBar progressBar;
    private View onboardingOverlay;
    private View errorOverlay;

    /** 本次会话是否已展示过启动引导（只在冷启动且无 Token 时出现一次） */
    private boolean onboardingShownThisSession = false;
    /** 是否由原生发起的 BIN 导入导航（加载完成后高亮上传区域并提示） */
    private boolean pendingBinHighlight = false;

    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        onboardingOverlay = findViewById(R.id.onboarding_overlay);
        errorOverlay = findViewById(R.id.error_overlay);
        Button retryButton = findViewById(R.id.btn_retry);
        Button btnImportBin = findViewById(R.id.btn_import_bin);
        Button btnLater = findViewById(R.id.btn_later);

        setupWebView();
        setupQuickBar();
        setupFileChooserLauncher();

        btnImportBin.setOnClickListener(v -> startBinImport());
        btnLater.setOnClickListener(v -> dismissOnboarding());
        retryButton.setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            webView.reload();
        });

        if (savedInstanceState != null) {
            // 恢复场景：不重复弹引导
            onboardingShownThisSession = true;
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(BASE_URL);
        }
    }

    // ------------------------------------------------------------------
    // WebView 初始化：复用网页版全部逻辑（JS / DOM storage / IndexedDB）
    // ------------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage
        s.setDatabaseEnabled(true);        // IndexedDB（Token / BIN 凭据存储）
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // 站内路由继续用 WebView；外部链接交给系统浏览器
                if ("https".equals(uri.getScheme())
                        && uri.getHost() != null
                        && uri.getHost().endsWith("xyzw-web-helper-2dx.pages.dev")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                errorOverlay.setVisibility(View.GONE);

                String path = Uri.parse(url).getPath();
                boolean looksLikeNoToken =
                        "/".equals(path) || "/tokens".equals(path);

                // 冷启动且落在首页/Token页 → 说明本地无 Token，弹出导入引导
                if (!onboardingShownThisSession && looksLikeNoToken) {
                    onboardingShownThisSession = true;
                    onboardingOverlay.setVisibility(View.VISIBLE);
                }

                if (pendingBinHighlight) {
                    pendingBinHighlight = false;
                    highlightBinUploadArea();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            // 网页版 BIN 上传组件（input[type=file]）→ 系统文件选择器
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 若有未完成的旧回调，先取消，避免后续选择器失效
                if (pendingFileChooserCallback != null) {
                    pendingFileChooserCallback.onReceiveValue(null);
                }
                pendingFileChooserCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                // bin/dmp 属于二进制流文件
                intent.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"application/octet-stream"});
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                fileChooserLauncher.launch(
                        Intent.createChooser(intent, "选择 BIN 文件"));
                return true;
            }
        });

        // 网页版「备份恢复」等导出文件 → 系统下载管理器
        webView.setDownloadListener((url, userAgent, contentDisposition,
                                    mimeType, contentLength) -> {
            try {
                DownloadManager.Request req =
                        new DownloadManager.Request(Uri.parse(url));
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) {
                    req.addRequestHeader("cookie", cookies);
                }
                if (userAgent != null) {
                    req.addRequestHeader("User-Agent", userAgent);
                }
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                String name = URLUtil.guessFileName(
                        url, contentDisposition, mimeType);
                req.setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm =
                        (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(req);
                    toast("已开始下载：" + name);
                }
            } catch (Exception e) {
                toast("下载失败：" + e.getMessage());
            }
        });
    }

    // ------------------------------------------------------------------
    // 底部一键执行快捷栏：与网页版路由一一对应
    // ------------------------------------------------------------------
    private void setupQuickBar() {
        bindNav(R.id.btn_home, URL_HOME);
        bindNav(R.id.btn_daily, BASE_URL + "/admin/daily-tasks");
        bindNav(R.id.btn_batch, BASE_URL + "/admin/batch-daily-tasks");
        bindNav(R.id.btn_features, BASE_URL + "/admin/game-features");
        bindNav(R.id.btn_backup, BASE_URL + "/admin/backup");
        findViewById(R.id.btn_bin).setOnClickListener(v -> startBinImport());
    }

    private void bindNav(int buttonId, String url) {
        Button b = findViewById(buttonId);
        if (b != null && b.getId() != R.id.btn_bin) {
            b.setOnClickListener(v -> {
                dismissOnboarding();
                webView.loadUrl(url);
            });
        }
    }

    // ------------------------------------------------------------------
    // BIN 导入流程
    // ------------------------------------------------------------------
    private void startBinImport() {
        dismissOnboarding();
        pendingBinHighlight = true;
        webView.loadUrl(URL_BIN_IMPORT);
        toast("进入 BIN 导入页后，请点击高亮的「上传」区域选择文件");
    }

    /**
     * 页面加载完成后，高亮 BIN 上传区域（受 WebView 安全策略限制，
     * 文件选择必须由用户真实点击触发，这里只做定位 + 提示）
     */
    private void highlightBinUploadArea() {
        final int[] attempts = {0};
        Runnable task = new Runnable() {
            @Override
            public void run() {
                attempts[0]++;
                webView.evaluateJavascript(
                        "(function(){"
                                + "var i=document.querySelector('input[type=file]');"
                                + "if(!i){return 'wait';}"
                                + "var t=i.closest('.ant-upload')||i.parentElement||i;"
                                + "t.style.outline='3px solid #007AFF';"
                                + "t.style.outlineOffset='2px';"
                                + "t.style.borderRadius='12px';"
                                + "try{t.scrollIntoView({block:'center',behavior:'smooth'});}catch(e){}"
                                + "return 'ok';"
                                + "})()",
                        value -> {
                            if (value != null && value.contains("wait")
                                    && attempts[0] < 6) {
                                mainHandler.postDelayed(this, 700);
                            }
                        });
            }
        };
        mainHandler.postDelayed(task, 500);
    }

    // ------------------------------------------------------------------
    // 系统文件选择器结果回传给网页版
    // ------------------------------------------------------------------
    private void setupFileChooserLauncher() {
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (pendingFileChooserCallback == null) {
                        return;
                    }
                    ValueCallback<Uri[]> cb = pendingFileChooserCallback;
                    pendingFileChooserCallback = null;
                    if (result.getResultCode() == RESULT_OK
                            && result.getData() != null) {
                        Uri[] uris = WebChromeClient.FileChooserParams
                                .parseResult(result.getResultCode(),
                                        result.getData());
                        // 兜底：多选场景从 ClipData 提取
                        if (uris == null && result.getData().getClipData() != null) {
                            ClipData clip = result.getData().getClipData();
                            uris = new Uri[clip.getItemCount()];
                            for (int i = 0; i < clip.getItemCount(); i++) {
                                uris[i] = clip.getItemAt(i).getUri();
                            }
                        }
                        cb.onReceiveValue(uris);
                    } else {
                        cb.onReceiveValue(null); // 用户取消，必须回调否则选择器卡死
                    }
                });
    }

    // ------------------------------------------------------------------
    // 其它
    // ------------------------------------------------------------------
    private void dismissOnboarding() {
        onboardingOverlay.setVisibility(View.GONE);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
