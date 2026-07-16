'use strict';

const APP_VERSION = '2.25';
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
const GRAMMAR_QUIZ_FILE = 'data/grammar_quiz_en.json';
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

let grammarQuizData = null;
let grammarQuizTopics = null;   // topics ayant des questions de quiz
async function startGrammarQuiz(topicId) {
  if (!grammarQuizData) grammarQuizData = await (await fetch(GRAMMAR_QUIZ_FILE)).json();
  let pool = grammarQuizData;
  if (topicId) pool = pool.filter(x => x.topic === topicId);
  if (!pool.length) return;
  state.kind = 'grammar';
  state.level = 'Global';
  state.words = pool.map(x => Object.assign({ word: x.id }, x));
  state.badge = 'Grammaire';
  startSession('srs');
}

async function loadGrammarLang(lang) {
  grammarLang = lang;
  if (!grammarCache[lang]) {
    grammarCache[lang] = await (await fetch(GRAMMAR_FILES[lang])).json();
  }
  grammarData = grammarCache[lang];
  if (!grammarQuizData) grammarQuizData = await (await fetch(GRAMMAR_QUIZ_FILE)).json();
  grammarQuizTopics = new Set(grammarQuizData.map(x => x.topic));
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

$('btn-grammar-ai').addEventListener('click', async () => {
  if (!grammarQuizData) grammarQuizData = await (await fetch(GRAMMAR_QUIZ_FILE)).json();
  if (grammarSelectedTopics.size === 0) grammarData.forEach(t => grammarSelectedTopics.add(t.id));
  const items = shuffle(grammarQuizData.filter(x => grammarSelectedTopics.has(x.topic))).slice(0, grammarCustomCount);
  if (!items.length) return;
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = 'Grammaire';
  state.mode = 'srs';
  state.questions = items.map(x => buildGrammarQuestion(x));
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
$('btn-grammar-learn').addEventListener('click', async () => {
  if (!grammarQuizData) grammarQuizData = await (await fetch(GRAMMAR_QUIZ_FILE)).json();
  state.kind = 'grammar'; state.level = 'Global';
  state.words = grammarQuizData.map(x => Object.assign({ word: x.id }, x));
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
        $('pronun-mic-hint').textContent = 'Micro refusé — Réglages → Applis → Quiz Langue → Micro.';
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

// ---------- temps verbaux ----------
const TENSES_FILE = 'data/tenses_en.json';
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
let tensesData = null;

function renderTensesList() {
  const list = $('tenses-list');
  const topics = [...new Set((tensesData || []).map(x => x.topic))];
  list.innerHTML = topics.map(topic => {
    const count = (tensesData || []).filter(x => x.topic === topic).length;
    const label = TENSES_TOPIC_LABELS[topic] || topic;
    return `<button class="grammar-item" data-topic="${esc(topic)}"><span class="gi-title">${esc(label)}</span><span class="gi-sub">${count} exercice${count > 1 ? 's' : ''}</span></button>`;
  }).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => startTensesQuiz(b.dataset.topic))
  );
  renderChips('.tcount-chip', state.count, 'count');
}

async function openTenses() {
  if (!tensesData) tensesData = await (await fetch(TENSES_FILE)).json();
  renderTensesList();
  showView('tenses');
}

function startTensesQuiz(topicId) {
  if (!tensesData || !tensesData.length) return;
  const pool = topicId ? tensesData.filter(x => x.topic === topicId) : tensesData;
  if (!pool.length) return;
  state.kind = 'tenses';
  state.level = 'Global';
  state.badge = topicId ? (TENSES_TOPIC_LABELS[topicId] || topicId) : 'Temps verbaux';
  state.words = pool.map(x => Object.assign({ word: x.id }, x));
  startSession('srs');
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
  if (phrasesPool) return phrasesPool;
  if (!grammarQuizData) grammarQuizData = await (await fetch(GRAMMAR_QUIZ_FILE)).json();
  if (!tensesData)     tensesData     = await (await fetch(TENSES_FILE)).json();
  if (!fauxAmisData)   fauxAmisData   = await (await fetch(FAUX_AMIS_FILE)).json();
  if (!famillesData)   famillesData   = await (await fetch(FAMILLES_FILE)).json();
  if (!cognatesData)   cognatesData   = await (await fetch(COGNATES_FILE)).json();
  phrasesPool = [
    ...grammarQuizData.map(x => ({ type: 'grammar',    data: x })),
    ...tensesData.map(x      => ({ type: 'tenses',     data: x })),
    ...fauxAmisData.map(x    => ({ type: 'faux-amis',  data: x })),
    ...famillesData.map(x    => ({ type: 'familles',   data: x })),
    ...cognatesData.map(x    => ({ type: 'cognates',   data: x })),
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
    await LN.schedule({ notifications: [{ id: 1, title: '📚 Quiz Langue', body: msg, schedule: { at: trigger, repeats: false }, sound: null, attachments: null, actionTypeId: '', extra: null }] });
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
