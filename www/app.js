'use strict';

const APP_VERSION = '2.33';
const OPTION_COUNT = 4;

const LANGS = {
  en: { label: 'Anglais', file: 'data/wordlist_en.json', tts: 'en-US', levels: ['Global', 'A1', 'A2', 'B1', 'B2', 'C', 'D'] },
  es: { label: 'Espagnol', file: 'data/wordlist_es.json', tts: 'es-ES', levels: ['Global', 'A1-A2', 'B1-B2', 'C1-C2'] },
};

// Leitner box -> days until due
const BOX_DAYS = [0, 1, 2, 4, 8, 16];
const MAX_BOX = BOX_DAYS.length - 1;
const DAY = 86400000;

const VERBS_FILE = 'data/verbs_en.json';
const VERBS_KEY = 'verbs';   // espace stats/SRS dédié aux verbes irréguliers
const GRAMMAR_KEY = 'grammar'; // espace stats/SRS dédié aux exos de grammaire
const FAUX_AMIS_KEY = 'faux-amis';
const FAMILLES_KEY = 'familles';
const COGNATES_KEY = 'cognates';
const TENSES_KEY  = 'tenses';
const PHRASES_KEY = 'phrases';
const KIND_COLORS = { vocab: '#27B3FF', verbs: '#4CE0D2', grammar: '#1B5CFF', pronun: '#B15CFF', 'faux-amis': '#FF6B35', familles: '#A855F7', cognates: '#10B981', tenses: '#EF4444', phrases: '#F59E0B' };

const state = {
  lang: 'en',
  level: 'Global',
  selectedLevels: new Set(),   // vide = Global (tous les niveaux)
  dir: 'fwd',       // 'fwd' = word->fr, 'rev' = fr->word
  count: 5,
  mode: 'srs',      // 'srs' | 'review'
  kind: 'vocab',    // 'vocab' | 'verbs'
  verbForm: 'mix',  // 'pret' | 'pp' | 'mix'
  badge: 'Global',  // libellé affiché dans l'en-tête du quiz
  words: [],
  questions: [],
  answers: [],
  index: 0,
};

let verbsData = null;   // liste des verbes irréguliers (chargée à la demande)
let verbSelectedWords = new Set();   // infinitifs sélectionnés pour le quiz personnalisé
let verbSelectPanelOpen = false;

// Clé de stats/SRS et voix TTS selon le mode courant.
function quizKey() { return state.kind === 'verbs' ? VERBS_KEY : state.kind === 'grammar' ? GRAMMAR_KEY : state.kind === 'faux-amis' ? FAUX_AMIS_KEY : state.kind === 'familles' ? FAMILLES_KEY : state.kind === 'cognates' ? COGNATES_KEY : state.kind === 'tenses' ? TENSES_KEY : state.kind === 'phrases' ? PHRASES_KEY : state.lang; }
function quizTts() { return (state.kind === 'verbs' || state.kind === 'grammar' || state.kind === 'faux-amis' || state.kind === 'familles' || state.kind === 'cognates' || state.kind === 'tenses' || state.kind === 'phrases') ? 'en-US' : LANGS[state.lang].tts; }

const settings = loadSettings();
const cache = {};   // lang -> words
const srsCache = {}; // lang -> srs map

// ---------- persistence ----------
function lsGet(k, d) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

function loadSettings() {
  return Object.assign({ audioAuto: true, autoNext: true, sound: true, closeDistractors: false, notifications: true, dailyGoal: 10, notifHour: 8 }, lsGet('quizlangue:settings:v1', {}));
}
function saveSettings() { lsSet('quizlangue:settings:v1', settings); }

function statsKey(lang) { return `quizlangue:stats:${lang}:v1`; }
function defaultStats() { return { totalCompleted: 0, totalPoints: 0, perfectStreak: 0, bestStreak: 0, perfectTotal: 0, lastScore: 0 }; }
function loadStats(lang) { return Object.assign(defaultStats(), lsGet(statsKey(lang), {})); }
function saveStats(lang, s) { lsSet(statsKey(lang), s); }

function srsKey(lang) { return `quizlangue:srs:${lang}:v1`; }
function getSrs(lang) {
  if (!srsCache[lang]) srsCache[lang] = lsGet(srsKey(lang), {});
  return srsCache[lang];
}
function saveSrs(lang) { lsSet(srsKey(lang), getSrs(lang)); }

// ---------- helpers ----------
function display(v) { return String(v || '').replace(/_/g, ' '); }

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Score de proximité entre deux mots (pour l'option « distracteurs proches »).
function similarity(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return -1;
  let s = 0;
  if (a[0] === b[0]) s += 3;
  s += Math.max(0, 3 - Math.abs(a.length - b.length));
  const setB = new Set(b); let shared = 0;
  new Set(a).forEach(ch => { if (setB.has(ch)) shared++; });
  return s + shared * 0.5;
}

// Choisit OPTION_COUNT-1 distracteurs. Si « distracteurs proches » est actif, on
// privilégie les candidats orthographiquement proches de la bonne réponse.
function chooseDistractors(correct, primaryRaw, fallbackRaw) {
  let cand = [...new Set(primaryRaw.map(display))].filter(v => v && v !== correct);
  if (cand.length < OPTION_COUNT - 1 && fallbackRaw) {
    cand = [...new Set(cand.concat(fallbackRaw.map(display)))].filter(v => v && v !== correct);
  }
  if (settings.closeDistractors) {
    const ranked = cand.map(v => [v, similarity(correct, v)]).sort((x, y) => y[1] - x[1]);
    const top = ranked.slice(0, Math.max(8, (OPTION_COUNT - 1) * 4)).map(x => x[0]);
    return shuffle(top).slice(0, OPTION_COUNT - 1);
  }
  return shuffle(cand).slice(0, OPTION_COUNT - 1);
}

function levelWords() {
  return state.selectedLevels.size ? state.words.filter(w => state.selectedLevels.has(w.level)) : state.words;
}

// ---------- SRS scheduling ----------
function srsUpdate(lang, word, correct) {
  const srs = getSrs(lang);
  const e = srs[word] || { box: 0, due: 0, seen: 0, correct: 0, wrong: 0, last: '' };
  e.seen++;
  if (correct) { e.correct++; e.box = Math.min(e.box + 1, MAX_BOX); e.last = 'ok'; }
  else { e.wrong++; e.box = 0; e.last = 'ko'; }
  e.due = Date.now() + BOX_DAYS[e.box] * DAY;
  srs[word] = e;
}

function dueList(words, srs, now) {
  return words.filter(w => srs[w.word] && srs[w.word].due <= now)
              .sort((a, b) => srs[a.word].due - srs[b.word].due);
}
function newList(words, srs) { return shuffle(words.filter(w => !srs[w.word])); }
function wrongList(words, srs) {
  return words.filter(w => srs[w.word] && (srs[w.word].last === 'ko' || srs[w.word].box === 0) && srs[w.word].seen > 0);
}

function pickSession(mode) {
  const words = levelWords();
  const srs = getSrs(quizKey());
  const now = Date.now();
  let picks;
  if (mode === 'review') {
    picks = shuffle(wrongList(words, srs)).slice(0, state.count);
  } else {
    const due = dueList(words, srs, now);
    const fresh = newList(words, srs);
    picks = due.concat(fresh).slice(0, state.count);
    if (picks.length < state.count) picks = picks.concat(shuffle(words)).slice(0, state.count);
    // de-dup while keeping order
    const used = new Set(); picks = picks.filter(w => !used.has(w.word) && used.add(w.word));
  }
  return shuffle(picks);
}

// ---------- question building ----------
function buildGrammarQuestion(item) {
  // phrase à compléter : options déjà rédigées (pas de display() -> on garde le "___")
  const correct = item.answer;
  const opts = shuffle(item.options.slice());
  return {
    word: item.id,                                  // clé SRS = id de l'exercice
    foreign: item.q,                                // phrase trouée (affichage résultat)
    fullSentence: item.q.replace('___', item.answer),
    promptText: item.q,
    promptIsForeign: false,                          // pas d'audio sur la phrase trouée
    promptLabel: 'Complète la phrase',
    options: opts,
    correctIndex: opts.indexOf(correct),
    correctText: correct,
    hint: item.hint || '',
  };
}

function buildVerbQuestion(item, words) {
  // forme testée : prétérit, participe passé, ou tirage aléatoire (mélange)
  let form = state.verbForm === 'mix' ? (Math.random() < 0.5 ? 'pret' : 'pp') : state.verbForm;
  const correct = display(item[form]);
  const poolRaw = words.map(w => w[form]);
  const shuffled = shuffle([correct, ...chooseDistractors(correct, poolRaw)]);
  return {
    word: item.word,                       // = infinitif (clé SRS)
    foreign: display(item.inf),            // infinitif (pour l'audio)
    promptText: display(item.inf) + ' — ' + display(item.fr),
    promptIsForeign: true,
    promptLabel: form === 'pret' ? 'Prétérit de' : 'Participe passé de',
    options: shuffled,
    correctIndex: shuffled.indexOf(correct),
    correctText: correct,
  };
}

function buildQuestion(item, words) {
  if (state.kind === 'grammar' || state.kind === 'tenses') return buildGrammarQuestion(item);
  if (state.kind === 'verbs') return buildVerbQuestion(item, words);
  // prompt/answer depend on direction
  const fwd = state.dir === 'fwd';
  const promptText = display(fwd ? item.word : item.fr);
  const correctRaw = fwd ? item.fr : item.word;
  const correct = display(correctRaw);
  // « distracteurs proches » : on restreint au même niveau, sinon tout le lexique.
  const closePool = settings.closeDistractors ? words.filter(w => w.level === item.level) : words;
  const poolRaw = fwd ? closePool.map(w => w.fr) : closePool.map(w => w.word);
  const fallbackRaw = fwd ? words.map(w => w.fr) : words.map(w => w.word);
  const shuffled = shuffle([correct, ...chooseDistractors(correct, poolRaw, fallbackRaw)]);
  return {
    word: item.word,                       // canonical key for SRS
    foreign: display(item.word),           // the EN/ES word (for audio)
    promptText,
    promptIsForeign: fwd,
    ipa: fwd ? (item.ipa || '') : '',      // IPA only when showing foreign word
    options: shuffled,
    correctIndex: shuffled.indexOf(correct),
    correctText: correct,
  };
}

// ---------- audio ----------
function speak(text) {
  const lang = quizTts();
  // Prefer Android native TTS (reliable inside the app's WebView)
  const cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.TextToSpeech) {
    try { cap.Plugins.TextToSpeech.stop().catch(() => {}); } catch (e) {}
    cap.Plugins.TextToSpeech.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' }).catch(() => {});
    return;
  }
  // Web fallback (PWA in a browser)
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch (e) {}
}

// ---------- sound + haptic ----------
let audioCtx = null;
function beep(ok) {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = ok ? 'sine' : 'square';
    o.frequency.value = ok ? 880 : 180;
    g.gain.setValueAtTime(0.001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (ok ? 0.18 : 0.28));
    o.start(); o.stop(audioCtx.currentTime + (ok ? 0.2 : 0.3));
  } catch (e) {}
}
function vibrate(ok) { try { navigator.vibrate && navigator.vibrate(ok ? 25 : [40, 50, 40]); } catch (e) {} }

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const views = { home: $('view-home'), quiz: $('view-quiz'), result: $('view-result'), stats: $('view-stats'), verbs: $('view-verbs'), grammar: $('view-grammar'), 'faux-amis': $('view-faux-amis'), familles: $('view-familles'), cognates: $('view-cognates'), tenses: $('view-tenses'), phrases: $('view-phrases'), learn: $('view-learn'), listen: $('view-listen'), pronun: $('view-pronun') };
let autoNextTimer = null;

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  window.scrollTo(0, 0);
  $('btn-fab-home').classList.toggle('hidden', name === 'home');
}

function renderChips(selector, current, attr) {
  document.querySelectorAll(selector).forEach(c => c.classList.toggle('active', c.dataset[attr] === String(current)));
}

function renderLevelChips() {
  const row = $('level-row'); row.innerHTML = '';
  LANGS[state.lang].levels.forEach(lv => {
    const b = document.createElement('button');
    const isGlobal = lv === 'Global';
    const isActive = isGlobal ? !state.selectedLevels.size : state.selectedLevels.has(lv);
    b.className = 'chip' + (isActive ? ' active' : '');
    b.textContent = lv;
    b.addEventListener('click', () => {
      if (isGlobal) {
        state.selectedLevels.clear();
      } else if (state.selectedLevels.has(lv)) {
        state.selectedLevels.delete(lv);
      } else {
        state.selectedLevels.add(lv);
      }
      state.level = state.selectedLevels.size ? [...state.selectedLevels].join('+') : 'Global';
      renderLevelChips(); renderStats();
    });
    row.appendChild(b);
  });
}

function renderStats() {
  renderMotivBar();
  const s = loadStats(state.lang);
  $('stat-last').textContent = `${s.lastScore}/5`;
  $('stat-total').textContent = `${s.totalCompleted} · ${s.totalPoints}`;
  $('stat-streak').textContent = `${s.perfectStreak} · ${s.bestStreak || 0}`;

  const words = levelWords();
  const srs = getSrs(state.lang);
  const now = Date.now();
  const seen = words.filter(w => srs[w.word] && srs[w.word].seen > 0).length;
  const mastered = words.filter(w => srs[w.word] && srs[w.word].box >= 4).length;
  const due = dueList(words, srs, now).length;
  const wrong = wrongList(words, srs).length;
  $('stat-seen').textContent = `${seen} / ${words.length}`;
  $('stat-mastered').textContent = mastered;
  $('stat-due').textContent = due;
  $('review-count').textContent = wrong;
  $('btn-review').disabled = wrong === 0;
}

async function loadWords(lang) {
  if (!cache[lang]) cache[lang] = await (await fetch(LANGS[lang].file)).json();
  return cache[lang];
}

