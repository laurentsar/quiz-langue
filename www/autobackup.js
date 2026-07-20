/*
 * autobackup.js — sauvegarde automatique des données de l'app vers Home
 * Assistant, et restauration après réinstallation.
 *
 * Pourquoi : désinstaller un APK Android efface le stockage privé de l'app.
 * Android ne fournit AUCUN hook au moment de la désinstallation (l'app est
 * tuée puis supprimée ; ACTION_PACKAGE_FULLY_REMOVED part vers les autres
 * apps). Impossible donc de sauvegarder « au moment où l'on désinstalle » :
 * la seule approche fiable est de sauvegarder en continu, avant.
 *
 * L'Auto Backup de Google ne couvre pas ce cas non plus : la restauration est
 * liée à la signature de l'app, or nos clés de signature ont changé.
 *
 * Ce module sauvegarde l'INTÉGRALITÉ du localStorage de l'app, sans connaître
 * son schéma — impossible d'oublier une clé lors d'une évolution de l'app.
 *
 * LIMITE CONNUE : un état posé via /api/states n'est pas persistant côté Home
 * Assistant — il vit dans la state machine et disparaît au redémarrage de HA.
 * L'app republie donc à chaque lancement, ce qui recrée l'entité. Fenêtre de
 * risque résiduelle : HA redémarre, puis on désinstalle l'app sans l'avoir
 * rouverte. Vérifier que sensor.<app>_sauvegarde existe AVANT de désinstaller.
 *
 * Config (avant ce script) :
 *   window.BACKUP_APP    = 'bornes-ve';        // obligatoire, préfixe des clés
 *   window.BACKUP_ENTITY = 'sensor.bornes_ve_sauvegarde';  // optionnel
 *   window.BACKUP_SKIP   = [/^feedcache:/];    // optionnel : caches régénérables
 *
 * API :
 *   AutoBackup.mount(el)   injecte le panneau de réglages (URL + jeton + boutons)
 *   AutoBackup.now()       sauvegarde immédiate
 *   AutoBackup.restore()   relit la sauvegarde et recharge la page
 */
