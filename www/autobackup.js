/*
 * autobackup.js — sauvegarde automatique des données de l'app vers Home
 * Assistant, et restauration après réinstallation.
 *
 * Pourquoi : désinstaller un APK Android efface le stockage privé de l'app.
 * Android ne fournit AUCUN hook au moment de la désinstallation. La seule
 * approche fiable est de sauvegarder en continu, avant.
 *
 * ROBUSTESSE (leçon d'un écrasement réel) : après réinstallation, l'URL + le
 * jeton HA sont perdus avec le stockage, donc l'app ne peut pas restaurer tant
 * qu'ils ne sont pas ressaisis. Le piège : dès qu'on les ressaisit, un
 * enregistrement automatique pouvait écraser la sauvegarde distante (pleine)
 * par les données par défaut (vides) de l'app fraîchement installée. Trois
 * protections empêchent désormais toute perte :
 *   1. RESTAURATION D'ABORD : à la configuration d'une install neuve, on lit la
 *      sauvegarde distante et on propose de la restaurer AVANT tout écrit.
 *   2. ENREGISTREMENT VERROUILLÉ tant qu'une restauration est due (restoreState
 *      != done/declined/empty) : aucun auto-save ne peut écraser quoi que ce soit.
 *   3. GARDE-FOU BAS NIVEAU : ne jamais remplacer une sauvegarde non vide par
 *      une sauvegarde vide, et archiver la précédente dans un slot de secours
 *      (sensor.<app>_sauvegarde_prec) avant tout écrasement.
 *
 * LIMITE CONNUE : un état posé via /api/states n'est pas persistant côté HA — il
 * disparaît au redémarrage de HA. L'app republie au lancement pour recréer
 * l'entité (sans risque : voir garde-fous ci-dessus).
 *
 * Config (avant ce script) :
 *   window.BACKUP_APP    = 'bornes-ve';        // obligatoire, préfixe des clés
 *   window.BACKUP_ENTITY = 'sensor.bornes_ve_sauvegarde';  // optionnel
 *   window.BACKUP_SKIP   = [/^feedcache:/];    // optionnel : caches régénérables
 *
 * API :
 *   AutoBackup.mount(el)   injecte le panneau de réglages (URL + jeton + boutons)
 *   AutoBackup.now(force)  sauvegarde immédiate (force=true ignore le garde-fou vide)
 *   AutoBackup.restore()   relit la sauvegarde distante et l'applique
 */