// ---------- magazine Vocable (Cafeyn) selon la langue ----------
// Accès natif (WebView in-app + biométrie + creds chiffrés + reprise lecture),
// même méthode que l'app Flux RSS. Repli navigateur en PWA.
const MAG_BY_LANG = {
  en: { id: 'en', title: 'Vocable Anglais',  url: 'https://www.cafeyn.co/fr/magazines/vocable-anglais' },
  es: { id: 'es', title: 'Vocable Espagnol', url: 'https://www.cafeyn.co/fr/magazines/vocable-espagnol' },
};
function openExternal(url) {
  const cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.Browser) cap.Plugins.Browser.open({ url });
  else window.open(url, '_blank', 'noopener');
}
// URL de lecture exploitable pour « reprendre » (pas l'accueil / la home)
function isResumableCafeyn(u) {
  if (!u || u.indexOf('cafeyn.co') < 0) return false;
  if (/\/(home|accueil)/.test(u)) return false;
  if (/cafeyn\.co\/fr\/?(\?|#|$)/.test(u)) return false;
  return true;
}
// Mini-menu Reprendre / Dernier numéro (résout 'resume' | 'latest' | null)
function magazineChoice(title) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'mag-modal';
    ov.innerHTML =
      '<div class="mag-modal-card">' +
        '<div class="mag-modal-head"><span>📖 ' + esc(title) + '</span><button data-act="cancel" aria-label="Fermer">✕</button></div>' +
        '<button data-act="resume">▶ Reprendre la lecture</button>' +
        '<button data-act="latest">🗞 Dernier numéro</button>' +
      '</div>';
    const done = v => { ov.remove(); resolve(v); };
    ov.addEventListener('click', e => {
      if (e.target === ov) return done(null);
      const b = e.target.closest('[data-act]'); if (!b) return;
      done(b.dataset.act === 'cancel' ? null : b.dataset.act);
    });
    document.body.appendChild(ov);
  });
}
async function openMagazine(mag) {
  if (!mag) return;
  const cap = window.Capacitor;
  const UP = cap && cap.Plugins && cap.Plugins.UpdatePlugin;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const lastKey = 'cafeynLast_' + mag.id;
  let resume = null;
  try { resume = localStorage.getItem(lastKey); } catch (e) {}
  let target = mag.url;
  if (resume) {
    const choice = await magazineChoice(mag.title);   // menu seulement si une lecture en cours existe
    if (choice === null) return;
    target = choice === 'resume' ? resume : mag.url;
  }
  if (isNative && UP) {
    try { await UP.authenticate({ reason: 'Accès à ' + mag.title }); }
    catch (e) { return; }
    try {
      const res = await UP.openInAppWebView({ url: target, title: '📖 ' + mag.title, barColor: '#7B3F00' });
      if (res && isResumableCafeyn(res.lastUrl)) { try { localStorage.setItem(lastKey, res.lastUrl); } catch (e) {} }
    } catch (e) {}
  } else {
    openExternal(target);
  }
}
// Mise à jour en un tap : télécharge + installe l'APK via le plugin natif
// (utilisé par update-check.js). Repli navigateur en PWA / sans plugin.
async function installApkUpdate(apkUrl, statusEl, onEnd) {
  const UP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.UpdatePlugin;
  if (UP && apkUrl) {
    if (statusEl) statusEl.textContent = '⏳ Téléchargement…';
    try {
      await UP.downloadAndInstall({ url: apkUrl });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/permission/i.test(msg)) {
        alert("Autorise « Installer des applis inconnues » pour VocaLang dans les réglages Android, puis réessaie.");
      } else {
        alert('Échec de la mise à jour : ' + msg);
      }
      if (onEnd) onEnd();
    }
    return;
  }
  window.open(apkUrl, '_blank');  // PWA / pas de plugin : téléchargement navigateur
  if (onEnd) onEnd();
}
window.installApkUpdate = installApkUpdate;  // utilisé aussi par update-check.js
function updateMagazineBtn() {
  const btn = $('btn-magazine');
  if (!btn) return;
  const mag = MAG_BY_LANG[state.lang];
  if (!mag) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.querySelector('b').textContent = mag.title;
}

async function selectLang(lang) {
  state.lang = lang;
  state.selectedLevels.clear();
  state.level = 'Global';
  state.words = await loadWords(lang);
  renderChips('.lang-chip', lang, 'lang');
  renderLevelChips();
  renderStats();
  updateMagazineBtn();
}

// ---------- quiz flow ----------
function verbBadge() { return state.verbForm === 'pret' ? 'Prétérit' : state.verbForm === 'pp' ? 'Participe' : 'Mélange'; }

function startSession(mode) {
  state.mode = mode;
  state.badge = state.kind === 'verbs' ? verbBadge() : state.level;
  state.questions = pickSession(mode).map(it => buildQuestion(it, state.words));
  if (!state.questions.length) return;
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

function renderQuestion() {
  clearTimeout(autoNextTimer);
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  $('quiz-progress').textContent = `Question ${state.index + 1}/${state.questions.length}`;
  $('quiz-level').textContent = (state.mode === 'review' ? '⟳ ' : '') + state.badge;
  const accent = KIND_COLORS[state.kind] || '#27B3FF';
  const bar = $('quiz-bar');
  bar.style.background = accent;
  bar.style.width = ((state.index + (a ? 1 : 0)) / state.questions.length * 100) + '%';
  $('quiz-level').style.color = accent;
  $('quiz-prompt-label').textContent = q.promptLabel || (q.promptIsForeign ? 'Mot' : 'Traduire en ' + (state.lang === 'en' ? 'anglais' : 'espagnol'));
  $('quiz-word').textContent = q.promptText;
  $('quiz-word').classList.toggle('sentence', state.kind === 'grammar' || state.kind === 'tenses' || (state.kind === 'phrases' && !!q.fullSentence));
  $('quiz-ipa').textContent = q.ipa ? '/' + q.ipa + '/' : '';

  // speak button: only meaningful for the foreign word
  const speakBtn = $('btn-speak');
  speakBtn.style.display = q.promptIsForeign ? '' : 'none';
  if (q.promptIsForeign && !a && settings.audioAuto) speak(q.foreign);

  const box = $('quiz-options'); box.innerHTML = '';
  q.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.innerHTML = `<span class="idx">${String.fromCharCode(65 + idx)}</span><span>${opt}</span>`;
    if (a) {
      btn.disabled = true;
      if (idx === q.correctIndex) btn.classList.add('correct');
      else if (idx === a.selectedIndex) btn.classList.add('wrong');
    } else {
      btn.addEventListener('click', () => selectOption(idx));
    }
    box.appendChild(btn);
  });

  const fb = $('quiz-feedback');
  if (a) {
    let html = `<div class="fb-head">${a.correct ? '✅ Correct' : '❌ Faux'}</div>`;
    if (!a.correct) html += `<div class="fb-line">Réponse : <b>${esc(q.correctText)}</b></div>`;
    if (['grammar', 'tenses', 'phrases'].includes(state.kind) && q.fullSentence) html += `<div class="fb-line">📝 ${esc(q.fullSentence)}</div>`;
    if (['grammar', 'faux-amis', 'familles', 'cognates', 'tenses', 'phrases'].includes(state.kind) && q.hint) html += `<div class="fb-line tip">💡 ${esc(q.hint)}</div>`;
    fb.innerHTML = html;
    fb.className = 'feedback show ' + (a.correct ? 'good' : 'bad');
  } else { fb.innerHTML = ''; fb.className = 'feedback'; }

  const next = $('btn-next');
  next.disabled = !a;
  next.textContent = state.index < state.questions.length - 1 ? 'Suivant' : 'Voir le score';
}

function selectOption(idx) {
  if (state.answers[state.index]) return;
  const q = state.questions[state.index];
  const correct = idx === q.correctIndex;
  state.answers[state.index] = { selectedIndex: idx, correct };
  srsUpdate(quizKey(), q.word, correct);
  saveSrs(quizKey());
  logDaily(quizKey(), correct);
  beep(correct); vibrate(correct);
  // prononce la bonne réponse après coup : mot étranger (sens inverse) ou forme correcte (verbes)
  if (settings.audioAuto) {
    if (state.kind === 'grammar' || state.kind === 'tenses' || (state.kind === 'phrases' && q.fullSentence)) speak(q.fullSentence || q.correctText);
    else if (state.kind === 'verbs') speak(q.correctText);
    else if (!q.promptIsForeign) speak(q.foreign);
  }
  renderQuestion();
  if (settings.autoNext) autoNextTimer = setTimeout(goNext, correct ? 900 : 1700);
}

function goNext() {
  clearTimeout(autoNextTimer);
  if (!state.answers[state.index]) return;
  if (state.index < state.questions.length - 1) { state.index++; renderQuestion(); }
  else finishQuiz();
}

function finishQuiz() {
  const total = state.questions.length;
  const score = state.answers.filter(a => a && a.correct).length;
  const wrong = state.questions.map((q, i) => ({
    foreign: q.foreign, correct: q.correctText, isCorrect: state.answers[i] && state.answers[i].correct,
  })).filter(x => !x.isCorrect);

  // stats: "perfect" tracked on 5-question sessions baseline; use ratio
  const prev = loadStats(quizKey());
  const perfect = score === total;
  const streak = perfect ? prev.perfectStreak + 1 : 0;
  const next = {
    totalCompleted: prev.totalCompleted + 1,
    totalPoints: prev.totalPoints + score,
    perfectStreak: streak,
    bestStreak: Math.max(prev.bestStreak || 0, streak),
    perfectTotal: perfect ? prev.perfectTotal + 1 : prev.perfectTotal,
    lastScore: score,
  };
  saveStats(quizKey(), next);

  $('result-sub').textContent = state.mode === 'review' ? 'Révision des erreurs terminée' : 'Quiz terminé';
  $('result-score').textContent = `${score}/${total}`;
  const wbox = $('result-wrong');
  if (wrong.length) {
    wbox.innerHTML = '<span class="wrong-title">À retravailler</span>' +
      wrong.map(w => `<div class="wrong-row"><span class="wrong-word">${w.foreign}</span><span class="wrong-answer">${w.correct}</span></div>`).join('');
  } else {
    wbox.innerHTML = '<span class="wrong-title">Parfait 🎉</span><span class="wrong-answer">Aucune erreur</span>';
  }
  showView('result');
  if (perfect && total >= 3) launchFireworks();
}

// ---------- feux d'artifice (série / quiz parfait) ----------
function launchFireworks() {
  let c = document.getElementById('fx-canvas');
  if (!c) { c = document.createElement('canvas'); c.id = 'fx-canvas'; document.body.appendChild(c); }
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  const colors = ['#FF3B5C', '#27B3FF', '#35D07F', '#FFD166', '#B15CFF', '#4CE0D2', '#FF9F43', '#FF6BD6', '#FFFFFF'];
  let parts = [];
  function burst(bx, by, big) {
    const col = colors[Math.floor(Math.random() * colors.length)];
    const n = big ? 180 + Math.floor(Math.random() * 90) : 100 + Math.floor(Math.random() * 60);
    const power = big ? 9.5 : 6.5;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (0.35 + Math.random()) * power;
      parts.push({ x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.018 + Math.random() * 0.022, col, r: 2 + Math.random() * 2.8 });
    }
    parts.push({ flash: true, x: bx, y: by, life: 1, decay: 0.13, col, r: big ? 110 : 70 }); // éclair de l'explosion
  }
  const t0 = performance.now();
  let last = 0, finale = false;
  function frame(t) {
    const el = t - t0;
    // ciel nocturne + traînées lumineuses
    x.globalCompositeOperation = 'source-over';
    x.fillStyle = 'rgba(6,16,28,0.22)'; x.fillRect(0, 0, W, H);
    if (el < 1100 && t - last > 190) { last = t; burst(W * (0.12 + Math.random() * 0.76), H * (0.12 + Math.random() * 0.42), Math.random() < 0.4); }
    if (!finale && el > 1100) { finale = true; for (let k = 0; k < 6; k++) burst(W * (0.18 + Math.random() * 0.64), H * (0.15 + Math.random() * 0.45), true); } // bouquet final
    x.globalCompositeOperation = 'lighter';
    parts.forEach(p => {
      if (p.flash) {
        p.life -= p.decay;
        const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, 'rgba(255,255,255,' + Math.max(0, p.life * 0.55) + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill();
        return;
      }
      p.vy += 0.055; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
      x.globalAlpha = Math.max(0, p.life);
      x.fillStyle = p.col; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill();
    });
    x.globalAlpha = 1;
    parts = parts.filter(p => p.life > 0);
    if (el < 2000) requestAnimationFrame(frame);
    else c.remove();
  }
  requestAnimationFrame(frame);
}

// ---------- wire up ----------
$('btn-toggle-modules').addEventListener('click', () => {
  const panel = $('modules-panel');
  const arrow = $('modules-arrow');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  arrow.classList.toggle('open', opening);
});

document.querySelectorAll('.lang-chip').forEach(c => c.addEventListener('click', () => selectLang(c.dataset.lang)));
$('btn-magazine').addEventListener('click', () => openMagazine(MAG_BY_LANG[state.lang]));
document.querySelectorAll('.dir-chip').forEach(c => c.addEventListener('click', () => { state.dir = c.dataset.dir; renderChips('.dir-chip', state.dir, 'dir'); }));
document.querySelectorAll('.count-chip').forEach(c => c.addEventListener('click', () => { state.count = +c.dataset.count; renderChips('.count-chip', state.count, 'count'); }));
$('btn-level-all').addEventListener('click', () => {
  LANGS[state.lang].levels.filter(l => l !== 'Global').forEach(l => state.selectedLevels.add(l));
  state.level = [...state.selectedLevels].join('+');
  renderLevelChips(); renderStats();
});
$('btn-level-none').addEventListener('click', () => {
  state.selectedLevels.clear();
  state.level = 'Global';
  renderLevelChips(); renderStats();
});

function exitToHome() {
  clearTimeout(autoNextTimer);
  try { speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
  if (['verbs', 'grammar', 'faux-amis', 'familles', 'cognates', 'tenses', 'phrases'].includes(state.kind)) { state.kind = 'vocab'; state.words = cache[state.lang] || state.words; }
  showView('home'); renderStats();
}

$('btn-start').addEventListener('click', () => { state.kind = 'vocab'; startSession('srs'); });
$('btn-review').addEventListener('click', () => { state.kind = 'vocab'; startSession('review'); });
$('btn-next').addEventListener('click', goNext);
$('btn-abort').addEventListener('click', exitToHome);
$('btn-speak').addEventListener('click', () => { const q = state.questions[state.index]; if (q) speak(q.foreign); });
$('btn-replay').addEventListener('click', () => {
  if (state.mode === 'pronun') { startPronunciation(); return; }
  startSession(state.mode);
});
$('btn-home').addEventListener('click', exitToHome);

// ---------- verbes irréguliers (menu dédié) ----------
function renderVerbsMenu() {
  renderChips('.vform-chip', state.verbForm, 'vform');
  renderChips('.vcount-chip', state.count, 'count');
  const srs = getSrs(VERBS_KEY);
  const st = loadStats(VERBS_KEY);
  const list = verbsData || [];
  let c = 0, w = 0, seen = 0, mastered = 0;
  list.forEach(it => { const e = srs[it.word]; if (e && e.seen > 0) { seen++; c += e.correct; w += e.wrong; if (e.box >= 4) mastered++; } });
  const acc = (c + w) ? Math.round(100 * c / (c + w)) : 0;
  $('verbs-summary').innerHTML = [
    ['Quiz', st.totalCompleted], ['Points', st.totalPoints], ['Précision', acc + '%'],
    ['Vus', seen + ' / ' + list.length], ['Maîtrisés', mastered], ['Record', st.bestStreak || 0],
  ].map(([l, v]) => `<div class="stile"><b>${v}</b><span>${l}</span></div>`).join('');
  const wrong = wrongList(list, srs).length;
  $('verbs-review-count').textContent = wrong;
  $('btn-verbs-review').disabled = wrong === 0;
  $('verbs-select-panel').classList.toggle('hidden', !verbSelectPanelOpen);
}

function renderVerbCheckboxes() {
  const container = $('verbs-select-list');
  if (!container || !verbsData) return;
  if (verbSelectedWords.size === 0) verbsData.forEach(v => verbSelectedWords.add(v.inf));
  container.innerHTML = verbsData.map(v =>
    `<label class="concept-item">
      <input type="checkbox" class="verb-cb" data-inf="${esc(v.inf)}" ${verbSelectedWords.has(v.inf) ? 'checked' : ''} />
      <span class="concept-label"><b>${esc(display(v.inf))}</b> <span style="color:var(--text-dim);">— ${esc(display(v.fr))}</span></span>
    </label>`
  ).join('');
  container.querySelectorAll('.verb-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) verbSelectedWords.add(cb.dataset.inf);
      else verbSelectedWords.delete(cb.dataset.inf);
    });
  });
}

async function openVerbs() {
  if (!verbsData) {
    verbsData = await (await fetch(VERBS_FILE)).json();
    verbsData.forEach(v => { v.word = v.inf; });   // clé SRS = infinitif
  }
  renderVerbsMenu();
  renderVerbCheckboxes();
  showView('verbs');
}

