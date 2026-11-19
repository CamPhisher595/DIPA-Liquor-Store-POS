package com.dealer.pos

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var firebaseAuthDomain: String
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingEmailLink: String? = null
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        firebaseAuthDomain = assets.open("firebase-config.json").bufferedReader().use {
            JSONObject(it.readText()).getString("authDomain")
        }
        pendingEmailLink = validFirebaseEmailLink(intent?.data)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.rgb(244, 241, 251)
        window.navigationBarColor = Color.rgb(244, 241, 251)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR

        webView = WebView(this).apply {
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            addJavascriptInterface(AndroidFileBridge(), "AndroidFileBridge")
            webViewClient = PosWebViewClient()
            webChromeClient = PosWebChromeClient()
        }

        setContentView(webView)
        webView.loadUrl("$APP_ASSET_ORIGIN/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingEmailLink = validFirebaseEmailLink(intent.data)
        dispatchPendingEmailLink()
    }

    @Deprecated("Use system back navigation on newer Android versions")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return

        val result = when {
            resultCode != RESULT_OK -> null
            data?.clipData != null -> Array(data.clipData!!.itemCount) { index ->
                data.clipData!!.getItemAt(index).uri
            }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileChooserCallback?.onReceiveValue(result)
        fileChooserCallback = null
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == STORAGE_PERMISSION_REQUEST &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        ) {
            Toast.makeText(this, "Storage access granted. Please export again.", Toast.LENGTH_SHORT).show()
        }
    }

    private inner class PosWebChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView?,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = callback
            val acceptedTypes = params.acceptTypes
                .flatMap { it.split(",") }
                .map { it.trim() }
                .filter { it.isNotEmpty() && it != "*/*" }

            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = when {
                    acceptedTypes.size == 1 -> acceptedTypes.first()
                    else -> "*/*"
                }
                if (acceptedTypes.size > 1) {
                    putExtra(Intent.EXTRA_MIME_TYPES, acceptedTypes.toTypedArray())
                }
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            }

            return try {
                startActivityForResult(Intent.createChooser(intent, "Choose a file"), FILE_CHOOSER_REQUEST)
                true
            } catch (error: Exception) {
                Log.e(TAG, "Could not open the file picker", error)
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = null
                false
            }
        }
    }

    private inner class PosWebViewClient : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            dispatchPendingEmailLink()
        }

        override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest
        ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.host == APP_ASSET_HOST && uri.scheme == "https") return false

            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                true
            } catch (error: Exception) {
                Log.w(TAG, "No app can open the requested link", error)
                true
            }
        }
    }

    private fun validFirebaseEmailLink(uri: Uri?): String? {
        if (uri == null || uri.scheme != "https" || uri.host != firebaseAuthDomain ||
            !uri.path.orEmpty().startsWith("/__/auth/links")
        ) {
            return null
        }
        return uri.toString()
    }

    private fun dispatchPendingEmailLink() {
        val link = pendingEmailLink ?: return
        if (!::webView.isInitialized) return
        pendingEmailLink = null
        webView.evaluateJavascript(
            "window.pendingFirebaseEmailLink = ${JSONObject.quote(link)};" +
                "if (typeof window.handleFirebaseEmailLink === 'function') {" +
                "const pendingLink = window.pendingFirebaseEmailLink;" +
                "window.pendingFirebaseEmailLink = '';" +
                "window.handleFirebaseEmailLink(pendingLink);" +
                "}",
            null
        )
    }

    private inner class AndroidFileBridge {
        @JavascriptInterface
        fun getAppVersionCode(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageManager.getPackageInfo(packageName, 0).longVersionCode.toInt()
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(packageName, 0).versionCode
        }

        @JavascriptInterface
        fun isAndroidApp(): Boolean = true

        @JavascriptInterface
        fun openExternalUrl(url: String): Boolean {
            val uri = Uri.parse(url)
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || !uri.userInfo.isNullOrBlank()) {
                return false
            }
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                true
            } catch (error: Exception) {
                Log.w(TAG, "Could not open external URL", error)
                false
            }
        }

        @JavascriptInterface
        fun saveFile(filename: String, mimeType: String, base64Data: String): String {
            return try {
                val safeName = filename.substringAfterLast('/').substringAfterLast('\\')
                    .replace(Regex("[^A-Za-z0-9._-]"), "_")
                    .ifBlank { "DIPA_export" }
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: return "error"
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                        ?: return "error"
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        runOnUiThread {
                            requestPermissions(
                                arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
                                STORAGE_PERMISSION_REQUEST
                            )
                        }
                        return "permission"
                    }
                    val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!downloads.exists() && !downloads.mkdirs()) return "error"
                    File(downloads, safeName).writeBytes(bytes)
                }
                "saved"
            } catch (error: Exception) {
                Log.e(TAG, "Could not save exported file", error)
                "error"
            }
        }
    }

    companion object {
        private const val TAG = "DipaPos"
        private const val APP_ASSET_HOST = "appassets.androidplatform.net"
        private const val APP_ASSET_ORIGIN = "https://$APP_ASSET_HOST"
        private const val FILE_CHOOSER_REQUEST = 1001
        private const val STORAGE_PERMISSION_REQUEST = 1002
    }
}