(function (global) {
  'use strict';

  var APP = global.BACKUP_APP;
  if (!APP) return;

  var ENTITY = global.BACKUP_ENTITY ||
    'sensor.' + APP.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '_sauvegarde';
  var PREV_ENTITY = ENTITY + '_prec';   // slot de secours : sauvegarde précédente
  var CFG_KEY = APP + '.ha';
  var META_KEY = APP + '.backupMeta';
  var DEBOUNCE = 4000;
  var MAX_BYTES = 240 * 1024;

  // Clés purement locales : les restaurer n'aurait pas de sens.
  var SKIP = /^(updPoll:|updDismiss:|dismissedUpdate$|_localforage)/;
  var EXTRA_SKIP = global.BACKUP_SKIP || [];

  function skipped(k) {
    if (k === CFG_KEY || k === META_KEY || SKIP.test(k)) return true;
    for (var i = 0; i < EXTRA_SKIP.length; i++) {
      if (EXTRA_SKIP[i].test(k)) return true;
    }
    return false;
  }

  // Certaines apps (mabiblio) stockent via Capacitor Preferences dans l'APK.
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

  // rawSet/rawRemove : accès direct au vrai localStorage (défini tôt car
  // restore() s'en sert). L'override qui déclenche les sauvegardes vient après.
  var rawSet = localStorage.setItem.bind(localStorage);
  var rawRemove = localStorage.removeItem.bind(localStorage);

  // --- état de restauration : verrou anti-écrasement -----------------------
  //  'unknown'  : pas encore déterminé (au démarrage / avant config)
  //  'pending'  : une restauration est peut-être due — AUCUN enregistrement
  //  'done'     : restaurée, ou install déjà en cours d'utilisation
  //  'declined' : l'utilisateur a refusé la restauration
  //  'empty'    : aucune sauvegarde distante — rien à restaurer
  var restoreState = 'unknown';
  function savingAllowed() {
    return enabled() &&
      (restoreState === 'done' || restoreState === 'declined' || restoreState === 'empty');
  }

  // Lecture brute d'une entité -> {raw, at, count, attrs} ou null.
  function readEntity(ent) {
    return req('/api/states/' + ent).then(function (st) {
      var raw = st && st.attributes && st.attributes.data;
      if (!raw) return null;
      return { raw: raw, at: st.state, count: (st.attributes.cles || 0), attrs: st.attributes };
    }, function () { return null; });
  }
  function postEntity(ent, data, count, stamp, label) {
    return req('/api/states/' + ent, {
      method: 'POST',
      body: {
        state: stamp.slice(0, 19).replace('T', ' '),
        attributes: {
          friendly_name: APP + ' sauvegarde' + (label ? ' ' + label : ''),
          icon: 'mdi:cloud-upload-outline',
          app: APP,
          taille_ko: Math.round(data.length / 102.4) / 10,
          cles: count,
          data: data
        }
      }
    });
  }

  // Écriture SÛRE. Garde-fous :
  //  - ne remplace jamais une sauvegarde non vide par une vide (sauf force) ;
  //  - archive la sauvegarde précédente (non vide, différente) dans PREV_ENTITY.
  function push(force) {
    return snapshot().then(function (snap) {
      var data = JSON.stringify(snap);
      var count = Object.keys(snap.ls).length + Object.keys(snap.prefs).length;
      if (data.length > MAX_BYTES) {
        throw new Error('sauvegarde trop volumineuse (' +
          Math.round(data.length / 1024) + ' ko) — exclure les caches via BACKUP_SKIP');
      }
      var stamp = new Date().toISOString();
      return readEntity(ENTITY).then(function (cur) {
        if (!force && count === 0 && cur && cur.count > 0) {
          throw new Error('sauvegarde vide ignorée — la sauvegarde existante (' +
            cur.count + ' entrées) est préservée');
        }
        var archive = (cur && cur.count > 0 && cur.raw !== data)
          ? postEntity(PREV_ENTITY, cur.raw, cur.count, cur.at, '(précédente)').catch(function () {})
          : Promise.resolve();
        return archive
          .then(function () { return postEntity(ENTITY, data, count, stamp); })
          .then(function () {
            setMeta({ at: stamp, size: data.length });
            return { size: data.length, at: stamp, count: count };
          });
      });
    });
  }
  function now(force) { return push(force); }

  function read() {
    return readEntity(ENTITY).then(function (cur) {
      if (!cur) throw new Error('aucune sauvegarde trouvée');
      return { data: JSON.parse(cur.raw), at: cur.at, count: cur.count };
    });
  }

  function applyData(d) {
    var ls = (d && d.v === 2) ? d.ls : d;
    var prefs = (d && d.v === 2) ? d.prefs : {};
    var n = 0;
    Object.keys(ls || {}).forEach(function (k) {
      try { rawSet(k, ls[k]); n++; } catch (e) {}
    });
    return writePrefs(prefs).then(function (m) { return n + m; });
  }
  function restore() {
    return read().then(function (r) {
      return applyData(r.data).then(function (count) {
        // marque cette install comme décidée : plus de re-proposition ni de
        // risque d'écrasement au prochain chargement.
        setMeta({ at: new Date().toISOString(), size: 0, restored: true });
        restoreState = 'done';
        return { count: count, at: r.at };
      });
    });
  }

  // --- sauvegarde automatique (verrouillée par savingAllowed) --------------
  var timer = null;
  var lastSaved = '';
  function schedule() {
    if (!savingAllowed()) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      snapshot().then(function (snap) {
        var cur = JSON.stringify(snap);
        if (cur === lastSaved) return;
        return push().then(function () { lastSaved = cur; });
      }).catch(function () {});
    }, DEBOUNCE);
  }
  try {
    localStorage.setItem = function (k, v) { rawSet(k, v); schedule(); };
    localStorage.removeItem = function (k) { rawRemove(k); schedule(); };
  } catch (e) { /* navigateur récalcitrant */ }

  function flush() {
    if (!savingAllowed()) return;
    snapshot().then(function (snap) {
      var cur = JSON.stringify(snap);
      if (cur === lastSaved) return;
      return push().then(function () { lastSaved = cur; });
    }).catch(function () {});
  }
  global.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  global.addEventListener('pagehide', flush);

  // --- décision de restauration (restore-first, anti-écrasement) -----------
  // Détermine restoreState et propose la restauration quand une install neuve
  // est configurée et qu'une sauvegarde distante existe. Renvoie une promesse.
  function evaluateRestore(interactive) {
    if (!enabled()) { restoreState = 'unknown'; return Promise.resolve(); }
    if (meta().at) {
      // install déjà décidée / en cours d'utilisation : republier sans risque.
      restoreState = 'done';
      flush();
      return Promise.resolve();
    }
    restoreState = 'pending';   // tant que non résolu : aucun enregistrement
    return readEntity(ENTITY).then(function (cur) {
      if (!cur || cur.count === 0) { restoreState = 'empty'; schedule(); return; }
      var when = new Date(cur.at).toLocaleString('fr-FR');
      var ok = global.confirm('Une sauvegarde du ' + when + ' (' + cur.count +
        ' entrées) a été trouvée sur Home Assistant.\n\nLa restaurer ? ' +
        'Les données actuelles de cette app seront remplacées.');
      if (ok) {
        return restore().then(function () { global.location.reload(); });
      }
      restoreState = 'declined';
      setMeta({ at: new Date().toISOString(), size: 0, declined: true });
    }, function () {
      // Réseau/HA injoignable : on RESTE en 'pending' -> aucun enregistrement,
      // aucune sauvegarde distante ne peut être écrasée. L'utilisateur peut
      // réessayer via le panneau.
      if (interactive) throw new Error('Home Assistant injoignable — vérifiez l\'URL et le jeton');
    });
  }

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
      '<button id="abRest" type="button">Restaurer</button>' +
      '<button id="abNow" type="button">Sauvegarder maintenant</button>' +
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
    if (m.at && m.size) {
      $('abMsg').textContent = 'Dernière sauvegarde : ' +
        new Date(m.at).toLocaleString('fr-FR') +
        ' (' + Math.round(m.size / 102.4) / 10 + ' ko)';
    }

    // Enregistrer la config = RESTAURATION D'ABORD. On n'écrit jamais avant
    // d'avoir vérifié (et proposé) une éventuelle sauvegarde distante.
    $('abSave').onclick = function () {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        url: $('abUrl').value.trim().replace(/\/+$/, ''),
        token: $('abTok').value.trim()
      }));
      $('abMsg').textContent = 'Connecté. Vérification d\'une sauvegarde existante…';
      evaluateRestore(true).then(function () {
        if (restoreState === 'empty')
          $('abMsg').textContent = 'Connecté. Aucune sauvegarde distante — sauvegarde automatique active.';
        else if (restoreState === 'declined')
          $('abMsg').textContent = 'Connecté. Restauration refusée — sauvegarde automatique active.';
        else if (restoreState === 'done')
          $('abMsg').textContent = 'Connecté.';
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };

    // Restauration explicite depuis le bouton.
    $('abRest').onclick = function () {
      if (!enabled()) { $('abMsg').textContent = 'Renseignez d\'abord l\'URL et le jeton, puis Enregistrer.'; return; }
      if (!confirm('Restaurer la sauvegarde ? Les données actuelles de cette app seront remplacées.')) return;
      $('abMsg').textContent = 'Restauration…';
      restore().then(function (r) {
        $('abMsg').textContent = r.count + ' entrées restaurées. Rechargement…';
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };

    // Sauvegarde manuelle immédiate (respecte le garde-fou anti-vide).
    $('abNow').onclick = function () {
      $('abMsg').textContent = 'Sauvegarde…';
      now(false).then(function (r) {
        restoreState = 'done';
        $('abMsg').textContent = 'Sauvegardé (' +
          Math.round(r.size / 102.4) / 10 + ' ko) le ' +
          new Date(r.at).toLocaleString('fr-FR') + '.';
      }).catch(function (e) { $('abMsg').textContent = 'Échec : ' + e.message; });
    };
  }

  global.AutoBackup = {
    mount: mount, now: now, restore: restore, read: read,
    enabled: enabled, ENTITY: ENTITY
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { evaluateRestore(false); });
  } else {
    evaluateRestore(false);
  }
})(window);