function startVerbs(mode) {
  state.kind = 'verbs';
  state.level = 'Global';      // pas de filtrage par niveau pour les verbes
  state.words = verbsData;
  startSession(mode);
}

$('btn-verbs').addEventListener('click', openVerbs);
document.querySelectorAll('.vform-chip').forEach(c => c.addEventListener('click', () => { state.verbForm = c.dataset.vform; renderChips('.vform-chip', state.verbForm, 'vform'); }));
document.querySelectorAll('.vcount-chip').forEach(c => c.addEventListener('click', () => { state.count = +c.dataset.count; renderChips('.vcount-chip', state.count, 'count'); }));
$('btn-verbs-start').addEventListener('click', () => startVerbs('srs'));
$('btn-verbs-review').addEventListener('click', () => startVerbs('review'));
$('btn-verbs-home').addEventListener('click', () => showView('home'));

$('btn-toggle-vsel').addEventListener('click', () => {
  verbSelectPanelOpen = !verbSelectPanelOpen;
  $('verbs-select-panel').classList.toggle('hidden', !verbSelectPanelOpen);
  $('btn-toggle-vsel').textContent = verbSelectPanelOpen ? '▲ Masquer la sélection' : '🎯 Quiz personnalisé — choisir les verbes';
});
$('btn-vsel-all').addEventListener('click', () => {
  if (verbsData) verbsData.forEach(v => verbSelectedWords.add(v.inf));
  renderVerbCheckboxes();
});
$('btn-vsel-none').addEventListener('click', () => {
  verbSelectedWords.clear();
  renderVerbCheckboxes();
});
$('btn-verbs-custom').addEventListener('click', () => {
  if (!verbsData) return;
  if (verbSelectedWords.size === 0) verbsData.forEach(v => verbSelectedWords.add(v.inf));
  const items = shuffle(verbsData.filter(v => verbSelectedWords.has(v.inf))).slice(0, state.count);
  if (!items.length) return;
  state.kind = 'verbs';
  state.level = 'Global';
  state.badge = verbBadge();
  state.mode = 'srs';
  state.questions = items.map(it => buildVerbQuestion(it, verbsData));
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
});

// ---------- grammaire (menu dédié, contenu explicatif) ----------
const GRAMMAR_FILES = { en: 'data/grammar_en.json', es: 'data/grammar_es.json' };
const GRAMMAR_LABELS = { en: '🇬🇧 Grammaire anglaise', es: '🇪🇸 Grammaire espagnole' };
let grammarLang = 'en';
let grammarData = null;
let grammarCache = {};
let grammarScrollY = 0;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderGrammarList(restoreScroll) {
  $('grammar-title').textContent = GRAMMAR_LABELS[grammarLang] || '📖 Grammaire';
  $('grammar-crumb').textContent = 'Sommaire';
  $('grammar-detail').classList.add('hidden');
  $('btn-grammar-back').classList.add('hidden');
  const isEn = grammarLang === 'en';
  $('btn-grammar-quiz').classList.toggle('hidden', !isEn);
  $('btn-grammar-learn').classList.toggle('hidden', !isEn);
  $('btn-toggle-ai').classList.toggle('hidden', !isEn);
  if (!isEn) $('grammar-ai-panel').classList.add('hidden');
  else $('grammar-ai-panel').classList.toggle('hidden', !grammarCustomPanelOpen);
  document.querySelectorAll('.glang-chip').forEach(c => c.classList.toggle('active', c.dataset.lang === grammarLang));
  const list = $('grammar-list');
  list.classList.remove('hidden');
  list.innerHTML = (grammarData || []).map((t, i) =>
    `<button class="grammar-item" data-idx="${i}"><span class="gi-title">${esc(t.title)}</span><span class="gi-sub">${esc(t.subtitle || '')}</span></button>`
  ).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => { grammarScrollY = window.scrollY; showGrammarTopic(+b.dataset.idx); }));
  if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, grammarScrollY));
  renderConceptCheckboxes();
}

function showGrammarTopic(idx) {
  const t = grammarData[idx];
  if (!t) return;
  $('grammar-crumb').textContent = t.title;
  $('btn-toggle-ai').classList.add('hidden');
  $('grammar-ai-panel').classList.add('hidden');
  $('btn-grammar-quiz').classList.add('hidden');
  $('btn-grammar-learn').classList.add('hidden');
  const videoBtn = t.videoUrl
    ? `<a class="btn-video" href="${esc(t.videoUrl)}" target="_blank" rel="noopener">🇬🇧 ${esc(t.videoTitle || 'Voir la vidéo')}</a>`
    : '';
  const videoBtnFr = t.videoUrlFr
    ? `<a class="btn-video btn-video-fr" href="${esc(t.videoUrlFr)}" target="_blank" rel="noopener">🇫🇷 ${esc(t.videoTitleFr || 'Voir la vidéo en français')}</a>`
    : '';
  const html = videoBtn + videoBtnFr +
    (t.sections || []).map(sec =>
    `<div class="card gram-section">
      <h3 class="gram-h3">${esc(sec.heading)}</h3>
      <ul class="gram-points">${(sec.points || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      ${(sec.examples && sec.examples.length) ? `<div class="gram-ex">${sec.examples.map(e => `<div class="gex-row"><span class="gex-en">${esc(e.en)}</span><span class="gex-fr">${esc(e.fr)}</span></div>`).join('')}</div>` : ''}
    </div>`
  ).join('') +
    ((grammarQuizTopics && grammarQuizTopics.has(t.id))
      ? `<button class="primary gram-practice" data-topic="${esc(t.id)}">🧩 S'entraîner sur ce point</button>`
      : '');
  const detail = $('grammar-detail');
  detail.innerHTML = html;
  const practice = detail.querySelector('.gram-practice');
  if (practice) practice.addEventListener('click', () => startGrammarQuiz(t.id));
  detail.querySelectorAll('.btn-video').forEach(vlink => {
    vlink.addEventListener('click', e => {
      e.preventDefault();
      const url = vlink.href;
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
        window.Capacitor.Plugins.Browser.open({ url });
      } else {
        window.open(url, '_blank');
      }
    });
  });
  detail.classList.remove('hidden');
  $('grammar-list').classList.add('hidden');
  $('btn-grammar-quiz').classList.add('hidden');
  $('btn-grammar-back').classList.remove('hidden');
  window.scrollTo(0, 0);
}

let grammarCustomCount = 5;
let grammarSelectedTopics = new Set();  // IDs des topics sélectionnés
let grammarCustomPanelOpen = false;

function renderConceptCheckboxes() {
  const container = $('grammar-concepts');
  if (!container || !grammarData) return;
  if (grammarSelectedTopics.size === 0) grammarData.forEach(t => grammarSelectedTopics.add(t.id));
  container.innerHTML = grammarData.map(t =>
    `<label class="concept-item">
      <input type="checkbox" class="concept-cb" data-id="${esc(t.id)}" ${grammarSelectedTopics.has(t.id) ? 'checked' : ''} />
      <span class="concept-label">${esc(t.title)}${t.subtitle ? ' <span style="color:var(--text-dim);font-size:12px;">— ' + esc(t.subtitle) + '</span>' : ''}</span>
    </label>`
  ).join('');
  container.querySelectorAll('.concept-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) grammarSelectedTopics.add(cb.dataset.id);
      else grammarSelectedTopics.delete(cb.dataset.id);
    });
  });
}

let grammarQuizTopics = null;   // topics ayant des questions de quiz (initialisé après le générateur)
function startGrammarQuiz(topicId) {
  const topics = topicId ? [topicId] : Object.keys(_GFIX);
  const count = state.count;
  const items = [];
  for (let i = 0; i < count; i++) {
    const t = topics[i % topics.length];
    const item = generateGrammarItem(t);
    if (item) items.push(item);
  }
  if (!items.length) return;
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = topicId ? (grammarData && grammarData.find(t => t.id === topicId) ? grammarData.find(t => t.id === topicId).title : topicId) : 'Grammaire';
  state.mode = 'srs';
  state.questions = shuffle(items).map(item => {
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + item.topic;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

async function loadGrammarLang(lang) {
  grammarLang = lang;
  if (!grammarCache[lang]) {
    grammarCache[lang] = await (await fetch(GRAMMAR_FILES[lang])).json();
  }
  grammarData = grammarCache[lang];
  grammarQuizTopics = new Set(Object.keys(_GFIX));
}

async function openGrammar() {
  await loadGrammarLang(grammarLang);
  grammarScrollY = 0;
  renderGrammarList(false);
  showView('grammar');
}

document.querySelectorAll('.glang-chip').forEach(c => c.addEventListener('click', async () => {
  if (c.dataset.lang === grammarLang) return;
  await loadGrammarLang(c.dataset.lang);
  grammarScrollY = 0;
  renderGrammarList(false);
}));

$('btn-grammar').addEventListener('click', openGrammar);
$('btn-grammar-quiz').addEventListener('click', () => startGrammarQuiz(null));
$('btn-grammar-back').addEventListener('click', () => renderGrammarList(true));
$('btn-grammar-home').addEventListener('click', () => showView('home'));

$('btn-toggle-ai').addEventListener('click', () => {
  grammarCustomPanelOpen = !grammarCustomPanelOpen;
  $('grammar-ai-panel').classList.toggle('hidden', !grammarCustomPanelOpen);
  $('btn-toggle-ai').textContent = grammarCustomPanelOpen ? '▲ Masquer la sélection' : '🎯 Quiz personnalisé — choisir les concepts';
});

$('btn-sel-all').addEventListener('click', () => {
  if (grammarData) grammarData.forEach(t => grammarSelectedTopics.add(t.id));
  renderConceptCheckboxes();
});
$('btn-sel-none').addEventListener('click', () => {
  grammarSelectedTopics.clear();
  renderConceptCheckboxes();
});

document.querySelectorAll('.gcount-chip').forEach(c => {
  c.addEventListener('click', () => {
    grammarCustomCount = +c.dataset.count;
    renderChips('.gcount-chip', grammarCustomCount, 'count');
  });
});

$('btn-grammar-ai').addEventListener('click', () => {
  if (grammarSelectedTopics.size === 0) grammarData.forEach(t => grammarSelectedTopics.add(t.id));
  const topics = [...grammarSelectedTopics].filter(t => _GFIX[t]);
  if (!topics.length) return;
  const items = [];
  for (let i = 0; i < grammarCustomCount; i++) {
    const item = generateGrammarItem(topics[i % topics.length]);
    if (item) items.push(item);
  }
  if (!items.length) return;
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = 'Grammaire';
  state.mode = 'srs';
  state.questions = shuffle(items).map(item => {
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + item.topic;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
});

// ---------- faux amis ----------
const FAUX_AMIS_FILE = 'data/faux_amis_en.json';
let fauxAmisData = null;
let fauxAmisScrollY = 0;

function renderFauxAmisList(restoreScroll) {
  $('faux-amis-detail').classList.add('hidden');
  $('btn-faux-amis-back').classList.add('hidden');
  $('btn-faux-amis-quiz').classList.remove('hidden');
  const list = $('faux-amis-list');
  list.classList.remove('hidden');
  list.innerHTML = (fauxAmisData || []).map((f, i) =>
    `<button class="grammar-item" data-idx="${i}"><span class="gi-title">${esc(f.en)}</span><span class="gi-sub">≠ ${esc(f.trap)}</span></button>`
  ).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => { fauxAmisScrollY = window.scrollY; showFauxAmi(+b.dataset.idx); })
  );
  if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, fauxAmisScrollY));
}

function showFauxAmi(idx) {
  const f = fauxAmisData[idx];
  if (!f) return;
  $('btn-faux-amis-back').classList.remove('hidden');
  $('btn-faux-amis-quiz').classList.add('hidden');
  $('faux-amis-list').classList.add('hidden');
  const detail = $('faux-amis-detail');
  detail.innerHTML = `
    <div class="card fa-card">
      <div class="fa-word">${esc(f.en)}</div>
      <div class="fa-trap">
        <span class="fa-trap-label">⚠️ Confusion fréquente</span>
        <span class="fa-trap-word">${esc(f.trap)}</span>
        <span class="fa-trap-meaning">qui veut dire : ${esc(f.trap_en)}</span>
      </div>
      <div class="fa-correct">
        <span class="fa-correct-label">✅ Traduction correcte</span>
        <span class="fa-correct-word">${esc(f.fr)}</span>
      </div>
      <div class="gex-row fa-example">
        <span class="gex-en">${esc(f.example.en)}</span>
        <span class="gex-fr">${esc(f.example.fr)}</span>
      </div>
      ${f.tip ? `<div class="fa-tip">💡 ${esc(f.tip)}</div>` : ''}
    </div>
  `;
  detail.classList.remove('hidden');
  window.scrollTo(0, 0);
}

function buildFauxAmiQuestion(item, allItems) {
  const correct = item.fr.split(' / ')[0].trim();
  const trap = item.trap;
  const others = shuffle(
    allItems.filter(f => f.id !== item.id).map(f => f.fr.split(' / ')[0].trim()).filter(v => v !== correct && v !== trap)
  ).slice(0, 2);
  const options = shuffle([correct, trap, ...others]);
  return {
    word: item.id,
    foreign: item.en,
    promptText: item.en,
    promptLabel: 'Que veut dire…',
    promptIsForeign: true,
    options,
    correctIndex: options.indexOf(correct),
    correctText: correct,
    hint: item.tip || `"${item.trap}" = ${item.trap_en}`,
  };
}

async function openFauxAmis() {
  if (!fauxAmisData) fauxAmisData = await (await fetch(FAUX_AMIS_FILE)).json();
  renderFauxAmisList();
  renderChips('.facount-chip', state.count, 'count');
  showView('faux-amis');
}

function startFauxAmisQuiz() {
  if (!fauxAmisData || !fauxAmisData.length) return;
  state.kind = 'faux-amis';
  state.badge = 'Faux amis';
  state.mode = 'srs';
  const picks = shuffle(fauxAmisData).slice(0, state.count);
  state.questions = picks.map(item => buildFauxAmiQuestion(item, fauxAmisData));
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

$('btn-faux-amis').addEventListener('click', openFauxAmis);
$('btn-faux-amis-home').addEventListener('click', () => showView('home'));
$('btn-faux-amis-back').addEventListener('click', () => renderFauxAmisList(true));
$('btn-faux-amis-quiz').addEventListener('click', startFauxAmisQuiz);
document.querySelectorAll('.facount-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.facount-chip', state.count, 'count');
}));

// ---------- familles de mots ----------
const FAMILLES_FILE = 'data/word_families_en.json';
let famillesData = null;
let famillesScrollY = 0;

function renderFamillesList(restoreScroll) {
  $('familles-detail').classList.add('hidden');
  $('btn-familles-back').classList.add('hidden');
  $('btn-familles-quiz').classList.remove('hidden');
  const list = $('familles-list');
  list.classList.remove('hidden');
  list.innerHTML = (famillesData || []).map((f, i) =>
    `<button class="grammar-item" data-idx="${i}"><span class="gi-title">${esc(f.root)}</span><span class="gi-sub">${esc(f.fr_root)}</span></button>`
  ).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => { famillesScrollY = window.scrollY; showFamille(+b.dataset.idx); })
  );
  if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, famillesScrollY));
}

