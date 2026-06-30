package com.laurent.quizlangue;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    private static final String KEY_ALIAS  = "quizlangue_creds_key";
    private static final String PREFS_NAME = "quizlangue_secure";
    private static final String PREF_CREDS = "cafeyn_creds";

    /* ── Android Keystore AES-GCM ──────────────────────────────────────── */

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return kg.generateKey();
    }

    private void saveEncryptedCreds(Context ctx, String email, String pass) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] plain = (email + "\0" + pass).getBytes(StandardCharsets.UTF_8);
            byte[] enc = cipher.doFinal(plain);
            byte[] combined = new byte[iv.length + enc.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(enc, 0, combined, iv.length, enc.length);
            ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
               .edit()
               .putString(PREF_CREDS, Base64.encodeToString(combined, Base64.NO_WRAP))
               .apply();
        } catch (Exception ignored) {}
    }

    private String[] loadDecryptedCreds(Context ctx) {
        String stored = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_CREDS, null);
        if (stored == null) return null;
        try {
            byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
            byte[] iv  = Arrays.copyOf(combined, 12);
            byte[] enc = Arrays.copyOfRange(combined, 12, combined.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
            String plain = new String(cipher.doFinal(enc), StandardCharsets.UTF_8);
            String[] parts = plain.split("\0", 2);
            return parts.length == 2 ? parts : null;
        } catch (Exception e) {
            return null;
        }
    }

    /* ── Biométrie ─────────────────────────────────────────────────────── */

    @PluginMethod
    public void authenticate(PluginCall call) {
        String reason = call.getString("reason", "Accès à votre magazine");
        FragmentActivity activity = getActivity();
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("📖 Magazine")
            .setSubtitle(reason)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build();
        BiometricPrompt prompt = new BiometricPrompt(activity,
            ContextCompat.getMainExecutor(activity),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    call.resolve();
                }
                @Override
                public void onAuthenticationError(int code, CharSequence msg) {
                    call.reject("auth_error", msg.toString());
                }
                @Override
                public void onAuthenticationFailed() { /* l'utilisateur réessaie */ }
            });
        activity.runOnUiThread(() -> prompt.authenticate(promptInfo));
    }

    /* ── WebView in-app ─────────────────────────────────────────────────── */

    @PluginMethod
    public void openInAppWebView(PluginCall call) {
        String url      = call.getString("url", "https://www.cafeyn.co");
        String title    = call.getString("title", "Magazine");
        int barColor    = Color.parseColor(call.getString("barColor", "#7B3F00"));

        Context ctx = getContext();
        String[] savedCreds = loadDecryptedCreds(ctx);

        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

            // --- Barre du haut ---
            LinearLayout topBar = new LinearLayout(activity);
            topBar.setOrientation(LinearLayout.HORIZONTAL);
            topBar.setBackgroundColor(barColor);
            int dp8 = dp(activity, 8);
            topBar.setPadding(dp8 * 2, dp8, dp8, dp8);

            TextView titleView = new TextView(activity);
            titleView.setText(title);
            titleView.setTextColor(Color.WHITE);
            titleView.setTextSize(16);
            titleView.setTypeface(null, android.graphics.Typeface.BOLD);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            tp.gravity = android.view.Gravity.CENTER_VERTICAL;
            titleView.setLayoutParams(tp);

            ImageButton closeBtn = new ImageButton(activity);
            closeBtn.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
            closeBtn.setBackgroundColor(Color.TRANSPARENT);
            closeBtn.setColorFilter(Color.WHITE);
            closeBtn.setOnClickListener(v -> dialog.dismiss());

            topBar.addView(titleView);
            topBar.addView(closeBtn);

            // --- Cookies ---
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);

            // --- WebView ---
            WebView webView = new WebView(activity);
            cm.setAcceptThirdPartyCookies(webView, true);

            WebSettings ws = webView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setLoadWithOverviewMode(true);
            ws.setUseWideViewPort(true);
            ws.setBuiltInZoomControls(false);
            ws.setSupportZoom(false);
            ws.setUserAgentString("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

            // Suivi de navigation pour gérer la redirection post-login de Cafeyn
            final boolean[] wasOnAuthPage   = {false};
            final boolean[] targetReached   = {false};

            // JavascriptInterface pour capturer les identifiants saisis
            webView.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void onCredentials(String email, String pass) {
                    if (email != null && !email.isEmpty() && pass != null && !pass.isEmpty()) {
                        saveEncryptedCreds(ctx, email, pass);
                    }
                }
            }, "QuizLangue");

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    return false; // tout reste dans la WebView
                }

                @Override
                public void onPageFinished(WebView view, String pageUrl) {
                    if (pageUrl.startsWith(url)) {
                        // On est arrivé sur le magazine cible
                        targetReached[0] = true;
                    } else if (pageUrl.contains("/login") || pageUrl.contains("/signin")
                            || pageUrl.contains("/connexion") || pageUrl.contains("/auth")
                            || pageUrl.contains("/sso")) {
                        // Page d'authentification Cafeyn
                        wasOnAuthPage[0] = true;
                    } else if (wasOnAuthPage[0] && !targetReached[0]) {
                        // Redirection post-login vers l'accueil — on repart vers le magazine
                        wasOnAuthPage[0] = false;
                        view.loadUrl(url);
                        return;
                    }

                    // Pré-remplir les identifiants si disponibles
                    if (savedCreds != null) {
                        String email = savedCreds[0].replace("'", "\\'");
                        String pass  = savedCreds[1].replace("'", "\\'");
                        String js =
                            "(function(){"
                            + "var emailInput = document.querySelector('input[type=\"email\"],input[name*=\"email\"],input[id*=\"email\"],input[autocomplete=\"email\"],input[autocomplete=\"username\"]');"
                            + "var passInput  = document.querySelector('input[type=\"password\"]');"
                            + "if(emailInput && passInput && !emailInput.value){"
                            + "  emailInput.value='" + email + "';"
                            + "  passInput.value='"  + pass  + "';"
                            + "  ['input','change'].forEach(function(ev){"
                            + "    emailInput.dispatchEvent(new Event(ev,{bubbles:true}));"
                            + "    passInput.dispatchEvent(new Event(ev,{bubbles:true}));"
                            + "  });"
                            + "}"
                            + "})();";
                        view.evaluateJavascript(js, null);
                    }

                    // Intercepter la soumission du formulaire de connexion pour sauvegarder les identifiants
                    String captureJs =
                        "(function(){"
                        + "if(window._quizlangue_capture) return;"
                        + "window._quizlangue_capture=true;"
                        + "document.addEventListener('submit',function(e){"
                        + "  var f=e.target;"
                        + "  var em=f.querySelector('input[type=\"email\"],input[name*=\"email\"],input[id*=\"email\"],input[autocomplete=\"email\"],input[autocomplete=\"username\"]');"
                        + "  var pw=f.querySelector('input[type=\"password\"]');"
                        + "  if(em&&pw&&em.value&&pw.value){"
                        + "    try{QuizLangue.onCredentials(em.value,pw.value);}catch(ex){}"
                        + "  }"
                        + "},true);"
                        + "})();";
                    view.evaluateJavascript(captureJs, null);
                }
            });
            webView.loadUrl(url);

            // bouton retour Android navigue dans la WebView
            dialog.setOnKeyListener((d, keyCode, event) -> {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                    if (webView.canGoBack()) { webView.goBack(); return true; }
                    dialog.dismiss(); return true;
                }
                return false;
            });

            // Persister les cookies + renvoyer la dernière URL lue à la fermeture
            dialog.setOnDismissListener(d -> {
                String last = null;
                try { last = webView.getUrl(); } catch (Exception ignored) {}
                cm.flush();
                webView.destroy();
                JSObject ret = new JSObject();
                if (last != null) ret.put("lastUrl", last);
                call.resolve(ret);
            });

            // --- Mise en page ---
            LinearLayout root = new LinearLayout(activity);
            root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams wvParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
            webView.setLayoutParams(wvParams);
            root.addView(topBar);
            root.addView(webView);

            dialog.setContentView(root);
            dialog.show();
            // call.resolve() est différé : il est appelé à la fermeture (setOnDismissListener)
            // avec la dernière URL lue, pour reprendre la lecture au prochain lancement.
        });
    }

    private int dp(Context ctx, int dp) {
        return Math.round(dp * ctx.getResources().getDisplayMetrics().density);
    }

    /* ── Mise à jour APK ────────────────────────────────────────────────── */

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String apkUrl = call.getString("url");
        if (apkUrl == null || apkUrl.isEmpty()) {
            call.reject("URL manquante");
            return;
        }

        Context ctx = getContext();
        File apkFile = new File(ctx.getCacheDir(), "quizlangue-update.apk");
        final String finalUrl = apkUrl;

        new Thread(() -> {
            try {
                downloadFile(finalUrl, apkFile);
                getActivity().runOnUiThread(() -> {
                    installApk(ctx, apkFile);
                    call.resolve();
                });
            } catch (Exception e) {
                call.reject("Erreur de téléchargement : " + e.getMessage());
            }
        }).start();
    }

    private void downloadFile(String urlStr, File dest) throws IOException {
        URL url = new URL(urlStr);
        int maxRedirects = 5;
        HttpURLConnection conn = null;
        while (maxRedirects-- > 0) {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(90_000);
            conn.connect();
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                url = new URL(location);
            } else {
                break;
            }
        }
        if (conn == null) throw new IOException("Connexion impossible");
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16_384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private void installApk(Context ctx, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            ctx, ctx.getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.startActivity(intent);
    }
}
