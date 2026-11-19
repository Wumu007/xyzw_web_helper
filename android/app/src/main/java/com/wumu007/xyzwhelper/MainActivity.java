package com.wumu007.xyzwhelper;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 快乐咸鱼 - 安卓壳应用
 *
 * 架构：WebView 加载线上网页版（同源复用全部处理流程），原生层提供：
 *  1. 启动引导：通过密钥验证且无 Token 时才弹出「导入 BIN 文件」引导卡片
 *     （保证进入应用时首个弹窗是网页内的密钥验证界面）
 *  2. 文件选择桥接：网页版 BIN 上传组件 ↔ 系统文件选择器（SAF）
 *  3. 底部一键执行快捷栏：日常任务 / 批量日常 / 游戏功能 / 备份恢复
 *  4. 加载进度条、主框架错误重试
 *  5. 下载双通道：
 *     - http(s) 下载 → 系统 DownloadManager（无需存储权限）
 *     - 网页内 blob/data 导出（如「导出长图」）→ JS 钩子捕获 → 原生写入
 *       公共下载目录（Android 10+ MediaStore 免权限；9 及以下需运行时授权）
 */
public class MainActivity extends AppCompatActivity {

    /** 网页版地址；如后续绑定自定义域名，仅需修改此处 */
    private static final String BASE_URL = "https://xyzw-web-helper-2dx.pages.dev";

    private static final String URL_HOME = BASE_URL + "/";
    private static final String URL_BIN_IMPORT = BASE_URL + "/TokenImport/bin";

    private static final int REQ_WRITE_STORAGE = 1001;

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