function showFamille(idx) {
  const f = famillesData[idx];
  if (!f) return;
  $('btn-familles-back').classList.remove('hidden');
  $('btn-familles-quiz').classList.add('hidden');
  $('familles-list').classList.add('hidden');
  const detail = $('familles-detail');
  detail.innerHTML = `
    <div class="card fam-card">
      <div class="fam-root">🔤 ${esc(f.root)}</div>
      <div class="fam-fr-root">${esc(f.fr_root)}</div>
      <div class="fam-words">
        ${f.words.map(w => `
          <div class="fam-word-row">
            <span class="fam-word">${esc(w.word)}</span>
            <span class="fam-pos">${esc(w.pos)}</span>
            <span class="fam-fr">${esc(w.fr)}</span>
          </div>
        `).join('')}
      </div>
      ${f.tip ? `<div class="fa-tip">💡 ${esc(f.tip)}</div>` : ''}
    </div>
  `;
  detail.classList.remove('hidden');
  window.scrollTo(0, 0);
}

function buildFamilleQuestion(family, allFamilies) {
  const wordObj = family.words[Math.floor(Math.random() * family.words.length)];
  const correct = wordObj.word;
  const others = shuffle(
    allFamilies.filter(f => f.id !== family.id).flatMap(f => f.words.map(w => w.word)).filter(w => w !== correct)
  ).slice(0, 3);
  const options = shuffle([correct, ...others]);
  return {
    word: family.id + '_' + correct,
    foreign: correct,
    promptText: wordObj.fr,
    promptLabel: 'Quel mot anglais correspond à…',
    promptIsForeign: false,
    options,
    correctIndex: options.indexOf(correct),
    correctText: correct,
    hint: family.tip,
  };
}

async function openFamilles() {
  if (!famillesData) famillesData = await (await fetch(FAMILLES_FILE)).json();
  renderFamillesList();
  renderChips('.famcount-chip', state.count, 'count');
  showView('familles');
}

function startFamillesQuiz() {
  if (!famillesData || !famillesData.length) return;
  state.kind = 'familles';
  state.badge = 'Familles de mots';
  state.mode = 'srs';
  const picks = shuffle(famillesData).slice(0, state.count);
  state.questions = picks.map(item => buildFamilleQuestion(item, famillesData));
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

$('btn-familles').addEventListener('click', openFamilles);
$('btn-familles-home').addEventListener('click', () => showView('home'));
$('btn-familles-back').addEventListener('click', () => renderFamillesList(true));
$('btn-familles-quiz').addEventListener('click', startFamillesQuiz);
document.querySelectorAll('.famcount-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.famcount-chip', state.count, 'count');
}));

// ---------- vrais cognates ----------
const COGNATES_FILE = 'data/cognates_en.json';
let cognatesData = null;
let cognatesScrollY = 0;

function renderCognatesList(restoreScroll) {
  $('cognates-detail').classList.add('hidden');
  $('btn-cognates-back').classList.add('hidden');
  $('btn-cognates-quiz').classList.remove('hidden');
  const list = $('cognates-list');
  list.classList.remove('hidden');
  list.innerHTML = (cognatesData || []).map((c, i) =>
    `<button class="grammar-item" data-idx="${i}"><span class="gi-title">${esc(c.pattern)}</span><span class="gi-sub">${esc(c.examples.slice(0, 3).map(e => e.en).join(', '))}…</span></button>`
  ).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => { cognatesScrollY = window.scrollY; showCognate(+b.dataset.idx); })
  );
  if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, cognatesScrollY));
}

function showCognate(idx) {
  const c = cognatesData[idx];
  if (!c) return;
  $('btn-cognates-back').classList.remove('hidden');
  $('btn-cognates-quiz').classList.add('hidden');
  $('cognates-list').classList.add('hidden');
  const detail = $('cognates-detail');
  detail.innerHTML = `
    <div class="card cog-card">
      <div class="cog-pattern">${esc(c.pattern)}</div>
      <div class="cog-rule">${esc(c.rule)}</div>
      <div class="cog-examples">
        ${c.examples.map(e => `
          <div class="cog-ex-row">
            <span class="cog-en">${esc(e.en)}</span>
            <span class="cog-arrow">→</span>
            <span class="cog-fr">${esc(e.fr)}</span>
          </div>
        `).join('')}
      </div>
      ${c.tip ? `<div class="fa-tip">💡 ${esc(c.tip)}</div>` : ''}
    </div>
  `;
  detail.classList.remove('hidden');
  window.scrollTo(0, 0);
}

function buildCognateQuestion(item, allItems) {
  const correct = item.quiz_fr_clean || item.quiz_fr;
  const others = shuffle(
    allItems.filter(x => x.id !== item.id).map(x => x.quiz_fr_clean || x.quiz_fr).filter(v => v !== correct)
  ).slice(0, 3);
  const options = shuffle([correct, ...others]);
  return {
    word: item.id,
    foreign: item.quiz_en,
    promptText: item.quiz_en,
    promptLabel: 'Que veut dire…',
    promptIsForeign: true,
    options,
    correctIndex: options.indexOf(correct),
    correctText: correct,
    hint: item.tip,
  };
}

async function openCognates() {
  if (!cognatesData) cognatesData = await (await fetch(COGNATES_FILE)).json();
  renderCognatesList();
  renderChips('.cogcount-chip', state.count, 'count');
  showView('cognates');
}

function startCognatesQuiz() {
  if (!cognatesData || !cognatesData.length) return;
  state.kind = 'cognates';
  state.badge = 'Cognates';
  state.mode = 'srs';
  const picks = shuffle(cognatesData).slice(0, state.count);
  state.questions = picks.map(item => buildCognateQuestion(item, cognatesData));
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

$('btn-cognates').addEventListener('click', openCognates);
$('btn-cognates-home').addEventListener('click', () => showView('home'));
$('btn-cognates-back').addEventListener('click', () => renderCognatesList(true));
$('btn-cognates-quiz').addEventListener('click', startCognatesQuiz);
document.querySelectorAll('.cogcount-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.cogcount-chip', state.count, 'count');
}));

// ---------- mode Apprendre (flashcards, partagé vocab / verbes / grammaire) ----------
function buildCard(item) {
  if (state.kind === 'verbs') {
    return { key: item.word, label: 'Verbe', audio: display(item.inf),
      front: display(item.inf) + ' — ' + display(item.fr),
      backHtml: 'Prétérit : <b>' + esc(display(item.pret)) + '</b><br>Participe passé : <b>' + esc(display(item.pp)) + '</b>' };
  }
  if (state.kind === 'grammar') {
    const full = item.q.replace('___', item.answer);
    return { key: item.id, label: 'Complète la phrase', audio: full, front: item.q,
      backHtml: '<b>' + esc(full) + '</b>' + (item.hint ? '<br>💡 ' + esc(item.hint) : '') };
  }
  return { key: item.word, label: 'Mot', audio: display(item.word), ipa: item.ipa || '',
    front: display(item.word), backHtml: '<b>' + esc(display(item.fr)) + '</b>' };
}

const learnState = { cards: [], idx: 0 };
function startLearn() {
  learnState.cards = pickSession('srs').map(buildCard);
  if (!learnState.cards.length) return;
  learnState.idx = 0;
  state.badge = state.kind === 'verbs' ? verbBadge() : state.level;
  showView('learn'); renderCard();
}
function renderCard() {
  clearTimeout(autoNextTimer);
  const c = learnState.cards[learnState.idx];
  $('learn-progress').textContent = `Carte ${learnState.idx + 1}/${learnState.cards.length}`;
  $('learn-badge').textContent = state.kind === 'grammar' ? 'Grammaire' : (state.kind === 'verbs' ? 'Verbes' : state.badge);
  $('flash-label').textContent = c.label;
  $('flash-front').textContent = c.front;
  $('flash-front').classList.toggle('sentence', state.kind === 'grammar');
  $('flash-ipa').textContent = c.ipa ? '/' + c.ipa + '/' : '';
  const back = $('flash-back'); back.innerHTML = c.backHtml; back.classList.add('hidden');
  $('btn-flash-speak').style.display = (state.kind === 'grammar') ? 'none' : '';
  $('btn-flash-reveal').classList.remove('hidden');
  $('flash-grade').classList.add('hidden');
  if (state.kind !== 'grammar' && settings.audioAuto) speak(c.audio);
}
function revealCard() {
  const c = learnState.cards[learnState.idx];
  $('flash-back').classList.remove('hidden');
  $('btn-flash-reveal').classList.add('hidden');
  $('flash-grade').classList.remove('hidden');
  if (settings.audioAuto && state.kind === 'grammar') speak(c.audio);
}
function gradeCard(ok) {
  const c = learnState.cards[learnState.idx];
  srsUpdate(quizKey(), c.key, ok); saveSrs(quizKey()); logDaily(quizKey(), ok);
  if (learnState.idx < learnState.cards.length - 1) { learnState.idx++; renderCard(); }
  else exitToHome();
}

$('btn-learn').addEventListener('click', () => { state.kind = 'vocab'; state.words = cache[state.lang] || state.words; startLearn(); });
$('btn-verbs-learn').addEventListener('click', () => { if (!verbsData) return; state.kind = 'verbs'; state.level = 'Global'; state.words = verbsData; startLearn(); });
$('btn-grammar-learn').addEventListener('click', () => {
  state.kind = 'grammar'; state.level = 'Global';
  state.words = Object.keys(_GFIX).flatMap(topic =>
    _GFIX[topic].map(t => Object.assign({ word: 'gen-' + topic }, _mkItem(topic, t.q, t.opts, t.ans, t.hint)))
  );
  startLearn();
});
$('btn-flash-reveal').addEventListener('click', revealCard);
$('btn-flash-speak').addEventListener('click', () => { const c = learnState.cards[learnState.idx]; if (c) speak(c.audio); });
$('btn-flash-ok').addEventListener('click', () => gradeCard(true));
$('btn-flash-again').addEventListener('click', () => gradeCard(false));
$('btn-learn-abort').addEventListener('click', exitToHome);

// ---------- réseau (CapacitorHttp natif, sinon fetch + repli proxy) ----------
async function httpGetText(url) {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.CapacitorHttp) {
    const r = await cap.Plugins.CapacitorHttp.get({ url, responseType: 'text', connectTimeout: 15000, readTimeout: 15000 });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }
  try { const r = await fetch(url); if (r.ok) return await r.text(); throw 0; }
  catch (e) { const r = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(url)); return await r.text(); }
}


// ---------- prononciation ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const pronunState = {
  words: [], index: 0, score: 0,
  results: [],  // verdict par mot : 'perfect' | 'good' | 'partial' | 'wrong' | null
  listening: false,
  busy: false,   // vrai pendant 400ms après chaque changement de carte (évite les doubles appels)
};

function evaluatePronun(recognized, target) {
  const norm = s => s.toLowerCase().trim().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ');
  const r = norm(recognized), t = norm(target);
  if (r === t) return 'perfect';
  const rSet = new Set(r.split(' ')), tWords = t.split(' ');
  if (tWords.every(w => rSet.has(w))) return 'good';
  const hits = tWords.filter(w => rSet.has(w)).length;
  return hits / tWords.length >= 0.5 ? 'partial' : 'wrong';
}

function hasSpeechCapability() {
  const cap = window.Capacitor;
  return !!(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.SpeechRecognition) || !!SR;
}

async function startPronunciation() {
  if (!hasSpeechCapability()) { alert('La reconnaissance vocale n\'est pas disponible sur cet appareil.'); return; }
  if (!cache[state.lang]) cache[state.lang] = await (await fetch(LANGS[state.lang].file)).json();
  state.words = cache[state.lang];
  const picks = shuffle(levelWords()).slice(0, state.count);
  if (!picks.length) return;
  pronunState.words = picks;
  pronunState.index = 0;
  pronunState.score = 0;
  pronunState.results = picks.map(() => null);
  pronunState.listening = false;
  state.mode = 'pronun';
  state.kind = 'vocab';
  showView('pronun');
  renderPronunCard();
}

function renderPronunCard() {
  pronunState.busy = true;
  clearTimeout(pronunState._autoTimer);
  setTimeout(() => { pronunState.busy = false; }, 400);
  const w = pronunState.words[pronunState.index];
  const total = pronunState.words.length;
  $('pronun-progress').textContent = `Mot ${pronunState.index + 1}/${total}`;
  $('pronun-bar').style.width = (pronunState.index / total * 100) + '%';
  $('pronun-word').textContent = display(w.word);
  $('pronun-ipa').textContent = w.ipa ? '/' + w.ipa + '/' : '';
  $('pronun-translation').textContent = display(w.fr);
  $('pronun-feedback').className = 'feedback hidden';
  $('pronun-feedback').innerHTML = '';
  $('pronun-recognized').classList.add('hidden');
  $('btn-pronun-next').disabled = true;
  $('btn-pronun-next').textContent = pronunState.index < total - 1 ? 'Suivant' : 'Voir le score';
  $('btn-pronun-mic').className = 'mic-btn';
  $('pronun-mic-hint').textContent = 'Appuie pour parler';
  if (settings.audioAuto) speak(display(w.word));
}

async function startListening() {
  if (pronunState.listening || pronunState.busy) return;
  if (!hasSpeechCapability()) {
    $('pronun-mic-hint').textContent = 'Reconnaissance vocale non disponible sur cet appareil.';
    return;
  }

  const w = pronunState.words[pronunState.index];
  const target = display(w.word);
  pronunState.listening = true;
  $('btn-pronun-mic').className = 'mic-btn mic-active';
  $('pronun-mic-hint').textContent = 'Écoute en cours…';

  const cap = window.Capacitor;
  const capSR = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.SpeechRecognition;

  if (capSR) {
    const srStart = () => capSR.start({
      language: LANGS[state.lang].tts,
      maxResults: 5,
      partialResults: false,
      popup: false,
    });

    const silentRetry = async (delay) => {
      await new Promise(r => setTimeout(r, delay));
      try { return await srStart(); } catch (_) { return null; }
    };

    try {
      let result;
      try {
        result = await srStart();
      } catch (startErr) {
        const errCode = String(startErr && (startErr.message || startErr.code || startErr)).toLowerCase();
        if (/permission|missing/i.test(errCode)) {
          try { await capSR.requestPermissions(); } catch (_) {}
          result = await srStart();
        } else if (/no.match|no_match|speech.timeout/i.test(errCode)) {
          // Cold-start Android : le service Google Speech n'était pas prêt.
          $('pronun-mic-hint').textContent = 'Réessai…';
          result = await silentRetry(400);
        } else if (/busy|recognizer/i.test(errCode)) {
          $('pronun-mic-hint').textContent = 'Réessai…';
          result = await silentRetry(600);
        } else {
          throw startErr;
        }
      }

      pronunState.listening = false;
      const matches = result && result.matches ? Array.from(result.matches) : [];
      if (matches.length) {
        let best = matches[0];
        for (const alt of matches) {
          if (evaluatePronun(alt, target) !== 'wrong') { best = alt; break; }
        }
        showPronunFeedback(evaluatePronun(best, target), best);
      } else {
        $('btn-pronun-mic').className = 'mic-btn';
        $('pronun-mic-hint').textContent = 'Aucune voix détectée — réessaie.';
      }
    } catch (err) {
      pronunState.listening = false;
      $('btn-pronun-mic').className = 'mic-btn';
      const code = String(err && (err.message || err.code || err) || '').toLowerCase();
      if (/permission|missing/i.test(code)) {
        $('pronun-mic-hint').textContent = 'Micro refusé — Réglages → Applis → VocaLang → Micro.';
      } else if (/not.available|unavailable/i.test(code)) {
        $('pronun-mic-hint').textContent = 'Reconnaissance vocale non disponible.';
      } else {
        $('pronun-mic-hint').textContent = 'Erreur micro — réessaie.';
      }
    }
    return;
  }

  // Fallback : Web Speech API (Chrome desktop/mobile)
  let rec;
  try { rec = new SR(); } catch (err) {
    pronunState.listening = false;
    $('btn-pronun-mic').className = 'mic-btn';
    $('pronun-mic-hint').textContent = 'Impossible d\'initialiser le micro : ' + err.message;
    return;
  }
  rec.lang = LANGS[state.lang].tts;
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 5;

  rec.onresult = (e) => {
    const alts = Array.from(e.results[0]).map(a => a.transcript);
    let best = alts[0];
    for (const alt of alts) {
      if (evaluatePronun(alt, target) !== 'wrong') { best = alt; break; }
    }
    pronunState.listening = false;
    showPronunFeedback(evaluatePronun(best, target), best);
  };
  rec.onerror = (e) => {
    pronunState.listening = false;
    $('btn-pronun-mic').className = 'mic-btn';
    const msg = {
      'not-allowed': 'Permission micro refusée — autorise le micro dans les réglages.',
      'no-speech': 'Aucune voix détectée — réessaie.',
      'network': 'Erreur réseau — la reconnaissance vocale nécessite une connexion.',
      'service-not-allowed': 'Service vocal non autorisé sur cet appareil.',
    };
    $('pronun-mic-hint').textContent = msg[e.error] || ('Erreur micro : ' + e.error);
  };
  rec.onend = () => { pronunState.listening = false; };
  try { rec.start(); } catch (err) {
    pronunState.listening = false;
    $('btn-pronun-mic').className = 'mic-btn';
    $('pronun-mic-hint').textContent = 'Impossible de démarrer le micro : ' + err.message;
  }
}

