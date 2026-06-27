/*
 * update-check.js — vérification de mise à jour applicative (générique).
 * Interroge la dernière Release GitHub, compare au numéro embarqué et affiche
 * une bannière de téléchargement si une version plus récente est publiée.
 *
 * Config (dans index.html, avant ce script) :
 *   window.UPDATE_REPO = 'laurentsar/<repo>';   // obligatoire
 *   window.APP_VERSION = '1.2';                  // obligatoire (version installée)
 *
 * Autonome : aucune dépendance, styles injectés. Anti-spam : 1 requête / 6 h,
 * mémorise la version ignorée. Échec réseau silencieux.
 */
(function () {
  'use strict';
  var REPO = window.UPDATE_REPO;
  var CURRENT = window.APP_VERSION;
  if (!REPO || !CURRENT) return;

  var POLL_INTERVAL = 6 * 3600 * 1000; // 6 h
  var KEY_POLL = 'updPoll:' + REPO;
  var KEY_DISMISS = 'updDismiss:' + REPO;

  function ls(get, k, v) {
    try { return get ? localStorage.getItem(k) : localStorage.setItem(k, v); }
    catch (e) { return null; }
  }

  // Compare deux versions "a.b.c" → >0 si va plus récente que vb.
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

  // Cache-buster (_) : évite qu'un service worker "cache-first" serve une
  // réponse d'API périmée. GitHub ignore les paramètres inconnus.
  fetch('https://api.github.com/repos/' + REPO + '/releases/latest?_=' + Date.now(), {
    headers: { Accept: 'application/vnd.github+json' }
  })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.tag_name) return;
      ls(false, KEY_POLL, Date.now());
      var latest = String(rel.tag_name).replace(/^v/, '');
      if (cmp(latest, CURRENT) <= 0) return;          // déjà à jour
      if (ls(true, KEY_DISMISS) === latest) return;    // version déjà ignorée
      var apk = (rel.assets || []).filter(function (a) {
        return /\.apk$/i.test(a.name);
      })[0];
      showBanner(latest, apk ? apk.browser_download_url : rel.html_url);
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
      '#update-banner a{flex:none;background:#22c55e;color:#06210f;text-decoration:none;' +
      'font-weight:700;padding:8px 14px;border-radius:10px}' +
      '#update-banner button{flex:none;background:transparent;border:0;color:#9ca3af;' +
      'font-size:18px;line-height:1;cursor:pointer;padding:4px}';
    document.head.appendChild(css);

    var b = document.createElement('div');
    b.id = 'update-banner';
    var txt = document.createElement('span');
    txt.className = 'ub-txt';
    txt.innerHTML = '🔄 Nouvelle version <b>v' + version + '</b> disponible';
    var dl = document.createElement('a');
    dl.href = url; dl.target = '_blank'; dl.rel = 'noopener';
    dl.textContent = 'Télécharger';
    var x = document.createElement('button');
    x.setAttribute('aria-label', 'Ignorer'); x.textContent = '✕';
    x.onclick = function () { ls(false, KEY_DISMISS, version); b.remove(); };
    b.appendChild(txt); b.appendChild(dl); b.appendChild(x);
    (document.body || document.documentElement).appendChild(b);
  }
})();