(function (global) {
  'use strict';

  var APP = global.BACKUP_APP;
  if (!APP) return;

  var ENTITY = global.BACKUP_ENTITY ||
    'sensor.' + APP.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '_sauvegarde';
  var CFG_KEY = APP + '.ha';
  var META_KEY = APP + '.backupMeta';
  var DEBOUNCE = 4000;
  var MAX_BYTES = 240 * 1024;   // au-delà, l'attribut HA devient déraisonnable

  // Clés purement locales : les restaurer n'aurait pas de sens.
  var SKIP = /^(updPoll:|updDismiss:|dismissedUpdate$|_localforage)/;

  // Caches régénérables propres à l'app (gros et sans valeur en sauvegarde).
  var EXTRA_SKIP = global.BACKUP_SKIP || [];

  function skipped(k) {
    if (k === CFG_KEY || k === META_KEY || SKIP.test(k)) return true;
    for (var i = 0; i < EXTRA_SKIP.length; i++) {
      if (EXTRA_SKIP[i].test(k)) return true;
    }
    return false;
  }

  // Certaines apps (mabiblio) stockent via Capacitor Preferences dans l'APK et
  // ne touchent le localStorage qu'en navigateur : il faut couvrir les deux.
  function prefsPlugin() {
    return global.Capacitor && global.Capacitor.Plugins &&
      global.Capacitor.Plugins.Preferences;
  }

  function readPrefs() {
    var P = prefsPlugin();
    if (!P) return Promise.resolve({});
    return P.keys().then(function (r) {
      var keys = (r && r.keys ? r.keys : []).filter(function (k) { return !skipped(k); });
      return Promise.all(keys.map(function (k) {
        return P.get({ key: k }).then(function (v) { return [k, v && v.value]; });
      })).then(function (pairs) {
        var out = {};
        pairs.forEach(function (p) { if (p[1] != null) out[p[0]] = p[1]; });
        return out;
      });
    }).catch(function () { return {}; });
  }

  function writePrefs(obj) {
    var P = prefsPlugin();
    if (!P || !obj) return Promise.resolve(0);
    var keys = Object.keys(obj);
    return Promise.all(keys.map(function (k) {
      return P.set({ key: k, value: String(obj[k]) });
    })).then(function () { return keys.length; }).catch(function () { return 0; });
  }

  function cfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function enabled() {
    var c = cfg();
    return !!(c.url && c.token);
  }

  function req(path, opt) {
    var c = cfg();
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    opt = opt || {};
    return fetch(c.url + path, {
      method: opt.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'Content-Type': 'application/json'
      },
      body: opt.body ? JSON.stringify(opt.body) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  function snapshotLocal() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (skipped(k)) continue;
      out[k] = localStorage.getItem(k);
    }
    return out;
  }

  // Payload versionné : { v, ls: {...}, prefs: {...} }. L'ancien format (objet
  // plat de clés localStorage) reste lisible à la restauration.
  function snapshot() {
    return readPrefs().then(function (prefs) {
      return { v: 2, ls: snapshotLocal(), prefs: prefs };
    });
  }

  function meta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function setMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  function now() {
    return snapshot().then(function (snap) {
      var data = JSON.stringify(snap);
      var count = Object.keys(snap.ls).length + Object.keys(snap.prefs).length;
      if (data.length > MAX_BYTES) {
        throw new Error('sauvegarde trop volumineuse (' +
          Math.round(data.length / 1024) + ' ko) — exclure les caches via BACKUP_SKIP');
      }
      var stamp = new Date().toISOString();
      return req('/api/states/' + ENTITY, {
        method: 'POST',
        body: {
          state: stamp.slice(0, 19).replace('T', ' '),
          attributes: {
            friendly_name: APP + ' sauvegarde',
            icon: 'mdi:cloud-upload-outline',
            app: APP,
            taille_ko: Math.round(data.length / 102.4) / 10,
            cles: count,
            data: data
          }
        }
      }).then(function () {
        setMeta({ at: stamp, size: data.length });
        return { size: data.length, at: stamp, count: count };
      });
    });
  }

  function read() {
    return req('/api/states/' + ENTITY).then(function (st) {
      var raw = st && st.attributes && st.attributes.data;
      if (!raw) throw new Error('aucune sauvegarde trouvée');
      return { data: JSON.parse(raw), at: st.state };
    });
  }

  function restore() {
    return read().then(function (r) {
      var d = r.data;
      // v1 : objet plat de clés localStorage. v2 : { ls, prefs }.
      var ls = (d && d.v === 2) ? d.ls : d;
      var prefs = (d && d.v === 2) ? d.prefs : {};
      var n = 0;
      Object.keys(ls || {}).forEach(function (k) {
        try { rawSet(k, ls[k]); n++; } catch (e) {}
      });
      return writePrefs(prefs).then(function (m) {
        return { count: n + m, at: r.at };
      });
    });
  }

  // --- sauvegarde automatique ---------------------------------------------

  var timer = null;
  var lastSaved = '';

  function schedule() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      snapshot().then(function (snap) {
        var cur = JSON.stringify(snap);
        if (cur === lastSaved) return;        // rien n'a bougé
        return now().then(function () { lastSaved = cur; });
      }).catch(function () { });
    }, DEBOUNCE);
  }

  // Tout écrit dans localStorage déclenche une sauvegarde différée, quelle que
  // soit la partie de l'app qui écrit -- rien à câbler dans chaque écran.
  var rawSet = localStorage.setItem.bind(localStorage);
  var rawRemove = localStorage.removeItem.bind(localStorage);
  try {
    localStorage.setItem = function (k, v) { rawSet(k, v); schedule(); };
    localStorage.removeItem = function (k) { rawRemove(k); schedule(); };
  } catch (e) { /* navigateur récalcitrant : on garde les déclencheurs ci-dessous */ }

  // Passage en arrière-plan : dernier moment fiable avant que l'app disparaisse.
  function flush() {
    if (!enabled()) return;
    snapshot().then(function (snap) {
      var cur = JSON.stringify(snap);
      if (cur === lastSaved) return;
      return now().then(function () { lastSaved = cur; });
    }).catch(function () { });
  }
  global.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  global.addEventListener('pagehide', flush);

  // --- panneau de réglages -------------------------------------------------

  function mount(el) {
    if (!el) return;
    var c = cfg();
    var m = meta();
    el.innerHTML =
      '<div class="ab-box">' +
      '<label>URL Home Assistant<input id="abUrl" type="url" placeholder="http://192.168.1.172:8123"></label>' +
      '<label>Jeton longue durée<input id="abTok" type="password" placeholder="eyJ…"></label>' +
      '<div class="ab-row">' +
      '<button id="abSave" type="button">Enregistrer</button>' +
      '<button id="abNow" type="button">Sauvegarder maintenant</button>' +
      '<button id="abRest" type="button">Restaurer</button>' +
      '</div><p id="abMsg" class="ab-msg"></p></div>';

    var css = document.createElement('style');
    css.textContent =
      '.ab-box label{display:block;margin:8px 0;font-size:14px}' +
      '.ab-box input{width:100%;padding:8px;margin-top:4px;border-radius:8px;' +
      'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}' +
      '.ab-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
      '.ab-row button{flex:1 1 auto;padding:9px 12px;border:0;border-radius:9px;' +
      'background:#2563eb;color:#fff;font-weight:600;cursor:pointer}' +
      '.ab-msg{font-size:13px;opacity:.85;margin-top:8px;min-height:1.2em}';
    el.appendChild(css);

    var $ = function (id) { return el.querySelector('#' + id); };
    $('abUrl').value = c.url || '';
    $('abTok').value = c.token || '';
    if (m.at) {
      $('abMsg').textContent = 'Dernière sauvegarde : ' +
        new Date(m.at).toLocaleString('fr-FR') +
        ' (' + Math.round(m.size / 102.4) / 10 + ' ko)';
    }

    $('abSave').onclick = function () {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        url: $('abUrl').value.trim().replace(/\/+$/, ''),
        token: $('abTok').value.trim()
      }));
      $('abMsg').textContent = 'Enregistré. Test…';
      now().then(function (r) {
        $('abMsg').textContent = 'Sauvegarde OK vers ' + ENTITY +
          ' (' + Math.round(r.size / 102.4) / 10 + ' ko).';
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };

    $('abNow').onclick = function () {
      $('abMsg').textContent = 'Sauvegarde…';
      now().then(function (r) {
        $('abMsg').textContent = 'Sauvegardé (' +
          Math.round(r.size / 102.4) / 10 + ' ko) le ' +
          new Date(r.at).toLocaleString('fr-FR') + '.';
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };

    $('abRest').onclick = function () {
      if (!confirm('Restaurer la sauvegarde ? Les données actuelles de cette ' +
                   'app seront remplacées.')) return;
      $('abMsg').textContent = 'Restauration…';
      restore().then(function (r) {
        $('abMsg').textContent = r.count + ' entrées restaurées. Rechargement…';
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };
  }

  // Première ouverture après réinstallation : proposer la restauration.
  //
  // On ne peut pas se fier à « le localStorage est vide » : app.js se charge
  // AVANT ce module et y écrit déjà ses valeurs par défaut. Le signal fiable
  // est l'absence de métadonnées locales de sauvegarde -- elles disparaissent
  // avec la désinstallation, alors que la sauvegarde distante subsiste.
  function offerRestoreIfFresh() {
    if (!enabled()) return;
    if (meta().at) {
      // L'entité HA n'étant pas persistante, un redémarrage de HA l'efface :
      // republier au lancement la recrée.
      flush();
      return;
    }
    read().then(function (r) {
      if (!confirm('Une sauvegarde du ' + new Date(r.at).toLocaleString('fr-FR') +
                   ' a été trouvée sur Home Assistant.\n\nLa restaurer ? ' +
                   'Les données actuelles de cette app seront remplacées.')) {
        setMeta({ at: new Date().toISOString(), size: 0, declined: true });
        return;                            // ne plus reproposer à chaque ouverture
      }
      restore().then(function () { location.reload(); });
    }).catch(function () { });
  }

  global.AutoBackup = {
    mount: mount, now: now, restore: restore, read: read,
    enabled: enabled, ENTITY: ENTITY
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', offerRestoreIfFresh);
  } else {
    offerRestoreIfFresh();
  }
})(window);