function showPronunFeedback(verdict, recognized) {
  $('btn-pronun-mic').className = 'mic-btn';
  const rank = { perfect: 3, good: 2, partial: 1, wrong: 0 };
  const prev = pronunState.results[pronunState.index];
  if (rank[verdict] > rank[prev || 'wrong']) {
    pronunState.results[pronunState.index] = verdict;
    pronunState.score = pronunState.results.filter(r => r === 'perfect' || r === 'good').length;
  }
  const labels = { perfect: '🎯 Parfait !', good: '✅ Très bien !', partial: '🟡 Presque…', wrong: '❌ Essaie encore' };
  const cls    = { perfect: 'good', good: 'good', partial: 'warn', wrong: 'bad' };
  const fb = $('pronun-feedback');
  fb.innerHTML = `<div class="fb-head">${labels[verdict]}</div>`;
  fb.className = 'feedback show ' + cls[verdict];
  $('pronun-heard-text').textContent = recognized || '—';
  $('pronun-recognized').classList.remove('hidden');
  $('btn-pronun-next').disabled = false;
  $('pronun-mic-hint').textContent = verdict === 'perfect' ? 'Parfait ! Passage automatique…' : 'Appuie pour réessayer';
  beep(verdict !== 'wrong'); vibrate(verdict !== 'wrong');

  if (verdict === 'perfect') {
    pronunState._autoTimer = setTimeout(() => {
      if (pronunState.index < pronunState.words.length - 1) {
        pronunState.index++; renderPronunCard();
      } else {
        finishPronun();
      }
    }, 1200);
  }
}

function finishPronun() {
  const total = pronunState.words.length;
  const score = pronunState.score;
  $('result-sub').textContent = 'Entraînement de prononciation terminé';
  $('result-score').textContent = `${score}/${total}`;
  const wrong = pronunState.words
    .map((w, i) => ({ word: display(w.word), result: pronunState.results[i] }))
    .filter(x => x.result !== 'perfect' && x.result !== 'good');
  const wbox = $('result-wrong');
  if (wrong.length) {
    wbox.innerHTML = '<span class="wrong-title">À retravailler</span>' +
      wrong.map(x => `<div class="wrong-row"><span class="wrong-word">${esc(x.word)}</span><span class="wrong-answer pronun-verdict">${x.result === 'partial' ? '🟡 Presque' : '❌ Raté'}</span></div>`).join('');
  } else {
    wbox.innerHTML = '<span class="wrong-title">Parfait 🎉</span><span class="wrong-answer">Prononciation impeccable !</span>';
  }
  showView('result');
  if (score === total && total >= 3) launchFireworks();
}

$('btn-pronun').addEventListener('click', startPronunciation);
$('btn-pronun-speak').addEventListener('click', () => {
  const w = pronunState.words[pronunState.index]; if (w) speak(display(w.word));
});
$('btn-pronun-mic').addEventListener('click', startListening);
$('btn-pronun-next').addEventListener('click', () => {
  clearTimeout(pronunState._autoTimer);
  if (pronunState.index < pronunState.words.length - 1) {
    pronunState.index++; renderPronunCard();
  } else {
    finishPronun();
  }
});
$('btn-pronun-abort').addEventListener('click', exitToHome);

// ---------- Écoute : podcasts par accent ----------
const LISTEN_FILE = 'data/listen.json';
let listenData = null, listenLang = state.lang, listenAccent = 0, listenEps = [];

function fmtDur(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.includes(':')) { const p = s.split(':').map(Number); const m = p.length === 3 ? p[0] * 60 + p[1] : p[0]; return m ? m + ' min' : ''; }
  const n = parseInt(s, 10); return n ? Math.round(n / 60) + ' min' : '';
}
function parsePodcast(xmlText, source) {
  let doc; try { doc = new DOMParser().parseFromString(xmlText, 'text/xml'); } catch (e) { return []; }
  const out = [];
  doc.querySelectorAll('item').forEach((it) => {
    const title = (it.querySelector('title') && it.querySelector('title').textContent || '').trim();
    const enc = it.querySelector('enclosure');
    let audio = (enc && (enc.getAttribute('type') || '').startsWith('audio')) ? (enc.getAttribute('url') || '') : '';
    audio = audio.replace(/^http:\/\//, 'https://').replace('/proto/http/', '/proto/https/'); // Android refuse l'audio http
    const date = (it.querySelector('pubDate') && it.querySelector('pubDate').textContent || '').trim();
    let dur = '';
    for (const n of it.getElementsByTagName('*')) { if (n.tagName.toLowerCase() === 'itunes:duration') { dur = fmtDur(n.textContent); break; } }
    if (title && audio) out.push({ title, audio, source, ts: Date.parse(date) || 0, dur });
  });
  return out.slice(0, 15);
}
function listenGroups() { return (listenData && listenData[listenLang]) || []; }
async function openListen() {
  if (!listenData) listenData = await (await fetch(LISTEN_FILE)).json();
  listenLang = state.lang; listenAccent = 0;
  renderListen();
  showView('listen');
}
function renderListen() {
  $('listen-lang').textContent = LANGS[listenLang].label;
  document.querySelectorAll('.slang2-chip').forEach(c => c.classList.toggle('active', c.dataset.lang === listenLang));
  const groups = listenGroups();
  const acc = $('listen-accents');
  acc.innerHTML = groups.map((g, i) => `<button class="chip ${i === listenAccent ? 'active' : ''}" data-i="${i}">${esc(g.accent)}</button>`).join('');
  acc.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { listenAccent = +b.dataset.i; renderListen(); }));
  loadEpisodes(groups[listenAccent]);
}
async function loadEpisodes(group) {
  const box = $('listen-episodes');
  if (!group) { box.innerHTML = ''; return; }
  const key = `quizlangue:listen:${listenLang}:${listenAccent}`;
  const cached = lsGet(key, null);
  if (cached && cached.length) renderEpisodes(cached);
  else box.innerHTML = '<div class="listen-status">Chargement des épisodes…</div>';
  const results = await Promise.allSettled((group.feeds || []).map(async (f) => parsePodcast(await httpGetText(f.url), f.name)));
  if (group !== listenGroups()[listenAccent]) return;   // accent changé
  let eps = [];
  results.forEach(r => { if (r.status === 'fulfilled') eps = eps.concat(r.value); });
  eps.sort((a, b) => b.ts - a.ts); eps = eps.slice(0, 30);
  if (eps.length) { lsSet(key, eps); renderEpisodes(eps); }
  else if (!cached) box.innerHTML = '<div class="listen-status">Aucun épisode (vérifie ta connexion).</div>';
}
function renderEpisodes(eps) {
  listenEps = eps;
  $('listen-episodes').innerHTML = eps.map((e, i) =>
    `<button class="ep" data-i="${i}"><span class="ep-play">▶</span><span class="ep-meta"><b>${esc(e.title)}</b><span class="ep-sub">${esc(e.source)}${e.dur ? ' · ' + esc(e.dur) : ''}</span></span></button>`).join('');
  $('listen-episodes').querySelectorAll('.ep').forEach(b => b.addEventListener('click', () => playEpisode(+b.dataset.i)));
}
function playEpisode(i) {
  const e = listenEps[i]; if (!e || !e.audio) return;
  const src = e.audio.replace(/^http:\/\//, 'https://').replace('/proto/http/', '/proto/https/');
  const box = $('listen-episodes');
  const btn = box.querySelector(`.ep[data-i="${i}"]`); if (!btn) return;
  const old = $('listen-inline'); if (old) old.remove();
  const pl = document.createElement('div');
  pl.id = 'listen-inline'; pl.className = 'ep-player';
  pl.innerHTML = `<div class="listen-now">${esc(e.title)}</div>`
    + `<audio id="listen-audio" controls src="${esc(src)}"></audio>`
    + `<a class="ep-ext" href="${esc(src)}" target="_blank" rel="noopener">Ouvrir dans le navigateur ↗</a>`;
  btn.insertAdjacentElement('afterend', pl);
  const au = pl.querySelector('#listen-audio');
  try { au.load(); au.play().catch(() => {}); } catch (err) {}
  pl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('btn-listen').addEventListener('click', openListen);
$('btn-listen-home').addEventListener('click', () => { const au = $('listen-audio'); if (au) { try { au.pause(); } catch (e) {} } showView('home'); });
document.querySelectorAll('.slang2-chip').forEach(c => c.addEventListener('click', () => { listenLang = c.dataset.lang; listenAccent = 0; renderListen(); }));

// ═══════════════════════════════════════════════════════════════
// GÉNÉRATEUR TEMPS VERBAUX + GRAMMAIRE — questions à la volée
// ═══════════════════════════════════════════════════════════════

// Verbe : [base, 3ps, -ing, past, pp]
const _V = [
  ['go','goes','going','went','gone'],
  ['eat','eats','eating','ate','eaten'],
  ['drink','drinks','drinking','drank','drunk'],
  ['write','writes','writing','wrote','written'],
  ['read','reads','reading','read','read'],
  ['speak','speaks','speaking','spoke','spoken'],
  ['take','takes','taking','took','taken'],
  ['make','makes','making','made','made'],
  ['come','comes','coming','came','come'],
  ['see','sees','seeing','saw','seen'],
  ['know','knows','knowing','knew','known'],
  ['think','thinks','thinking','thought','thought'],
  ['work','works','working','worked','worked'],
  ['play','plays','playing','played','played'],
  ['watch','watches','watching','watched','watched'],
  ['study','studies','studying','studied','studied'],
  ['travel','travels','traveling','traveled','traveled'],
  ['sleep','sleeps','sleeping','slept','slept'],
  ['leave','leaves','leaving','left','left'],
  ['buy','buys','buying','bought','bought'],
  ['bring','brings','bringing','brought','brought'],
  ['teach','teaches','teaching','taught','taught'],
  ['learn','learns','learning','learned','learned'],
  ['finish','finishes','finishing','finished','finished'],
  ['start','starts','starting','started','started'],
  ['live','lives','living','lived','lived'],
  ['move','moves','moving','moved','moved'],
  ['open','opens','opening','opened','opened'],
  ['close','closes','closing','closed','closed'],
  ['call','calls','calling','called','called'],
  ['walk','walks','walking','walked','walked'],
  ['drive','drives','driving','drove','driven'],
  ['swim','swims','swimming','swam','swum'],
  ['sing','sings','singing','sang','sung'],
  ['cook','cooks','cooking','cooked','cooked'],
  ['clean','cleans','cleaning','cleaned','cleaned'],
  ['help','helps','helping','helped','helped'],
  ['visit','visits','visiting','visited','visited'],
  ['meet','meets','meeting','met','met'],
  ['run','runs','running','ran','run'],
];

// Sujet : [pronom, est3ps, be-présent, be-passé]
const _SP = [
  ['I',    false, 'am',  'was'],
  ['you',  false, 'are', 'were'],
  ['he',   true,  'is',  'was'],
  ['she',  true,  'is',  'was'],
  ['we',   false, 'are', 'were'],
  ['they', false, 'are', 'were'],
];

function _rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function _cap(s)   { return s.charAt(0).toUpperCase() + s.slice(1); }
let _genSeq = 0;
function _mkItem(topic, q, opts, ans, hint) {
  return { id: `gen-${topic}-${++_genSeq}`, topic, q, options: opts, answer: ans, hint };
}

// Générateurs paramétriques (sujet × verbe aléatoires)
const _TGEN = {
  'present-simple': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj, is3ps] = sp; const [base, s3, ing, past] = v;
    const correct = is3ps ? s3 : base;
    const ctx = _rnd(['every day','every morning','on weekdays','usually','often']);
    const q = `${_cap(subj)} ___ (${base}) ${ctx}.`;
    const wrongs = shuffle([is3ps ? base : s3, ing, past].filter(f => f !== correct));
    return _mkItem('present-simple', q, shuffle([correct, ...wrongs.slice(0,3)]), correct,
      `Habitude régulière → présent simple. ${is3ps ? `(${subj} → ${s3})` : `(${subj} → base)`}`);
  },
  'present-continuous': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj, , auxPres] = sp; const [base, s3, ing, past] = v;
    const correct = `${auxPres} ${ing}`;
    const wrongAux = ['am','is','are'].filter(a => a !== auxPres);
    const wrongs = shuffle([`${wrongAux[0]} ${ing}`, `${wrongAux[1]} ${ing}`, s3, past]);
    const ctx = _rnd(['right now','at the moment']);
    const q = `${_cap(subj)} ___ (${base}) ${ctx}.`;
    return _mkItem('present-continuous', q, shuffle([correct, ...wrongs.slice(0,3)]), correct,
      `Action en cours → ${subj} ${auxPres} + ${ing}.`);
  },
  'past-simple': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj] = sp; const [base, s3, ing, past, pp] = v;
    const ctx = _rnd(['yesterday','last week','last night','two days ago']);
    const q = `${_cap(subj)} ___ (${base}) ${ctx}.`;
    const wrongs = shuffle([base, ing, pp].filter(f => f !== past));
    return _mkItem('past-simple', q, shuffle([past, ...wrongs.slice(0,3)]), past,
      `Moment passé défini (${ctx}) → prétérit : ${past}.`);
  },
  'past-continuous': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj, , , auxPast] = sp; const [base, s3, ing, past] = v;
    const correct = `${auxPast} ${ing}`;
    const wrongAux = auxPast === 'was' ? 'were' : 'was';
    const wrongs = shuffle([`${wrongAux} ${ing}`, past, `${auxPast} ${past}`]);
    const ctx = _rnd(['when the phone rang','when she arrived','at 9 p.m. yesterday']);
    const q = `${_cap(subj)} ___ (${base}) ${ctx}.`;
    return _mkItem('past-continuous', q, shuffle([correct, ...wrongs.slice(0,3)]), correct,
      `Action en cours dans le passé → ${subj} ${auxPast} + ${ing}.`);
  },
  'present-perfect': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj, is3ps] = sp; const [base, s3, ing, past, pp] = v;
    const hv = is3ps ? 'has' : 'have';
    const ctx = _rnd(['just','already','recently']);
    const q = `${_cap(subj)} ${hv} ${ctx} ___ (${base}).`;
    const wrongs = shuffle([past, ing, base].filter((f, i, a) => a.indexOf(f) === i && f !== pp));
    return _mkItem('present-perfect', q, shuffle([pp, ...wrongs.slice(0,3)]), pp,
      `${ctx} → present perfect : ${hv} ${ctx} + participe passé (${pp}).`);
  },
  'past-perfect': () => {
    const v = _rnd(_V); const sp = _rnd(_SP);
    const [subj] = sp; const [base, s3, ing, past, pp] = v;
    const correct = `had ${pp}`;
    const wrongs = shuffle([past, `has ${pp}`, `had ${ing}`].filter(f => f !== correct));
    const ctx = _rnd(['before I arrived','by the time she came','when we got there']);
    const q = `${_cap(subj)} ___ (${base}) ${ctx}.`;
    return _mkItem('past-perfect', q, shuffle([correct, ...wrongs.slice(0,3)]), correct,
      `Antériorité dans le passé → had + participe passé (${pp}).`);
  },
};