    /** 运行时权限被拒前的暂存导出任务 */
    private String pendingMime;
    private String pendingName;
    private byte[] pendingBytes;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService saveExecutor = Executors.newSingleThreadExecutor();

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
        s.setUseWideViewPort(true);        // 遵循页面 viewport meta，按手机屏宽渲染
        s.setTextZoom(100);                // 固定文字缩放：避免系统大字号把布局撑出横向滚动
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER); // 消除边缘横滑回弹

        // 网页内 blob/data 导出桥接（导出长图、导出配置等）
        webView.addJavascriptInterface(new DownloadBridge(), "AndroidBridge");

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

                installDownloadHook(view);

                String path = Uri.parse(url).getPath();
                boolean looksLikeNoToken =
                        "/".equals(path) || "/tokens".equals(path);

                // 冷启动且落在首页/Token页：先检查网页内密钥门禁是否已通过
                // （localStorage 有 xyzw_access_record 才算通过），只有通过后
                // 且本地无 Token 才弹原生导入引导——保证首个弹窗是密钥验证界面
                if (!onboardingShownThisSession && looksLikeNoToken) {
                    onboardingShownThisSession = true;
                    final WebView wv = view;
                    wv.evaluateJavascript(
                            "(function(){try{return localStorage.getItem('xyzw_access_record')?'1':'0';}catch(e){return '0';}})()",
                            value -> {
                                if (value != null && value.contains("1")
                                        && !isFinishing()) {
                                    onboardingOverlay.setVisibility(View.VISIBLE);
                                }
                            });
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

        // 网页版 http(s) 链接下载 → 系统 DownloadManager（无需存储权限）
        webView.setDownloadListener((url, userAgent, contentDisposition,
                                    mimeType, contentLength) -> {
            if (url == null || url.startsWith("blob:") || url.startsWith("data:")) {
                return; // blob/data 由 JS 钩子 → DownloadBridge 处理
            }
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
    // blob/data 导出捕获：点击 a[download] 时把文件内容转 base64 交给原生
    // ------------------------------------------------------------------
    private void installDownloadHook(WebView view) {
        view.evaluateJavascript(
                "(function(){"
                        + "if(window.__klDlHook){return;}window.__klDlHook=1;"
                        + "document.addEventListener('click',function(e){"
                        + "var t=e.target;var a=null;"
                        + "while(t&&t!==document){if(t.tagName==='A'&&t.getAttribute('download')!==null){a=t;break;}t=t.parentNode;}"
                        + "if(!a){return;}"
                        + "var href=a.getAttribute('href')||'';"
                        + "if(href.indexOf('blob:')===0){"
                        + "e.preventDefault();e.stopPropagation();"
                        + "fetch(href).then(function(r){return r.blob();}).then(function(b){"
                        + "var fr=new FileReader();"
                        + "fr.onload=function(){try{window.AndroidBridge.saveBase64(b.type||'application/octet-stream',a.getAttribute('download')||'',String(fr.result).split(',').pop());}catch(err){}};"
                        + "fr.readAsDataURL(b);"
                        + "}).catch(function(){});"
                        + "}else if(href.indexOf('data:')===0){"
                        + "e.preventDefault();e.stopPropagation();"
                        + "var comma=href.indexOf(',');"
                        + "var mime='application/octet-stream';"
                        + "try{mime=href.slice(5,comma).split(';')[0]||mime;}catch(err){}"
                        + "try{window.AndroidBridge.saveBase64(mime,a.getAttribute('download')||'',href.slice(comma+1));}catch(err){}"
                        + "}"
                        + "},true);"
                        + "})()",
                null);
    }

    // ------------------------------------------------------------------
    // 导出保存：Android 10+ 走 MediaStore（免权限），9 及以下写公共目录（需运行时权限）
    // ------------------------------------------------------------------
    private class DownloadBridge {
        @JavascriptInterface
        public void saveBase64(String mime, String name, String base64) {
            if (TextUtils.isEmpty(base64)) {
                return;
            }
            final byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                return;
            }
            final String m = TextUtils.isEmpty(mime) ? "application/octet-stream" : mime;
            final String n = sanitizeName(name, m);
            saveExecutor.execute(() -> saveDownload(m, n, bytes));
        }
    }

    private String sanitizeName(String name, String mime) {
        String n = (name == null ? "" : name.trim())
                .replaceAll("[\\\\/:*?\"<>|]", "_");
        if (TextUtils.isEmpty(n)) {
            n = "export-" + System.currentTimeMillis() + extFor(mime);
        } else if (!n.contains(".")) {
            n = n + extFor(mime);
        }
        return n;
    }

    private String extFor(String mime) {
        if (mime == null) return ".bin";
        switch (mime) {
            case "image/png": return ".png";
            case "image/jpeg": return ".jpg";
            case "image/webp": return ".webp";
            case "application/json": return ".json";
            case "application/pdf": return ".pdf";
            case "application/zip": return ".zip";
            case "text/plain": return ".txt";
            case "text/csv": return ".csv";
            default: return ".bin";
        }
    }

    private void saveDownload(String mime, String name, byte[] bytes) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            writeViaMediaStore(mime, name, bytes);
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED) {
            writeLegacy(name, bytes);
        } else {
            // 暂存任务，授权后自动续写
            pendingMime = mime;
            pendingName = name;
            pendingBytes = bytes;
            mainHandler.post(() -> androidx.core.app.ActivityCompat
                    .requestPermissions(this,
                            new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                            REQ_WRITE_STORAGE));
        }
    }

    private void writeViaMediaStore(String mime, String name, byte[] bytes) {
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) {
                toastOnUiThread("导出失败：无法创建下载文件");
                return;
            }
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new IllegalStateException("output stream null");
                os.write(bytes);
                os.flush();
            }
            toastOnUiThread("已保存到「下载」：" + name);
        } catch (Exception e) {
            toastOnUiThread("导出失败：" + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void writeLegacy(String name, byte[] bytes) {
        try {
            File dir = Environment
                    .getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (dir != null && !dir.exists()) {
                dir.mkdirs();
            }
            File f = new File(dir, name);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(bytes);
                fos.flush();
            }
            toastOnUiThread("已保存到「下载」：" + name);
        } catch (Exception e) {
            toastOnUiThread("导出失败：" + e.getMessage());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode,
                                           String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WRITE_STORAGE
                && grantResults != null
                && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && pendingBytes != null) {
            final String m = pendingMime, n = pendingName;
            final byte[] b = pendingBytes;
            pendingMime = null;
            pendingName = null;
            pendingBytes = null;
            saveExecutor.execute(() -> writeLegacy(n, b));
        } else if (requestCode == REQ_WRITE_STORAGE) {
            pendingMime = null;
            pendingName = null;
            pendingBytes = null;
            toast("未授权存储权限，导出已取消");
        }
    }

    private void toastOnUiThread(String msg) {
        mainHandler.post(() -> toast(msg));
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
        final Runnable[] poll = new Runnable[1];
        poll[0] = () -> webView.evaluateJavascript(
                "(function(){"
                        + "var i=document.querySelector('input[type=file]');"
                        + "if(!i){return 'wait';}"
                        + "var t=i.closest('.ant-upload')||i.closest('.n-upload')||i.parentElement||i;"
                        + "t.style.outline='3px solid #007AFF';"
                        + "t.style.outlineOffset='2px';"
                        + "t.style.borderRadius='12px';"
                        + "try{t.scrollIntoView({block:'center',behavior:'smooth'});}catch(e){}"
                        + "return 'ok';"
                        + "})()",
                value -> {
                    if (value != null && value.contains("wait") && attempts[0] < 6) {
                        attempts[0]++;
                        mainHandler.postDelayed(poll[0], 700);
                    }
                });
        mainHandler.postDelayed(poll[0], 500);
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
        saveExecutor.shutdownNow();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
