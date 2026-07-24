/*
 * update-check.js — vérification de mise à jour via le flux Atom des releases GitHub.
 * Plus fiable que l'API REST : pas de rate-limit, pas de token, CDN GitHub.
 *
 * Config (dans index.html, avant ce script) :
 *   window.UPDATE_REPO = 'owner/repo';   // obligatoire
 *
 * window.APP_VERSION est lu depuis app.js (window.APP_VERSION = APP_VERSION).
 * Anti-spam : 1 requête / 6 h. Mémorise la version ignorée. Échec silencieux.
 */
(function () {
  'use strict';
  var REPO = window.UPDATE_REPO;
  var CURRENT = window.APP_VERSION;
  if (!REPO || !CURRENT) return;

  var POLL_INTERVAL = 6 * 3600 * 1000;
  var KEY_POLL    = 'updPoll:'    + REPO;
  var KEY_DISMISS = 'updDismiss:' + REPO;

  function ls(get, k, v) {
    try { return get ? localStorage.getItem(k) : localStorage.setItem(k, v); }
    catch (e) { return null; }
  }

  function cmp(va, vb) {
    var a = String(va).replace(/^v/, '').split('.');
    var b = String(vb).replace(/^v/, '').split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var d = (parseInt(a[i], 10) || 0) - (parseInt(b[i], 10) || 0);
      if (d) return d;
    }
    return 0;
  }

  var last = parseInt(ls(true, KEY_POLL), 10) || 0;
  if (Date.now() - last < POLL_INTERVAL) return;

  // Flux Atom GitHub releases — format stable, sans auth, sans rate-limit
  fetch('https://github.com/' + REPO + '/releases.atom', {
    headers: { Accept: 'application/atom+xml,application/xml,text/xml' }
  })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (xml) {
      if (!xml) return;
      ls(false, KEY_POLL, Date.now());

      // Extrait le tag depuis l'<id> de la première <entry> :
      // <id>tag:github.com,2008:Repository/123/v2.35</id>
      var m = xml.match(/<entry>[\s\S]*?<id>[^<]*\/([^/<]+)<\/id>/);
      if (!m) return;
      var latest = m[1].replace(/^v/, '').trim();
      if (!latest || cmp(latest, CURRENT) <= 0) return;
      if (ls(true, KEY_DISMISS) === latest) return;

      // URL de l'APK dérivée du numéro de version (pattern constant dans ce repo)
      var repoName = REPO.split('/')[1];
      var apkUrl = 'https://github.com/' + REPO +
                   '/releases/download/v' + latest +
                   '/' + repoName + '-' + latest + '.apk';

      showBanner(latest, apkUrl);
    })
    .catch(function () { /* hors-ligne : silencieux */ });

  function showBanner(version, url) {
    if (document.getElementById('update-banner')) return;
    var css = document.createElement('style');
    css.textContent =
      '#update-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
      'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:14px;' +
      'background:#1f2937;color:#f9fafb;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
      'font:500 14px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'max-width:520px;margin:0 auto}' +
      '#update-banner .ub-txt{flex:1;min-width:0}' +
      '#update-banner b{color:#fff}' +
      '#update-banner a.ub-act,#update-banner button.ub-act{flex:none;background:#22c55e;' +
      'color:#06210f;text-decoration:none;border:0;font-weight:700;font-size:14px;' +
      'padding:8px 14px;border-radius:10px;cursor:pointer}' +
      '#update-banner button.ub-x{flex:none;background:transparent;border:0;color:#9ca3af;' +
      'font-size:18px;line-height:1;cursor:pointer;padding:4px}';
    document.head.appendChild(css);

    var b = document.createElement('div');
    b.id = 'update-banner';
    var txt = document.createElement('span');
    txt.className = 'ub-txt';
    txt.innerHTML = '🔄 Nouvelle version <b>v' + version + '</b> disponible';

    var canInstall = typeof window.installApkUpdate === 'function' &&
      window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.UpdatePlugin;
    var act;
    if (canInstall) {
      act = document.createElement('button');
      act.className = 'ub-act';
      act.textContent = '⬇ Installer';
      act.onclick = function () {
        act.disabled = true; act.textContent = '⏳ Installation…';
        window.installApkUpdate(url, act, function () {
          act.disabled = false; act.textContent = '⬇ Installer';
        });
      };
    } else {
      act = document.createElement('a');
      act.className = 'ub-act';
      act.href = url; act.target = '_blank'; act.rel = 'noopener';
      act.textContent = 'Télécharger';
    }

    var x = document.createElement('button');
    x.className = 'ub-x';
    x.setAttribute('aria-label', 'Ignorer'); x.textContent = '✕';
    x.onclick = function () { ls(false, KEY_DISMISS, version); b.remove(); };
    b.appendChild(txt); b.appendChild(act); b.appendChild(x);
    (document.body || document.documentElement).appendChild(b);
  }
})();