// Banques fixes pour les temps dont la forme ne dépend pas du sujet
const _TFIX = {
  'future-will': [
    { q: "I'm tired. I think I ___ go to bed.", opts: ['will','am going to','go','would'], ans: 'will', hint: 'Décision spontanée → will.' },
    { q: "It's cold. I ___ close the window.", opts: ['will','am going to','close','would close'], ans: 'will', hint: 'Réaction immédiate → will.' },
    { q: 'She ___ be 30 next year.', opts: ['will','is going to','would','is'], ans: 'will', hint: 'Prédiction sans indice visible → will.' },
    { q: "Don't worry, I ___ help you.", opts: ['will','am going to','would','shall'], ans: 'will', hint: 'Promesse/offre spontanée → will.' },
    { q: 'The test ___ probably be difficult.', opts: ['will','is going to','would','going to'], ans: 'will', hint: 'Prédiction basée sur opinion → will.' },
    { q: 'I promise I ___ call you tomorrow.', opts: ['will','am going to','would','shall'], ans: 'will', hint: 'Promesse → will.' },
  ],
  'future-going-to': [
    { q: 'Look at the sky! It ___ rain.', opts: ['is going to','will','goes to','shall'], ans: 'is going to', hint: 'Indice présent visible → be going to.' },
    { q: 'She ___ have a baby in March. (prévu)', opts: ['is going to','will','is','would'], ans: 'is going to', hint: 'Événement futur planifié → be going to.' },
    { q: 'I ___ visit my parents this weekend. (décidé)', opts: ['am going to','will','am visiting','would'], ans: 'am going to', hint: 'Intention déjà décidée → be going to.' },
    { q: 'Be careful! You ___ fall!', opts: ['are going to','will','go to','would'], ans: 'are going to', hint: 'Situation imminente visible → be going to.' },
    { q: 'They ___ open a new restaurant next month.', opts: ['are going to','will','going to','are'], ans: 'are going to', hint: 'Projet annoncé → be going to.' },
    { q: 'He ___ resign. He told me yesterday.', opts: ['is going to','will','would','shall'], ans: 'is going to', hint: 'Décision déjà prise → be going to.' },
  ],
  'conditional': [
    { q: 'If I had more time, I ___ travel more.', opts: ['would','will','am going to','should'], ans: 'would', hint: 'Hypothèse irréelle (type 2) → would + infinitif.' },
    { q: 'She ___ help if you asked her.', opts: ['would','will','should','is going to'], ans: 'would', hint: 'Condition non réalisée → would.' },
    { q: 'I ___ buy a car if I had the money.', opts: ['would','will','should','might'], ans: 'would', hint: 'If + prétérit → would dans la principale.' },
    { q: 'If it rained, we ___ stay indoors.', opts: ['would','will','should','are going to'], ans: 'would', hint: 'Conditionnel présent (type 2) → would.' },
    { q: 'He ___ come if you invited him.', opts: ['would','will','could','should'], ans: 'would', hint: 'Invitation hypothétique → would.' },
    { q: 'They ___ be happy if they knew the truth.', opts: ['would','will','should','are'], ans: 'would', hint: 'Condition irréelle → would dans la principale.' },
  ],
  'passive': [
    { q: 'English ___ all over the world.', opts: ['is spoken','speaks','is speaking','has spoken'], ans: 'is spoken', hint: 'Passif présent → is/are + participe passé.' },
    { q: 'The letter ___ sent yesterday.', opts: ['was','is','has been','had been'], ans: 'was', hint: 'Passif passé → was/were + participe passé.' },
    { q: 'The film ___ directed by Spielberg.', opts: ['was','is','has been','had been'], ans: 'was', hint: 'Passif avec by → was + participe passé.' },
    { q: 'This building ___ in 1920.', opts: ['was built','built','is built','has built'], ans: 'was built', hint: 'Date passée → passif au prétérit : was built.' },
    { q: 'The results ___ announced tomorrow.', opts: ['will be','are','were','have been'], ans: 'will be', hint: 'Passif futur → will be + participe passé.' },
    { q: 'The cake ___ by my mother every Sunday.', opts: ['is made','made','was made','has made'], ans: 'is made', hint: 'Passif présent habituel → is made.' },
  ],
};

// Banques de questions pour les topics de grammaire
const _GFIX = {
  'present-simple-continuous': [
    { q: 'She ___ to work by bus every day.', opts: ['goes','is going','go','going'], ans: 'goes', hint: 'Habitude → présent simple (she → -s).' },
    { q: 'Listen! The baby ___.', opts: ['is crying','cries','cry','cried'], ans: 'is crying', hint: 'Action en cours → présent continu.' },
    { q: 'Water ___ at 100 degrees Celsius.', opts: ['boils','is boiling','boil','boiled'], ans: 'boils', hint: 'Vérité générale → présent simple.' },
    { q: "I can't talk now, I ___ dinner.", opts: ['am cooking','cook','cooked','cooks'], ans: 'am cooking', hint: 'Maintenant → be + V-ing.' },
    { q: 'Look! It ___.', opts: ['is raining','rains','rained','rain'], ans: 'is raining', hint: 'Look! → action visible maintenant → présent continu.' },
    { q: 'The train ___ at nine every morning.', opts: ['leaves','is leaving','left','leave'], ans: 'leaves', hint: 'Horaire fixe → présent simple.' },
  ],
  'past-vs-present-perfect': [
    { q: 'She ___ to France last summer.', opts: ['went','goes','has gone','go'], ans: 'went', hint: 'Moment daté dans le passé → prétérit.' },
    { q: "I ___ my keys. I can't find them.", opts: ['have lost','lost','lose','am losing'], ans: 'have lost', hint: 'Résultat présent → present perfect.' },
    { q: 'She ___ here since 2010.', opts: ['has lived','lived','lives','living'], ans: 'has lived', hint: 'since → present perfect.' },
    { q: 'He ___ us a funny story at dinner.', opts: ['told','tells','has told','tell'], ans: 'told', hint: 'Action achevée à un moment précis → prétérit.' },
    { q: 'They ___ three films this week.', opts: ['have watched','watched','watch','are watching'], ans: 'have watched', hint: 'this week (non terminée) → present perfect.' },
    { q: 'I ___ him three times today.', opts: ['have called','called','call','am calling'], ans: 'have called', hint: 'today (journée en cours) → present perfect.' },
  ],
  'future': [
    { q: "I'm tired. I think I ___ go to bed.", opts: ['will','am going to','go','would'], ans: 'will', hint: 'Décision spontanée → will.' },
    { q: 'Look at the sky! It ___ rain.', opts: ['is going to','will','goes to','shall'], ans: 'is going to', hint: 'Indice présent visible → be going to.' },
    { q: 'We ___ to Paris next Friday. (plan arrangé)', opts: ['are flying','fly','flew','flies'], ans: 'are flying', hint: 'Plan futur déjà organisé → présent continu.' },
    { q: 'She ___ be 30 next year.', opts: ['will','is going to','would','is'], ans: 'will', hint: 'Prédiction sans indice visible → will.' },
    { q: 'I ___ visit my parents this weekend. (décidé)', opts: ['am going to','will','am visiting','would'], ans: 'am going to', hint: 'Intention déjà décidée → be going to.' },
    { q: "Don't worry, I ___ help you.", opts: ['will','am going to','would','shall'], ans: 'will', hint: 'Promesse/offre spontanée → will.' },
  ],
  'articles': [
    { q: 'She is ___ engineer.', opts: ['an','a','the','—'], ans: 'an', hint: 'Avant voyelle → an.' },
    { q: 'Can you pass me ___ salt, please?', opts: ['the','a','an','—'], ans: 'the', hint: 'Élément unique/connu → the.' },
    { q: 'He plays ___ tennis every weekend.', opts: ['—','the','a','an'], ans: '—', hint: 'Sports → zéro article.' },
    { q: 'I saw ___ bird in the garden.', opts: ['a','an','the','—'], ans: 'a', hint: 'Première mention, consonne → a.' },
    { q: '___ Eiffel Tower is in Paris.', opts: ['The','A','An','—'], ans: 'The', hint: 'Monument unique → the.' },
    { q: 'She goes to ___ school by bus.', opts: ['—','the','a','an'], ans: '—', hint: 'Institutions (school/church) sans article = fonction.' },
  ],
  'comparatives': [
    { q: 'This book is ___ than that one.', opts: ['more interesting','interestinger','most interesting','interesting'], ans: 'more interesting', hint: 'Adjectif long (≥ 2 syll.) → more + adj.' },
    { q: "She is ___ student in the class.", opts: ['the best','the most good','better','the better'], ans: 'the best', hint: 'Superlatif irrégulier de good → the best.' },
    { q: 'He runs ___ than his brother.', opts: ['faster','more fast','fastest','most fast'], ans: 'faster', hint: 'Adjectif court → -er au comparatif.' },
    { q: "This is ___ film I've ever seen.", opts: ['the worst','the most bad','worse','more bad'], ans: 'the worst', hint: 'Superlatif de bad → the worst.' },
    { q: 'London is ___ expensive ___ New York.', opts: ['as / as','more / than','less / that','the most / —'], ans: 'as / as', hint: 'Égalité → as + adjectif + as.' },
    { q: 'The ___ you practise, the ___ you become.', opts: ['more / better','most / best','much / good','more / more'], ans: 'more / better', hint: 'Comparatif parallèle → the more … the better.' },
  ],
  'modals': [
    { q: "You ___ wear a seatbelt. It's the law.", opts: ['must','might','could','would'], ans: 'must', hint: 'Obligation → must.' },
    { q: 'She ___ speak three languages when she was young.', opts: ['could','can','must','should'], ans: 'could', hint: 'Capacité passée → could.' },
    { q: 'You ___ eat more vegetables. Good advice.', opts: ['should','must','can','might'], ans: 'should', hint: 'Conseil → should.' },
    { q: 'It ___ rain later — the clouds look dark.', opts: ['might','must','should','could'], ans: 'might', hint: 'Possibilité incertaine → might.' },
    { q: '___ I borrow your pen?', opts: ['May','Must','Should','Would'], ans: 'May', hint: 'Permission polie → may.' },
    { q: "You ___ park here. It's forbidden.", opts: ["mustn't","can't","shouldn't",'might not'], ans: "mustn't", hint: 'Interdiction → mustn\'t.' },
  ],
  'conditionals': [
    { q: 'If you heat water to 100°C, it ___.', opts: ['boils','would boil','will boil','boiled'], ans: 'boils', hint: 'Type 0 (vérité générale) → présent + présent.' },
    { q: 'If it rains tomorrow, we ___ stay indoors.', opts: ['will','would','should','can'], ans: 'will', hint: 'Type 1 (situation réelle) → if + présent, will + base.' },
    { q: 'If I had more time, I ___ travel more.', opts: ['would','will','am going to','should'], ans: 'would', hint: 'Type 2 (hypothèse irréelle) → if + prétérit, would + base.' },
    { q: "If she had studied harder, she ___ passed.", opts: ['would have','will have','had','should have'], ans: 'would have', hint: 'Type 3 (regret passé) → if + past perfect, would have + pp.' },
    { q: 'I ___ call you if I need help.', opts: ['will','would','shall','might'], ans: 'will', hint: 'Type 1 → will dans la principale.' },
    { q: 'Unless you hurry, you ___ miss the train.', opts: ['will','would','shall','might'], ans: 'will', hint: 'Unless = if not → type 1, will.' },
  ],
  'questions-negation': [
    { q: '___ she speak French?', opts: ['Does','Do','Is','Has'], ans: 'Does', hint: '3e pers. sing. au présent simple → Does.' },
    { q: "He ___ like coffee.", opts: ["doesn't","don't","isn't","hasn't"], ans: "doesn't", hint: "3e pers. sing. → doesn't." },
    { q: '___ you watching TV when I called?', opts: ['Were','Was','Did','Are'], ans: 'Were', hint: 'Prétérit continu (you) → Were.' },
    { q: 'They ___ arrived yet.', opts: ["haven't","didn't","aren't","don't"], ans: "haven't", hint: 'yet avec present perfect → haven\'t.' },
    { q: 'Where ___ she go last night?', opts: ['did','does','was','has'], ans: 'did', hint: 'Question au prétérit → did.' },
    { q: 'What ___ you doing right now?', opts: ['are','do','did','have'], ans: 'are', hint: 'Action en cours → are (present continuous).' },
  ],
  'quantifiers': [
    { q: "There isn't ___ milk left.", opts: ['any','some','much','many'], ans: 'any', hint: 'Négatif → any (indénombrable).' },
    { q: 'I have ___ friends in London — about five.', opts: ['a few','a little','few','little'], ans: 'a few', hint: 'Dénombrable, quantité positive petite → a few.' },
    { q: 'Would you like ___ tea?', opts: ['some','any','many','few'], ans: 'some', hint: 'Offre → some (même en question).' },
    { q: 'There is ___ water in the desert.', opts: ['little','few','a few','some'], ans: 'little', hint: 'Indénombrable, presque rien → little.' },
    { q: 'How ___ students are in the class?', opts: ['many','much','few','little'], ans: 'many', hint: 'Dénombrable + question → How many.' },
    { q: 'She has ___ experience — she just started.', opts: ['little','few','a little','a few'], ans: 'little', hint: 'Indénombrable (experience) + quantité insuffisante → little.' },
  ],
  'gerund-infinitive': [
    { q: 'She enjoys ___ in the park.', opts: ['walking','to walk','walk','walked'], ans: 'walking', hint: 'enjoy + gérondif (-ing).' },
    { q: 'He decided ___ a new car.', opts: ['to buy','buying','buy','bought'], ans: 'to buy', hint: 'decide + infinitif (to).' },
    { q: 'They stopped ___ when I arrived.', opts: ['talking','to talk','talk','talked'], ans: 'talking', hint: 'stop + -ing = arrêter de faire qqch.' },
    { q: 'I want ___ a doctor.', opts: ['to be','being','be','been'], ans: 'to be', hint: 'want + infinitif (to).' },
    { q: 'Would you mind ___ the window?', opts: ['closing','to close','close','closed'], ans: 'closing', hint: 'mind + gérondif (-ing).' },
    { q: "She's looking forward to ___ you.", opts: ['seeing','see','to see','seen'], ans: 'seeing', hint: 'look forward to + -ing (to est une préposition ici).' },
  ],
  'be': [
    { q: 'They ___ very tired after the race.', opts: ['were','was','are','be'], ans: 'were', hint: 'They au prétérit → were.' },
    { q: 'She ___ a teacher when she was young.', opts: ['was','were','is','be'], ans: 'was', hint: 'She au prétérit → was.' },
    { q: 'By next year, he ___ 30 years old.', opts: ['will be','is','was','be'], ans: 'will be', hint: 'Futur → will be.' },
    { q: "I ___ at home when you called.", opts: ["wasn't","weren't","didn't be","isn't"], ans: "wasn't", hint: 'Négatif prétérit singulier → wasn\'t.' },
    { q: 'The books ___ on the table.', opts: ['are','is','were','be'], ans: 'are', hint: 'Books (pluriel) → are.' },
    { q: '___ you tired yesterday?', opts: ['Were','Was','Did','Are'], ans: 'Were', hint: 'Question prétérit (you) → Were.' },
  ],
  'have': [
    { q: 'She ___ a headache this morning.', opts: ['had','has had','have','is having'], ans: 'had', hint: 'this morning (passé défini) → had (prétérit).' },
    { q: 'They ___ lunch when I arrived.', opts: ['were having','had','have','are having'], ans: 'were having', hint: 'Action en cours dans le passé → were having.' },
    { q: 'He ___ three cars.', opts: ['has','have','is having','had'], ans: 'has', hint: 'Possession (he) → has.' },
    { q: 'Do you ___ any brothers or sisters?', opts: ['have','has','had','having'], ans: 'have', hint: 'Do you ___ → base form (have).' },
    { q: 'She ___ her hair cut every month.', opts: ['has','have','is having','gets'], ans: 'has', hint: 'Causatif have → has + object + past participle.' },
    { q: 'I ___ a great time at the party last night.', opts: ['had','have','was having','am having'], ans: 'had', hint: 'last night → prétérit : had.' },
  ],
  'personal-pronouns': [
    { q: "Can you help ___? I can't open this jar.", opts: ['me','I','my','mine'], ans: 'me', hint: 'Pronom objet après verbe → me.' },
    { q: 'The tickets are for her and ___.', opts: ['me','I','my','myself'], ans: 'me', hint: 'Après préposition → pronom objet (me).' },
    { q: '___ is a lovely day today.', opts: ['It','He','She','This'], ans: 'It', hint: 'Temps/météo → it.' },
    { q: 'She did it by ___.', opts: ['herself','her','she','hers'], ans: 'herself', hint: 'Seule, sans aide → by + pronom réfléchi.' },
    { q: 'Give this to ___ — it belongs to them.', opts: ['them','they','their','theirs'], ans: 'them', hint: 'Pronom objet → them.' },
    { q: "Is this book ___? No, it's mine.", opts: ['yours','your','you','yourself'], ans: 'yours', hint: 'Pronom possessif indépendant → yours.' },
  ],
  'nouns-plural': [
    { q: 'There are three ___ in the garden.', opts: ['children','childs','childrens','child'], ans: 'children', hint: 'Pluriel irrégulier : child → children.' },
    { q: 'The ___ are on the shelf.', opts: ['books','book','bookes','bookies'], ans: 'books', hint: 'Pluriel régulier → + s.' },
    { q: 'I saw two ___ in the park.', opts: ['geese','gooses','goose','goosed'], ans: 'geese', hint: 'Pluriel irrégulier : goose → geese.' },
    { q: 'She has three ___.', opts: ['knives','knifes','knife','knivs'], ans: 'knives', hint: 'Noms en -fe → -ves (knife → knives).' },
    { q: 'The ___ are very tall.', opts: ['men','mans','mens','man'], ans: 'men', hint: 'Pluriel irrégulier : man → men.' },
    { q: 'She has two ___ (studio).', opts: ['studios','studioes','studious','studio'], ans: 'studios', hint: 'Noms en -io → + s (studios).' },
  ],
  'possession': [
    { q: "That is ___ book. (belonging to Mary)", opts: ["Mary's",'Mary','of Mary','Marys'], ans: "Mary's", hint: 'Génitif possessif → nom + \'s.' },
    { q: "The ___ toys are everywhere. (the children)", opts: ["children's","childrens'","children",'of children'], ans: "children's", hint: "Pluriel irrégulier → + 's (children's)." },
    { q: 'This is a friend ___ mine.', opts: ['of',"'s",'from','—'], ans: 'of', hint: 'a friend of mine = construction avec pronom possessif.' },
    { q: 'Is this pen ___? (belonging to you)', opts: ['yours','your','you','yourself'], ans: 'yours', hint: 'Pronom possessif indépendant → yours.' },
    { q: "The end ___ the film was surprising.", opts: ['of',"'s",'—','from'], ans: 'of', hint: 'Choses (non-personnes) → of (the end of the film).' },
    { q: "My ___ car is new. (my parents' car)", opts: ["parents'","parent's",'parents','of parents'], ans: "parents'", hint: "Pluriel régulier → apostrophe après le s (parents')." },
  ],
  'prepositions-place': [
    { q: 'The book is ___ the table.', opts: ['on','in','at','under'], ans: 'on', hint: 'Surface → on.' },
    { q: 'She lives ___ London.', opts: ['in','at','on','by'], ans: 'in', hint: 'Ville → in.' },
    { q: 'Meet me ___ the entrance.', opts: ['at','in','on','by'], ans: 'at', hint: 'Point précis → at.' },
    { q: 'The cat is ___ the bed.', opts: ['under','on','in','at'], ans: 'under', hint: 'En dessous → under.' },
    { q: 'The painting is ___ the wall.', opts: ['on','in','at','by'], ans: 'on', hint: 'Accroché à une surface → on.' },
    { q: 'We sat ___ the fire to keep warm.', opts: ['by','on','in','at'], ans: 'by', hint: 'À côté de → by.' },
  ],
  'demonstratives': [
    { q: '___ is my friend Tom. (ici, près de moi)', opts: ['This','That','These','Those'], ans: 'This', hint: 'Proche, singulier → this.' },
    { q: '___ are my keys. (ici)', opts: ['These','Those','This','That'], ans: 'These', hint: 'Proche, pluriel → these.' },
    { q: 'Look at ___ mountains over there!', opts: ['those','these','this','that'], ans: 'those', hint: 'Loin, pluriel → those.' },
    { q: '___ was a great film. (the one we just saw)', opts: ['That','This','Those','These'], ans: 'That', hint: 'Chose venant d\'être mentionnée (distante) → that.' },
    { q: 'Can I try ___ shoes? (in the shop window)', opts: ['those','these','that','this'], ans: 'those', hint: 'Chaussures dans la vitrine (loin) → those.' },
    { q: "___ is a great idea! (the one you just said)", opts: ['That','This','Those','These'], ans: 'That', hint: 'Idée venant d\'être dite → that.' },
  ],
  'causative': [
    { q: 'She ___ her car repaired last week.', opts: ['had','has','got','did'], ans: 'had', hint: 'Causatif have → had + object + pp.' },
    { q: 'I need to ___ my hair cut.', opts: ['get','have','make','let'], ans: 'get', hint: 'get + object + pp = faire faire qqch (familier).' },
    { q: 'They ___ the house painted every two years.', opts: ['have','get','make','let'], ans: 'have', hint: 'have + object + pp = faire faire qqch.' },
    { q: "I'm going to ___ my computer fixed.", opts: ['get','have','make','let'], ans: 'get', hint: 'get + object + pp (familier/oral).' },
    { q: 'She ___ her nails done at the salon.', opts: ['has','have','got','made'], ans: 'has', hint: 'have (présent) + object + pp.' },
    { q: 'We must ___ this contract signed today.', opts: ['get','have','make','do'], ans: 'get', hint: 'get + object + pp pour résultat nécessaire.' },
  ],
  'prepositions-time': [
    { q: 'I was born ___ 1995.', opts: ['in','on','at','by'], ans: 'in', hint: 'Années → in.' },
    { q: 'The meeting is ___ Monday.', opts: ['on','in','at','by'], ans: 'on', hint: 'Jours → on.' },
    { q: 'She arrives ___ noon.', opts: ['at','in','on','by'], ans: 'at', hint: 'Heure précise / midi / minuit → at.' },
    { q: 'I always study ___ the evening.', opts: ['in','on','at','during'], ans: 'in', hint: 'Parties du jour → in the morning/afternoon/evening.' },
    { q: 'He left ___ Christmas.', opts: ['at','on','in','by'], ans: 'at', hint: 'Fêtes (Noël, Pâques) → at.' },
    { q: 'She was born ___ a cold winter morning.', opts: ['on','in','at','during'], ans: 'on', hint: 'Matins/après-midis/soirs avec adjectif → on.' },
  ],
  'passive': [
    { q: 'English ___ all over the world.', opts: ['is spoken','speaks','is speaking','has spoken'], ans: 'is spoken', hint: 'Passif présent → is/are + participe passé.' },
    { q: 'The letter ___ sent yesterday.', opts: ['was','is','has been','had been'], ans: 'was', hint: 'Passif passé → was/were + participe passé.' },
    { q: 'This building ___ in 1920.', opts: ['was built','built','is built','has built'], ans: 'was built', hint: 'Date passée → was built.' },
    { q: 'The results ___ announced tomorrow.', opts: ['will be','are','were','have been'], ans: 'will be', hint: 'Passif futur → will be + participe passé.' },
    { q: 'Coffee ___ grown in Brazil.', opts: ['is','was','are','be'], ans: 'is', hint: 'Passif présent simple → is + pp.' },
    { q: 'The email had ___ sent before I arrived.', opts: ['been','be','being','was'], ans: 'been', hint: 'Past perfect passif → had been + pp.' },
  ],
  'adverbs': [
    { q: 'She sings ___ (beautiful).', opts: ['beautifully','beautiful','more beautiful','beautifuly'], ans: 'beautifully', hint: 'Adverbe de manière → adj + -ly.' },
    { q: 'He drives very ___.', opts: ['carefully','careful','more careful','care'], ans: 'carefully', hint: 'careful → carefully.' },
    { q: 'She ___ arrives late. (toujours)', opts: ['always','never','sometimes','usually'], ans: 'always', hint: 'toujours → always.' },
    { q: 'I ___ watch TV before bed. (parfois)', opts: ['sometimes','always','never','often'], ans: 'sometimes', hint: 'parfois → sometimes.' },
    { q: 'He worked ___ (dur).', opts: ['hard','hardly','hardily','hardy'], ans: 'hard', hint: 'hard = dur (adverbe) ; hardly = à peine.' },
    { q: 'I arrived ___ for the meeting. (juste à l\'heure)', opts: ['just in time','in time','on time','timely'], ans: 'just in time', hint: 'juste à l\'heure → just in time.' },
  ],
  'numbers': [
    { q: 'She finished in ___ place. (3rd)', opts: ['third','three','thirdly','the third'], ans: 'third', hint: 'Ordinal : 3 → third.' },
    { q: '___ of the students passed the exam. (50%)', opts: ['Half','A half','The half','Halves'], ans: 'Half', hint: '50% → half (sans article).' },
    { q: 'It costs ___ euros. (21)', opts: ['twenty-one','twenty one','twentyone','twenty-first'], ans: 'twenty-one', hint: 'Nombres composés 21-99 → trait d\'union.' },
    { q: 'This is my ___ birthday. (40th)', opts: ['fortieth','fortyth','fortith','forty'], ans: 'fortieth', hint: 'forty → fortieth (-y → -ieth).' },
    { q: '___ the class got an A. (⅔)', opts: ['Two thirds of','Two third of','The two thirds','Second third of'], ans: 'Two thirds of', hint: 'Fractions : cardinal + ordinal pluriel.' },
    { q: 'The ___ century saw many inventions. (19th)', opts: ['nineteenth','ninteenth','ninetheen','ninetieth'], ans: 'nineteenth', hint: 'nine + teen + th → nineteenth.' },
  ],
  'adjective-order': [
    { q: 'She bought a ___ dress.', opts: ['beautiful long red','long beautiful red','beautiful red long','red long beautiful'], ans: 'beautiful long red', hint: 'Ordre : opinion → taille → couleur.' },
    { q: 'He drives an ___ car.', opts: ['old red Italian','old Italian red','red old Italian','Italian old red'], ans: 'old red Italian', hint: 'Ordre : âge → couleur → origine.' },
    { q: 'I found a ___ box.', opts: ['small old wooden','small wooden old','old small wooden','wooden small old'], ans: 'small old wooden', hint: 'Ordre : taille → âge → matière.' },
    { q: 'She wore a ___ hat.', opts: ['lovely big black','big lovely black','black big lovely','big black lovely'], ans: 'lovely big black', hint: 'Ordre : opinion → taille → couleur.' },
    { q: 'They live in a ___ house.', opts: ['big old French','old big French','French big old','big French old'], ans: 'big old French', hint: 'Ordre : taille → âge → origine.' },
    { q: 'He bought a ___ watch.', opts: ['beautiful small gold','small beautiful gold','gold small beautiful','small gold beautiful'], ans: 'beautiful small gold', hint: 'Ordre : opinion → taille → matière.' },
  ],
  'word-formation': [
    { q: 'She is very ___. (care)', opts: ['careful','caring','careless','care'], ans: 'careful', hint: '-ful = plein de → careful = prudent.' },
    { q: 'It was an ___ result. (expect)', opts: ['unexpected','expected','unexopected','expectful'], ans: 'unexpected', hint: 'un- + expected = inattendu.' },
    { q: 'He works ___ (heavy).', opts: ['heavily','heavy','heavyly','more heavy'], ans: 'heavily', hint: '-y → -ily : heavy → heavily.' },
    { q: 'She is a great ___. (sing)', opts: ['singer','singing','singor','song'], ans: 'singer', hint: '-er = agent → singer = chanteur.' },
    { q: 'The film was ___. (bore)', opts: ['boring','bored','boreful','boresome'], ans: 'boring', hint: '-ing → cause de l\'ennui → boring = ennuyeux.' },
    { q: 'He showed great ___. (kind)', opts: ['kindness','kindful','kindom','kindly'], ans: 'kindness', hint: '-ness = qualité abstraite → kindness = gentillesse.' },
  ],
  'deduction': [
    { q: "She ___ be at home — her lights are on.", opts: ['must','might',"can't",'should'], ans: 'must', hint: 'Déduction quasi-certaine (positive) → must.' },
    { q: "He ___ be English — he speaks with a French accent.", opts: ["can't","mustn't",'might',"shouldn't"], ans: "can't", hint: "Déduction quasi-certaine (négative) → can't." },
    { q: 'She ___ be tired — she worked all night.', opts: ['must','can','might','could'], ans: 'must', hint: 'Déduction logique forte → must.' },
    { q: "I'm not sure where he is. He ___ be at the gym.", opts: ['might','must',"can't",'should'], ans: 'might', hint: 'Possibilité incertaine → might.' },
    { q: "That ___ be Tom — Tom is in London!", opts: ["can't",'must','might',"shouldn't"], ans: "can't", hint: 'Impossibilité logique → can\'t.' },
    { q: "She's been studying for 10 hours. She ___ be exhausted.", opts: ['must','might',"can't",'could'], ans: 'must', hint: 'Déduction forte → must.' },
  ],
};

function generateTenseItem(topicId) {
  if (_TGEN[topicId]) return _TGEN[topicId]();
  if (_TFIX[topicId]) {
    const t = _rnd(_TFIX[topicId]);
    return _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
  }
  return null;
}

function generateGrammarItem(topicId) {
  const bank = _GFIX[topicId];
  if (!bank) return null;
  const t = _rnd(bank);
  return _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
}

const TENSES_TOPIC_ORDER = [...Object.keys(_TGEN), ...Object.keys(_TFIX)];

// ---------- temps verbaux ----------
const TENSES_TOPIC_LABELS = {
  'present-simple':     'Présent simple',
  'present-continuous': 'Présent continu',
  'past-simple':        'Prétérit simple',
  'past-continuous':    'Prétérit continu',
  'present-perfect':    'Present perfect',
  'past-perfect':       'Plus-que-parfait',
  'future-will':        'Futur — will',
  'future-going-to':    'Futur — be going to',
  'conditional':        'Conditionnel (would)',
  'passive':            'Voix passive',
};

function renderTensesList() {
  const list = $('tenses-list');
  list.innerHTML = TENSES_TOPIC_ORDER.map(topic => {
    const label = TENSES_TOPIC_LABELS[topic] || topic;
    return `<button class="grammar-item" data-topic="${esc(topic)}"><span class="gi-title">${esc(label)}</span><span class="gi-sub">Génération aléatoire</span></button>`;
  }).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => startTensesQuiz(b.dataset.topic))
  );
  renderChips('.tcount-chip', state.count, 'count');
}

function openTenses() {
  renderTensesList();
  showView('tenses');
}

function startTensesQuiz(topicId) {
  const topics = topicId ? [topicId] : TENSES_TOPIC_ORDER;
  const count = state.count;
  const items = [];
  for (let i = 0; i < count; i++) {
    const t = topics[i % topics.length];
    const item = generateTenseItem(t);
    if (item) items.push(item);
  }
  if (!items.length) return;
  state.kind = 'tenses';
  state.level = 'Global';
  state.badge = topicId ? (TENSES_TOPIC_LABELS[topicId] || topicId) : 'Temps verbaux';
  state.mode = 'srs';
  state.questions = shuffle(items).map(item => {
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + item.topic;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

$('btn-tenses').addEventListener('click', openTenses);
$('btn-tenses-quiz').addEventListener('click', () => startTensesQuiz(null));
$('btn-tenses-home').addEventListener('click', () => showView('home'));
document.querySelectorAll('.tcount-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.tcount-chip', state.count, 'count');
}));

// ---------- phrases à compléter (méga-quiz cross-mode) ----------
let phrasesPool = null;

async function loadPhrasesPool() {
  if (!fauxAmisData) fauxAmisData = await (await fetch(FAUX_AMIS_FILE)).json();
  phrasesPool = [
    ...Object.entries(_GFIX).flatMap(([topic, bank]) =>
      bank.map(t => ({ type: 'grammar', data: _mkItem(topic, t.q, [...t.opts], t.ans, t.hint) }))
    ),
    ...TENSES_TOPIC_ORDER.flatMap(topic => {
      const fixed = (_TFIX[topic] || []).map(t => ({ type: 'tenses', data: _mkItem(topic, t.q, [...t.opts], t.ans, t.hint) }));
      const param = _TGEN[topic] ? Array.from({ length: 8 }, () => ({ type: 'tenses', data: _TGEN[topic]() })) : [];
      return [...fixed, ...param];
    }),
    ...fauxAmisData.map(x => ({ type: 'faux-amis', data: x })),
  ];
  return phrasesPool;
}

async function startPhrasesQuiz() {
  const pool = await loadPhrasesPool();
  const count = state.count || 10;
  const picks = shuffle(pool).slice(0, count);
  state.kind = 'phrases';
  state.badge = 'Tout en un';
  state.mode = 'srs';
  state.questions = picks.map(p => {
    if (p.type === 'grammar' || p.type === 'tenses') return buildGrammarQuestion(p.data);
    if (p.type === 'faux-amis')  return buildFauxAmiQuestion(p.data, fauxAmisData);
    if (p.type === 'familles')   return buildFamilleQuestion(p.data, famillesData);
    if (p.type === 'cognates')   return buildCognateQuestion(p.data, cognatesData);
    return null;
  }).filter(Boolean);
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

$('btn-phrases').addEventListener('click', () => { renderChips('.pcount-chip', state.count, 'count'); showView('phrases'); });
$('btn-phrases-start').addEventListener('click', startPhrasesQuiz);
$('btn-phrases-home').addEventListener('click', () => showView('home'));
document.querySelectorAll('.pcount-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.pcount-chip', state.count, 'count');
}));

// ---------- motivation : streak quotidien + objectif du jour ----------
const ALL_DAILY_KEYS = () => ['en', 'es', VERBS_KEY, GRAMMAR_KEY, FAUX_AMIS_KEY, FAMILLES_KEY, COGNATES_KEY, TENSES_KEY, PHRASES_KEY];

function todayTotalQuestions() {
  const today = todayStr();
  let total = 0;
  ALL_DAILY_KEYS().forEach(k => {
    total += (lsGet(dailyKey(k), {})[today] || {}).q || 0;
  });
  return total;
}

function dailyStreak() {
  const merged = {};
  ALL_DAILY_KEYS().forEach(k => {
    Object.entries(lsGet(dailyKey(k), {})).forEach(([day, data]) => {
      merged[day] = (merged[day] || 0) + (data.q || 0);
    });
  });
  let streak = 0;
  const d = new Date();
  while (true) {
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if ((merged[k] || 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function renderMotivBar() {
  const streak = dailyStreak();
  const done = todayTotalQuestions();
  const goal = settings.dailyGoal;
  const pct = Math.min(100, Math.round(done / goal * 100));
  $('motiv-streak-count').textContent = streak;
  $('motiv-flame').textContent = streak > 0 ? '🔥' : '💤';
  $('motiv-today').textContent = done;
  $('motiv-target').textContent = goal;
  $('motiv-progress-bar').style.width = pct + '%';
  $('motiv-progress-bar').style.background = pct >= 100 ? 'var(--success)' : 'var(--sky)';
}

// ---------- smart review notifications ----------
async function countDueWords() {
  let due = 0;
  const now = Date.now();
  for (const lang of Object.keys(LANGS)) {
    const srs = getSrs(lang);
    Object.values(srs).forEach(e => {
      if (!e || !e.seen) return;
      const nextDue = (e.lastSeen || 0) + BOX_DAYS[Math.min(e.box, MAX_BOX)] * DAY;
      if (nextDue <= now) due++;
    });
  }
  return due;
}

async function scheduleReviewNotification() {
  const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LN.requestPermissions();
      if (req.display !== 'granted') return;
    }
    await LN.cancel({ notifications: [{ id: 1 }] });
    const done = todayTotalQuestions();
    const goal = settings.dailyGoal;
    if (done >= goal) return; // objectif atteint : pas de rappel inutile
    const streak = dailyStreak();
    const due = await countDueWords();
    let msg;
    if (streak >= 2) msg = `🔥 ${streak} jours de suite ! Plus que ${Math.max(0, goal - done)} questions pour aujourd'hui.`;
    else if (due > 0) msg = `${due} mot${due > 1 ? 's' : ''} à réviser — objectif : ${goal} questions aujourd'hui !`;
    else msg = `Continue ta progression — ${goal} questions aujourd'hui !`;
    const hour = settings.notifHour || 8;
    const now = new Date();
    const trigger = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
    if (trigger <= now) trigger.setDate(trigger.getDate() + 1);
    await LN.schedule({ notifications: [{ id: 1, title: '📚 VocaLang', body: msg, schedule: { at: trigger, repeats: false }, sound: null, attachments: null, actionTypeId: '', extra: null }] });
  } catch (_) {}
}

async function cancelReviewNotification() {
  const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try { await LN.cancel({ notifications: [{ id: 1 }] }); } catch (_) {}
}

function bindToggle(id, key) {
  const el = $(id); el.checked = settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); });
}
bindToggle('opt-audio', 'audioAuto');
bindToggle('opt-autonext', 'autoNext');
bindToggle('opt-sound', 'sound');
bindToggle('opt-close', 'closeDistractors');

const elNotif = $('opt-notifications');
elNotif.checked = settings.notifications;
elNotif.addEventListener('change', () => {
  settings.notifications = elNotif.checked;
  saveSettings();
  if (settings.notifications) scheduleReviewNotification();
  else cancelReviewNotification();
});


const settingsModal = $('settings-modal');
$('btn-settings').addEventListener('click', () => settingsModal.classList.remove('hidden'));
$('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// ---------- daily activity log ----------
function dailyKey(lang) { return `quizlangue:daily:${lang}:v1`; }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function logDaily(lang, correct) {
  const prevTotal = todayTotalQuestions();
  const m = lsGet(dailyKey(lang), {});
  const t = todayStr();
  const e = m[t] || { q: 0, c: 0 };
  e.q++; if (correct) e.c++;
  m[t] = e;
  // prune > 90 days
  const keys = Object.keys(m).sort();
  while (keys.length > 90) delete m[keys.shift()];
  lsSet(dailyKey(lang), m);
  // mise à jour du widget + notification si objectif atteint
  if (views.home && !views.home.classList.contains('hidden')) renderMotivBar();
  if (prevTotal < settings.dailyGoal && prevTotal + 1 >= settings.dailyGoal) {
    if (settings.notifications) cancelReviewNotification();
  }
}
function lastNDays(lang, n) {
  const m = lsGet(dailyKey(lang), {});
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    out.push({ day: d.getDate(), q: (m[k] || {}).q || 0 });
  }
  return out;
}

// ---------- canvas charts ----------
function canvasCtx(c, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 320;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
  return [x, w, h];
}
function roundRect(x, bx, by, bw, bh, r) {
  r = Math.min(r, bw / 2, bh / 2); if (bh <= 0) return;
  x.beginPath();
  x.moveTo(bx + r, by);
  x.arcTo(bx + bw, by, bx + bw, by + bh, r);
  x.arcTo(bx + bw, by + bh, bx, by + bh, r);
  x.arcTo(bx, by + bh, bx, by, r);
  x.arcTo(bx, by, bx + bw, by, r);
  x.closePath();
}
function drawBars(c, labels, values, colors) {
  const [x, w, h] = canvasCtx(c, 170);
  const pad = { l: 6, r: 6, t: 20, b: 22 };
  const max = Math.max(1, ...values);
  const n = values.length || 1;
  const bw = (w - pad.l - pad.r) / n;
  x.font = '11px sans-serif'; x.textAlign = 'center';
  values.forEach((v, i) => {
    const bh = (h - pad.t - pad.b) * (v / max);
    const bx = pad.l + i * bw, by = h - pad.b - bh;
    x.fillStyle = (typeof colors === 'function' ? colors(i, v) : (colors[i] || '#27B3FF'));
    roundRect(x, bx + bw * 0.18, by, bw * 0.64, bh, 4); x.fill();
    if (v) { x.fillStyle = '#EAF2FF'; x.fillText(v, bx + bw / 2, by - 5); }
    x.fillStyle = '#B8C7E3'; x.fillText(labels[i], bx + bw / 2, h - 7);
  });
}
function drawGrouped(c, labels, a, b, colA, colB) {
  const [x, w, h] = canvasCtx(c, 170);
  const pad = { l: 6, r: 6, t: 20, b: 22 };
  const max = Math.max(1, ...a, ...b);
  const n = labels.length || 1;
  const gw = (w - pad.l - pad.r) / n;
  x.font = '11px sans-serif'; x.textAlign = 'center';
  labels.forEach((lab, i) => {
    const gx = pad.l + i * gw;
    [[a[i], colA, 0.20], [b[i], colB, 0.52]].forEach(([v, col, off]) => {
      const bh = (h - pad.t - pad.b) * (v / max);
      const bx = gx + gw * off, by = h - pad.b - bh, bwid = gw * 0.28;
      x.fillStyle = col; roundRect(x, bx, by, bwid, bh, 3); x.fill();
      if (v) { x.fillStyle = '#EAF2FF'; x.fillText(v, bx + bwid / 2, by - 4); }
    });
    x.fillStyle = '#B8C7E3'; x.fillText(lab, gx + gw / 2, h - 7);
  });
}

// ---------- stats view ----------
function renderStatsView() {
  const lang = state.lang, words = state.words, srs = getSrs(lang);
  document.querySelectorAll('.slang-chip').forEach(c => c.classList.toggle('active', c.dataset.lang === lang));
  $('stats-lang').textContent = LANGS[lang].label;

  let c = 0, w = 0, seen = 0, mastered = 0;
  const boxes = [0, 0, 0, 0, 0, 0];
  words.forEach(it => {
    const e = srs[it.word];
    if (e && e.seen > 0) { seen++; c += e.correct; w += e.wrong; boxes[e.box] = (boxes[e.box] || 0) + 1; if (e.box >= 4) mastered++; }
  });
  const acc = (c + w) ? Math.round(100 * c / (c + w)) : 0;
  const st = loadStats(lang);
  $('stats-summary').innerHTML = [
    ['Quiz', st.totalCompleted], ['Points', st.totalPoints], ['Précision', acc + '%'],
    ['Mots vus', seen], ['Maîtrisés', mastered], ['Record série', st.bestStreak || 0],
  ].map(([l, v]) => `<div class="stile"><b>${v}</b><span>${l}</span></div>`).join('');

  const act = lastNDays(lang, 14);
  drawBars($('chart-activity'), act.map(d => d.day), act.map(d => d.q), '#27B3FF');

  const boxColors = ['#FF6B81', '#27B3FF', '#27B3FF', '#4CE0D2', '#35D07F', '#35D07F'];
  drawBars($('chart-boxes'), ['0', '1', '2', '3', '4', '5'], boxes, (i) => boxColors[i]);

  const lvls = LANGS[lang].levels.filter(l => l !== 'Global');
  const vus = lvls.map(lv => words.filter(it => it.level === lv && srs[it.word] && srs[it.word].seen > 0).length);
  const mas = lvls.map(lv => words.filter(it => it.level === lv && srs[it.word] && srs[it.word].box >= 4).length);
  drawGrouped($('chart-levels'), lvls, vus, mas, '#27B3FF', '#35D07F');
}

document.querySelectorAll('.slang-chip').forEach(c => c.addEventListener('click', async () => {
  await selectLang(c.dataset.lang); renderStatsView();
}));
$('btn-stats').addEventListener('click', () => { showView('stats'); renderStatsView(); });
$('btn-stats-home').addEventListener('click', () => { showView('home'); renderStats(); });
window.addEventListener('resize', () => { if (!views.stats.classList.contains('hidden')) renderStatsView(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

renderChips('.dir-chip', state.dir, 'dir');
renderChips('.count-chip', state.count, 'count');
$('app-version').textContent = 'v' + APP_VERSION;
selectLang('en');

$('btn-fab-home').addEventListener('click', () => showView('home'));

// chips objectif quotidien et heure de rappel
renderChips('.goalcount-chip', settings.dailyGoal, 'count');
document.querySelectorAll('.goalcount-chip').forEach(c => c.addEventListener('click', () => {
  settings.dailyGoal = +c.dataset.count;
  saveSettings();
  renderChips('.goalcount-chip', settings.dailyGoal, 'count');
  renderMotivBar();
  if (settings.notifications) scheduleReviewNotification();
}));
renderChips('.notifhour-chip', settings.notifHour, 'hour');
document.querySelectorAll('.notifhour-chip').forEach(c => c.addEventListener('click', () => {
  settings.notifHour = +c.dataset.hour;
  saveSettings();
  renderChips('.notifhour-chip', settings.notifHour, 'hour');
  if (settings.notifications) scheduleReviewNotification();
}));

if (settings.notifications) scheduleReviewNotification();
