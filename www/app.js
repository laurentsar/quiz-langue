'use strict';

const APP_VERSION = '3.15';
window.APP_VERSION = APP_VERSION;
const OPTION_COUNT = 4;

const LANGS = {
  en: { label: 'Anglais', file: 'data/wordlist_en.json', tts: 'en-US', levels: ['Global', 'A1', 'A2', 'B1', 'B2', 'C', 'D'] },
  es: { label: 'Espagnol', file: 'data/wordlist_es.json', tts: 'es-ES', levels: ['Global', 'A1-A2', 'B1-B2', 'C1-C2'] },
};

// Leitner box -> days until due
const BOX_DAYS = [0, 1, 1, 3, 7, 14];
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
const KIND_COLORS = { vocab: '#27B3FF', verbs: '#4CE0D2', grammar: '#1B5CFF', 'faux-amis': '#FF6B35', familles: '#A855F7', cognates: '#10B981', tenses: '#EF4444', phrases: '#F59E0B', toeic: '#F97316', mixed: '#7C3AED' };

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
  grammarSeriesKey: null,
  dailySession: null,
  browse: false,   // true pendant le mode Parcours grammaire (lecture libre, sans notation)
};

let verbsData = null;   // liste des verbes irréguliers (chargée à la demande)
let verbSelectedWords = new Set();   // infinitifs sélectionnés pour le quiz personnalisé
let verbSelectPanelOpen = false;

// Clé de stats/SRS et voix TTS selon le mode courant.
const TOEIC_KEY = 'toeic';
function quizKey() { return state.kind === 'verbs' ? VERBS_KEY : state.kind === 'grammar' ? GRAMMAR_KEY : state.kind === 'faux-amis' ? FAUX_AMIS_KEY : state.kind === 'familles' ? FAMILLES_KEY : state.kind === 'cognates' ? COGNATES_KEY : state.kind === 'tenses' ? TENSES_KEY : state.kind === 'phrases' ? PHRASES_KEY : state.kind === 'toeic' ? TOEIC_KEY : state.lang; }
function quizTts() { return (state.kind === 'verbs' || state.kind === 'grammar' || state.kind === 'faux-amis' || state.kind === 'familles' || state.kind === 'cognates' || state.kind === 'tenses' || state.kind === 'phrases' || state.kind === 'toeic' || state.kind === 'mixed') ? 'en-US' : LANGS[state.lang].tts; }

const settings = loadSettings();
const cache = {};   // lang -> words
const srsCache = {}; // lang -> srs map

// ---------- persistence ----------
function lsGet(k, d) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

function loadSettings() {
  return Object.assign({ audioAuto: true, autoNext: true, sound: true, closeDistractors: false, notifications: true, dailyGoal: 10, notifHour: 8, newRatio: 40 }, lsGet('quizlangue:settings:v1', {}));
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
  else { e.wrong++; e.box = Math.max(e.box - 2, 0); e.last = 'ko'; }
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
    const wrong = shuffle(wrongList(words, srs));
    const wrongSet = new Set(wrong.map(w => w.word));
    const due = dueList(words, srs, now).filter(w => !wrongSet.has(w.word));
    const fresh = newList(words, srs).filter(w => !wrongSet.has(w.word));
    picks = wrong.concat(due).concat(fresh).slice(0, state.count);
    const used = new Set(); picks = picks.filter(w => !used.has(w.word) && used.add(w.word));
  } else {
    const due = dueList(words, srs, now);
    const fresh = newList(words, srs);
    // ① quota minimum de nouveaux mots : configurable via settings.newRatio (%)
    const newSlots = Math.ceil(state.count * (settings.newRatio / 100));
    const dueSlots = state.count - newSlots;
    picks = due.slice(0, dueSlots).concat(fresh.slice(0, newSlots));
    // complète si l'un des deux pools est vide
    if (picks.length < state.count) {
      const remaining = due.slice(dueSlots).concat(fresh.slice(newSlots));
      picks = picks.concat(remaining);
    }
    if (picks.length < state.count) picks = picks.concat(shuffle(words));
    picks = picks.slice(0, state.count);
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
  const cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.TextToSpeech) {
    try { cap.Plugins.TextToSpeech.stop().catch(() => {}); } catch (e) {}
    cap.Plugins.TextToSpeech.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' }).catch(() => {});
    return;
  }
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch (e) {}
}

function speakFemale(text, lang) {
  const cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.TextToSpeech) {
    try { cap.Plugins.TextToSpeech.stop().catch(() => {}); } catch (e) {}
    cap.Plugins.TextToSpeech.speak({ text, lang, rate: 1.0, pitch: 1.2, volume: 1.0, category: 'playback' }).catch(() => {});
    return;
  }
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.9;
    const voices = speechSynthesis.getVoices();
    const langCode = lang.split('-')[0];
    const FEMALE = ['samantha','karen','victoria','fiona','kate','moira','veena','zira','female','audrey','amelie','google uk english female','google us english','google français'];
    const voice = voices.find(v => v.lang.startsWith(langCode) && FEMALE.some(n => v.name.toLowerCase().includes(n)))
                || voices.find(v => v.lang.startsWith(langCode));
    if (voice) u.voice = voice;
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
const views = { home: $('view-home'), quiz: $('view-quiz'), result: $('view-result'), stats: $('view-stats'), verbs: $('view-verbs'), grammar: $('view-grammar'), 'faux-amis': $('view-faux-amis'), familles: $('view-familles'), cognates: $('view-cognates'), tenses: $('view-tenses'), toeic: $('view-toeic'), phrases: $('view-phrases'), learn: $('view-learn'), listen: $('view-listen'), pronun: $('view-pronun'), crossword: $('view-crossword'), matching: $('view-matching') };
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

const LESSON_CATS = ['grammar', 'faux-amis', 'word-family', 'cognates', 'verbs'];
const LESSON_FILES = {
  grammar: 'data/grammar_en.json',
  'faux-amis': 'data/faux_amis_en.json',
  'word-family': 'data/word_families_en.json',
  cognates: 'data/cognates_en.json',
  verbs: 'data/verbs_en.json',
};
const lessonCache = {};

function _lessonHeader(label) {
  return `<div class="lesson-header"><span class="lesson-label">${label}</span><span class="lesson-5min">≤ 5 min</span></div>`;
}
function _lessonExamples(exs) {
  if (!exs || !exs.length) return '';
  return `<div class="lesson-examples">${exs.map(e =>
    `<div class="lesson-ex"><span class="lesson-ex-en">${esc(e.en)}</span><span class="lesson-ex-fr">${esc(e.fr)}</span></div>`
  ).join('')}</div>`;
}

function drawGrammarLesson(topics, n) {
  const topic = topics[n % topics.length];
  if (!topic?.sections?.length) return '';
  const sec = topic.sections[0];
  const pts = (sec.points || []).slice(0, 3).map(p => `<li>${esc(p)}</li>`).join('');
  return `${_lessonHeader('📘 Grammaire du jour')}
    <div class="lesson-title">${esc(topic.title)}</div>
    ${topic.subtitle ? `<div class="lesson-sub">${esc(topic.subtitle)}</div>` : ''}
    <div class="lesson-sec-heading">${esc(sec.heading)}</div>
    <ul class="lesson-points">${pts}</ul>
    ${_lessonExamples((sec.examples || []).slice(0, 2))}
    <button class="lesson-more-btn secondary">📖 Cours complet →</button>`;
}

function drawFauxAmisLesson(items, n) {
  const start = (n * 3) % items.length;
  const batch = [0, 1, 2].map(i => items[(start + i) % items.length]);
  const rows = batch.map(it =>
    `<div class="fa-row"><span class="fa-word">${esc(it.en)}</span><span class="fa-arrow">≠</span><span class="fa-trap">« ${esc(it.trap)} »</span><span class="fa-meaning">→ ${esc(it.fr)}</span></div>`
  ).join('');
  return `${_lessonHeader('⚠️ Faux amis du jour')}
    <div class="lesson-sub">3 mots à ne pas confondre</div>
    <div class="fa-list">${rows}</div>
    ${batch[0].example ? _lessonExamples([batch[0].example]) : ''}
    <button class="lesson-more-btn secondary">⚠️ Voir tous les faux amis →</button>`;
}

function drawWordFamilyLesson(families, n) {
  const fam = families[n % families.length];
  if (!fam) return '';
  const wordRows = (fam.words || []).slice(0, 6).map(w =>
    `<div class="wf-row"><span class="wf-word">${esc(w.word)}</span><span class="wf-pos">${esc(w.pos)}</span><span class="wf-fr">${esc(w.fr)}</span></div>`
  ).join('');
  return `${_lessonHeader('🔤 Famille de mots')}
    <div class="lesson-title">${esc(fam.root.toUpperCase())} <span class="lesson-sub-inline">(${esc(fam.fr_root)})</span></div>
    <div class="wf-grid">${wordRows}</div>
    ${fam.tip ? `<div class="lesson-tip">💡 ${esc(fam.tip)}</div>` : ''}
    <button class="lesson-more-btn secondary">🔤 Explorer les familles →</button>`;
}

function drawCognatesLesson(patterns, n) {
  const p = patterns[n % patterns.length];
  if (!p) return '';
  const exStr = (p.examples || []).slice(0, 5).map(e => esc(e.en)).join(', ');
  return `${_lessonHeader('✅ Vrais cognates')}
    <div class="lesson-title">${esc(p.pattern)}</div>
    <div class="lesson-sub">${esc(p.rule)}</div>
    <div class="lesson-examples"><div class="lesson-ex"><span class="lesson-ex-en">${exStr}</span></div></div>
    ${p.tip ? `<div class="lesson-tip">💡 ${esc(p.tip)}</div>` : ''}
    <button class="lesson-more-btn secondary">✅ Voir tous les cognates →</button>`;
}

function drawVerbsLesson(verbs, n) {
  const start = (n * 6) % verbs.length;
  const batch = verbs.slice(start, start + 6);
  if (batch.length < 6) batch.push(...verbs.slice(0, 6 - batch.length));
  const rows = batch.map(v =>
    `<tr><td>${esc(v.inf)}</td><td>${esc(v.pret)}</td><td>${esc(v.pp)}</td><td class="verb-fr">${esc(v.fr)}</td></tr>`
  ).join('');
  return `${_lessonHeader('📘 Verbes irréguliers')}
    <div class="lesson-sub">6 verbes essentiels</div>
    <table class="verb-table"><thead><tr><th>Base</th><th>Prétérit</th><th>Participe</th><th>FR</th></tr></thead><tbody>${rows}</tbody></table>
    <button class="lesson-more-btn secondary">📘 S'entraîner →</button>`;
}

function renderHomeLessonCard() {
  const card = $('home-lesson-card');
  if (!card) return;
  const dayNum = Math.floor(Date.now() / 86400000);
  const cat = LESSON_CATS[dayNum % LESSON_CATS.length];
  const n = Math.floor(dayNum / LESSON_CATS.length);

  const draw = (data) => {
    const drawFns = { grammar: drawGrammarLesson, 'faux-amis': drawFauxAmisLesson, 'word-family': drawWordFamilyLesson, cognates: drawCognatesLesson, verbs: drawVerbsLesson };
    const html = drawFns[cat](data, n);
    if (!html) { card.classList.add('hidden'); return; }
    card.innerHTML = html;
    card.classList.remove('hidden');
    card.querySelector('.lesson-more-btn')?.addEventListener('click', async () => {
      if (cat === 'grammar') { await loadGrammarLang('en'); showView('grammar'); showGrammarTopic(n % data.length); }
      else if (cat === 'faux-amis') openFauxAmis();
      else if (cat === 'word-family') openFamilles();
      else if (cat === 'cognates') openCognates();
      else if (cat === 'verbs') openVerbs();
    });
  };

  const cached = lessonCache[cat] || (cat === 'grammar' && grammarCache['en']);
  if (cached) { lessonCache[cat] = cached; draw(cached); return; }

  fetch(LESSON_FILES[cat]).then(r => r.json()).then(data => {
    lessonCache[cat] = data;
    if (cat === 'grammar') grammarCache['en'] = data;
    if (cat === 'verbs' && !verbsData) { verbsData = data; data.forEach(v => { v.word = v.inf; }); }
    if (cat === 'faux-amis' && !fauxAmisData) fauxAmisData = data;
    if (cat === 'word-family' && !famillesData) famillesData = data;
    if (cat === 'cognates' && !cognatesData) cognatesData = data;
    draw(data);
  }).catch(() => card.classList.add('hidden'));
}

function renderStats() {
  renderMotivBar();
  renderHomeLessonCard();
  renderMorningCards();
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
  const reviewCount = wrong + due;
  $('review-count').textContent = reviewCount || newList(words, srs).length;
  $('btn-review').disabled = false;
  renderGrammarExpressCard();
  renderMixedBrowseCard();
}

async function loadWords(lang) {
  if (!cache[lang]) cache[lang] = await (await fetch(LANGS[lang].file)).json();
  return cache[lang];
}

// ---------- Série du matin + Révisions express (reset à 7h chaque jour) ----------

function morningDate() {
  const now = new Date();
  // Avant 7h : on reste sur la "journée d'hier" pour conserver le contenu de la veille
  return now.getHours() < 7
    ? new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    : now.toISOString().slice(0, 10);
}

function _loadMorning(key) {
  const today = morningDate();
  try {
    const s = JSON.parse(localStorage.getItem(key) || 'null');
    if (s?.date === today) return s;
  } catch {}
  return null;
}
function _saveMorning(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

function _startTargetedVocabQuiz(wordObjects, lang, badge) {
  state.kind = 'vocab';
  state.lang = lang;
  state.words = cache[lang] || state.words;
  state.mode = 'srs';
  state.badge = badge;
  state.questions = shuffle([...wordObjects]).map(it => buildQuestion(it, state.words));
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

function renderGrammarExpressCard() {
  const card = $('grammar-express-card');
  if (!card) return;
  const topics = grammarWrongTopics();
  if (!topics.length) { card.classList.add('hidden'); return; }
  const chips = topics.map(id => {
    const t = grammarData && grammarData.find(d => d.id === id);
    return `<span class="morning-chip">${esc(t ? t.title : id)}</span>`;
  }).join('');
  card.innerHTML = `
    <div class="morning-header">
      <span class="morning-label">⟳ Révision Grammaire</span>
      <span class="morning-progress">${topics.length} concept${topics.length > 1 ? 's' : ''}</span>
    </div>
    <div class="morning-chips">${chips}</div>
    <button id="btn-start-grammar-review" class="primary">▶ Réviser</button>`;
  card.classList.remove('hidden');
  $('btn-start-grammar-review').addEventListener('click', startGrammarReview);
}

function renderMixedBrowseCard() {
  const card = $('mixed-browse-card');
  if (!card) return;
  if (state.lang !== 'en') { card.classList.add('hidden'); return; }
  card.innerHTML = `
    <div class="morning-header">
      <span class="morning-label">🔀 Parcourir</span>
      <span class="morning-progress">10 mots + 1 topic</span>
    </div>
    <div class="morning-chips">
      <span class="morning-chip">🔊 Prononciation auto</span>
      <span class="morning-chip">📝 1 concept grammaire (6 q.)</span>
    </div>
    <button id="btn-start-mixed-browse" class="primary">▶ Parcourir</button>`;
  card.classList.remove('hidden');
  $('btn-start-mixed-browse').addEventListener('click', startMixedBrowse);
}

async function startMixedBrowse() {
  const lang = 'en';
  if (!cache[lang]) await loadWords(lang);
  if (!grammarData) await loadGrammarLang(lang);
  const words = cache[lang] || [];
  // Initialise la session continue
  state.mixedSession = { allWords: words, shownVocabSet: new Set(), usedTopicIds: new Set() };
  state.kind = 'mixed';
  state.lang = lang;
  state.words = words;
  _launchMixedRound();
}

function _launchMixedRound() {
  const session = state.mixedSession;
  const srsVocab = getSrs('en');
  const due = dueList(session.allWords, srsVocab).filter(w => !session.shownVocabSet.has(w.word));
  const newWords = shuffle(session.allWords.filter(w => !srsVocab[w.word] && !session.shownVocabSet.has(w.word)));
  const vocabPicks = [...due, ...newWords].slice(0, 10);

  // Topics grammar : cycling si tous épuisés
  let topicPool = Object.keys(_GFIX).filter(id => !session.usedTopicIds.has(id));
  if (!topicPool.length) { session.usedTopicIds.clear(); topicPool = Object.keys(_GFIX); }
  topicPool = shuffle(topicPool);
  let pickedTopicId = null;
  for (const id of topicPool) {
    if (getTopicSeries(id).length) { pickedTopicId = id; break; }
  }

  // Session terminée : plus de vocab à voir
  if (!vocabPicks.length) {
    state.mixedSession = null;
    exitToHome();
    return;
  }

  vocabPicks.forEach(w => session.shownVocabSet.add(w.word));
  if (pickedTopicId) session.usedTopicIds.add(pickedTopicId);

  const grammarTitle = pickedTopicId && grammarData ? (grammarData.find(t => t.id === pickedTopicId)?.title || pickedTopicId) : '';
  state.badge = grammarTitle ? `🔀 Parcourir — ${grammarTitle}` : '🔀 Parcourir';
  state.browse = true;

  browseState.cards = vocabPicks.map(it => buildCard(it));
  browseState.idx = 0;
  browseState.revealed = false;
  browseState.seenMarked = new Set();
  browseState.renderFn = renderVocabBrowseCard;
  browseState.doneLabel = pickedTopicId ? 'Commencer la grammaire →' : 'Terminer';
  browseState.onDone = pickedTopicId
    ? () => _startMixedGrammarQuiz(pickedTopicId, session.allWords, grammarTitle)
    : () => _launchMixedRound();
  showView('learn');
  renderVocabBrowseCard();
}

function _startMixedGrammarQuiz(topicId, allWords, grammarTitle) {
  const serie = getTopicSeries(topicId)[0] || [];
  const grammarQs = serie.map(t => {
    const item = _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
    const gq = buildGrammarQuestion(item);
    gq.word = 'gen-' + topicId;
    gq._srsKey = GRAMMAR_KEY;
    gq._isGrammar = true;
    gq._isSentence = true;
    return gq;
  });
  state.kind = 'mixed';
  state.browse = false;
  state.words = allWords;
  state.mode = 'srs';
  state.badge = grammarTitle ? `🔀 Parcourir — ${grammarTitle}` : '🔀 Parcourir';
  state.questions = grammarQs;
  state.answers = [];
  state.index = 0;
  state.onQuizFinish = () => _launchMixedRound();
  showView('quiz');
  renderQuestion();
}

async function renderMorningCards() {
  const serCard = $('morning-series-card');
  const exCard  = $('morning-express-card');
  if (!serCard || !exCard) return;

  const lang = state.lang;
  const allWords = state.words && state.words.length ? state.words : await loadWords(lang);
  const words = state.selectedLevels.size ? allWords.filter(w => state.selectedLevels.has(w.level)) : allWords;
  const srs   = getSrs(lang);
  const now   = Date.now();
  const today = morningDate();
  const serKey = `morning_series_${lang}`;
  const exKey  = `morning_express_${lang}`;

  // ── Série du matin (10 mots non maîtrisés) ──
  let series = _loadMorning(serKey);
  if (!series) {
    const unseen = shuffle(words.filter(w => !srs[w.word]));
    const lowBox = shuffle(words.filter(w => srs[w.word] && srs[w.word].box < 2));
    const picks  = [...unseen, ...lowBox].slice(0, 10);
    if (picks.length) {
      series = { date: today, words: picks.map(w => w.word), done: false };
      _saveMorning(serKey, series);
    }
  }

  if (series) {
    const wList = series.words.map(wid => words.find(w => w.word === wid)).filter(Boolean);
    const doneCount = wList.filter(w => { const e = srs[w.word]; return e && e.seen > 0 && e.last === 'ok'; }).length;
    const done = series.done || doneCount >= wList.length;
    serCard.innerHTML = `
      <div class="morning-header">
        <span class="morning-label">📚 Série du matin</span>
        <span class="morning-progress">${doneCount}/${wList.length}</span>
      </div>
      <div class="morning-wordlist">
        ${wList.slice(0, 5).map(w => `<div class="morning-word"><span class="morning-en${srs[w.word]?.last==='ok'?' morning-done-word':''}">${esc(w.word)}</span><span class="morning-fr">${esc(w.fr)}</span></div>`).join('')}
        ${wList.length > 5 ? `<div class="morning-word"><span class="morning-fr">+${wList.length - 5} mots…</span></div>` : ''}
      </div>
      ${done
        ? `<p class="morning-done-msg">✅ Série terminée — à demain 7h !</p>`
        : `<button id="btn-start-series" class="primary">▶ ${doneCount > 0 ? 'Continuer' : 'Commencer'}</button>`}`;
    serCard.classList.remove('hidden');
    if (!done) $('btn-start-series').addEventListener('click', () => _startTargetedVocabQuiz(wList, lang, '📚 Série du matin'));
  } else {
    serCard.classList.add('hidden');
  }

  // ── Révisions express (5 mots les plus en retard) ──
  let express = _loadMorning(exKey);
  if (!express) {
    const due = dueList(words, srs, now).slice(0, 5);
    if (due.length) {
      express = { date: today, words: due.map(w => w.word), done: false };
      _saveMorning(exKey, express);
    }
  }

  if (express) {
    const eList = express.words.map(wid => words.find(w => w.word === wid)).filter(Boolean);
    const done  = express.done;
    exCard.innerHTML = `
      <div class="morning-header">
        <span class="morning-label">⚡ Révisions express</span>
        <span class="morning-progress">${eList.length} mots</span>
      </div>
      <div class="morning-chips">${eList.map(w => `<span class="morning-chip">${esc(w.word)}</span>`).join('')}</div>
      ${done
        ? `<p class="morning-done-msg">✅ Révisions faites — à demain 7h !</p>`
        : `<button id="btn-start-express" class="primary">⚡ Réviser en 3 min</button>`}`;
    exCard.classList.remove('hidden');
    if (!done) $('btn-start-express').addEventListener('click', () => {
      express.done = true;
      _saveMorning(exKey, express);
      _startTargetedVocabQuiz(eList, lang, '⚡ Révisions express');
    });
  } else {
    exCard.classList.add('hidden');
  }
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
  if (lang === 'en') {
    state.selectedLevels.add('D');
    state.level = 'D';
  } else {
    state.level = 'Global';
  }
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
  $('quiz-word').classList.toggle('sentence', q._isSentence || state.kind === 'grammar' || state.kind === 'tenses' || (state.kind === 'phrases' && !!q.fullSentence));
  $('quiz-ipa').textContent = q.ipa ? '/' + q.ipa + '/' : '';

  const speakBtn = $('btn-speak');
  speakBtn.style.display = (state.mode === 'review' || q.promptIsForeign) ? '' : 'none';
  if (!a && settings.audioAuto) {
    if (state.mode === 'review') speakFemale(q.promptText, q.promptIsForeign ? quizTts() : 'fr-FR');
    else if (q.promptIsForeign) speak(q.foreign);
  }

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
    if ((q._isSentence || ['grammar', 'tenses', 'phrases'].includes(state.kind)) && q.fullSentence) html += `<div class="fb-line">📝 ${esc(q.fullSentence)}</div>`;
    if ((q._isSentence || ['grammar', 'faux-amis', 'familles', 'cognates', 'tenses', 'phrases'].includes(state.kind)) && q.hint) html += `<div class="fb-line tip">💡 ${esc(q.hint)}</div>`;
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
  const _sk = q._srsKey || quizKey();
  srsUpdate(_sk, q.word, correct);
  saveSrs(_sk);
  logDaily(_sk, correct);
  beep(correct); vibrate(correct);
  // prononce la bonne réponse après coup : mot étranger (sens inverse) ou forme correcte (verbes)
  if (settings.audioAuto) {
    if (state.mode === 'review') speakFemale(q.fullSentence || q.foreign || q.correctText, quizTts());
    else if (q._isGrammar || state.kind === 'grammar' || state.kind === 'tenses' || (state.kind === 'phrases' && q.fullSentence)) speak(q.fullSentence || q.correctText);
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
  if (state.grammarSeriesKey) { markSeriesDone(state.grammarSeriesKey); state.grammarSeriesKey = null; }

  // Mode Parcourir : enchaîner le prochain round sans afficher l'écran résultat
  if (state.onQuizFinish) {
    const cb = state.onQuizFinish;
    state.onQuizFinish = null;
    cb();
    return;
  }

  // Daily session: mark topic done and wire up continue button
  const _dailyCtx = state.dailySession ? { ...state.dailySession } : null;
  state.dailySession = null;
  const existingContinue = $('btn-daily-continue');
  if (existingContinue) existingContinue.remove();
  let _dailyResultSub = null;
  if (_dailyCtx) {
    const { session, topicIdx } = _dailyCtx;
    session.done[topicIdx] = true;
    saveDailySession(session);
    const nextIdx = session.done.findIndex(d => !d);
    if (nextIdx !== -1) {
      _dailyResultSub = `Session du jour — ${topicIdx + 1}/3 terminé`;
      const nTitle = grammarData?.find(t => t.id === session.topics[nextIdx])?.title || session.topics[nextIdx];
      const btn = document.createElement('button');
      btn.id = 'btn-daily-continue';
      btn.className = 'primary';
      btn.textContent = `▶ ${nTitle} (${nextIdx + 1}/3)`;
      btn.addEventListener('click', () => { btn.remove(); startDailyTopicAtIdx(session, nextIdx); });
      $('btn-replay').insertAdjacentElement('beforebegin', btn);
    } else {
      _dailyResultSub = '🎉 Session du jour complétée !';
    }
  }

  $('result-sub').textContent = _dailyResultSub
    || (state.mode === 'review' ? 'Révision terminée' : 'Quiz terminé');
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
  state.browse = false;
  if (['verbs', 'grammar', 'faux-amis', 'familles', 'cognates', 'tenses', 'phrases', 'toeic'].includes(state.kind)) state.kind = 'vocab';
  state.words = cache[state.lang] || state.words;
  showView('home'); renderStats();
}

$('btn-start').addEventListener('click', () => { state.kind = 'vocab'; startSession('srs'); });
$('btn-review').addEventListener('click', () => { state.kind = 'vocab'; startSession('review'); });
$('btn-next').addEventListener('click', goNext);
$('btn-abort').addEventListener('click', exitToHome);
$('btn-speak').addEventListener('click', () => { const q = state.questions[state.index]; if (!q) return; state.mode === 'review' ? speakFemale(q.promptText, q.promptIsForeign ? quizTts() : 'fr-FR') : speak(q.foreign); });
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
  $('btn-grammar-browse').classList.toggle('hidden', !(grammarData && grammarData.length));
  $('btn-toggle-ai').classList.toggle('hidden', !isEn);
  const _wrongCount = isEn ? grammarWrongTopics().length : 0;
  $('btn-grammar-review').classList.toggle('hidden', !isEn);
  $('btn-grammar-review').disabled = _wrongCount === 0;
  $('grammar-review-count').textContent = _wrongCount;
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
  renderDailySessionCard();
}

function showGrammarTopic(idx) {
  const t = grammarData[idx];
  if (!t) return;
  $('grammar-crumb').textContent = t.title;
  $('btn-toggle-ai').classList.add('hidden');
  $('grammar-ai-panel').classList.add('hidden');
  $('btn-grammar-quiz').classList.add('hidden');
  $('btn-grammar-learn').classList.add('hidden');
  $('btn-grammar-browse').classList.add('hidden');
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
      ${sec.tip ? `<div class="gram-tip">💡 ${esc(sec.tip)}</div>` : ''}
      ${(sec.examples && sec.examples.length) ? `<div class="gram-ex">${sec.examples.map(e => typeof e === 'string' ? `<div class="gex-row"><span class="gex-en">${esc(e)}</span></div>` : `<div class="gex-row"><span class="gex-en">${esc(e.en)}</span>${e.fr ? `<span class="gex-fr">${esc(e.fr)}</span>` : ''}</div>`).join('')}</div>` : ''}
    </div>`
  ).join('') +
    (() => {
      const topicSeries = getTopicSeries(t.id);
      if (!topicSeries.length) return '';
      const done = getSeriesDone();
      return `<div class="series-list">${topicSeries.map((s, i) => {
        const key = `${t.id}:${i}`;
        const isDone = done.has(key);
        return `<div class="series-row">
          <span class="series-badge${isDone ? ' done' : ''}">${isDone ? '✓' : i + 1}</span>
          <span class="series-label">Série ${i + 1} — ${s.length} questions</span>
          <button class="chip series-btn" data-topic="${esc(t.id)}" data-series="${i}">▶ Pratiquer</button>
        </div>`;
      }).join('')}</div>`;
    })();
  const detail = $('grammar-detail');
  detail.innerHTML = html;
  detail.querySelectorAll('.series-btn').forEach(btn =>
    btn.addEventListener('click', () => startGrammarQuizSeries(btn.dataset.topic, +btn.dataset.series)));
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

// ---------- mode Parcours grammaire (lecture libre, sans notation) ----------
// Inspiré du mode « Parcourir » de CyberRévision : on avance carte par carte dans les
// règles de grammaire, avec révélation progressive de la règle. Aucune note SRS n'est
// enregistrée ici. Les leçons (topics) sont tirées dans un ordre aléatoire, et celles déjà
// vues dans la journée sont exclues tant que toutes les leçons n'ont pas été parcourues.
const browseState = { cards: [], idx: 0, revealed: false, seenMarked: new Set(), onDone: null, renderFn: null, doneLabel: 'Terminer' };

// Persiste, par langue et par jour, la liste des leçons déjà proposées en Parcours —
// remise à zéro automatiquement au changement de date (comparaison de la clé 'date').
function grammarBrowseSeenStore() {
  const today = todayStr();
  let store = null;
  try { store = JSON.parse(localStorage.getItem('grammar_browse_seen') || 'null'); } catch (e) {}
  if (!store || store.date !== today) store = { date: today, en: [], es: [] };
  return store;
}
function grammarBrowseMarkSeen(topicId) {
  const store = grammarBrowseSeenStore();
  const seen = store[grammarLang] || (store[grammarLang] = []);
  if (!seen.includes(topicId)) seen.push(topicId);
  localStorage.setItem('grammar_browse_seen', JSON.stringify(store));
}

function buildGrammarBrowseCards() {
  const topics = grammarData || [];
  if (!topics.length) return [];
  const store = grammarBrowseSeenStore();
  const seenIds = new Set(store[grammarLang] || []);
  let pool = topics.filter(t => !seenIds.has(t.id));
  if (!pool.length) {
    // Toutes les leçons du jour ont déjà été vues : on repart pour un nouveau tour.
    store[grammarLang] = [];
    localStorage.setItem('grammar_browse_seen', JSON.stringify(store));
    pool = topics;
  }
  return shuffle(pool).flatMap(t =>
    (t.sections || []).map((sec, i) => ({
      topicId: t.id,
      topicTitle: t.title,
      partLabel: t.sections.length > 1 ? `Partie ${i + 1}/${t.sections.length}` : '',
      heading: sec.heading,
      points: sec.points || [],
      tip: sec.tip,
      examples: sec.examples || [],
    }))
  );
}

function startGrammarBrowse() {
  const cards = buildGrammarBrowseCards();
  if (!cards.length) return;
  browseState.cards = cards;
  browseState.idx = 0;
  browseState.revealed = false;
  browseState.seenMarked = new Set();
  state.browse = true;
  state.kind = 'grammar';
  showView('learn');
  renderBrowseCard();
}

function renderBrowseCard() {
  clearTimeout(autoNextTimer);
  const c = browseState.cards[browseState.idx];
  if (c.topicId && !browseState.seenMarked.has(c.topicId)) {
    browseState.seenMarked.add(c.topicId);
    grammarBrowseMarkSeen(c.topicId);
  }
  $('learn-progress').textContent = `Carte ${browseState.idx + 1}/${browseState.cards.length}`;
  $('learn-badge').textContent = `📖 Grammaire · ${grammarLang === 'en' ? 'Anglais' : 'Espagnol'}`;
  $('flash-label').textContent = c.topicTitle + (c.partLabel ? ' · ' + c.partLabel : '');
  $('flash-front').textContent = c.heading;
  $('flash-front').classList.add('sentence');
  $('flash-ipa').textContent = '';
  const back = $('flash-back');
  back.innerHTML = `<ul class="gram-points">${c.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` +
    (c.tip ? `<div class="gram-tip">💡 ${esc(c.tip)}</div>` : '') +
    (c.examples.length ? `<div class="gram-ex">${c.examples.map(e => typeof e === 'string'
      ? `<div class="gex-row"><span class="gex-en">${esc(e)}</span></div>`
      : `<div class="gex-row"><span class="gex-en">${esc(e.en)}</span>${e.fr ? `<span class="gex-fr">${esc(e.fr)}</span>` : ''}</div>`).join('')}</div>` : '');
  back.classList.add('hidden');
  browseState.revealed = false;
  $('btn-flash-reveal').classList.add('hidden');
  $('btn-flash-speak').style.display = 'none';
  $('flash-grade').classList.add('hidden');
  $('browse-nav').classList.remove('hidden');
  $('btn-browse-prev').disabled = browseState.idx === 0;
  $('btn-browse-next').textContent = 'Voir la règle →';
}

function renderVocabBrowseCard() {
  clearTimeout(autoNextTimer);
  const c = browseState.cards[browseState.idx];
  $('learn-progress').textContent = `Mot ${browseState.idx + 1}/${browseState.cards.length}`;
  $('learn-badge').textContent = '🔀 Parcourir';
  $('flash-label').textContent = 'Vocabulaire';
  $('flash-front').textContent = c.front;
  $('flash-front').classList.remove('sentence');
  $('flash-ipa').textContent = c.ipa ? '/' + c.ipa + '/' : '';
  const back = $('flash-back'); back.innerHTML = c.backHtml; back.classList.add('hidden');
  $('btn-flash-speak').style.display = '';
  $('btn-flash-reveal').classList.add('hidden');
  $('flash-grade').classList.add('hidden');
  $('browse-nav').classList.remove('hidden');
  $('btn-browse-prev').disabled = browseState.idx === 0;
  $('btn-browse-next').textContent = 'Voir la traduction →';
  browseState.revealed = false;
  if (settings.audioAuto) speak(c.audio);
}

function browsePrev() {
  if (!state.browse || browseState.idx === 0) return;
  browseState.idx--;
  (browseState.renderFn || renderBrowseCard)();
}

function browseNext() {
  if (!state.browse) return;
  if (!browseState.revealed) {
    browseState.revealed = true;
    $('flash-back').classList.remove('hidden');
    $('btn-browse-next').textContent = browseState.idx < browseState.cards.length - 1 ? 'Suivant →' : (browseState.doneLabel || 'Terminer');
  } else if (browseState.idx < browseState.cards.length - 1) {
    browseState.idx++;
    (browseState.renderFn || renderBrowseCard)();
  } else {
    state.browse = false;
    const done = browseState.onDone;
    browseState.onDone = null;
    if (done) done();
    else exitToHome();
  }
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
  state.onQuizFinish = null;
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

// Accès direct au Parcours grammaire depuis l'accueil (raccourci, sans passer par le sommaire).
async function openGrammarBrowseFromHome() {
  await loadGrammarLang(grammarLang);
  startGrammarBrowse();
}

document.querySelectorAll('.glang-chip').forEach(c => c.addEventListener('click', async () => {
  if (c.dataset.lang === grammarLang) return;
  await loadGrammarLang(c.dataset.lang);
  grammarScrollY = 0;
  renderGrammarList(false);
}));

$('btn-grammar').addEventListener('click', openGrammar);
$('btn-home-grammar-browse').addEventListener('click', openGrammarBrowseFromHome);
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
  state.browse = false;
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
  $('browse-nav').classList.add('hidden');
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
$('btn-grammar-browse').addEventListener('click', startGrammarBrowse);
$('btn-browse-prev').addEventListener('click', browsePrev);
$('btn-browse-next').addEventListener('click', browseNext);

// Raccourcis clavier du mode Parcours grammaire (← précédent, → suivant/révéler, Échap quitter)
document.addEventListener('keydown', (e) => {
  if (!state.browse || $('view-learn').classList.contains('hidden')) return;
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); browsePrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); browseNext(); }
  else if (e.key === 'Escape') { e.preventDefault(); exitToHome(); }
});

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
  'how-questions': [
    { q: '___ books do you have? (quantité dénombrable)', opts: ['How many','How much','How often','How long'], ans: 'How many', hint: 'Dénombrable → How many.' },
    { q: '___ does it cost? (prix)', opts: ['How much','How many','How far','How often'], ans: 'How much', hint: 'Prix / indénombrable → How much.' },
    { q: '___ can you run? (vitesse)', opts: ['How fast','How far','How well','How long'], ans: 'How fast', hint: 'Vitesse → How fast.' },
    { q: '___ is the station? (distance)', opts: ['How far','How long','How fast','How often'], ans: 'How far', hint: 'Distance → How far.' },
    { q: '___ do you go to the gym? (fréquence)', opts: ['How often','How long','How many','How much'], ans: 'How often', hint: 'Fréquence → How often.' },
    { q: '___ have you been waiting? (durée)', opts: ['How long','How often','How much','How many'], ans: 'How long', hint: 'Durée → How long.' },
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
  'emotions': [
    { q: "I'm ___ because I failed the test. (triste)", opts: ['sad','happy','proud','bored'], ans: 'sad', hint: 'Triste → sad.' },
    { q: "She was ___ when she got the job. (heureuse)", opts: ['happy','lonely','nervous','tired'], ans: 'happy', hint: 'Heureuse → happy.' },
    { q: "He feels ___ — he has a lot of work. (stressé)", opts: ['stressed','relaxed','grateful','amazed'], ans: 'stressed', hint: 'Stressé → stressed.' },
    { q: "I'm ___ of you — you did so well! (fier)", opts: ['proud','scared','confused','bored'], ans: 'proud', hint: 'Fier → proud.' },
    { q: "She was ___ by the magic show. (stupéfaite)", opts: ['amazed','nervous','disappointed','angry'], ans: 'amazed', hint: 'Stupéfait(e) → amazed.' },
    { q: "I feel ___ — I don't understand anything. (confus)", opts: ['confused','grateful','relaxed','surprised'], ans: 'confused', hint: 'Confus → confused.' },
  ],
  'daily-phrases': [
    { q: "J'ai compris. → I ___ it.", opts: ['got','did','made','took'], ans: 'got', hint: "I got it = j'ai compris." },
    { q: "Ce n'est pas grave. → It's not a big ___.", opts: ['deal','thing','issue','matter'], ans: 'deal', hint: "It's not a big deal = ce n'est pas grave." },
    { q: "Je reviens tout de suite. → I'll be ___ back.", opts: ['right','just','soon','quickly'], ans: 'right', hint: "I'll be right back = je reviens tout de suite." },
    { q: "Ça a du sens. → That ___ sense.", opts: ['makes','does','has','gives'], ans: 'makes', hint: 'Make sense = avoir du sens.' },
    { q: "Je m'en occupe. → I'll ___ it.", opts: ['handle','make','do','fix'], ans: 'handle', hint: "I'll handle it = je m'en occupe." },
    { q: "Je suis partant(e). → I'm ___.", opts: ['down','up','in','on'], ans: 'down', hint: "I'm down = je suis partant(e) (familier)." },
  ],
  'key-verbs': [
    { q: "'Éviter' en anglais ?", opts: ['avoid','blame','deny','ignore'], ans: 'avoid', hint: 'Éviter → avoid.' },
    { q: "'Accomplir' en anglais ?", opts: ['achieve','boost','commit','ensure'], ans: 'achieve', hint: 'Accomplir → achieve.' },
    { q: "'Impliquer' en anglais ?", opts: ['involve','deliver','offer','happen'], ans: 'involve', hint: 'Impliquer → involve.' },
    { q: "'Convaincre' en anglais ?", opts: ['convince','confirm','compare','consider'], ans: 'convince', hint: 'Convaincre → convince.' },
    { q: "'Admettre' en anglais ?", opts: ['admit','avoid','achieve','advise'], ans: 'admit', hint: 'Admettre → admit.' },
    { q: "'Se concentrer' en anglais ?", opts: ['focus','complain','compare','commit'], ans: 'focus', hint: 'Se concentrer → focus.' },
  ],
  'native-expressions': [
    { q: "Que signifie 'Actually' ?", opts: ['En fait','Donc','Peut-être','Vraiment'], ans: 'En fait', hint: "Actually = En fait (corriger ou nuancer)." },
    { q: "Que signifie 'Basically' ?", opts: ['En gros','Enfin','Franchement','Pourtant'], ans: 'En gros', hint: "Basically = En gros (résumer l'essentiel)." },
    { q: "Que signifie 'Never mind' ?", opts: ['Laisse tomber','Je vois','Ça dépend','Franchement'], ans: 'Laisse tomber', hint: "Never mind = Laisse tomber (abandonner un sujet)." },
    { q: "Que signifie 'Fair enough' ?", opts: ["C'est juste",'Laisse tomber','Attends','En gros'], ans: "C'est juste", hint: "Fair enough = C'est juste / D'accord." },
    { q: "Que signifie 'Hang on' ?", opts: ['Attends','Laisse tomber','Ça dépend','En fait'], ans: 'Attends', hint: "Hang on = Attends une seconde." },
    { q: "Que signifie 'It depends' ?", opts: ['Ça dépend','Je vois','Enfin','Ça suffit'], ans: 'Ça dépend', hint: "It depends = Ça dépend (réponse nuancée)." },
  ],
  'it-structures': [
    { q: "It's worth ___ (essayer)", opts: ['trying','to try','try','tried'], ans: 'trying', hint: "It's worth + gérondif (V-ing)." },
    { q: "It's no use ___ (pleurer)", opts: ['crying','to cry','cry','cried'], ans: 'crying', hint: "It's no use + gérondif (V-ing)." },
    { q: "It's time ___ (partir)", opts: ['to go','going','go','gone'], ans: 'to go', hint: "It's time to + infinitif (base verbale)." },
    { q: "It's up to you ___ (décider)", opts: ['to decide','deciding','decide','decided'], ans: 'to decide', hint: "It's up to you to + infinitif." },
    { q: "Traduction : 'Ça vaut la peine d'essayer.'", opts: ["It's worth trying","It's no use trying","It's time trying","It's up to try"], ans: "It's worth trying", hint: "Ça vaut la peine → It's worth + V-ing." },
    { q: "Traduction : 'Ça ne sert à rien de s'inquiéter.'", opts: ["It's no use worrying","It's worth worrying","It's time to worry","It's up to worry"], ans: "It's no use worrying", hint: "Ça ne sert à rien → It's no use + V-ing." },
  ],
  'refusal-expressions': [
    { q: "Comment dire 'Je ne peux pas' ?", opts: ["I can't","I won't","I don't","I'm not"], ans: "I can't", hint: "Je ne peux pas → I can't." },
    { q: "Comment dire 'Je ne suis pas intéressé' ?", opts: ["I'm not interested","I'm not interesting","I don't interest","I have no interest"], ans: "I'm not interested", hint: "Pas intéressé → I'm not interested." },
    { q: "Comment dire 'Peut-être une autre fois' ?", opts: ["Maybe another time","Maybe other time","Perhaps another day time","Maybe one time"], ans: "Maybe another time", hint: "Peut-être une autre fois → Maybe another time." },
    { q: "Comment dire 'Je vais passer' (refus informel) ?", opts: ["I'm gonna pass","I'm gonna go","I'll pass by","I pass"], ans: "I'm gonna pass", hint: "Je vais passer (décliner) → I'm gonna pass." },
    { q: "Comment dire 'C'est pas pour moi' ?", opts: ["It's not for me","It's not mine","It's not about me","It's not by me"], ans: "It's not for me", hint: "C'est pas pour moi → It's not for me." },
    { q: "Comment dire 'C'est compliqué' ?", opts: ["It's complicated","It's complex","It's difficult","It's a problem"], ans: "It's complicated", hint: "C'est compliqué → It's complicated." },
  ],
  'polite-refusals': [
    { q: "Comment dire 'Ça ne m'arrange pas' ?", opts: ["That doesn't work for me","That's not for me","That doesn't help me","That won't work out"], ans: "That doesn't work for me", hint: "Ça ne m'arrange pas → That doesn't work for me." },
    { q: "Comment dire 'Je préfèrerais pas' (doux) ?", opts: ["I'd rather not","I prefer not","I don't want","I won't do it"], ans: "I'd rather not", hint: "Je préfèrerais pas → I'd rather not." },
    { q: "Comment dire 'J'ai bien peur de ne pas pouvoir' ?", opts: ["I'm afraid I can't","I'm scared I won't","I fear I don't","I'm afraid to not"], ans: "I'm afraid I can't", hint: "Très poli : I'm afraid I can't." },
    { q: "Comment dire 'J'adorerais, mais...' ?", opts: ["I'd love to, but...","I would love, but...","I'd like to, but...","I loved to, but..."], ans: "I'd love to, but...", hint: "J'adorerais → I'd love to (conditionnel)." },
    { q: "Comment dire 'J'ai déjà quelque chose de prévu' ?", opts: ["I've already got plans","I already have plans made","I've got something planned","I have something already"], ans: "I've already got plans", hint: "Déjà prévu → I've already got plans." },
    { q: "Comment dire 'Je vais passer mon tour' ?", opts: ["I'm going to sit this one out","I'm gonna pass my turn","I'll skip this turn","I'm sitting out this"], ans: "I'm going to sit this one out", hint: "Passer son tour → sit this one out." },
  ],
  'everyday-expressions': [
    { q: "Comment dire 'Ça ne me dérange pas' ?", opts: ["I don't mind","I don't care","It's okay","No problem"], ans: "I don't mind", hint: "Ça ne me dérange pas → I don't mind." },
    { q: "Comment dire 'Fais attention !' ?", opts: ["Watch out!","Look out!","Be careful!","Pay attention!"], ans: "Watch out!", hint: "Fais attention ! → Watch out!" },
    { q: "Comment dire 'C'est parti !' ?", opts: ["Here we go!","Let's go!","We start!","Off we go!"], ans: "Here we go!", hint: "C'est parti ! → Here we go!" },
    { q: "Comment dire 'Que se passe-t-il ?' ?", opts: ["What's going on?","What is happening?","What's the matter?","What's wrong?"], ans: "What's going on?", hint: "Que se passe-t-il ? → What's going on?" },
    { q: "Comment dire 'Prends ton temps' ?", opts: ["Take your time","Take the time","Have your time","Keep your time"], ans: "Take your time", hint: "Prends ton temps → Take your time." },
    { q: "Comment dire 'Je t'en prie' (après un merci) ?", opts: ["Don't mention it","You're welcome","No problem","Of course"], ans: "Don't mention it", hint: "Je t'en prie → Don't mention it (très naturel)." },
  ],
  'practical-phrases': [
    { q: "Comment dire 'Ce n'est pas grave' ?", opts: ["It doesn't matter","It's not serious","It's no big deal","It's not grave"], ans: "It doesn't matter", hint: "Ce n'est pas grave → It doesn't matter." },
    { q: "Comment dire 'Je suis bloqué(e)' ?", opts: ["I'm stuck","I'm blocked","I'm frozen","I'm stopped"], ans: "I'm stuck", hint: "Je suis bloqué → I'm stuck." },
    { q: "Comment dire 'C'est trop tard' ?", opts: ["It's too late","It's too slow","It's very late","This is late"], ans: "It's too late", hint: "C'est trop tard → It's too late." },
    { q: "Comment dire 'Je n'ai pas encore fini' ?", opts: ["I haven't finished yet","I didn't finish yet","I'm not finished yet","I haven't done yet"], ans: "I haven't finished yet", hint: "Pas encore fini → haven't finished yet (present perfect)." },
    { q: "Comment dire 'Je dois rester concentré' ?", opts: ["I need to stay focused","I must stay focused","I have to be focused","I need to focus more"], ans: "I need to stay focused", hint: "Je dois rester concentré → I need to stay focused." },
    { q: "Comment dire 'Je suis de retour' ?", opts: ["I'm back","I'm returned","I came back","I'm here again"], ans: "I'm back", hint: "Je suis de retour → I'm back." },
  ],
  'do-you-questions': [
    { q: "'Tu veux manger ?' en anglais ?", opts: ['Do you want to eat?','Do you want to drink?','Do you want food?','Are you hungry?'], ans: 'Do you want to eat?', hint: "Tu veux manger ? → Do you want to eat?" },
    { q: "'Tu veux sortir ?' en anglais ?", opts: ['Do you want to go out?','Do you want to leave?','Do you want to exit?','Do you want to go?'], ans: 'Do you want to go out?', hint: "Tu veux sortir ? → Do you want to go out?" },
    { q: "'Tu veux essayer ?' en anglais ?", opts: ['Do you want to try?','Do you want to test?','Do you want to attempt?','Do you want to practice?'], ans: 'Do you want to try?', hint: "Tu veux essayer ? → Do you want to try?" },
    { q: "'Tu aimes la musique ?' en anglais ?", opts: ['Do you like music?','Do you enjoy music?','Do you love music?','Are you into music?'], ans: 'Do you like music?', hint: "Tu aimes la musique ? → Do you like music?" },
    { q: "'Tu fais quoi ?' en anglais ?", opts: ['What are you doing?','What do you do?','What are you making?','What are you up to?'], ans: 'What are you doing?', hint: "Tu fais quoi ? → What are you doing?" },
    { q: "'Tu es prêt(e) ?' en anglais ?", opts: ['Are you ready?','Are you set?','Are you prepared?','Are you done?'], ans: 'Are you ready?', hint: "Tu es prêt(e) ? → Are you ready?" },
  ],
  'essential-sentences': [
    { q: "'Attends une minute' en anglais ?", opts: ['Wait a minute','Hold on a second','One moment please','Just a minute'], ans: 'Wait a minute', hint: "Attends une minute → Wait a minute." },
    { q: "'Je suis perdu(e)' en anglais ?", opts: ["I'm lost","I'm confused","I don't know where I am","I'm disoriented"], ans: "I'm lost", hint: "Je suis perdu(e) → I'm lost." },
    { q: "'Je suis d'accord' en anglais ?", opts: ['I agree','I accept','I approve','I confirm'], ans: 'I agree', hint: "Je suis d'accord → I agree." },
    { q: "'Assieds-toi' en anglais ?", opts: ['Sit down','Take a seat','Be seated','Sit here'], ans: 'Sit down', hint: "Assieds-toi → Sit down." },
    { q: "'C'est parfait' en anglais ?", opts: ["That's perfect","That's great","That's excellent","That's correct"], ans: "That's perfect", hint: "C'est parfait → That's perfect." },
    { q: "'Fais de ton mieux' en anglais ?", opts: ['Do your best','Try your hardest','Give your best','Do what you can'], ans: 'Do your best', hint: "Fais de ton mieux → Do your best." },
  ],
  'slang-expressions': [
    { q: "'C'est la galère' en anglais ?", opts: ["It's a struggle","It's hard","It's a mess","It's complicated"], ans: "It's a struggle", hint: "C'est la galère → It's a struggle." },
    { q: "'Je suis crevé' en anglais ?", opts: ["I'm exhausted","I'm tired","I'm done","I'm finished"], ans: "I'm exhausted", hint: "Je suis crevé → I'm exhausted." },
    { q: "'Je capte rien' en anglais ?", opts: ['I have no clue','I understand nothing','I got nothing','I know nothing'], ans: 'I have no clue', hint: "Je capte rien → I have no clue." },
    { q: "'T'es sérieux là ?' en anglais ?", opts: ['Are you serious?','Are you joking?','Is that real?','Really?'], ans: 'Are you serious?', hint: "T'es sérieux là ? → Are you serious?" },
    { q: "'On gère' en anglais ?", opts: ['We got this','We manage','We handle it','We can do it'], ans: 'We got this', hint: "On gère → We got this." },
    { q: "'J'ai la flemme' en anglais ?", opts: ['I feel lazy','I have no energy','I feel tired','I can\'t be bothered'], ans: 'I feel lazy', hint: "J'ai la flemme → I feel lazy." },
  ],
  'social-expressions': [
    { q: "'Enchanté(e)' en anglais ?", opts: ['Nice to meet you','Glad to see you','Pleased to be here','Good to meet you'], ans: 'Nice to meet you', hint: "Enchanté(e) → Nice to meet you." },
    { q: "'Bon travail !' en anglais ?", opts: ['Good job!','Well done!','Not bad!','Great work!'], ans: 'Good job!', hint: "Bon travail ! → Good job!" },
    { q: "'Bravo !' en anglais ?", opts: ['Well done!','Good job!','Not bad!','Great!'], ans: 'Well done!', hint: "Bravo ! → Well done!" },
    { q: "'Bonne chance !' en anglais ?", opts: ['Best of luck!','Good luck!','You can do it!','Stay strong!'], ans: 'Best of luck!', hint: "Bonne chance ! → Best of luck!" },
    { q: "'J'ai une idée !' en anglais ?", opts: ['I have an idea!','I got it!','I think so!','Let me think!'], ans: 'I have an idea!', hint: "J'ai une idée ! → I have an idea!" },
    { q: "'C'est exact.' en anglais ?", opts: ["That's right.","That's correct.","Exactly right.","You're right."], ans: "That's right.", hint: "C'est exact. → That's right." },
  ],
  'driving-expressions': [
    { q: "'Je tourne à gauche' en anglais ?", opts: ['I turn left','I go left','I drive left','I move left'], ans: 'I turn left', hint: "Je tourne à gauche → I turn left." },
    { q: "'Je freine' en anglais ?", opts: ['I brake','I stop','I slow','I halt'], ans: 'I brake', hint: "Je freine → I brake." },
    { q: "'Je ralentis' en anglais ?", opts: ['I slow down','I brake','I stop','I calm down'], ans: 'I slow down', hint: "Je ralentis → I slow down." },
    { q: "'J'accélère' en anglais ?", opts: ['I speed up','I go fast','I accelerate more','I drive fast'], ans: 'I speed up', hint: "J'accélère → I speed up." },
    { q: "'Je dépasse la voiture' en anglais ?", opts: ['I overtake the car','I pass by the car','I drive past it','I skip the car'], ans: 'I overtake the car', hint: "Je dépasse la voiture → I overtake the car." },
    { q: "'Il y a des embouteillages' en anglais ?", opts: ["There's traffic",'There are jams','The road is blocked','Cars are everywhere'], ans: "There's traffic", hint: "Il y a des embouteillages → There's traffic." },
  ],
  'french-proverbs': [
    { q: "'L'espoir fait vivre' en anglais ?", opts: ['Hope keeps us going','Hope makes us live','Hope drives us forward','Hope is everything'], ans: 'Hope keeps us going', hint: "L'espoir fait vivre → Hope keeps us going." },
    { q: "'La patience est une vertu' en anglais ?", opts: ['Patience is a virtue','Patience is key','Patience pays off','Patience always wins'], ans: 'Patience is a virtue', hint: "La patience est une vertu → Patience is a virtue." },
    { q: "'Il n'y a pas de fumée sans feu' en anglais ?", opts: ["Where there's smoke, there's fire",'No smoke without reason','Fire always leaves traces','Smoke means danger'], ans: "Where there's smoke, there's fire", hint: "Il n'y a pas de fumée sans feu → Where there's smoke, there's fire." },
    { q: "'On apprend de ses erreurs' en anglais ?", opts: ['We learn from our mistakes','We grow from failure','Mistakes teach us all','Error is human'], ans: 'We learn from our mistakes', hint: "On apprend de ses erreurs → We learn from our mistakes." },
    { q: "'La vérité finit toujours par éclater' en anglais ?", opts: ['The truth always comes out','Truth is never hidden','Facts come to light','Lies never last'], ans: 'The truth always comes out', hint: "La vérité finit toujours par éclater → The truth always comes out." },
    { q: "'Mieux vaut être seul que mal accompagné' en anglais ?", opts: ['Better be alone than in bad company','Solitude is better than misery','Choose friends wisely','Bad friends bring bad luck'], ans: 'Better be alone than in bad company', hint: "Mieux vaut être seul que mal accompagné → Better be alone than in bad company." },
  ],
  'negotiation-expressions': [
    { q: "Traduction de 'To open the talks'", opts: ['Ouvrir les négociations','Commencer à parler','Lancer le débat','Ouvrir la discussion'], ans: 'Ouvrir les négociations', hint: "To open the talks → Ouvrir les négociations." },
    { q: "Traduction de 'To make a concession'", opts: ['Faire une concession','Accepter un compromis','Céder du terrain','Prendre position'], ans: 'Faire une concession', hint: "To make a concession → Faire une concession." },
    { q: "Traduction de 'To close the deal'", opts: ["Conclure l'accord",'Fermer le dossier','Signer le contrat','Terminer les talks'], ans: "Conclure l'accord", hint: "To close the deal → Conclure l'accord." },
    { q: "Traduction de 'To handle objections'", opts: ['Gérer les objections','Répondre aux questions','Traiter les plaintes','Ignorer les objections'], ans: 'Gérer les objections', hint: "To handle objections → Gérer les objections." },
    { q: "Traduction de 'To reach a compromise'", opts: ['Parvenir à un compromis','Trouver une solution','Accepter les termes','Faire un accord'], ans: 'Parvenir à un compromis', hint: "To reach a compromise → Parvenir à un compromis." },
    { q: "Traduction de 'To follow up'", opts: ['Assurer le suivi','Faire un retour','Vérifier les détails','Continuer les talks'], ans: 'Assurer le suivi', hint: "To follow up → Assurer le suivi." },
  ],
  'tout-expressions': [
    { q: "'Tout à fait' en anglais ?", opts: ['Absolutely','All the way','Quite well','Fully'], ans: 'Absolutely', hint: "Tout à fait → Absolutely / Exactly." },
    { q: "'Tout de suite' en anglais ?", opts: ['Right away','All at once','Soon','Immediately after'], ans: 'Right away', hint: "Tout de suite → Right away / Immediately." },
    { q: "'Tout le monde' en anglais ?", opts: ['Everyone','All the world','Everybody out','The whole world'], ans: 'Everyone', hint: "Tout le monde → Everyone / Everybody." },
    { q: "'Tout d'abord' en anglais ?", opts: ['First of all','Above all','After all','All things considered'], ans: 'First of all', hint: "Tout d'abord → First of all." },
    { q: "'Malgré tout' en anglais ?", opts: ['Despite everything','Above all','After all','All the same'], ans: 'Despite everything', hint: "Malgré tout → Despite everything." },
    { q: "'Pas du tout' en anglais ?", opts: ['Not at all','Not totally','Not really','Absolutely not'], ans: 'Not at all', hint: "Pas du tout → Not at all." },
  ],
  'use-of-else': [
    { q: "'Autre chose ?' en anglais (question au restaurant)", opts: ["Anything else?","Something else?","What else?","Other thing?"], ans: "Anything else?", hint: "En question → anything else (pas something)." },
    { q: "'Quelqu'un d'autre' en anglais", opts: ["Someone else","Anyone else","Nobody else","Other person"], ans: "Someone else", hint: "Quelqu'un d'autre → someone else (affirmatif)." },
    { q: "'Rien d'autre' en anglais", opts: ["Nothing else","Anything else","No else","Not else"], ans: "Nothing else", hint: "Rien d'autre → nothing else." },
    { q: "'Quoi d'autre ?' en anglais", opts: ["What else?","Which else?","What other?","How else?"], ans: "What else?", hint: "Quoi d'autre ? → What else?" },
    { q: "'Sinon' (conséquence) en anglais", opts: ["Or else","If not","Otherwise else","Or other"], ans: "Or else", hint: "Sinon (conséquence) → or else." },
    { q: "'Nulle part ailleurs' en anglais", opts: ["Nowhere else","No else where","Not elsewhere","Anywhere else not"], ans: "Nowhere else", hint: "Nulle part ailleurs → nowhere else." },
  ],
  'compliments': [
    { q: "Comment dire 'Tu es magnifique aujourd'hui' ?", opts: ["You look amazing today","You are amazing today","You look beautiful today","You seem amazing today"], ans: "You look amazing today", hint: "Magnifique → You look amazing (look + adjectif)." },
    { q: "Comment dire 'J'adore ton style' ?", opts: ["I love your style","I like your style","I adore your style","I enjoy your style"], ans: "I love your style", hint: "J'adore → I love (plus naturel qu'I adore en anglais)." },
    { q: "Comment dire 'Ta tenue est parfaite' ?", opts: ["Your outfit is perfect","Your clothes are perfect","Your dress is perfect","Your suit is perfect"], ans: "Your outfit is perfect", hint: "Tenue → outfit (terme général pour une tenue vestimentaire)." },
    { q: "Comment dire 'Cette couleur te va très bien' ?", opts: ["That color looks great on you","That color is great for you","This color suits to you","That color fits you"], ans: "That color looks great on you", hint: "Te va bien → looks great on you." },
    { q: "Comment dire 'Tu rayonnes aujourd'hui' ?", opts: ["You're glowing today","You're shining today","You're radiant today","You're beaming today"], ans: "You're glowing today", hint: "Tu rayonnes → You're glowing (expression très naturelle)." },
    { q: "Comment dire 'Tu es en pleine forme' ?", opts: ["You're in great shape","You look healthy","You're very fit","You're in good form"], ans: "You're in great shape", hint: "En pleine forme → in great shape." },
  ],
  'discourse-connectors': [
    { q: "Quel connecteur signifie 'D'abord' ?", opts: ['First','Then','Next','After that'], ans: 'First', hint: "First → D'abord — le premier connecteur de séquence." },
    { q: "Quel connecteur signifie 'Pendant ce temps' ?", opts: ['Meanwhile','At the same time','Then','After that'], ans: 'Meanwhile', hint: "Meanwhile → Pendant ce temps (récit / narration)." },
    { q: "Que signifie 'Last but not least' ?", opts: ["Enfin, et non des moindres","Enfin et le dernier","Le dernier mais pas le moindre effort","Dernier point, sans importance"], ans: "Enfin, et non des moindres", hint: "Last but not least → souligne que le dernier point est tout aussi important." },
    { q: "Quel connecteur utiliser pour résumer ?", opts: ['To sum up','In conclusion','Meanwhile','After that'], ans: 'To sum up', hint: "To sum up → Pour résumer (début d'une synthèse)." },
    { q: "Différence entre 'Meanwhile' et 'At the same time' ?", opts: ["Meanwhile = récit/narration ; at the same time = factuel","Ce sont des synonymes exacts","At the same time = résumé","Meanwhile = conclusion"], ans: "Meanwhile = récit/narration ; at the same time = factuel", hint: "Meanwhile est plus narratif ; at the same time est plus factuel/explicatif." },
    { q: "Compléter : '___, I'd like to thank the entire team.' (dernier point important)", opts: ['Last but not least','Finally','To sum up','In conclusion'], ans: 'Last but not least', hint: "Last but not least → dernier point présenté comme tout aussi important." },
  ],
  'such-expressions': [
    { q: "Que signifie 'as such' dans 'The job, as such, doesn't appeal to him' ?", opts: ['En soi / en tant que tel','Par conséquent','Tellement','Tel ou tel'], ans: 'En soi / en tant que tel', hint: "As such → en lui-même / à ce titre." },
    { q: "Compléter : 'There's no ___ thing as a perfect person.'", opts: ['such','such a','as such','such and such'], ans: 'such', hint: "There's no such thing as… → ça n'existe pas." },
    { q: "Que signifie 'such and such a time' ?", opts: ['À telle ou telle heure (non précisée)','À une heure précise','Tellement tard','En tant que telle'], ans: 'À telle ou telle heure (non précisée)', hint: "Such and such → remplace une info vague ou non précisée." },
    { q: "Traduire : 'Elle a tellement protesté qu'une enquête a été demandée.'", opts: ['She protested to such an extent that an investigation was demanded.','She protested so much that an investigation was such.','Such was her protest that she demanded an investigation.','She did no such thing as protest.'], ans: 'She protested to such an extent that an investigation was demanded.', hint: "To such an extent that… → tellement… que… (conséquence extrême)." },
    { q: "Comment utilise-t-on 'I did no such thing' ?", opts: ['Pour nier fermement une accusation','Pour exprimer un doute','Pour indiquer une quantité vague','Pour marquer une conséquence'], ans: 'Pour nier fermement une accusation', hint: "\"I did no such thing!\" → Je n'ai rien fait de tel ! (déni ferme)." },
    { q: "Quelle expression remplace une info non précisée ?", opts: ['Such and such','As such','No such thing','To such an extent'], ans: 'Such and such', hint: "Such and such → tel ou tel, une chose ou une autre (info vague)." },
  ],
  'ing-ed-adjectives': [
    { q: "The film was very ___. I fell asleep.", opts: ['boring','bored','bore','boringly'], ans: 'boring', hint: "-ING décrit la chose : the film was boring (ennuyeux)." },
    { q: "We were ___ by the shocking news.", opts: ['shocked','shocking','shock','shockingly'], ans: 'shocked', hint: "-ED décrit ce qu'on ressent : we were shocked (choqués)." },
    { q: "The hike was ___. (Le trajet était fatigant)", opts: ['tiring','tired','tire','tiresome'], ans: 'tiring', hint: "Le trajet (chose) → tiring ; c'est vous (personne) → tired." },
    { q: "She was ___ by her son's results. (impressionnée)", opts: ['amazed','amazing','amaze','amazingly'], ans: 'amazed', hint: "Elle ressent → amazed (-ED). Les résultats sont amazing (-ING)." },
    { q: "The circus is ___ for children.", opts: ['exciting','excited','excite','excitingly'], ans: 'exciting', hint: "Le cirque (chose) → exciting ; les enfants (personnes) → excited." },
    { q: "I was ___ by the refugee's story. (touché)", opts: ['moved','moving','move','movingly'], ans: 'moved', hint: "-ED pour la personne qui ressent : I was moved." },
  ],
  'disagreement-expressions': [
    { q: "Comment dire 'Je ne crois pas' poliment ?", opts: ["I don't believe so","I don't think so","I'm not sure","That's not true"], ans: "I don't believe so", hint: "I don't believe so → Je ne crois pas — plus poli que 'I don't think so'." },
    { q: "Que signifie 'That's not true' ?", opts: ["Ce n'est pas vrai","Ce n'est pas juste","Je ne crois pas","Tu as tort"], ans: "Ce n'est pas vrai", hint: "That's not true → Ce n'est pas vrai (direct, à éviter en contexte formel)." },
    { q: "Comment dire 'Tu as tort' en anglais ?", opts: ["You're wrong","You're mistaken","That's false","You're incorrect"], ans: "You're wrong", hint: "You're wrong → Tu as tort (direct et courant)." },
    { q: "Que signifie 'I see it differently' ?", opts: ["Je vois les choses autrement","Je comprends différemment","J'ai une autre idée","Je ne suis pas d'accord"], ans: "Je vois les choses autrement", hint: "I see it differently → Je vois les choses autrement (diplomatique)." },
    { q: "Comment dire 'Je ne suis pas convaincu(e)' ?", opts: ["I'm not convinced","I'm not sure","I disagree","I don't believe so"], ans: "I'm not convinced", hint: "I'm not convinced → Je ne suis pas convaincu(e)." },
    { q: "Comment dire 'Ce n'est pas une bonne idée' ?", opts: ["It's not a good idea","That's a bad idea","I refuse that","Not a great plan"], ans: "It's not a good idea", hint: "It's not a good idea → Ce n'est pas une bonne idée (doux mais clair)." },
  ],
  'i-dont-know-alternatives': [
    { q: "Que signifie 'It beats me' ?", opts: ["Je n'en sais rien","Ça me dépasse (difficile)","Je suis battu","Tu m'impressionnes"], ans: "Je n'en sais rien", hint: "It beats me → Ça me dépasse / Je n'en sais rien (informel)." },
    { q: "Comment dire 'Je ne suis pas sûr(e)' poliment ?", opts: ["I'm not sure","I have no clue","It beats me","I wouldn't know"], ans: "I'm not sure", hint: "I'm not sure → Je ne suis pas sûr(e) — expression polie et naturelle." },
    { q: "Quelle expression signifie 'Je ne suis pas au courant' ?", opts: ["I'm not aware","I'm not certain","I can't say","I'm unsure"], ans: "I'm not aware", hint: "I'm not aware → Je ne suis pas au courant de ça." },
    { q: "Comment dire 'Je n'ai pas la moindre idée' (familier) ?", opts: ["I haven't got a clue","I'm not sure","I can't say","I wouldn't know"], ans: "I haven't got a clue", hint: "I haven't got a clue → Je n'ai pas la moindre idée (très familier)." },
    { q: "Que signifie 'I wouldn't know' ?", opts: ["Je ne saurais pas dire","Je ne voudrais pas savoir","Je ne le saurai jamais","Je n'aurais pas su"], ans: "Je ne saurais pas dire", hint: "I wouldn't know → Je ne saurais pas dire (ce n'est pas mon domaine)." },
    { q: "Comment dire 'Je ne peux pas dire' en anglais ?", opts: ["I can't say","I don't know","I'm unsure","I won't tell"], ans: "I can't say", hint: "I can't say → Je ne peux pas dire (parfois : c'est confidentiel)." },
  ],
  'away-phrasal-verbs': [
    { q: "Que signifie 'turn away' ?", opts: ['Se détourner','Partir','S\'enfuir','Ranger'], ans: 'Se détourner', hint: "Turn away → se détourner, faire face à l'opposé." },
    { q: "Compléter : 'The thief managed to ___ before the police arrived.'", opts: ['get away','run away','go away','stay away'], ans: 'get away', hint: "Get away → s'échapper avec succès." },
    { q: "Que signifie 'put away' ?", opts: ['Ranger','Jeter','Enlever','Donner'], ans: 'Ranger', hint: "Put away → ranger soigneusement à sa place." },
    { q: "Que signifie 'give away' ?", opts: ['Donner gratuitement','Jeter','Enlever','Ranger'], ans: 'Donner gratuitement', hint: "Give away → donner gratuitement, offrir." },
    { q: "Compléter : '___ from that dog — it bites!'", opts: ['Stay away','Run away','Look away','Go away'], ans: 'Stay away', hint: "Stay away → rester à distance (éviter)." },
    { q: "Traduire : 'Elle a jeté tous ses vieux magazines.'", opts: ["She threw away all her old magazines.","She put away all her old magazines.","She gave away all her old magazines.","She took away all her old magazines."], ans: "She threw away all her old magazines.", hint: "Throw away → jeter définitivement." },
  ],
  'question-expressions': [
    { q: "Que signifie 'What for' ?", opts: ['Dans quel but / Pourquoi','Avec qui','De quelle manière','Depuis quand'], ans: 'Dans quel but / Pourquoi', hint: "What for → dans quel but, pourquoi (informel et direct)." },
    { q: "Comment dit-on 'Avec qui' (formel) en anglais ?", opts: ['With whom','Who with','By whom','For whom'], ans: 'With whom', hint: "With whom → avec qui (formel). Informel : who with." },
    { q: "Que signifie 'How come' ?", opts: ['Comment se fait-il que','Comment venir','Pourquoi venir','De quelle manière'], ans: 'Comment se fait-il que', hint: "How come → comment se fait-il que (informel, sans inversion : How come you're late?)." },
    { q: "Quelle expression signifie 'Jusqu'à quand' ?", opts: ['Until when','From when','At what time','At which time'], ans: 'Until when', hint: "Until when → jusqu'à quand." },
    { q: "Différence entre 'At what time' et 'At which time' ?", opts: ["At which time est plus précis et formel","Ce sont des synonymes exacts","At what time est plus formel","At which time s'utilise en informel"], ans: "At which time est plus précis et formel", hint: "At which time → version plus précise et formelle de at what time." },
    { q: "Que signifie 'From where' ?", opts: ["D'où","Vers où","Depuis quand","Par où"], ans: "D'où", hint: "From where → d'où (origine ou provenance)." },
  ],
  'linking-expressions': [
    { q: "Que signifie 'Provided that' ?", opts: ['À condition que','Au cas où','Même si','Tant que'], ans: 'À condition que', hint: "Provided that → à condition que (condition stricte)." },
    { q: "Différence entre 'Thanks to' et 'Due to' ?", opts: ["Thanks to = résultat positif ; due to = résultat négatif/neutre","Ce sont des synonymes","Due to = résultat positif","Thanks to = cause logique"], ans: "Thanks to = résultat positif ; due to = résultat négatif/neutre", hint: "Thanks to → grâce à (positif) ; due to → à cause de (négatif/neutre)." },
    { q: "Que signifie 'In case' ?", opts: ['Au cas où','À condition que','Même si','Puisque'], ans: 'Au cas où', hint: "In case → au cas où (précaution face à un risque)." },
    { q: "Compléter : 'She left early ___ avoid traffic.' (de manière à)", opts: ['so as to','so that','in order that','because'], ans: 'so as to', hint: "So as to + infinitif → de manière à." },
    { q: "Que signifie 'In spite of' ?", opts: ['Malgré / en dépit de','En plus de','À cause de','Grâce à'], ans: 'Malgré / en dépit de', hint: "In spite of → malgré, en dépit de (concession)." },
    { q: "Que signifie 'Since' dans 'Since you're here, let's start' ?", opts: ['Puisque (cause logique)','Depuis (temps)','Tant que','Même si'], ans: 'Puisque (cause logique)', hint: "Since peut signifier 'puisque' (cause) ou 'depuis' (temps). Ici : cause logique." },
  ],
  'verb-types': [
    { q: "Qu'est-ce qu'un verbe fini (finite verb) ?", opts: ['Un verbe qui montre le temps et s\'accorde avec le sujet','Un verbe sans temps ni accord','Un verbe auxiliaire','Un verbe à particule'], ans: "Un verbe qui montre le temps et s'accorde avec le sujet", hint: "Finite verb → montre le temps, s'accorde avec le sujet — c'est le verbe principal de la phrase." },
    { q: "Lequel est un verbe non-fini (non-finite) ?", opts: ['To go','She goes','He went','They go'], ans: 'To go', hint: "To go = infinitif → non-fini (pas de temps, pas d'accord sujet)." },
    { q: "Quels sont les 3 Primary Auxiliaries ?", opts: ['be, do, have','can, will, must','am, is, are','was, were, been'], ans: 'be, do, have', hint: "Primary Auxiliaries : be, do, have. Ils aident à former les temps et les questions." },
    { q: "Que signifie 'give up' comme phrasal verb ?", opts: ['Abandonner / arrêter','Donner','Monter','Offrir'], ans: 'Abandonner / arrêter', hint: "Give up (Verb + Adverb) → abandonner, arrêter. Sens non littéral." },
    { q: "Un gerund (gérondif) est quel type de verbe ?", opts: ['Non-fini (non-finite)','Fini (finite)','Auxiliaire','Modal'], ans: 'Non-fini (non-finite)', hint: "Le gérondif (verb + ing) est un verbe non-fini — il n'indique pas le temps." },
    { q: "Quel modal verb exprime la nécessité absolue ?", opts: ['must','can','might','shall'], ans: 'must', hint: "Must → nécessité absolue. Can → capacité. Might → possibilité faible." },
  ],
  'idioms-work-learning': [
    { q: "Que signifie 'bite the bullet' ?", opts: ["Prendre sur soi / avaler la pilule","Mâcher son frein","Foncer tête baissée","Arrêter de travailler"], ans: "Prendre sur soi / avaler la pilule", hint: "Bite the bullet → faire face à quelque chose de difficile avec courage." },
    { q: "Que signifie 'burn the midnight oil' ?", opts: ["Travailler tard dans la nuit","Gaspiller ses ressources","Allumer les bougies","Faire la fête jusqu'au bout"], ans: "Travailler tard dans la nuit", hint: "Burn the midnight oil → travailler tard, à la lumière d'une lampe à huile." },
    { q: "Que signifie 'call it a day' ?", opts: ['Arrêter de travailler / en rester là','Terminer la journée à midi','Appeler un collègue','Tout recommencer'], ans: 'Arrêter de travailler / en rester là', hint: "Call it a day → décider que le travail du jour est terminé." },
    { q: "Que signifie 'back to square one' ?", opts: ['Repartir de zéro','Revenir au bureau','Recommencer correctement','Retourner à la case départ du jeu'], ans: 'Repartir de zéro', hint: "Back to square one → tout recommencer depuis le début." },
    { q: "Que signifie 'miss the boat' ?", opts: ['Rater le coche / manquer une opportunité','Rater son bus','Arriver en retard','Manquer un rendez-vous'], ans: 'Rater le coche / manquer une opportunité', hint: "Miss the boat → laisser passer une chance qu'on ne retrouvera peut-être pas." },
    { q: "Que signifie 'kill two birds with one stone' ?", opts: ["Faire d'une pierre deux coups","Éliminer des problèmes","Travailler trop vite","Tout accomplir en une journée"], ans: "Faire d'une pierre deux coups", hint: "Kill two birds with one stone → atteindre deux objectifs avec une seule action." },
  ],
  'idioms-communication': [
    { q: "Que signifie 'beat around the bush' ?", opts: ['Tourner autour du pot','Parler fort','Éviter le sujet principal','Chercher ses mots'], ans: 'Tourner autour du pot', hint: "Beat around the bush → éviter de dire quelque chose directement." },
    { q: "Que signifie 'spill the beans' ?", opts: ['Révéler un secret','Faire une gaffe','Renverser quelque chose','Raconter une histoire'], ans: 'Révéler un secret', hint: "Spill the beans → révéler un secret, souvent accidentellement." },
    { q: "Que signifie 'all ears' ?", opts: ['Tout ouïe / à l\'écoute','Attentif visuellement','Disponible','Prêt à parler'], ans: "Tout ouïe / à l'écoute", hint: "All ears → entièrement à l'écoute, prêt à entendre ce qu'on va dire." },
    { q: "Que signifie 'pull someone's leg' ?", opts: ['Faire marcher quelqu\'un','Blesser quelqu\'un','Aider quelqu\'un','Persuader quelqu\'un'], ans: "Faire marcher quelqu'un", hint: "Pull someone's leg → taquiner ou faire croire quelque chose de faux." },
    { q: "Que signifie 'speak of the devil' ?", opts: ['Quand on parle du loup','Parler de quelqu\'un de mauvais','Appeler quelqu\'un','Faire une mauvaise blague'], ans: "Quand on parle du loup", hint: "Speak of the devil → dit quand la personne dont on parlait arrive." },
    { q: "Différence entre 'let the cat out of the bag' et 'spill the beans' ?", opts: ["Même sens : révéler un secret","Let the cat... = mentir ; spill the beans = trahir","Let the cat... = positif ; spill... = négatif","Spill the beans = volontairement ; let the cat... = uniquement par accident"], ans: "Même sens : révéler un secret", hint: "Les deux signifient révéler un secret, souvent sans le vouloir." },
  ],
  'idioms-feelings-situations': [
    { q: "Que signifie 'a blessing in disguise' ?", opts: ['Un bien pour un mal / une chance cachée','Une bénédiction évidente','Une mauvaise surprise','Une occasion manquée'], ans: 'Un bien pour un mal / une chance cachée', hint: "A blessing in disguise → quelque chose qui semblait mauvais mais s'avère bénéfique." },
    { q: "Que signifie 'under the weather' ?", opts: ['Ne pas être dans son assiette','Travailler sous la pluie','Être déprimé','Avoir froid'], ans: 'Ne pas être dans son assiette', hint: "Under the weather → se sentir malade ou pas en forme." },
    { q: "Que signifie 'once in a blue moon' ?", opts: ['Très rarement','Une fois par mois','La nuit seulement','Quand la lune est pleine'], ans: 'Très rarement', hint: "Once in a blue moon → très rarement, presque jamais." },
    { q: "Que signifie 'on cloud nine' ?", opts: ['Aux anges / extrêmement heureux','Dans les nuages','Rêveur','Distrait'], ans: 'Aux anges / extrêmement heureux', hint: "On cloud nine → dans un état de bonheur intense." },
    { q: "Que signifie 'water under the bridge' ?", opts: ["C'est du passé / on tourne la page","Problème résolu","Eau coulée sous les ponts (littéral)","Chose sans importance"], ans: "C'est du passé / on tourne la page", hint: "Water under the bridge → ce qui est passé ne sert à rien d'en débattre." },
    { q: "Que signifie 'through thick and thin' ?", opts: ['Dans les bons et les mauvais moments','Avec beaucoup de difficulté','À travers tous les obstacles','En toutes circonstances physiques'], ans: 'Dans les bons et les mauvais moments', hint: "Through thick and thin → loyauté inconditionnelle, en toutes circonstances." },
  ],
  'idioms-decisions-risks': [
    { q: "Que signifie 'bite off more than you can chew' ?", opts: ['Voir trop grand / vouloir trop faire','Manger trop vite','Accepter une proposition dangereuse','Travailler trop dur'], ans: 'Voir trop grand / vouloir trop faire', hint: "Bite off more than you can chew → prendre en charge plus qu'on ne peut gérer." },
    { q: "Que signifie 'face the music' ?", opts: ['Assumer les conséquences','Affronter la musique','Accepter la critique','Écouter attentivement'], ans: 'Assumer les conséquences', hint: "Face the music → faire face aux conséquences de ses actes, même désagréables." },
    { q: "Que signifie 'throw in the towel' ?", opts: ["Jeter l'éponge / abandonner","Se battre jusqu'au bout","Tout recommencer","Refuser de participer"], ans: "Jeter l'éponge / abandonner", hint: "Throw in the towel → vient de la boxe, où l'entraîneur jette la serviette pour arrêter le combat." },
    { q: "Que signifie 'the last straw' ?", opts: ['La goutte d\'eau qui fait déborder le vase','La dernière chance','La paille finale','Le dernier espoir'], ans: "La goutte d'eau qui fait déborder le vase", hint: "The last straw → l'élément final qui rend une situation insupportable." },
    { q: "Que signifie 'jump the gun' ?", opts: ['Agir trop vite / brûler les étapes','Sauter sur une opportunité','Tirer en premier','Devancer ses adversaires'], ans: 'Agir trop vite / brûler les étapes', hint: "Jump the gun → partir avant le signal (sport), agir prématurément." },
    { q: "Que signifie 'put all your eggs in one basket' ?", opts: ['Mettre tous ses œufs dans le même panier','Se concentrer sur un seul objectif','Risquer tout sur une seule chance','Compter sur une seule personne'], ans: 'Mettre tous ses œufs dans le même panier', hint: "Put all your eggs in one basket → ne pas diversifier ses risques." },
  ],
  'idioms-character-attitude': [
    { q: "Que signifie 'a dime a dozen' ?", opts: ['Très commun / banal','Très rare','Peu coûteux','À la douzaine'], ans: 'Très commun / banal', hint: "A dime a dozen → si commun que ça n'a pas grande valeur." },
    { q: "Que signifie 'you can't judge a book by its cover' ?", opts: ["L'habit ne fait pas le moine","Il faut apprendre à lire","Les apparences sont trompeuses","Tout ce qui brille n'est pas or"], ans: "L'habit ne fait pas le moine", hint: "You can't judge a book by its cover → l'apparence ne reflète pas la valeur réelle." },
    { q: "Que signifie 'caught red-handed' ?", opts: ['Pris la main dans le sac','Surpris en flagrant délit','Pris sur le fait avec des preuves','Toutes ces réponses'], ans: 'Toutes ces réponses', hint: "Caught red-handed → surpris en train de faire quelque chose de répréhensible." },
    { q: "Que signifie 'out of the blue' ?", opts: ['De façon inattendue / sans prévenir','Du ciel','Sans raison','En secret'], ans: 'De façon inattendue / sans prévenir', hint: "Out of the blue → comme un coup de tonnerre dans un ciel bleu — totalement inattendu." },
    { q: "Que signifie 'walk on eggshells' ?", opts: ['Marcher sur des œufs / être très précautionneux','Faire attention à ses pas','Avoir peur de quelqu\'un','Éviter un sujet délicat'], ans: "Marcher sur des œufs / être très précautionneux", hint: "Walk on eggshells → agir avec une extrême précaution pour ne pas offenser." },
    { q: "Que signifie 'a leopard can't change its spots' ?", opts: ["On ne change pas sa nature","Il faut accepter les gens tels qu'ils sont","Les mauvaises habitudes persistent","Les deux premières réponses"], ans: "On ne change pas sa nature", hint: "A leopard can't change its spots → la nature profonde d'une personne ne change pas." },
  ],
  'fixed-prepositions-1': [
    { q: "She apologized ___ being late.", opts: ['for','of','to','at'], ans: 'for', hint: "Apologize FOR = s'excuser de. Toujours suivi de FOR." },
    { q: "This problem is difficult to deal ___.", opts: ['with','from','to','in'], ans: 'with', hint: "Deal WITH = gérer / s'occuper de." },
    { q: "He insisted ___ paying the bill.", opts: ['on','in','for','to'], ans: 'on', hint: "Insist ON doing something = insister pour faire quelque chose." },
    { q: "The committee consists ___ five members.", opts: ['of','from','in','with'], ans: 'of', hint: "Consist OF = être composé de." },
    { q: "You can always count ___ me.", opts: ['on','in','for','to'], ans: 'on', hint: "Count ON someone = compter sur quelqu'un." },
    { q: "We arrived ___ the airport on time.", opts: ['at','in','to','for'], ans: 'at', hint: "Arrive AT (lieu précis) ; Arrive IN (ville, pays)." },
  ],
  'fixed-prepositions-2': [
    { q: "He refused to pay ___ the damage.", opts: ['for','of','to','on'], ans: 'for', hint: "Pay FOR something = payer pour quelque chose." },
    { q: "We should protect children ___ online dangers.", opts: ['from','of','against','with'], ans: 'from', hint: "Protect FROM = protéger de (une menace)." },
    { q: "She specializes ___ tax law.", opts: ['in','on','at','for'], ans: 'in', hint: "Specialize IN a field = se spécialiser dans un domaine." },
    { q: "He finally succeeded ___ passing the exam.", opts: ['in','at','on','for'], ans: 'in', hint: "Succeed IN doing = réussir à faire quelque chose." },
    { q: "Take care ___ yourself!", opts: ['of','for','about','with'], ans: 'of', hint: "Take care OF = prendre soin de." },
    { q: "She recovered ___ her illness quickly.", opts: ['from','of','to','in'], ans: 'from', hint: "Recover FROM = se remettre de." },
  ],
  'connectors-advanced-1': [
    { q: "She speaks French ___ Spanish and Italian.", opts: ['as well as','despite this','hence','then again'], ans: 'as well as', hint: "As well as = ainsi que / en plus de (addition)." },
    { q: "He worked hard. ___, he deserved the promotion.", opts: ['Hence','Though','Despite this','All the same'], ans: 'Hence', hint: "Hence = D'où / Par conséquent (conséquence formelle)." },
    { q: "___ the heavy rain, the match was cancelled.", opts: ['Owing to','Just as','Likewise','Then again'], ans: 'Owing to', hint: "Owing to + nom = En raison de (cause)." },
    { q: "I don't like the plan. ___, I will support it.", opts: ['That said','Likewise','Hence','As well as'], ans: 'That said', hint: "That said = Cela dit (concession après accord)." },
    { q: "The product is expensive. ___, it has poor reviews.", opts: ["What's more",'Given that','Yet','Just as'], ans: "What's more", hint: "What's more = Qui plus est (accumulation de points négatifs)." },
    { q: "___ she studied hard, her success was expected.", opts: ['Given that','Still','Besides','In contrast'], ans: 'Given that', hint: "Given that = Étant donné que (cause/condition)." },
  ],
  'connectors-advanced-2': [
    { q: "___, let me introduce the main topic.", opts: ['To begin with','As such','In short','By doing so'], ans: 'To begin with', hint: "To begin with = Pour commencer (ouverture de discours)." },
    { q: "She is the manager. ___, she makes the final call.", opts: ['As such','Firstly','Previously','In this manner'], ans: 'As such', hint: "As such = De ce fait / En tant que tel (conclusion logique)." },
    { q: "___, it was a great year for the company.", opts: ['All in all','Through this','Thereafter','Coupled with'], ans: 'All in all', hint: "All in all = Tout compte fait (bilan global)." },
    { q: "Save your work regularly — ___, you risk losing everything.", opts: ['Otherwise','Indeed','Firstly','In the same vein'], ans: 'Otherwise', hint: "Otherwise = Sinon / Autrement (conséquence si non rempli)." },
    { q: "The results were, ___, better than expected.", opts: ['in fact','by doing so','thereafter','as such'], ans: 'in fact', hint: "In fact = En fait (rectification ou renforcement)." },
    { q: "He apologized; ___, he saved the friendship.", opts: ['by doing so','in short','clearly','previously'], ans: 'by doing so', hint: "By doing so = En faisant cela (référence à l'action précédente)." },
  ],
  'what-when-why-questions': [
    { q: "___ makes you happy?", opts: ['What','When','Why','How'], ans: 'What', hint: "What makes you…? → sujet = what, pas de DO nécessaire." },
    { q: "___ did this happen?", opts: ['When','Why','What','Where'], ans: 'When', hint: "When did…? → WHEN pour une information temporelle (passé → did)." },
    { q: "___ are you late?", opts: ['Why','When','What','Where'], ans: 'Why', hint: "Why are you…? → WHY demande une raison ou une explication." },
    { q: "What ___ you want?", opts: ['do','are','did','is'], ans: 'do', hint: "What DO you want? → présent simple avec do (sujet = you)." },
    { q: "When ___ this happen?", opts: ['did','does','is','was'], ans: 'did', hint: "When DID this happen? → passé simple → did + base verbale." },
    { q: "When ___ you coming back?", opts: ['are','do','did','were'], ans: 'are', hint: "When ARE you coming? → action future arrangée → présent continu." },
  ],
  'allow-let-permit-enable': [
    { q: "Dad ___ me drive his car. (informel, sans 'to')", opts: ['let','allowed','permitted','enabled'], ans: 'let', hint: "Let = le plus informel. Let + objet + infinitif NUS (sans 'to'). Jamais au passif." },
    { q: "Smoking is not ___ on board. (règle officielle, passif)", opts: ['permitted','allowed','let','enabled'], ans: 'permitted', hint: "Permit = formel, règles officielles. S'utilise souvent au passif (≠ let qui ne s'utilise jamais au passif)." },
    { q: "A computer will ___ you to work from home. (rendre possible)", opts: ['enable','allow','let','permit'], ans: 'enable', hint: "Enable = rendre quelque chose possible, donner la capacité. ≠ autoriser." },
    { q: "The boss ___ us to leave early. (autorisation neutre, avec 'to')", opts: ['allowed','let','permitted','enabled'], ans: 'allowed', hint: "Allow = autoriser (neutre, courant). Allow + objet + TO + infinitif." },
    { q: "Don't ___ the dog sit on the sofa. (informel, sans 'to')", opts: ['let','allow','permit','enable'], ans: 'let', hint: "Let = informel, bare infinitive. Don't let = ne laisse pas (sans 'to')." },
    { q: "Is parking ___ in this area? (règle officielle, passif)", opts: ['permitted','allowed','enabled','let'], ans: 'permitted', hint: "Permit au passif = règle officielle. Let ne s'utilise jamais au passif." },
  ],
  'daily-commands-phrases': [
    { q: "Réveille-toi tôt chaque jour.", opts: ['Wake up early every day.','Get up and get ready.','Sit down and relax.','Slow down a little.'], ans: 'Wake up early every day.', hint: "Wake up early every day = réveille-toi tôt chaque jour (habitude matinale).", _isSentence: true },
    { q: "Éteins la télévision.", opts: ['Turn off the TV.','Turn on the light.','Take off your jacket.','Slow down a little.'], ans: 'Turn off the TV.', hint: "Turn off = éteindre (opposé de turn on = allumer).", _isSentence: true },
    { q: "Enlève ta veste.", opts: ['Take off your jacket.','Put on your shoes.','Slow down a little.','Sit down and relax.'], ans: 'Take off your jacket.', hint: "Take off = enlever (un vêtement). Opposé : put on = mettre.", _isSentence: true },
    { q: "Ralentis un peu.", opts: ['Slow down a little.','Sit down and relax.','Get up and get ready.','Turn off the TV.'], ans: 'Slow down a little.', hint: "Slow down = ralentir (au sens propre ou figuré). A little = un peu.", _isSentence: true },
    { q: "Lève-toi et prépare-toi.", opts: ['Get up and get ready.','Wake up early every day.','Sit down and relax.','Put on your shoes.'], ans: 'Get up and get ready.', hint: "Get up = se lever (sortir du lit). Get ready = se préparer.", _isSentence: true },
    { q: "Assieds-toi et détends-toi.", opts: ['Sit down and relax.','Slow down a little.','Turn off the TV.','Get up and get ready.'], ans: 'Sit down and relax.', hint: "Sit down and relax = assieds-toi et détends-toi (deux impératifs en un).", _isSentence: true },
  ],
  'motivational-phrases': [
    { q: "Reste humble.", opts: ['Stay humble.','Be patient.','Stay strong.','Be kind.'], ans: 'Stay humble.', hint: "Stay humble = reste humble (stay + adjectif = rester dans un état).", _isSentence: true },
    { q: "Donne-toi à fond.", opts: ['Push yourself.','Work hard.','Act now.','Stay focused.'], ans: 'Push yourself.', hint: "Push yourself = donne-toi à fond / dépasse-toi.", _isSentence: true },
    { q: "Fais que ça arrive.", opts: ['Make it happen.','Move forward.','Act now.',"Don't wait."], ans: 'Make it happen.', hint: "Make it happen = fais en sorte que ça arrive (responsabilité personnelle).", _isSentence: true },
    { q: "N'abandonne jamais.", opts: ['Never give up.','Stay strong.',"Don't wait.",'Stay positive.'], ans: 'Never give up.', hint: "Never give up = n'abandonne jamais — phrase de motivation universelle.", _isSentence: true },
    { q: "Rêve grand.", opts: ['Dream big.','Think big.','Move forward.','Keep learning.'], ans: 'Dream big.', hint: "Dream big = rêve grand (avoir de grandes ambitions).", _isSentence: true },
    { q: "Continue d'apprendre.", opts: ['Keep learning.','Work hard.','Stay focused.','Push yourself.'], ans: 'Keep learning.', hint: "Keep learning = continue d'apprendre (keep + -ing = continuer à faire).", _isSentence: true },
  ],
  'good-mood-expressions': [
    { q: "Je suis aux anges.", opts: ["I'm on cloud nine.","I'm bursting with joy.","I feel fantastic.","I'm in a great mood."], ans: "I'm on cloud nine.", hint: "I'm on cloud nine = je suis aux anges (expression idiomatique, toujours 'nine').", _isSentence: true },
    { q: "Je déborde de joie.", opts: ["I'm bursting with joy.","I'm full of energy.","I feel alive.","I'm so happy."], ans: "I'm bursting with joy.", hint: "I'm bursting with joy = je déborde de joie (très expressif, peu formel).", _isSentence: true },
    { q: "Rien ne peut gâcher ma journée.", opts: ["Nothing can ruin my day.","I'm having a great day.","I'm enjoying this moment.","I'm in a great mood today."], ans: "Nothing can ruin my day.", hint: "Nothing can ruin my day = rien ne peut gâcher ma journée (sérénité totale).", _isSentence: true },
    { q: "Je suis plein(e) d'énergie.", opts: ["I'm full of energy.","I feel alive.","I'm bursting with joy.","I feel fantastic."], ans: "I'm full of energy.", hint: "I'm full of energy = je suis plein(e) d'énergie (vitalité et dynamisme).", _isSentence: true },
    { q: "Je passe une excellente journée.", opts: ["I'm having a great day.","I'm in a great mood today.","I'm enjoying this moment.","I'm doing great!"], ans: "I'm having a great day.", hint: "I'm having a great day = je passe une excellente journée (présent continu).", _isSentence: true },
    { q: "Je suis ravi(e).", opts: ["I'm delighted.","I'm so happy.","I feel fantastic.","I'm in a good mood."], ans: "I'm delighted.", hint: "I'm delighted = je suis ravi(e) (plus formel, souvent pour une bonne nouvelle).", _isSentence: true },
  ],
  'basic-phrasal-verbs': [
    { q: "Don't ___ — you're almost there!", opts: ['give up','show up','wake up','sit down'], ans: 'give up', hint: "Give up = abandonner / renoncer. Don't give up! = N'abandonne pas !" },
    { q: "I'm ___ my keys — have you seen them?", opts: ['looking for','picking up','turning on','coming back'], ans: 'looking for', hint: "Look for = chercher quelque chose. I'm looking for = je cherche (présent continu)." },
    { q: "___ the light — it's too dark in here.", opts: ['Turn on','Put on','Pick up','Wake up'], ans: 'Turn on', hint: "Turn on = allumer (lumière, appareil). Opposé : turn off = éteindre." },
    { q: "He promised to come but he didn't ___.", opts: ['show up','give up','sit down','come back'], ans: 'show up', hint: "Show up = se présenter / arriver à un rendez-vous. He didn't show up = il ne s'est pas présenté." },
    { q: "___ your jacket before you go out.", opts: ['Put on','Turn on','Pick up','Look for'], ans: 'Put on', hint: "Put on = mettre (un vêtement). Opposé : take off = enlever." },
    { q: "Please ___ soon — we miss you.", opts: ['come back','show up','wake up','give up'], ans: 'come back', hint: "Come back = revenir. Please come back soon = reviens bientôt." },
  ],
  'assertive-phrases': [
    { q: "Tu plaisantes j'espère.", opts: ['You must be kidding.','I\'m not arguing.','Believe what you want.','That\'s not how this works.'], ans: 'You must be kidding.', hint: "You must be kidding = tu plaisantes j'espère (incrédulité / surprise négative).", _isSentence: true },
    { q: "Je ne discute pas.", opts: ['I\'m not arguing.','I don\'t need approval.','You made your choice.','Don\'t disappoint me.'], ans: 'I\'m not arguing.', hint: "I'm not arguing = je ne discute pas / je ne vais pas en débattre (refus de polémique).", _isSentence: true },
    { q: "Ce n'est pas comme ça que ça marche.", opts: ["That's not how this works.",'You must be kidding.',"I don't need approval.",'Believe what you want.'], ans: "That's not how this works.", hint: "That's not how this works = ce n'est pas comme ça que ça marche (recadrage ferme).", _isSentence: true },
    { q: "Tu as fait ton choix.", opts: ['You made your choice.',"Don't disappoint me.",'I\'m not arguing.',"That's not how this works."], ans: 'You made your choice.', hint: "You made your choice = tu as fait ton choix (constater une décision, souvent avec des conséquences).", _isSentence: true },
    { q: "Je n'ai pas besoin d'approbation.", opts: ["I don't need approval.",'I\'m not arguing.','Believe what you want.','You must be kidding.'], ans: "I don't need approval.", hint: "I don't need approval = je n'ai pas besoin d'approbation (affirmation d'indépendance).", _isSentence: true },
    { q: "Crois ce que tu veux.", opts: ['Believe what you want.','You made your choice.',"Don't disappoint me.","That's not how this works."], ans: 'Believe what you want.', hint: "Believe what you want = crois ce que tu veux (se désengager d'un débat inutile).", _isSentence: true },
  ],
  'changing-subject-expressions': [
    { q: "___, did you hear about the new café downtown?", opts: ['By the way','Anyway','Enough about that',"Let's not go there"], ans: 'By the way', hint: "By the way = au fait (pour introduire une digression ou un nouveau sujet)." },
    { q: "___ — I have a meeting in ten minutes.", opts: ['Anyway','By the way','On a different note',"Let's not go there"], ans: 'Anyway', hint: "Anyway = bref (pour conclure une digression et reprendre le fil)." },
    { q: "___ — your birthday is next week, right?", opts: ['Before I forget','Anyway',"Let's not go there",'Enough about that'], ans: 'Before I forget', hint: "Before I forget = avant que j'oublie (info urgente à glisser dans la conversation)." },
    { q: "___ the trip we took last summer!", opts: ['That reminds me of','By the way','On a different note','Enough about that'], ans: 'That reminds me of', hint: "That reminds me of = ça me fait penser à (transition par association d'idées)." },
    { q: "This topic is getting awkward. ___, please.", opts: ["Let's not go there","Enough about that",'Anyway','By the way'], ans: "Let's not go there", hint: "Let's not go there = évitons ce sujet (pour signaler qu'un sujet est délicat)." },
    { q: "___ — I've already talked too much about myself tonight.", opts: ['Enough about that',"Let's not go there",'Anyway',"Let's change the subject"], ans: 'Enough about that', hint: "Enough about that = on a assez parlé de ça (pour clore un sujet avec légèreté)." },
  ],
  'mind-expressions': [
    { q: "She's ___ about whether to accept the offer.", opts: ['in two minds','out of her mind','of one mind','in her right mind'], ans: 'in two minds', hint: "Be in two minds = être indécis / hésiter entre deux options." },
    { q: "There are so many options — I just can't ___!", opts: ['make up my mind','cross my mind','bear in mind','change my mind'], ans: 'make up my mind', hint: "Make up your mind = se décider définitivement / trancher." },
    { q: "He ___ when he saw the weather forecast.", opts: ['changed his mind','made up his mind','crossed his mind','spoke his mind'], ans: 'changed his mind', hint: "Change your mind = revenir sur une décision déjà prise." },
    { q: "___ that the library closes at 6 pm today.", opts: ['Bear in mind','Make up your mind','Cross your mind','Speak your mind'], ans: 'Bear in mind', hint: "Bear in mind = garder à l'esprit / se souvenir d'un fait important." },
    { q: "Don't interfere — just ___!", opts: ['mind your own business','speak your mind','never mind','make up your mind'], ans: 'mind your own business', hint: "Mind your own business = mêle-toi de tes affaires (expression directe)." },
    { q: "Sorry I forgot the tickets. ___ — we can buy more at the door.", opts: ['Never mind','Mind your own business','Cross your mind','Out of your mind'], ans: 'Never mind', hint: "Never mind = peu importe / ne t'en fais pas (pour consoler ou minimiser)." },
  ],
  'correlative-conjunctions': [
    { q: "Diana not only plays the piano ___ also sings.", opts: ['but','nor','and','or'], ans: 'but', hint: "Not only…but also = non seulement…mais aussi (double affirmation)." },
    { q: "Hugo was ___ willing nor able to chair the meeting.", opts: ['neither','either','not only','both'], ans: 'neither', hint: "Neither…nor = ni…ni (double négation pour deux éléments)." },
    { q: "No sooner had I arrived ___ they all started to argue.", opts: ['than','when','that','as'], ans: 'than', hint: "No sooner…than — jamais no sooner…when : la paire exige 'than'." },
    { q: "She was ___ weak that she could hardly move.", opts: ['so','such','too','very'], ans: 'so', hint: "So…that = si/tellement…que (so + adjectif ou adverbe + that)." },
    { q: "It was ___ a cold day that we decided to stay indoors.", opts: ['such','so','too','very'], ans: 'such', hint: "Such…that = si/tellement…que (such + article + groupe nominal + that)." },
    { q: "___ Tom walks to work or takes his bicycle.", opts: ['Either','Neither','Both','Whether'], ans: 'Either', hint: "Either…or = soit…soit (choix entre deux possibilités)." },
  ],
  'across-phrasal-verbs': [
    { q: "She ___ an old letter while cleaning the attic.", opts: ['came across','ran across','went across','cut across'], ans: 'came across', hint: "Come across = trouver par hasard, sans l'avoir cherché." },
    { q: "It was hard to ___ my idea in that meeting.", opts: ['get across','go across','cut across','look across'], ans: 'get across', hint: "Get across = faire passer / communiquer clairement un message." },
    { q: "He ___ his old teacher at the market.", opts: ['ran across','came across','stumbled across','went across'], ans: 'ran across', hint: "Run across = tomber sur quelqu'un par hasard (personne connue)." },
    { q: "Let's ___ the park — it'll be faster.", opts: ['cut across','spread across','go across','look across'], ans: 'cut across', hint: "Cut across = couper par un endroit pour prendre un raccourci." },
    { q: "She ___ to shake his hand warmly.", opts: ['reached across','looked across','stumbled across','spread across'], ans: 'reached across', hint: "Reach across = tendre le bras par-dessus / par-delà quelque chose." },
    { q: "The news ___ the entire city overnight.", opts: ['spread across','reached across','cut across','came across'], ans: 'spread across', hint: "Spread across = s'étendre / se répandre sur une grande zone." },
  ],
  'out-phrasal-verbs': [
    { q: "I finally ___ the answer.", opts: ['figured out','gave out','ran out','came out'], ans: 'figured out', hint: "Figure out = comprendre / résoudre par la réflexion." },
    { q: "She ___ he had been lying all along.", opts: ['found out','hung out','worked out','checked out'], ans: 'found out', hint: "Find out = découvrir une information cachée ou inconnue." },
    { q: "Everything ___ better than expected.", opts: ['worked out','carried out','ran out','came out'], ans: 'worked out', hint: "Work out (bien se passer) = réussir, fonctionner bien." },
    { q: "They were asked to ___ the new plan.", opts: ['carry out','check out','find out','hang out'], ans: 'carry out', hint: "Carry out = exécuter / accomplir une tâche assignée." },
    { q: "We've ___ of time — hurry up!", opts: ['run out','come out','give out','turn out'], ans: 'run out', hint: "Run out of = épuiser le stock / manquer de quelque chose." },
    { q: "Let's ___ at the mall this weekend!", opts: ['hang out','figure out','work out','carry out'], ans: 'hang out', hint: "Hang out = passer du temps ensemble (très familier)." },
  ],
  'job-interview-phrases': [
    { q: "Skill signifie :", opts: ['Compétence','Force','Faiblesse','Capacité'], ans: 'Compétence', hint: "Skill = compétence (capacité acquise par l'apprentissage ou l'expérience)." },
    { q: "Weakness signifie :", opts: ['Faiblesse','Force','Efficacité','Flexibilité'], ans: 'Faiblesse', hint: "Weakness = faiblesse (point faible, opposé de strength)." },
    { q: "Traduction : 'Parlez-moi de vous.'", opts: ['Tell me about yourself.','Why should we hire you?','What motivates you?','What are your strengths?'], ans: 'Tell me about yourself.', hint: "Tell me about yourself = Parlez-moi de vous (question d'ouverture classique d'entretien).", _isSentence: true },
    { q: "Comment gérez-vous le stress ?", opts: ['How do you handle stress?','Do you like teamwork?','Why do you want this job?','What are your career goals?'], ans: 'How do you handle stress?', hint: "Handle = gérer, s'en sortir avec. Ici : comment gérez-vous le stress ?", _isSentence: true },
    { q: "Ability signifie :", opts: ['Capacité','Intérêt','Disponibilité','Expertise'], ans: 'Capacité', hint: "Ability = capacité, aptitude (peut être innée ou acquise)." },
    { q: "Pourquoi voulez-vous ce poste ?", opts: ['Why do you want this job?','Why should we hire you?','What experience do you have?','What motivates you?'], ans: 'Why do you want this job?', hint: "This job = ce poste / cet emploi. Hire = embaucher.", _isSentence: true },
  ],
  'at-work-phrases': [
    { q: "Dis-moi si tu as besoin d'aide.", opts: ["Let me know if you need help.","Let me help you now.","Tell me if you are free.","Ask me for any help."], ans: "Let me know if you need help.", hint: "Let me know = dis-moi / fais-moi signe. If you need help = si tu as besoin d'aide.", _isSentence: true },
    { q: "Je te tiendrai informé.", opts: ["I'll keep you updated.","I'll let you know soon.","I'll stay in touch.","I'll tell you everything."], ans: "I'll keep you updated.", hint: "Keep + objet + updated = tenir quelqu'un informé des dernières nouvelles.", _isSentence: true },
    { q: "Ce rapport est attendu aujourd'hui.", opts: ["This report is due today.","This report is ready today.","This report is done today.","This report is needed soon."], ans: "This report is due today.", hint: "Due = attendu / prévu pour une date précise (deadline). Due today = à rendre aujourd'hui.", _isSentence: true },
    { q: "Partageons la charge de travail.", opts: ["Let's share the workload.","Let's organize the workload.","Let's divide the tasks.","Let's split the work now."], ans: "Let's share the workload.", hint: "Share the workload = partager la charge de travail. Workload = charge de travail.", _isSentence: true },
    { q: "Pouvons-nous parler en privé ?", opts: ["Can we talk in private?","Can we meet in private?","Can we speak in secret?","Can we chat privately?"], ans: "Can we talk in private?", hint: "In private = en privé, loin des autres. Talk in private = avoir une conversation privée.", _isSentence: true },
    { q: "Je m'en occupe.", opts: ["I'll handle this.","I'll do this now.","I'll manage it well.","I'll take this over."], ans: "I'll handle this.", hint: "Handle = s'occuper de, gérer. I'll handle this = je m'en occupe (prise en charge).", _isSentence: true },
  ],
  'farewell-expressions': [
    { q: "À plus.", opts: ["See you.","Goodbye.","Take care.","See you later."], ans: "See you.", hint: "See you = à plus (très court et informel). La forme la plus courte pour dire au revoir.", _isSentence: true },
    { q: "Je m'en vais.", opts: ["I'm off.","I'm leaving now.","I've got to go.","I'm going out."], ans: "I'm off.", hint: "I'm off = je m'en vais / je pars (très informel et courant). Plus court que 'I have to go'.", _isSentence: true },
    { q: "À bientôt.", opts: ["See you soon.","See you later.","Talk to you later.","Speak soon."], ans: "See you soon.", hint: "See you soon = à bientôt (soon = bientôt). Ne pas confondre avec 'See you later' (à plus tard).", _isSentence: true },
    { q: "On se parle plus tard.", opts: ["Talk to you later.","Speak soon.","Catch you later.","See you later."], ans: "Talk to you later.", hint: "Talk to you later = on se parle plus tard. Souvent abrégé en TTYL à l'écrit.", _isSentence: true },
    { q: "Je dois y aller.", opts: ["I've got to go.","I have to go now.","I need to leave.","I should head off."], ans: "I've got to go.", hint: "I've got to go = je dois y aller (contraction informelle de 'I have got to go').", _isSentence: true },
    { q: "À plus tard.", opts: ["See you later.","See you soon.","See you.","Catch you later."], ans: "See you later.", hint: "See you later = à plus tard. Later = plus tard (délai vague). ≠ See you soon (bientôt).", _isSentence: true },
  ],
  'tired-expressions': [
    { q: "Je suis fatigué.", opts: ["I'm tired.","I'm beat.","I'm drained.","I'm worn out."], ans: "I'm tired.", hint: "I'm tired = Je suis fatigué (l'expression la plus neutre et la plus courante).", _isSentence: true },
    { q: "Je suis claqué.", opts: ["I'm beat.","I'm tired.","I'm exhausted.","I'm drained."], ans: "I'm beat.", hint: "I'm beat = Je suis claqué (très familier, idée d'être à plat comme après un combat).", _isSentence: true },
    { q: "Je suis vidé.", opts: ["I'm drained.","I'm tired.","I'm worn out.","I feel drowsy."], ans: "I'm drained.", hint: "I'm drained = Je suis vidé (de 'to drain' = vider, comme une batterie déchargée).", _isSentence: true },
    { q: "Je suis épuisé.", opts: ["I'm exhausted.","I'm dead tired.","I'm worn out.","I'm beat."], ans: "I'm exhausted.", hint: "I'm exhausted = Je suis épuisé (degré fort de fatigue, de 'to exhaust' = épuiser).", _isSentence: true },
    { q: "Je suis mort de fatigue.", opts: ["I'm dead tired.","I'm exhausted.","I'm so sleepy.","I'm drained."], ans: "I'm dead tired.", hint: "I'm dead tired = Je suis mort de fatigue (dead amplifie tired de façon expressive).", _isSentence: true },
    { q: "J'ai besoin de repos.", opts: ["I need some rest.","I'm so sleepy.","I feel drowsy.","I'm worn out."], ans: "I need some rest.", hint: "I need some rest = J'ai besoin de repos (rest = repos, need = avoir besoin).", _isSentence: true },
  ],
  'times-of-day': [
    { q: "Dawn signifie :", opts: ["L'aube","Le lever du soleil","Le crépuscule","La nuit"], ans: "L'aube", hint: "Dawn = l'aube (la première lueur du jour, avant que le soleil apparaisse à l'horizon)." },
    { q: "Dusk signifie :", opts: ["Le crépuscule","L'aube","Le coucher du soleil","La soirée"], ans: "Le crépuscule", hint: "Dusk (= twilight) = le crépuscule (lumière déclinante après sunset, avant l'obscurité totale)." },
    { q: "Noon signifie :", opts: ["Midi","Minuit","Le matin","L'après-midi"], ans: "Midi", hint: "Noon = midi (12h00, le milieu du jour). Attention : midnight = minuit (pas noon)." },
    { q: "Sunset signifie :", opts: ["Le coucher du soleil","Le lever du soleil","Le crépuscule","Le soir"], ans: "Le coucher du soleil", hint: "Sunset = coucher du soleil (sun = soleil, set = se coucher). ≠ Sunrise (lever du soleil)." },
    { q: "Afternoon est la période entre :", opts: ["Midi et le soir","Le matin et midi","Le soir et la nuit","L'aube et le matin"], ans: "Midi et le soir", hint: "Afternoon = l'après-midi (12h00–16h00), juste après noon/midi jusqu'au soir." },
    { q: "Quel mot décrit la première lueur avant que le soleil apparaisse ?", opts: ["Dawn","Sunrise","Dusk","Twilight"], ans: "Dawn", hint: "Dawn = l'aube (premier signe de lumière). Sunrise est le moment où le soleil apparaît à l'horizon." },
  ],
  'who-which-where-questions': [
    { q: "WHO s'utilise pour parler :", opts: ["D'une personne (sujet)","D'un lieu","D'un objet","D'une possession"], ans: "D'une personne (sujet)", hint: "WHO = qui (personne, sujet). Who is your teacher? = Qui est ton professeur ?" },
    { q: "WHERE s'utilise pour parler :", opts: ["D'un lieu","D'une personne","D'un choix","D'un moment"], ans: "D'un lieu", hint: "WHERE = où (lieu). Where do you live? = Où habites-tu ?" },
    { q: "WHOSE s'utilise pour demander :", opts: ["À qui appartient quelque chose","Qui fait quelque chose","Où est quelque chose","Lequel choisir"], ans: "À qui appartient quelque chose", hint: "WHOSE = à qui (possession). Whose phone is this? = À qui est ce téléphone ?" },
    { q: "WHICH s'utilise pour :", opts: ["Un choix parmi un ensemble limité","Demander un lieu","Parler d'une personne","Exprimer une raison"], ans: "Un choix parmi un ensemble limité", hint: "WHICH = lequel/laquelle (choix limité). Which book do you like — this one or that one?" },
    { q: "WHOM est la forme _____ de WHO :", opts: ["Objet (complément)","Sujet","Possessif","Pluriel"], ans: "Objet (complément)", hint: "WHOM = forme objet de WHO. Whom did you call? = Qui as-tu appelé ? (informel : Who did you call?)" },
    { q: "À qui est ce téléphone ?", opts: ["Whose phone is this?","Who has this phone?","Which phone is yours?","Where is my phone?"], ans: "Whose phone is this?", hint: "WHOSE = à qui (possession). Whose phone is this? → It's mine.", _isSentence: true },
  ],
  'grow-phrasal-verbs': [
    { q: "Grow apart signifie :", opts: ["S'éloigner l'un de l'autre","Grandir ensemble","Se rapprocher","Se séparer brusquement"], ans: "S'éloigner l'un de l'autre", hint: "Grow apart = s'éloigner (perdre le lien d'une relation). 'We've grown apart' = on s'est éloignés." },
    { q: "Grow up signifie :", opts: ["Grandir / Devenir adulte","Monter en haut","Cultiver des plantes","Développer une habitude"], ans: "Grandir / Devenir adulte", hint: "Grow up = grandir, devenir adulte. 'I grew up in a small village.' / 'Grow up!' = arrête de faire l'enfant." },
    { q: "Grow out of signifie :", opts: ["Devenir trop grand pour","Sortir en grimpant","Se désintéresser de","Grandir vers l'extérieur"], ans: "Devenir trop grand pour", hint: "Grow out of = devenir trop grand pour (vêtements). Aussi : dépasser une phase. 'He grew out of his shyness.'" },
    { q: "Grow on someone signifie :", opts: ["Finir par apprécier quelque chose","Pousser sur quelqu'un","Envahir quelqu'un","Impressionner quelqu'un"], ans: "Finir par apprécier quelque chose", hint: "Grow on someone = finir par aimer quelque chose qu'on n'aimait pas au départ. 'The idea grew on me.'" },
    { q: "Grow back signifie :", opts: ["Repousser","Reculer","Revenir en arrière","Retomber"], ans: "Repousser", hint: "Grow back = repousser (cheveux, ongles, plantes). 'Nails grow back very quickly.'" },
    { q: "Grow into signifie :", opts: ["Évoluer en / Devenir (avec le temps)","Entrer dans","Cultiver à l'intérieur","Grandir vers"], ans: "Évoluer en / Devenir (avec le temps)", hint: "Grow into = évoluer en, devenir au fil du temps. 'The boy grew into a responsible man.' Aussi : devenir assez grand pour (vêtements)." },
  ],
  'credible-expressions': [
    { q: "Franchement,", opts: ["Frankly,","Honestly,","To be honest,","To tell the truth,"], ans: "Frankly,", hint: "Frankly = franchement (direct, parfois tranchant). 'Frankly, I disagree.' Plus assertif que 'Honestly'.", _isSentence: true },
    { q: "Il me semble que", opts: ["It seems to me that","I think that","I would say that","From my point of view,"], ans: "It seems to me that", hint: "It seems to me that = il me semble que (impression personnelle nuancée, moins affirmatif que 'I think').", _isSentence: true },
    { q: "Ce que je veux dire, c'est que", opts: ["What I mean is that","What I say is that","What I think is that","What I know is that"], ans: "What I mean is that", hint: "What I mean is that = ce que je veux dire, c'est que (clarification ou reformulation de sa propre pensée).", _isSentence: true },
    { q: "Pour être honnête,", opts: ["To be honest,","To be frank,","To tell the truth,","Honestly,"], ans: "To be honest,", hint: "To be honest = pour être honnête (introduit une confidence ou une vérité difficile à dire).", _isSentence: true },
    { q: "D'après moi,", opts: ["In my view,","In my opinion,","From my point of view,","I think that"], ans: "In my view,", hint: "In my view = d'après moi (légèrement plus formel que 'In my opinion'). Les deux expriment un point de vue personnel.", _isSentence: true },
    { q: "À vrai dire,", opts: ["To tell the truth,","To be honest,","Actually,","Frankly,"], ans: "To tell the truth,", hint: "To tell the truth = à vrai dire (révélation d'une vérité qu'on hésitait à dire). 'To tell the truth, I wasn't sure.'", _isSentence: true },
  ],
  'church-expressions': [
    { q: "Que Dieu te bénisse.", opts: ["God bless you.","May God guide you.","Praise the LORD.","Let's pray."], ans: "God bless you.", hint: "God bless you = Que Dieu te bénisse (bless = bénir). Expression très courante après un éternuement ou pour prendre congé.", _isSentence: true },
    { q: "Gloire à Dieu.", opts: ["Praise the LORD.","God bless you.","Joy in the LORD.","Let's sing for the LORD."], ans: "Praise the LORD.", hint: "Praise the LORD = Gloire à Dieu / Louange au Seigneur (praise = louer, glorifier).", _isSentence: true },
    { q: "Prions ensemble.", opts: ["Let's pray.","Let's sing.","Let's go to church.","May God guide."], ans: "Let's pray.", hint: "Let's pray = Prions (Let's + base verbale = invitation à faire quelque chose ensemble). Pray = prier.", _isSentence: true },
    { q: "Merci pour l'invitation.", opts: ["Thanks for the invitation.","Joy in the house of the LORD.","God bless you.","See you at church."], ans: "Thanks for the invitation.", hint: "Thanks for the invitation = Merci pour l'invitation (Thanks for + nom/gérondif = formule de remerciement).", _isSentence: true },
    { q: "À bientôt à l'église.", opts: ["See you at church.","Let's go to church.","Church service is starting.","Church Celebration."], ans: "See you at church.", hint: "See you at church = À bientôt à l'église. See you at + lieu = formule d'au revoir avec rendez-vous.", _isSentence: true },
    { q: "Chantons pour le Seigneur.", opts: ["Let's sing for the LORD.","Let's pray for the LORD.","Praise the LORD.","Joy in the house of the LORD."], ans: "Let's sing for the LORD.", hint: "Let's sing for the LORD = Chantons pour le Seigneur (LORD en majuscules = référence à Dieu dans la tradition chrétienne).", _isSentence: true },
  ],
};

// ========== SÉRIES 2 ET 3 PAR CONCEPT ==========
const _GFIX_SERIES = {
  'present-simple-continuous': [
    [
      { q: 'He ___ a novel at the moment.', opts: ['is writing','writes','write','wrote'], ans: 'is writing', hint: 'at the moment → présent continu.' },
      { q: 'She ___ her teeth twice a day.', opts: ['brushes','is brushing','brush','brushed'], ans: 'brushes', hint: 'Habitude régulière → présent simple.' },
      { q: 'Ice ___ at 0°C.', opts: ['melts','is melting','melt','has melted'], ans: 'melts', hint: 'Vérité scientifique → présent simple.' },
      { q: 'They ___ a new house right now.', opts: ['are building','build','built','builds'], ans: 'are building', hint: 'right now → présent continu.' },
      { q: 'He always ___ to loud music. It\'s annoying.', opts: ['listens','is listening','listened','listen'], ans: 'listens', hint: 'always + habitude → présent simple.' },
      { q: 'Why ___ you wearing a coat indoors?', opts: ['are','do','is','did'], ans: 'are', hint: 'Question sur action en cours → be + -ing.' },
    ],
    [
      { q: 'I ___ you understand — it\'s really hard.', opts: ['know','am knowing','knew','have known'], ans: 'know', hint: 'know = verbe d\'état → pas de continu.' },
      { q: 'We ___ to Australia next month. (arranged)', opts: ['are flying','fly','flew','will fly'], ans: 'are flying', hint: 'Plan futur arrangé → présent continu.' },
      { q: 'This coffee ___  bitter.', opts: ['tastes','is tasting','taste','tasted'], ans: 'tastes', hint: 'Verbe de perception (taste) → présent simple.' },
      { q: 'The company ___ its profits year by year.', opts: ['is increasing','increases','increased','increase'], ans: 'is increasing', hint: 'Tendance en cours → présent continu.' },
      { q: 'He ___ five languages — impressive!', opts: ['speaks','is speaking','spoke','speak'], ans: 'speaks', hint: 'Capacité permanente → présent simple.' },
      { q: 'She ___ her driving test on Friday. (arranged)', opts: ['is taking','takes','took','will take'], ans: 'is taking', hint: 'Rendez-vous futur arrangé → présent continu.' },
    ],
  ],
  'past-vs-present-perfect': [
    [
      { q: 'I ___ to Japan twice in my life.', opts: ['have been','went','was','have gone'], ans: 'have been', hint: 'Expérience de vie → present perfect.' },
      { q: '___ you watch the match last night?', opts: ['Did','Have','Do','Had'], ans: 'Did', hint: 'last night = passé défini → did.' },
      { q: 'She ___ in this house for ten years.', opts: ['has lived','lived','lives','was living'], ans: 'has lived', hint: 'for + durée encore en cours → present perfect.' },
      { q: 'We ___ the film before dinner last Tuesday.', opts: ['watched','have watched','watch','had watched'], ans: 'watched', hint: 'last Tuesday → date précise → prétérit.' },
      { q: 'This is the first time she ___ sushi.', opts: ['has tried','tried','tries','had tried'], ans: 'has tried', hint: 'First time + present perfect → has tried.' },
      { q: 'They ___ the meeting until noon yesterday.', opts: ['postponed','have postponed','postpone','had postponed'], ans: 'postponed', hint: 'yesterday = date précise → prétérit.' },
    ],
    [
      { q: 'By the time he arrived, she ___ already left.', opts: ['had','has','was','did'], ans: 'had', hint: 'Antériorité dans le passé → past perfect (had).' },
      { q: '___ you ever tried bungee jumping?', opts: ['Have','Did','Do','Had'], ans: 'Have', hint: 'Expérience avec ever → have + pp.' },
      { q: 'The train ___ five minutes ago.', opts: ['left','has left','leave','had left'], ans: 'left', hint: 'five minutes ago → moment daté → prétérit.' },
      { q: 'I ___ here since I was a child.', opts: ['have lived','lived','was living','live'], ans: 'have lived', hint: 'since → present perfect.' },
      { q: 'She ___ Shakespeare many times before she graduated.', opts: ['had read','read','has read','reads'], ans: 'had read', hint: 'Antériorité → past perfect (had read).' },
      { q: 'How long ___ for the bus?', opts: ['have you been waiting','did you wait','were you waiting','do you wait'], ans: 'have you been waiting', hint: 'Durée en cours → present perfect continuous.' },
    ],
  ],
  'future': [
    [
      { q: 'She looks pale. I think she ___ faint.', opts: ['is going to','will','goes to','would'], ans: 'is going to', hint: 'Indice présent visible → be going to.' },
      { q: 'Don\'t worry, I ___ call you tonight.', opts: ['will','am going to','shall','am calling'], ans: 'will', hint: 'Promesse spontanée → will.' },
      { q: 'We ___ the Smiths for dinner on Saturday. (arranged)', opts: ['are meeting','will meet','meet','met'], ans: 'are meeting', hint: 'Arrangement futur fixé → présent continu.' },
      { q: 'I think it ___ a great success.', opts: ['will be','is going to be','is','would be'], ans: 'will be', hint: 'Prédiction sans preuve → will.' },
      { q: 'He ___ apply for that job — he made up his mind.', opts: ['is going to','will','would','is applying'], ans: 'is going to', hint: 'Intention décidée → be going to.' },
      { q: 'The flight ___ at 7:15 tomorrow. (horaire officiel)', opts: ['leaves','is leaving','will leave','left'], ans: 'leaves', hint: 'Horaire officiel → présent simple.' },
    ],
    [
      { q: 'By this time next year, she ___ finished her studies.', opts: ['will have','is going to have','will be','would have'], ans: 'will have', hint: 'Accomplissement futur avant un moment → future perfect.' },
      { q: 'At 10 pm tonight, I ___ sleep soundly.', opts: ['will be sleeping','will sleep','am going to sleep','sleep'], ans: 'will be sleeping', hint: 'Action en cours à un moment futur → future continuous.' },
      { q: 'Watch out! The vase ___  fall!', opts: ['is going to','will','would','is falling'], ans: 'is going to', hint: 'Danger imminent visible → be going to.' },
      { q: 'If you need anything, I ___ happy to help.', opts: ['will be','am going to be','am','would be'], ans: 'will be', hint: 'Offre conditionnelle → will.' },
      { q: 'She ___ do it herself — she\'s already hired someone.', opts: ["isn't going to",'won\'t','doesn\'t','isn\'t'], ans: "isn't going to", hint: 'Plan décidé (négatif) → isn\'t going to.' },
      { q: 'The conference ___ from 9 to 5 tomorrow. (programme)', opts: ['runs','will run','is running','ran'], ans: 'runs', hint: 'Programme officiel → présent simple.' },
    ],
  ],
  'articles': [
    [
      { q: 'He is ___ honest man.', opts: ['an','a','the','—'], ans: 'an', hint: 'honest commence par voyelle → an.' },
      { q: 'She plays ___ piano beautifully.', opts: ['the','a','an','—'], ans: 'the', hint: 'Instruments de musique → the.' },
      { q: 'We need ___ milk.', opts: ['—','the','a','an'], ans: '—', hint: 'Indénombrable sans référence précise → zéro article.' },
      { q: '___ life is full of surprises.', opts: ['—','The','A','An'], ans: '—', hint: 'Généralisation abstraite → zéro article.' },
      { q: 'She\'s ___ CEO of a big company.', opts: ['the','a','an','—'], ans: 'the', hint: 'Poste unique dans l\'entreprise → the.' },
      { q: 'I\'d like ___ coffee and ___ biscuit please.', opts: ['a / a','the / the','an / a','a / the'], ans: 'a / a', hint: 'Première mention, singulier → a.' },
    ],
    [
      { q: 'He goes to ___ church every Sunday.', opts: ['—','the','a','an'], ans: '—', hint: 'Institution dans sa fonction → zéro article.' },
      { q: '___ Pacific is the largest ocean.', opts: ['The','A','An','—'], ans: 'The', hint: 'Noms d\'océans → the.' },
      { q: 'She has ___ headache.', opts: ['a','an','the','—'], ans: 'a', hint: 'h aspiré → a (a headache).' },
      { q: 'He is in ___ hospital. (as a patient)', opts: ['—','the','a','an'], ans: '—', hint: 'Institution dans sa fonction → zéro article (hospital).' },
      { q: '___ news is bad today.', opts: ['The','A','—','An'], ans: 'The', hint: 'news est indénombrable mais défini → the.' },
      { q: 'It\'s ___ pleasure to meet you.', opts: ['a','an','the','—'], ans: 'a', hint: 'Première mention, singulier → a pleasure.' },
    ],
  ],
  'comparatives': [
    [
      { q: 'She is ___ person in the room. (tall)', opts: ['the tallest','the taller','the most tall','tallest'], ans: 'the tallest', hint: 'Superlatif court → the + adj + -est.' },
      { q: 'This test is ___ than the last one. (difficult)', opts: ['more difficult','difficulter','most difficult','the most difficult'], ans: 'more difficult', hint: 'Adjectif long → more + adj.' },
      { q: 'He earns ___ money than his sister.', opts: ['less','fewer','little','least'], ans: 'less', hint: 'Indénombrable inférieur → less.' },
      { q: 'The ___ I study, the ___ I remember.', opts: ['more / more','most / most','much / more','most / more'], ans: 'more / more', hint: 'Comparatif parallèle → the more … the more.' },
      { q: 'This is ___ solution. (good)', opts: ['the best','the better','the most good','the goodest'], ans: 'the best', hint: 'Superlatif irrégulier de good → the best.' },
      { q: 'There are ___ students this year than last year.', opts: ['fewer','less','least','few'], ans: 'fewer', hint: 'Dénombrable inférieur → fewer.' },
    ],
    [
      { q: 'It\'s getting ___ and ___ hot.', opts: ['hotter / hotter','more hot / more hot','hottest / hottest','more / more'], ans: 'hotter / hotter', hint: 'Double comparatif → hotter and hotter (adj court).' },
      { q: 'She\'s ___ as her mother. (tall)', opts: ['as tall','taller','the tallest','most tall'], ans: 'as tall', hint: 'Égalité → as + adj + as.' },
      { q: 'He\'s ___ less experienced than I thought.', opts: ['far','very','the','more'], ans: 'far', hint: 'Intensificateur de comparatif → far less.' },
      { q: 'The situation is ___ than we expected. (bad)', opts: ['worse','more bad','the worst','badder'], ans: 'worse', hint: 'Comparatif irrégulier de bad → worse.' },
      { q: 'She\'s by ___ the smartest in the team.', opts: ['far','much','very','most'], ans: 'far', hint: 'by far + superlatif → de loin la plus intelligente.' },
      { q: 'This car is no ___ than the other one. (cheap)', opts: ['cheaper','cheapest','more cheap','cheap'], ans: 'cheaper', hint: 'no + comparatif + than → pas moins cher que.' },
    ],
  ],
  'modals': [
    [
      { q: 'You ___ be tired — you haven\'t slept!', opts: ['must','might','should','could'], ans: 'must', hint: 'Déduction logique forte → must.' },
      { q: '___ I use your phone?', opts: ['Could','Should','Would','Must'], ans: 'Could', hint: 'Requête polie → could.' },
      { q: 'We ___ arrive on time — the boss will be angry otherwise.', opts: ['must','might','could','should'], ans: 'must', hint: 'Obligation forte → must.' },
      { q: 'She ___ speak Spanish when she was little.', opts: ['could','can','must','should'], ans: 'could', hint: 'Capacité passée → could.' },
      { q: 'You ___ eat so much sugar. It\'s bad for you.', opts: ["shouldn't",'mustn\'t','can\'t','wouldn\'t'], ans: "shouldn't", hint: 'Conseil négatif → shouldn\'t.' },
      { q: 'He ___ be at home — I\'m not sure.', opts: ['might','must','should','can'], ans: 'might', hint: 'Incertitude → might.' },
    ],
    [
      { q: 'You ___ have told me earlier! I\'m upset.', opts: ['should','must','could','would'], ans: 'should', hint: 'Reproche passé → should have + pp.' },
      { q: 'She ___ have left — her bag is still here.', opts: ["can't","mustn't",'might not','shouldn\'t'], ans: "can't", hint: 'Impossibilité passée → can\'t have + pp.' },
      { q: 'We ___ wait — the doctor will see us now.', opts: ["needn't",'mustn\'t',"shouldn't","can't"], ans: "needn't", hint: 'Absence d\'obligation → needn\'t.' },
      { q: 'They ___ have won — they played so well!', opts: ['could','must','should','would'], ans: 'could', hint: 'Possibilité non réalisée → could have + pp.' },
      { q: 'You ___ be kidding! That\'s incredible.', opts: ['must','might','should','could'], ans: 'must', hint: 'Réaction de surprise → must (you must be kidding).' },
      { q: 'She ___ have studied abroad — her accent is perfect.', opts: ['must','might','should','could'], ans: 'must', hint: 'Déduction passée forte → must have + pp.' },
    ],
  ],
  'conditionals': [
    [
      { q: 'If you ___ earlier, you\'d catch the train.', opts: ['left','leave','will leave','would leave'], ans: 'left', hint: 'Type 2 → if + prétérit, would + base.' },
      { q: 'She would have passed if she ___ harder.', opts: ['had studied','studied','would study','studies'], ans: 'had studied', hint: 'Type 3 → if + past perfect.' },
      { q: 'If it ___ fine tomorrow, we\'ll go to the beach.', opts: ['is','was','will be','would be'], ans: 'is', hint: 'Type 1 → if + présent, will + base.' },
      { q: 'Mix blue and yellow, you ___ green. (loi)', opts: ['get','will get','would get','got'], ans: 'get', hint: 'Type 0 → présent + présent (vérité).' },
      { q: 'I wish I ___ speak Italian.', opts: ['could','can','would','should'], ans: 'could', hint: 'Wish + prétérit → regret présent.' },
      { q: 'If only she ___ listened to me!', opts: ['had','has','would have','could have'], ans: 'had', hint: 'If only + past perfect → regret du passé.' },
    ],
    [
      { q: 'Were I you, I ___ accept.', opts: ['would','will','should','could'], ans: 'would', hint: 'Inversion formelle : Were I you → would (= If I were you).' },
      { q: 'Had she known, she ___ told you.', opts: ['would have','will have','had','should have'], ans: 'would have', hint: 'Inversion past perfect → type 3 formel.' },
      { q: 'Provided that you ___ hard, you\'ll pass.', opts: ['work','worked','would work','will work'], ans: 'work', hint: 'Provided that = if → type 1 → présent.' },
      { q: 'She treats me as though I ___ stupid.', opts: ['were','am','was','would be'], ans: 'were', hint: 'as though + subjonctif → were (hypothèse).' },
      { q: '___ you need help, don\'t hesitate to call.', opts: ['Should','Would','If','Were'], ans: 'Should', hint: 'Inversion modale : Should you = If you should (formel).' },
      { q: 'Even if he ___, I won\'t believe him.', opts: ['apologises','apologised','would apologise','had apologised'], ans: 'apologises', hint: 'Even if → type 1 → présent.' },
    ],
  ],
  'how-questions': [
    [
      { q: '___ do you exercise? Once a week.', opts: ['How often','How long','How many','How much'], ans: 'How often', hint: 'Fréquence → How often.' },
      { q: '___ sugar do you take? (indénombrable)', opts: ['How much','How many','How often','How well'], ans: 'How much', hint: 'Indénombrable → How much.' },
      { q: '___ is it from London to Paris? (distance)', opts: ['How far','How long','How fast','How often'], ans: 'How far', hint: 'Distance → How far.' },
      { q: '___ is your sister? She\'s 25.', opts: ['How old','How long','How well','How far'], ans: 'How old', hint: 'Âge → How old.' },
      { q: '___ did the ceremony last? (durée)', opts: ['How long','How often','How far','How much'], ans: 'How long', hint: 'Durée → How long.' },
      { q: '___ do you speak French? (qualité)', opts: ['How well','How fast','How much','How often'], ans: 'How well', hint: 'Qualité / niveau → How well.' },
    ],
    [
      { q: '___ people came to the event? (dénombrable)', opts: ['How many','How much','How often','How well'], ans: 'How many', hint: 'Dénombrable (people) → How many.' },
      { q: '___ is it from here to the airport? About 20km.', opts: ['How far','How fast','How long','How often'], ans: 'How far', hint: 'Distance → How far.' },
      { q: '___ does the train travel? 300 km/h.', opts: ['How fast','How far','How long','How often'], ans: 'How fast', hint: 'Vitesse → How fast.' },
      { q: '___ time does it take? (durée)', opts: ['How long','How much','How often','How many'], ans: 'How long', hint: 'How long = combien de temps (durée).' },
      { q: '___ did you sleep last night? (qualité)', opts: ['How well','How much','How long','How often'], ans: 'How well', hint: 'Qualité du sommeil → How well.' },
      { q: '___ does this phone cost? (prix)', opts: ['How much','How many','How often','How far'], ans: 'How much', hint: 'Prix → How much.' },
    ],
  ],
  'questions-negation': [
    [
      { q: 'She ___ to school yesterday.', opts: ["didn't go","don't go","hasn't gone","wasn't going"], ans: "didn't go", hint: 'Négatif prétérit → didn\'t + base.' },
      { q: '___ they living in Paris?', opts: ['Are','Do','Were','Did'], ans: 'Are', hint: 'Question présent continu → are + they + -ing.' },
      { q: 'He has never ___ to China.', opts: ['been','went','gone','be'], ans: 'been', hint: 'never + present perfect → never been.' },
      { q: 'Where ___ she work?', opts: ['does','do','is','has'], ans: 'does', hint: 'Question présent simple (she) → does.' },
      { q: 'They ___ watching TV when I called.', opts: ["weren't",'don\'t','didn\'t','aren\'t'], ans: "weren't", hint: 'Négatif prétérit continu → weren\'t.' },
      { q: '___ she spoken to him yet?', opts: ['Has','Did','Is','Does'], ans: 'Has', hint: 'Question au present perfect → has.' },
    ],
    [
      { q: 'Seldom ___ he made such a mistake.', opts: ['has','does','did','had'], ans: 'has', hint: 'Inversion après adverbe négatif (seldom) → has he made.' },
      { q: 'You like jazz, ___?', opts: ['don\'t you','do you','aren\'t you','didn\'t you'], ans: 'don\'t you', hint: 'Question tag : affirmative → tag négatif (don\'t you).' },
      { q: 'She understood neither the question ___ the answer.', opts: ['nor','or','neither','and'], ans: 'nor', hint: 'neither … nor (ni … ni).' },
      { q: 'Little ___ she know what awaited her.', opts: ['did','does','has','had'], ans: 'did', hint: 'Inversion après little → did she know.' },
      { q: 'Not only ___ she rude, but she also lied.', opts: ['was','is','did','has'], ans: 'was', hint: 'Not only → inversion → was she.' },
      { q: 'She hasn\'t arrived yet, ___?', opts: ['has she','hasn\'t she','did she','does she'], ans: 'has she', hint: 'Tag après présent perfect négatif → has she.' },
    ],
  ],
  'quantifiers': [
    [
      { q: 'There is ___ point arguing — it\'s decided.', opts: ['no','any','some','not'], ans: 'no', hint: 'no + nom = aucun(e).' },
      { q: 'Could you give me ___ information?', opts: ['some','any','a','many'], ans: 'some', hint: 'Demande polie → some.' },
      { q: 'She has ___ friends in the city — maybe two.', opts: ['a few','few','a little','little'], ans: 'a few', hint: 'Dénombrable, petit nombre positif → a few.' },
      { q: 'He drank ___ water during the race.', opts: ['too much','too many','enough','several'], ans: 'too much', hint: 'Indénombrable en excès → too much.' },
      { q: 'There weren\'t ___ guests at the party.', opts: ['many','much','some','any'], ans: 'many', hint: 'Négatif + dénombrable → many.' },
      { q: 'I need ___ more time to finish. (un peu)', opts: ['a little','a few','little','few'], ans: 'a little', hint: 'Indénombrable, petite quantité positive → a little.' },
    ],
    [
      { q: 'There are ___ students absent today. (aucun)', opts: ['no','none','any','not any'], ans: 'no', hint: 'No + nom → aucun étudiant.' },
      { q: '___ of my friends speak Spanish. (aucun)', opts: ['None','No','Neither','Any'], ans: 'None', hint: 'None of + groupe nominal → aucun de.' },
      { q: 'She ate ___ the food on her plate. (tout)', opts: ['all of','all the','most of','some of'], ans: 'all of', hint: 'all of + pronom/déterminant → tout le contenu.' },
      { q: 'He\'s had ___ practice lately. (insuffisant)', opts: ['too little','too few','a little','a few'], ans: 'too little', hint: 'Indénombrable insuffisant → too little.' },
      { q: 'There\'s ___ milk left — we need to buy more.', opts: ['hardly any','few','a few','many'], ans: 'hardly any', hint: 'Presque aucun (indénombrable) → hardly any.' },
      { q: 'I have ___ time for a coffee. (suffisamment)', opts: ['enough','plenty','much','many'], ans: 'enough', hint: 'Suffisamment → enough.' },
    ],
  ],
  'gerund-infinitive': [
    [
      { q: 'I\'ve always wanted ___ the world.', opts: ['to travel','travelling','travel','have travelled'], ans: 'to travel', hint: 'want + infinitif → to travel.' },
      { q: 'He admitted ___ the money.', opts: ['stealing','to steal','steal','stolen'], ans: 'stealing', hint: 'admit + gérondif (-ing).' },
      { q: 'She can\'t help ___ when she sees cats.', opts: ['smiling','to smile','smile','smiled'], ans: 'smiling', hint: 'can\'t help + gérondif.' },
      { q: 'They agreed ___ the proposal.', opts: ['to accept','accepting','accept','accepted'], ans: 'to accept', hint: 'agree + infinitif (to).' },
      { q: 'He regrets not ___ harder at school.', opts: ['studying','to study','study','studied'], ans: 'studying', hint: 'regret + gérondif → regret not studying.' },
      { q: 'She avoided ___ him after the argument.', opts: ['meeting','to meet','meet','met'], ans: 'meeting', hint: 'avoid + gérondif (-ing).' },
    ],
    [
      { q: 'I remember ___ her somewhere before.', opts: ['seeing','to see','see','saw'], ans: 'seeing', hint: 'remember + -ing → souvenir d\'une action passée.' },
      { q: 'Don\'t forget ___ the lights before you leave.', opts: ['to turn off','turning off','turn off','turned off'], ans: 'to turn off', hint: 'forget + to → tâche future à accomplir.' },
      { q: 'He tried ___ the door, but it was locked.', opts: ['to open','opening','open','opened'], ans: 'to open', hint: 'try + to = tenter de (effort).' },
      { q: 'We stopped ___ at a nice restaurant.', opts: ['to eat','eating','eat','eaten'], ans: 'to eat', hint: 'stop + to = s\'arrêter pour (but).' },
      { q: 'She is used to ___ early. (habitude)', opts: ['getting up','get up','got up','get'], ans: 'getting up', hint: 'used to doing = habitude actuelle → -ing.' },
      { q: 'I\'d rather ___ home tonight.', opts: ['stay','staying','to stay','stayed'], ans: 'stay', hint: 'would rather + base (sans to).' },
    ],
  ],
  'be': [
    [
      { q: 'It ___ a beautiful day yesterday.', opts: ['was','were','is','been'], ans: 'was', hint: 'Prétérit singulier → was.' },
      { q: 'They ___ at the concert when I arrived.', opts: ['were','was','are','be'], ans: 'were', hint: 'They au prétérit → were.' },
      { q: 'Where ___ you last night?', opts: ['were','was','did','are'], ans: 'were', hint: 'Question prétérit (you) → were.' },
      { q: 'The meeting ___ postponed.', opts: ['has been','had','is being','have been'], ans: 'has been', hint: 'Passif present perfect → has been + pp.' },
      { q: 'She ___ born in Lyon in 1990.', opts: ['was','is','were','has been'], ans: 'was', hint: 'Naissance → was born.' },
      { q: '___ there any problems?', opts: ['Were','Was','Are','Is'], ans: 'Were', hint: 'Question prétérit + there + pluriel → Were there.' },
    ],
    [
      { q: 'There ___ to be a better solution.', opts: ['has','have','had','is'], ans: 'has', hint: 'There has to be = il doit y avoir (singulier).' },
      { q: 'She ___ known for her kindness.', opts: ['is','was','were','has'], ans: 'is', hint: 'Passif présent (connue pour) → is known.' },
      { q: 'What time ___ the last train?', opts: ['is','are','was','were'], ans: 'is', hint: 'Horaire (singulier) → is.' },
      { q: 'They ___ said to be the best team in the league.', opts: ['are','were','have been','is'], ans: 'are', hint: 'Passif présent (they) → are said.' },
      { q: 'It ___ raining when we left.', opts: ['was','is','were','had'], ans: 'was', hint: 'Prétérit continu → was raining.' },
      { q: 'The door ___ painted blue last year.', opts: ['was','is','were','has'], ans: 'was', hint: 'Passif prétérit (singulier) → was.' },
    ],
  ],
  'have': [
    [
      { q: 'She ___ her computer serviced every year.', opts: ['has','have','gets','is having'], ans: 'has', hint: 'Causatif have → has + objet + pp.' },
      { q: 'Do you ___ any idea where he is?', opts: ['have','has','had','having'], ans: 'have', hint: 'Do you + base form → have.' },
      { q: 'We ___ a lovely time at the party.', opts: ['had','have','are having','has'], ans: 'had', hint: 'Expression au prétérit → had a lovely time.' },
      { q: 'She ___ a shower when the phone rang.', opts: ['was having','had','has had','is having'], ans: 'was having', hint: 'Action en cours → prétérit continu (was having).' },
      { q: 'He ___ nothing to do with it.', opts: ['had','has','have','is having'], ans: 'had', hint: 'Contexte passé → had nothing to do with it.' },
      { q: 'I ___ my eyes tested every two years.', opts: ['have','has','get','am having'], ans: 'have', hint: 'Causatif have (présent, I) → have.' },
    ],
    [
      { q: 'She wouldn\'t ___ done it without help.', opts: ['have','had','has','be'], ans: 'have', hint: 'Would + have + pp → conditional perfect.' },
      { q: 'He ___ his passport renewed last week.', opts: ['had','has had','got','was having'], ans: 'had', hint: 'Causatif passé → had + objet + pp.' },
      { q: '___ you ever had your car stolen?', opts: ['Have','Has','Had','Were'], ans: 'Have', hint: 'Question present perfect → Have you + pp.' },
      { q: 'She ___ to stop — the pain was unbearable.', opts: ['had','has had','was having','have'], ans: 'had', hint: 'have to (obligation) au prétérit → had to.' },
      { q: 'I ___ a go at fixing it before calling a plumber.', opts: ['had','have','has had','am having'], ans: 'had', hint: 'have a go (essayer) au prétérit → had a go.' },
      { q: 'They ___ trouble finding a hotel that night.', opts: ['had','have had','are having','have'], ans: 'had', hint: 'Prétérit narratif → had trouble -ing.' },
    ],
  ],
  'personal-pronouns': [
    [
      { q: 'That\'s her over there — my sister and ___.', opts: ['me','I','my','myself'], ans: 'me', hint: 'Après and, pronom complément → me.' },
      { q: 'He taught ___ how to cook.', opts: ['himself','him','his','he'], ans: 'himself', hint: 'Sujet = complément → réfléchi (himself).' },
      { q: 'They introduced ___ as the new manager.', opts: ['themselves','them','their','they'], ans: 'themselves', hint: 'Sujet = complément → réfléchi (themselves).' },
      { q: 'Between you and ___, this is a secret.', opts: ['me','I','myself','mine'], ans: 'me', hint: 'Après préposition → pronom objet (me).' },
      { q: 'We did it all by ___.', opts: ['ourselves','us','our','ours'], ans: 'ourselves', hint: 'Seuls, sans aide → by + réfléchi (ourselves).' },
      { q: 'Is this bag ___? No, mine is blue.', opts: ['yours','your','you','yourself'], ans: 'yours', hint: 'Pronom possessif indépendant → yours.' },
    ],
    [
      { q: 'They blamed ___ for the mistake.', opts: ['us','we','our','ourselves'], ans: 'us', hint: 'Pronom complément après blame → us.' },
      { q: 'She hurt ___ while running.', opts: ['herself','her','she','hers'], ans: 'herself', hint: 'Même sujet et objet → réfléchi (herself).' },
      { q: 'It\'s ___ birthday today! (belonging to us)', opts: ['our','ours','us','we'], ans: 'our', hint: 'Possessif adjectival devant nom → our.' },
      { q: 'Neither he nor ___ was invited.', opts: ['she','her','hers','herself'], ans: 'she', hint: 'Sujet dans neither … nor → she.' },
      { q: 'We enjoyed ___ at the festival.', opts: ['ourselves','us','our','ours'], ans: 'ourselves', hint: 'Pronom réfléchi → ourselves.' },
      { q: 'Give ___ a hand — they can\'t carry it alone.', opts: ['them','they','their','theirs'], ans: 'them', hint: 'Pronom objet → them.' },
    ],
  ],
  'nouns-plural': [
    [
      { q: 'There are two ___ in the pond.', opts: ['fish','fishes','fishs','fishies'], ans: 'fish', hint: 'fish reste identique au pluriel.' },
      { q: 'The ___ are beautiful in autumn.', opts: ['leaves','leafs','leafes','leifs'], ans: 'leaves', hint: '-f → -ves : leaf → leaves.' },
      { q: 'They hired three ___ last month.', opts: ['assistants','assistant','assistantes','assistantess'], ans: 'assistants', hint: 'Pluriel régulier → + s.' },
      { q: 'The ___ left the meeting early.', opts: ['women','womans','womens','woman'], ans: 'women', hint: 'Pluriel irrégulier : woman → women.' },
      { q: 'She has two ___ at home. (piano)', opts: ['pianos','pianoes','piano','pianis'], ans: 'pianos', hint: 'Noms en -o courants → + s (pianos).' },
      { q: 'She has two ___ (criterion).', opts: ['criteria','criterions','criterias','criterion'], ans: 'criteria', hint: 'Pluriel latin : criterion → criteria.' },
    ],
    [
      { q: 'The phenomenon was explained by two ___.', opts: ['phenomena','phenomenons','phenomenon','phenomenas'], ans: 'phenomena', hint: 'Pluriel grec : phenomenon → phenomena.' },
      { q: 'All the ___ were present. (mouse)', opts: ['mice','mouses','mouse','mices'], ans: 'mice', hint: 'Pluriel irrégulier : mouse → mice.' },
      { q: 'These ___ are very old. (tooth)', opts: ['teeth','tooths','toothes','tooth'], ans: 'teeth', hint: 'Pluriel irrégulier : tooth → teeth.' },
      { q: 'She counted several ___. (sheep)', opts: ['sheep','sheeps','sheepes','sheepies'], ans: 'sheep', hint: 'sheep → invariable au pluriel.' },
      { q: 'The data ___ not conclusive.', opts: ['are','is','was','were'], ans: 'are', hint: 'data = pluriel de datum → are.' },
      { q: 'Several ___ were damaged in the storm. (roof)', opts: ['roofs','rooves','roof','roofes'], ans: 'roofs', hint: 'roof → roofs (exception : pas de -ves).' },
    ],
  ],
  'possession': [
    [
      { q: 'Is this ___ umbrella?', opts: ['James\'s','James\'','James','of James'], ans: 'James\'s', hint: 'Noms se terminant par s → + \'s (James\'s).' },
      { q: 'The ___ office is on the first floor. (managers, plural)', opts: ["managers'",'manager\'s','managers\'s','of the managers'], ans: "managers'", hint: 'Pluriel régulier → apostrophe seule après s.' },
      { q: 'That\'s a friend ___ mine.', opts: ['of','—','\'s','from'], ans: 'of', hint: 'a friend of + pronom possessif.' },
      { q: 'Those are ___ books. (belonging to them)', opts: ['their','theirs','them','they\'s'], ans: 'their', hint: 'Possessif adjectival (devant nom) → their.' },
      { q: 'The end ___ the film was surprising.', opts: ['of','\'s','—','from'], ans: 'of', hint: 'Choses non-animées → of (the end of the film).' },
      { q: 'My ___ car is new. (my parents\')', opts: ["parents'","parent's",'parents','of parents'], ans: "parents'", hint: 'Pluriel régulier → apostrophe après le s.' },
    ],
    [
      { q: 'The ___ bark kept us awake. (dog)', opts: ["dog's","dogs'",'dogs','of dog'], ans: "dog's", hint: 'Singulier → génitif saxon : dog\'s.' },
      { q: 'She read two ___ books.', opts: ['Shakespeare\'s','Shakespeares\'','of Shakespeare','Shakespeare'], ans: 'Shakespeare\'s', hint: 'Auteur → génitif possessif.' },
      { q: 'That is ___ problem, not mine.', opts: ['your','yours','you','yourself'], ans: 'your', hint: 'Possessif devant nom → your (adjectif).' },
      { q: 'This bag is ___ . (belonging to the woman)', opts: ["the woman's","the woman'","of the woman",'the women\'s'], ans: "the woman's", hint: 'Singulier → génitif saxon.' },
      { q: 'The team ___ performance was outstanding.', opts: ["'s","s'","s's",'—'], ans: "'s", hint: 'team (singulier) → team\'s.' },
      { q: 'Those results are ___. (belonging to us)', opts: ['ours','our','us','ourselves'], ans: 'ours', hint: 'Pronom possessif indépendant → ours.' },
    ],
  ],
  'prepositions-place': [
    [
      { q: 'He arrived ___ the airport two hours early.', opts: ['at','in','on','by'], ans: 'at', hint: 'Lieu de transit → at.' },
      { q: 'The keys are ___ the drawer.', opts: ['in','on','at','under'], ans: 'in', hint: 'À l\'intérieur d\'un espace fermé → in.' },
      { q: 'She sat ___ the window and looked out.', opts: ['by','on','at','in'], ans: 'by', hint: 'Tout près de → by.' },
      { q: 'He lives ___ the third floor.', opts: ['on','in','at','by'], ans: 'on', hint: 'Étages → on the third floor.' },
      { q: 'The station is ___ the bank and the post office.', opts: ['between','among','in','at'], ans: 'between', hint: 'Entre deux choses précises → between.' },
      { q: 'The poster is ___ the wall.', opts: ['on','in','at','by'], ans: 'on', hint: 'Surface verticale → on.' },
    ],
    [
      { q: 'She hid the key ___ the mat.', opts: ['under','below','beneath','on'], ans: 'under', hint: 'Directement en dessous → under.' },
      { q: 'The plane flew ___ the clouds.', opts: ['above','over','through','across'], ans: 'above', hint: 'Plus haut que, sans traverser → above.' },
      { q: 'He walked ___ the room to open the window.', opts: ['across','through','along','over'], ans: 'across', hint: 'D\'un côté à l\'autre → across.' },
      { q: 'She was standing ___ me. (face à face)', opts: ['opposite','against','among','towards'], ans: 'opposite', hint: 'En face de → opposite.' },
      { q: 'The books were scattered ___ the floor.', opts: ['all over','in','on','across'], ans: 'all over', hint: 'Éparpillé partout sur → all over.' },
      { q: 'We live ___ the park. (de l\'autre côté)', opts: ['across from','opposite to','against','by'], ans: 'across from', hint: 'De l\'autre côté de → across from.' },
    ],
  ],
  'demonstratives': [
    [
      { q: '___ is my favourite photo. (close, singular)', opts: ['This','That','These','Those'], ans: 'This', hint: 'Proche, singulier → this.' },
      { q: '___ were the days! (le bon vieux temps)', opts: ['Those','These','That','This'], ans: 'Those', hint: 'Époque révolue (loin dans le temps) → those.' },
      { q: 'Are ___ your glasses on the desk? (near)', opts: ['these','those','this','that'], ans: 'these', hint: 'Proche, pluriel → these.' },
      { q: 'I prefer ___ shoes here to ___ over there.', opts: ['these / those','those / these','this / that','that / this'], ans: 'these / those', hint: 'Proche → these, loin → those.' },
      { q: '___ is a difficult question. (just asked)', opts: ['That','This','Those','These'], ans: 'That', hint: 'Question venant d\'être posée → that.' },
      { q: 'What is ___ smell? (strange, nearby)', opts: ['that','this','those','these'], ans: 'that', hint: 'Odeur perçue avec distance/surprise → that.' },
    ],
    [
      { q: '___ who cheat will be disqualified. (référence générale)', opts: ['Those','These','That','This'], ans: 'Those', hint: 'Référence générale (ceux qui) → Those who.' },
      { q: 'Her results were good, but ___ of her brother were better.', opts: ['those','these','this','that'], ans: 'those', hint: 'Pronom de substitution pour éviter la répétition → those.' },
      { q: '___ said, I agree with your conclusion.', opts: ['That','This','Those','These'], ans: 'That', hint: 'Expression figée : that said (cela dit).' },
      { q: 'We had ___ big presentation today. (proche dans le temps)', opts: ['this','that','these','those'], ans: 'this', hint: 'Événement d\'aujourd\'hui → this.' },
      { q: '___ information is confidential.', opts: ['This','That','These','Those'], ans: 'This', hint: 'information (indénombrable, singulier) → this.' },
      { q: 'Of all the options, ___ seems the most viable.', opts: ['this','that','these','those'], ans: 'this', hint: 'Option évoquée juste avant → this (proche mentalement).' },
    ],
  ],
  'causative': [
    [
      { q: 'I need to ___ this document translated.', opts: ['have','get','make','let'], ans: 'have', hint: 'have + objet + pp = faire faire (formel).' },
      { q: 'She ___ her house cleaned every week.', opts: ['gets','has','makes','lets'], ans: 'gets', hint: 'get + objet + pp (courant/oral).' },
      { q: 'The teacher made the students ___ the text again.', opts: ['read','to read','reading','reads'], ans: 'read', hint: 'make + objet + base = obliger (sans to).' },
      { q: 'He let his son ___ the car.', opts: ['take','to take','taking','took'], ans: 'take', hint: 'let + objet + base = permettre.' },
      { q: 'She ___ her nails painted at the salon.', opts: ['had','has had','gets','got'], ans: 'had', hint: 'Causatif passé → had + objet + pp.' },
      { q: 'They ___ their luggage sent ahead.', opts: ['had','have','got','made'], ans: 'had', hint: 'Causatif : had + objet + pp.' },
    ],
    [
      { q: 'He ___ us stay late. (forced us)', opts: ['made','let','had','got'], ans: 'made', hint: 'make + objet + base (forcer) → made us stay.' },
      { q: 'She got the mechanic ___ the car.', opts: ['to fix','fix','fixing','fixed'], ans: 'to fix', hint: 'get + personne + to + base → to fix.' },
      { q: 'They wouldn\'t ___ us in.', opts: ['let','make','have','get'], ans: 'let', hint: 'let = permettre → let us in.' },
      { q: 'She had her tooth ___ at the dentist.', opts: ['pulled out','pull out','pulling out','to pull out'], ans: 'pulled out', hint: 'have + objet + pp → pulled out.' },
      { q: 'He got his application ___ quickly.', opts: ['processed','process','processing','to process'], ans: 'processed', hint: 'get + objet + pp (résultat).' },
      { q: 'The manager had the team ___ the report.', opts: ['rewrite','rewritten','to rewrite','rewriting'], ans: 'rewrite', hint: 'have + personne + base (sans to) → rewrite.' },
    ],
  ],
  'prepositions-time': [
    [
      { q: 'We\'ll meet ___ Tuesday afternoon.', opts: ['on','in','at','by'], ans: 'on', hint: 'Jour + partie du jour → on Tuesday afternoon.' },
      { q: 'She started her job ___ the beginning of March.', opts: ['at','in','on','by'], ans: 'at', hint: 'at the beginning of = au début de.' },
      { q: 'He works best ___ night.', opts: ['at','in','on','during'], ans: 'at', hint: 'at night (la nuit).' },
      { q: 'We lived there ___ the nineties.', opts: ['in','on','at','during'], ans: 'in', hint: 'Décennie → in the nineties.' },
      { q: 'She must finish ___ 5 pm. (pas plus tard que)', opts: ['by','at','until','on'], ans: 'by', hint: 'Au plus tard → by.' },
      { q: 'I\'ve been studying ___ this morning.', opts: ['since','for','during','from'], ans: 'since', hint: 'Depuis un point de départ → since.' },
    ],
    [
      { q: 'She works ___ 9 ___ 5 every day.', opts: ['from / to','from / until','since / until','at / to'], ans: 'from / to', hint: 'Plage horaire → from … to.' },
      { q: 'He was stuck in traffic ___ an hour.', opts: ['for','since','during','by'], ans: 'for', hint: 'Durée → for.' },
      { q: 'They arrived ___ the middle of the night.', opts: ['in','at','on','during'], ans: 'in', hint: 'in the middle of = au milieu de.' },
      { q: 'I haven\'t seen her ___ ages.', opts: ['for','since','during','in'], ans: 'for', hint: 'Durée non précise → for ages.' },
      { q: 'We stayed ___ the end of the concert.', opts: ['until','by','for','since'], ans: 'until', hint: 'Jusqu\'à → until.' },
      { q: 'She graduated ___ the summer of 2022.', opts: ['in','on','at','during'], ans: 'in', hint: 'Saison → in the summer.' },
    ],
  ],
  'passive': [
    [
      { q: 'The report ___ by the secretary every week.', opts: ['is typed','types','has typed','is typing'], ans: 'is typed', hint: 'Passif présent → is + pp.' },
      { q: 'They ___ told about the meeting.', opts: ['were','was','are','had been'], ans: 'were', hint: 'Passif prétérit (they) → were + pp.' },
      { q: 'The bridge ___ for six months.', opts: ['has been closed','was closed','closes','has closed'], ans: 'has been closed', hint: 'Depuis → present perfect passif → has been + pp.' },
      { q: 'This problem ___ deal with immediately.', opts: ['must be','must have been','has to','is being'], ans: 'must be', hint: 'Obligation au passif → must be + pp.' },
      { q: 'He ___ arrested when I called.', opts: ['was being','is being','was','had been'], ans: 'was being', hint: 'Action en cours dans le passé → passif continu prétérit.' },
      { q: 'The documents ___ by tomorrow.', opts: ['will have been signed','will sign','are signed','are being signed'], ans: 'will have been signed', hint: 'Passif futur antérieur → will have been + pp.' },
    ],
    [
      { q: 'It ___ that the CEO will resign.', opts: ['is reported','reports','is reporting','was reported'], ans: 'is reported', hint: 'Construction impersonnelle passive → It is reported that.' },
      { q: 'By the time it opened, the road ___ for years.', opts: ['had been planned','was planned','has been planned','had planned'], ans: 'had been planned', hint: 'Passif past perfect → had been + pp.' },
      { q: 'Nothing ___ to improve the situation.', opts: ['was done','did','has done','were done'], ans: 'was done', hint: 'Passif prétérit (nothing) → was done.' },
      { q: 'He ___ believed to have fled the country.', opts: ['is','was','has been','were'], ans: 'is', hint: 'Passif présent impersonnel → He is believed to.' },
      { q: 'The thief ___ hiding in the basement.', opts: ['was found','found','is found','has found'], ans: 'was found', hint: 'Passif prétérit (découverte) → was found.' },
      { q: 'The criminals ___ caught red-handed.', opts: ['were','are','have','had'], ans: 'were', hint: 'Passif prétérit (pluriel) → were caught.' },
    ],
  ],
  'adverbs': [
    [
      { q: 'She plays the piano ___ . (good → adverbe)', opts: ['well','good','goodly','greatly'], ans: 'well', hint: 'Adverbe de good → well.' },
      { q: 'He ___ watches TV. He prefers reading. (rarement)', opts: ['rarely','always','often','usually'], ans: 'rarely', hint: 'rarement → rarely.' },
      { q: 'She finished the exam ___ quickly.', opts: ['surprisingly','surprising','surprise','surprised'], ans: 'surprisingly', hint: 'Modifie un adverbe → adverbe en -ly.' },
      { q: 'She ___ finished her essay. (presque)', opts: ['nearly','near','close','almost nearly'], ans: 'nearly', hint: 'Presque → nearly.' },
      { q: 'He arrived ___ after the meeting started.', opts: ['shortly','short','shortly after','short after'], ans: 'shortly', hint: 'Peu après → shortly.' },
      { q: 'He treats everyone ___ . (polite → adverbe)', opts: ['politely','politly','polite','in a polite'], ans: 'politely', hint: '-ite + ly → politely.' },
    ],
    [
      { q: 'He can ___ wait — he\'s very patient. (à peine)', opts: ['hardly','hard','never','rarely'], ans: 'hardly', hint: 'À peine → hardly (≠ hard = dur).' },
      { q: 'She ___ forgets things. She\'s very organised.', opts: ['never','always','often','usually'], ans: 'never', hint: 'ne … jamais → never.' },
      { q: 'He drives ___ carefully when it rains.', opts: ['more','most','very','so'], ans: 'more', hint: 'Comparatif d\'adverbe → more carefully.' },
      { q: 'She speaks French ___ well.', opts: ['incredibly','incredible','incrediblily','incrediblly'], ans: 'incredibly', hint: '-ible → -ibly : incredible → incredibly.' },
      { q: 'The train arrived two hours ___ .', opts: ['late','lately','later','last'], ans: 'late', hint: 'late = adverbe (en retard) ; lately = récemment.' },
      { q: 'He ___ finished when the alarm went off. (à peine)', opts: ['had barely','barely had','had scarcely','scarcely had'], ans: 'had barely', hint: 'À peine avait-il fini → had barely + pp.' },
    ],
    [
      { q: "'Cependant' en anglais ?", opts: ['However','Therefore','Meanwhile','Instead'], ans: 'However', hint: 'Cependant → however.' },
      { q: "'Donc / Par conséquent' en anglais ?", opts: ['Therefore','However','Anyway','Although'], ans: 'Therefore', hint: 'Donc → therefore.' },
      { q: "'Pendant ce temps' en anglais ?", opts: ['Meanwhile','Instead','Anyway','However'], ans: 'Meanwhile', hint: 'Pendant ce temps → meanwhile.' },
      { q: "'Absolument' en anglais ?", opts: ['Absolutely','Generally','Exactly','Certainly'], ans: 'Absolutely', hint: 'Absolument → absolutely.' },
      { q: "'À la place' en anglais ?", opts: ['Instead','Anyway','However','Therefore'], ans: 'Instead', hint: 'À la place → instead.' },
      { q: "'Surtout / Particulièrement' en anglais ?", opts: ['Especially','Generally','Totally','Probably'], ans: 'Especially', hint: 'Surtout → especially.' },
    ],
    [
      { q: "'De nos jours' en anglais ?", opts: ['Nowadays','These days','Currently','Today'], ans: 'Nowadays', hint: 'De nos jours → Nowadays.' },
      { q: "'Actuellement' en anglais ?", opts: ['Currently','Actually','Now','At the moment'], ans: 'Currently', hint: "Currently = actuellement (≠ Actually = en fait)." },
      { q: "'Il y a deux jours' en anglais ?", opts: ['Two days ago','Before two days','Two days before','Since two days'], ans: 'Two days ago', hint: "Ago se place APRÈS la durée : two days ago." },
      { q: "'Plus tôt' en anglais ?", opts: ['Earlier','Before','Sooner','Previously'], ans: 'Earlier', hint: 'Plus tôt → earlier (comparatif de early).' },
      { q: "'Bientôt' en anglais ?", opts: ['Soon','Shortly','Quickly','Now'], ans: 'Soon', hint: 'Bientôt → soon.' },
      { q: "Compléter : 'She called me ___ this morning.' (plus tôt)", opts: ['earlier','before','sooner','previously'], ans: 'earlier', hint: 'Earlier = plus tôt (plus tôt dans la journée).' },
    ],
  ],
  'numbers': [
    [
      { q: 'There were ___ people at the event. (1 542)', opts: ['one thousand five hundred and forty-two','fifteen forty-two','one thousand and five forty-two','fifteen hundred forty-two'], ans: 'one thousand five hundred and forty-two', hint: 'Millier + centaine + dizaine + unité.' },
      { q: 'She came ___. (2nd)', opts: ['second','two','twoth','secondary'], ans: 'second', hint: 'Ordinal : 2 → second.' },
      { q: '___ of the candidates were selected. (1/3)', opts: ['A third','The third','One thirds','A thirds'], ans: 'A third', hint: 'Fraction : 1/3 → a third.' },
      { q: 'He scored ___ on the test. (5th)', opts: ['fifth','fiveth','five','fiftieth'], ans: 'fifth', hint: 'five → fifth (irrégulier).' },
      { q: 'The population is ___ million. (3.5)', opts: ['three and a half','three point five','three and five','three-five'], ans: 'three and a half', hint: '3,5 → three and a half.' },
      { q: 'She ran the race in ___ minutes. (42)', opts: ['forty-two','forty two','fourty-two','forty-second'], ans: 'forty-two', hint: 'Dizaine + unité → trait d\'union (forty-two).' },
    ],
    [
      { q: 'The meeting is on the ___ of July. (4th)', opts: ['fourth','four','forty','fourteen'], ans: 'fourth', hint: 'four → fourth (ordinal).' },
      { q: '___ the students passed. (75%)', opts: ['Three quarters of','Three quarter of','The three quarters','Three-quarter'], ans: 'Three quarters of', hint: '3/4 → three quarters of.' },
      { q: 'It costs ___ pounds. (£12.50)', opts: ['twelve pounds fifty','twelve and fifty pence','twelve fifty pence','twelve-five pounds'], ans: 'twelve pounds fifty', hint: 'Prix → twelve pounds fifty.' },
      { q: 'He lives on the ___ floor. (12th)', opts: ['twelfth','twelft','twelve','twelve-th'], ans: 'twelfth', hint: 'twelve → twelfth (irrégulier).' },
      { q: 'The team won ___ . (3-1)', opts: ['three to one','three by one','three against one','three one'], ans: 'three to one', hint: 'Score → three to one.' },
      { q: 'She rang ___ times. (0)', opts: ['zero','nil','nought','oh'], ans: 'zero', hint: 'Zéro général → zero.' },
    ],
  ],
  'adjective-order': [
    [
      { q: 'She has ___ cat.', opts: ['a lovely small white','a small lovely white','a white small lovely','a lovely white small'], ans: 'a lovely small white', hint: 'Opinion → taille → couleur.' },
      { q: 'He wore ___ shoes.', opts: ['old brown leather','brown old leather','leather brown old','old leather brown'], ans: 'old brown leather', hint: 'Âge → couleur → matière.' },
      { q: 'She drove a ___ car.', opts: ['big red French','red big French','French big red','big French red'], ans: 'big red French', hint: 'Taille → couleur → origine.' },
      { q: 'They live in a ___ house.', opts: ['beautiful old stone','old beautiful stone','stone beautiful old','beautiful stone old'], ans: 'beautiful old stone', hint: 'Opinion → âge → matière.' },
      { q: 'He found a ___ coin.', opts: ['rare tiny gold','tiny rare gold','gold tiny rare','rare gold tiny'], ans: 'rare tiny gold', hint: 'Opinion → taille → matière.' },
      { q: 'I saw a ___ dog.', opts: ['large furry black','furry large black','black large furry','large black furry'], ans: 'large furry black', hint: 'Taille → qualificateur → couleur.' },
    ],
    [
      { q: 'She wore a ___ scarf.', opts: ['long blue silk','blue long silk','silk long blue','long silk blue'], ans: 'long blue silk', hint: 'Taille → couleur → matière.' },
      { q: 'He drives a ___ vehicle.', opts: ['powerful new Japanese','new powerful Japanese','Japanese powerful new','powerful Japanese new'], ans: 'powerful new Japanese', hint: 'Qualificateur → âge → origine.' },
      { q: 'We have a ___ table.', opts: ['round old wooden','old round wooden','wooden old round','round wooden old'], ans: 'round old wooden', hint: 'Forme → âge → matière.' },
      { q: 'She bought ___ earrings.', opts: ['beautiful small pearl','small beautiful pearl','pearl beautiful small','beautiful pearl small'], ans: 'beautiful small pearl', hint: 'Opinion → taille → matière.' },
      { q: 'He has a ___ building.', opts: ['massive old Victorian','old massive Victorian','Victorian massive old','massive Victorian old'], ans: 'massive old Victorian', hint: 'Taille → âge → style/origine.' },
      { q: 'They chose ___ fabric.', opts: ['an exquisite thin red Italian','a red thin exquisite Italian','a thin Italian red exquisite','an Italian exquisite red thin'], ans: 'an exquisite thin red Italian', hint: 'Opinion → taille → couleur → origine.' },
    ],
  ],
  'word-formation': [
    [
      { q: 'She showed great ___ in the competition. (strong)', opts: ['strength','strong','strongly','strongness'], ans: 'strength', hint: 'strong → strength (nom irrégulier).' },
      { q: 'It was ___ to hear such news. (shock)', opts: ['shocking','shocked','shockful','shockingly'], ans: 'shocking', hint: '-ing = source de choc → shocking.' },
      { q: 'He ___ the safety rules. (not obey)', opts: ['disobeyed','unobeyed','inobeyed','disbeyed'], ans: 'disobeyed', hint: 'dis- = contraire → disobeyed.' },
      { q: 'The project was a great ___. (succeed)', opts: ['success','succeeding','successful','succession'], ans: 'success', hint: 'succeed → success (nom).' },
      { q: 'She\'s a very ___ player. (skill)', opts: ['skilful','skilling','skilled','skillful'], ans: 'skilful', hint: '-ful = qui a → skilful (BrE).' },
      { q: 'This machine is very ___. (use)', opts: ['useful','usable','using','usely'], ans: 'useful', hint: '-ful → utile → useful.' },
    ],
    [
      { q: 'They reached an ___ after long talks. (agree)', opts: ['agreement','agreeing','agreed','agreeance'], ans: 'agreement', hint: 'agree → agreement (-ment = nom).' },
      { q: 'He was ___ of the risks. (aware)', opts: ['unaware','nonaware','disaware','misaware'], ans: 'unaware', hint: 'un- + aware = inconscient de.' },
      { q: 'Her ___ surprised everyone. (generous)', opts: ['generosity','generousness','generousity','generous'], ans: 'generosity', hint: 'generous → generosity.' },
      { q: 'The decision was ___. (reverse + not possible)', opts: ['irreversible','unversible','not reversible','disreversible'], ans: 'irreversible', hint: 'ir- + reversible = ne pouvant pas être annulé.' },
      { q: 'He gave a ___ answer. (thought)', opts: ['thoughtful','thinkful','thoughted','thought'], ans: 'thoughtful', hint: 'thought + -ful = réfléchi.' },
      { q: 'She spoke ___ at the ceremony. (emotion)', opts: ['emotionally','emotional','emotive','emotioned'], ans: 'emotionally', hint: 'emotion → emotional → emotionally.' },
    ],
  ],
  'deduction': [
    [
      { q: 'She passed all her exams. She ___ very hard.', opts: ['must have studied','might study','should study','could study'], ans: 'must have studied', hint: 'Déduction sur le passé (positive) → must have + pp.' },
      { q: 'He looks exhausted. He ___ slept well last night.', opts: ["can't have","must have",'should have','would have'], ans: "can't have", hint: 'Déduction négative sur le passé → can\'t have + pp.' },
      { q: 'She ___ be happy — she got the promotion.', opts: ['must','might','could','should'], ans: 'must', hint: 'Déduction certaine présent → must.' },
      { q: 'The lights are off. They ___ gone out.', opts: ['must have','can\'t have','might have','should have'], ans: 'must have', hint: 'Déduction sur passé (positive) → must have gone.' },
      { q: 'He ___ be a doctor — he can\'t stand the sight of blood.', opts: ["can't",'must','might','should'], ans: "can't", hint: 'Impossibilité logique présente → can\'t.' },
      { q: 'She ___ arrived by now — it\'s been two hours.', opts: ['must have','can\'t have','should have','might have'], ans: 'must have', hint: 'Déduction raisonnée → must have + pp.' },
    ],
    [
      { q: 'There\'s a light on upstairs. Someone ___ home.', opts: ['must be','might be','should be','would be'], ans: 'must be', hint: 'Preuve visible → déduction forte → must be.' },
      { q: 'He answered immediately. He ___ the email.', opts: ['must have seen','can\'t have seen','might have seen','should have seen'], ans: 'must have seen', hint: 'Réponse immédiate → déduction passée → must have seen.' },
      { q: 'That ___ be Sarah — she\'s in New York!', opts: ["can't",'must','might','could'], ans: "can't", hint: 'Impossibilité → can\'t be her.' },
      { q: 'Nobody answered. They ___ out.', opts: ['must be','can\'t be','might be','should be'], ans: 'must be', hint: 'Déduction présente → must be out.' },
      { q: 'The test was easy for everyone. She ___ passed.', opts: ['should have','must have','would have','could have'], ans: 'should have', hint: 'Aurait dû logiquement réussir → should have + pp.' },
      { q: 'He never misses it. He ___ forgotten.', opts: ["can't have",'must have','might have','should have'], ans: "can't have", hint: 'Déduction négative passée → can\'t have + pp.' },
    ],
  ],
  'emotions': [
    [
      { q: "'Reconnaissant' en anglais ?", opts: ['grateful','nervous','lonely','bored'], ans: 'grateful', hint: 'Reconnaissant → grateful.' },
      { q: "'Déçu' en anglais ?", opts: ['disappointed','surprised','scared','angry'], ans: 'disappointed', hint: 'Déçu → disappointed.' },
      { q: "She felt ___ before the interview. (nerveuse)", opts: ['nervous','proud','relaxed','amazed'], ans: 'nervous', hint: 'Nerveuse → nervous.' },
      { q: "I ___ better now, thanks. (se sentir)", opts: ['feel','am','look','seem'], ans: 'feel', hint: 'Se sentir → feel.' },
      { q: "'Gêné' en anglais ?", opts: ['embarrassed','confused','stressed','lonely'], ans: 'embarrassed', hint: 'Gêné → embarrassed.' },
      { q: "I must ___ — it's getting late. (partir)", opts: ['go now','go later','stay calm','try again'], ans: 'go now', hint: 'I must go now = je dois partir maintenant.' },
    ],
    [
      { q: "Let's ___ — we've been working for hours. (faire une pause)", opts: ['take a break','start now','try again','stay calm'], ans: 'take a break', hint: 'Faire une pause → take a break.' },
      { q: "'Motivé' en anglais ?", opts: ['motivated','amazed','relaxed','confused'], ans: 'motivated', hint: 'Motivé → motivated.' },
      { q: "I ___ my idea — it was a bad plan. (changer d'avis)", opts: ['changed','lost','forgot','kept'], ans: 'changed', hint: 'I changed my idea = j\'ai changé d\'avis.' },
      { q: "I can ___ — it makes sense. (comprendre)", opts: ['understand','decide','wait','learn'], ans: 'understand', hint: 'Je peux comprendre → I can understand.' },
      { q: "'Fatigué' en anglais ?", opts: ['tired','bored','sad','angry'], ans: 'tired', hint: 'Fatigué → tired (attention : bored = qui s\'ennuie).' },
      { q: "I ___ calm during the argument. (rester)", opts: ['stayed','felt','seemed','looked'], ans: 'stayed', hint: 'I stayed calm = je suis resté calme.' },
    ],
    [
      { q: "'Sans blague !' en anglais ?", opts: ['No way!','For real?','So what?','Go ahead!'], ans: 'No way!', hint: "Sans blague ! → No way!" },
      { q: "'Je n'arrive pas à y croire' en anglais ?", opts: ["I can't believe it","I'm shocked","No way","What a surprise"], ans: "I can't believe it", hint: "Je n'arrive pas à y croire → I can't believe it." },
      { q: "'Tu plaisantes !' en anglais ?", opts: ["You're joking!","No way!","Unbelievable!","For real?"], ans: "You're joking!", hint: "Tu plaisantes ! → You're joking!" },
      { q: "'Je suis bouche bée' en anglais ?", opts: ["I'm speechless","I'm shocked","I'm amazed","I can't believe it"], ans: "I'm speechless", hint: "Je suis bouche bée → I'm speechless." },
      { q: "'C'est dingue !' en anglais ?", opts: ["That's crazy!","No way!","Unbelievable!","What a surprise!"], ans: "That's crazy!", hint: "C'est dingue ! → That's crazy!" },
      { q: "'Incroyable !' en anglais ?", opts: ['Unbelievable!','Incredible!','Amazing!','No way!'], ans: 'Unbelievable!', hint: "Incroyable ! → Unbelievable!" },
    ],
    [
      { q: "'Mon Dieu !' en anglais ?", opts: ['Oh my God!','Oh my Gosh!','My God!','Good Lord!'], ans: 'Oh my God!', hint: "Mon Dieu ! → Oh my God!" },
      { q: "'Tu te moques de moi ?' en anglais ?", opts: ['Are you kidding me?','Are you joking me?','You mock me?','Is this a joke?'], ans: 'Are you kidding me?', hint: "Tu te moques de moi ? → Are you kidding me?" },
      { q: "'C'est hallucinant !' en anglais ?", opts: ["That's mind-blowing!","That's amazing!","That's incredible!","That's unreal!"], ans: "That's mind-blowing!", hint: "C'est hallucinant ! → That's mind-blowing!" },
      { q: "'Je suis sans voix' en anglais ?", opts: ["I'm at a loss for words","I'm speechless","I've lost my voice","I can't speak"], ans: "I'm at a loss for words", hint: "Je suis sans voix → I'm at a loss for words." },
      { q: "'Je n'en crois pas mes yeux' en anglais ?", opts: ["I can't believe my eyes","I don't trust my eyes","I can't see it","My eyes can't believe"], ans: "I can't believe my eyes", hint: "Je n'en crois pas mes yeux → I can't believe my eyes." },
      { q: "'Je n'ai jamais vu ça !' en anglais ?", opts: ["I've never seen that before!","I never saw that!","I haven't seen this!","Never seen before!"], ans: "I've never seen that before!", hint: "Je n'ai jamais vu ça ! → I've never seen that before!" },
    ],
  ],
  'daily-phrases': [
    [
      { q: "Je ne comprends pas. → I ___ get it.", opts: ["don't","can't","won't","didn't"], ans: "don't", hint: "I don't get it = je ne comprends pas." },
      { q: "Et maintenant ? → What ___?", opts: ['now','next','then','after'], ans: 'now', hint: 'What now? = et maintenant ?' },
      { q: "C'est bizarre. → That's ___.", opts: ['weird','wrong','funny','strange'], ans: 'weird', hint: "That's weird = c'est bizarre." },
      { q: "J'ai besoin d'une pause. → I need a ___.", opts: ['break','rest','stop','pause'], ans: 'break', hint: 'I need a break = j\'ai besoin d\'une pause.' },
      { q: "Je jure. → I ___.", opts: ['swear','promise','vow','say'], ans: 'swear', hint: 'I swear = je jure.' },
      { q: "C'est drôle. → That's ___.", opts: ['funny','weird','silly','nice'], ans: 'funny', hint: "That's funny = c'est drôle." },
    ],
    [
      { q: "Je suis prêt. → I'm all ___.", opts: ['set','done','good','ready'], ans: 'set', hint: "I'm all set = je suis prêt." },
      { q: "Je vais y réfléchir. → I'll ___ about it.", opts: ['think','talk','ask','read'], ans: 'think', hint: "I'll think about it = je vais y réfléchir." },
      { q: "C'est fini. → I'm ___.", opts: ['done','over','finished','complete'], ans: 'done', hint: "I'm done = c'est fini / j'ai terminé." },
      { q: "C'est faux. → That's ___.", opts: ['wrong','bad','false','incorrect'], ans: 'wrong', hint: "That's wrong = c'est faux." },
      { q: "Peut-être. → ___.", opts: ['Maybe','Perhaps','Probably','Possibly'], ans: 'Maybe', hint: 'Peut-être → Maybe (ou Perhaps).' },
      { q: "Je reviens tout de suite. → I'll be right ___.", opts: ['back','here','there','soon'], ans: 'back', hint: "I'll be right back = je reviens tout de suite." },
    ],
    [
      { q: "'Quoi de neuf ?' en anglais ?", opts: ["What's up?","No worries","Let's go","For sure"], ans: "What's up?", hint: "Quoi de neuf ? → What's up?" },
      { q: "'Ça roule' en anglais ?", opts: ["It's all good","We'll see","Got it","Go ahead"], ans: "It's all good", hint: "Ça roule → It's all good." },
      { q: "'Laisse tomber' en anglais ?", opts: ["Never mind","Totally","Alright","Catch you later"], ans: "Never mind", hint: "Laisse tomber → Never mind." },
      { q: "'C'est parti' en anglais ?", opts: ["Let's go","Go ahead","That's clear","It's possible"], ans: "Let's go", hint: "C'est parti → Let's go." },
      { q: "'À tout à l'heure' en anglais ?", opts: ["Catch you later","We'll see","No worries","For sure"], ans: "Catch you later", hint: "À tout à l'heure → Catch you later." },
      { q: "'D'accord' en anglais ?", opts: ["Alright","Totally","Got it","I got this"], ans: "Alright", hint: "D'accord → Alright." },
    ],
    [
      { q: "'En fait' en anglais ?", opts: ['Actually','Generally','Anyway','However'], ans: 'Actually', hint: "En fait → Actually." },
      { q: "'En résumé' en anglais ?", opts: ['To sum up','To be honest','Not to mention','In other words'], ans: 'To sum up', hint: "En résumé → To sum up." },
      { q: "'De toute façon' en anglais ?", opts: ['Anyway','Meanwhile','Instead','Therefore'], ans: 'Anyway', hint: "De toute façon → Anyway." },
      { q: "'Tu peux répéter ?' en anglais ?", opts: ['Say that again?','What do you mean?','Is that all?','Why not?'], ans: 'Say that again?', hint: "Tu peux répéter ? → Say that again?" },
      { q: "'À la prochaine' en anglais ?", opts: ['Until next time','Take it easy','Have a good one','Good night'], ans: 'Until next time', hint: "À la prochaine → Until next time." },
      { q: "'Ça me va' en anglais ?", opts: ['Works for me','I got it','No problem','Right away'], ans: 'Works for me', hint: "Ça me va → Works for me." },
    ],
  ],
  'key-verbs': [
    [
      { q: "'Livrer' en anglais ?", opts: ['deliver','avoid','deny','plan'], ans: 'deliver', hint: 'Livrer → deliver.' },
      { q: "'Blâmer' en anglais ?", opts: ['blame','boost','commit','compare'], ans: 'blame', hint: 'Blâmer → blame.' },
      { q: "'Découvrir' en anglais ?", opts: ['discover','deny','deliver','encourage'], ans: 'discover', hint: 'Découvrir → discover.' },
      { q: "'Assurer' en anglais ?", opts: ['ensure','offer','ignore','identify'], ans: 'ensure', hint: 'Assurer → ensure.' },
      { q: "'Planifier' en anglais ?", opts: ['plan','praise','push','provide'], ans: 'plan', hint: 'Planifier → plan.' },
      { q: "'Se plaindre' en anglais ?", opts: ['complain','compare','commit','consider'], ans: 'complain', hint: 'Se plaindre → complain.' },
    ],
    [
      { q: "'Stimuler' en anglais ?", opts: ['boost','blame','build','break'], ans: 'boost', hint: 'Stimuler → boost.' },
      { q: "'Défier' en anglais ?", opts: ['challenge','confirm','consider','convince'], ans: 'challenge', hint: 'Défier → challenge.' },
      { q: "'Nier' en anglais ?", opts: ['deny','deliver','discover','decide'], ans: 'deny', hint: 'Nier → deny.' },
      { q: "'Identifier' en anglais ?", opts: ['identify','ignore','involve','imagine'], ans: 'identify', hint: 'Identifier → identify.' },
      { q: "'Encourager' en anglais ?", opts: ['encourage','ensure','examine','evaluate'], ans: 'encourage', hint: 'Encourager → encourage.' },
      { q: "'Comparer' en anglais ?", opts: ['compare','confirm','consider','commit'], ans: 'compare', hint: 'Comparer → compare.' },
    ],
  ],
  'native-expressions': [
    [
      { q: "Que signifie 'Kind of' ?", opts: ['Un peu / plutôt','En fait','Ça dépend','Laisse tomber'], ans: 'Un peu / plutôt', hint: "Kind of = Un peu / plutôt (adoucir une affirmation)." },
      { q: "Que signifie 'To be honest' ?", opts: ['Honnêtement','En gros','En fait','Attends'], ans: 'Honnêtement', hint: "To be honest = Honnêtement." },
      { q: "Que signifie 'That makes sense' ?", opts: ["C'est logique",'Ça dépend','Laisse tomber','Attends'], ans: "C'est logique", hint: "That makes sense = C'est logique / Je comprends." },
      { q: "Que signifie 'I mean...' ?", opts: ['Je veux dire...','En fait','En gros','Honnêtement'], ans: 'Je veux dire...', hint: "I mean... = Je veux dire... (clarifier sa pensée)." },
      { q: "Comment dire 'En fait' en anglais ?", opts: ['Actually','Basically','Honestly','Never mind'], ans: 'Actually', hint: "En fait → Actually." },
      { q: "Comment dire 'En gros' en anglais ?", opts: ['Basically','Actually','Kind of','Fair enough'], ans: 'Basically', hint: "En gros → Basically." },
    ],
    [
      { q: "Compléter : '___, I don't agree.' (En fait...)", opts: ['Actually','Basically','Never mind','Hang on'], ans: 'Actually', hint: "Actually = En fait, pour corriger ou nuancer." },
      { q: "Compléter : '___, it's a bit complicated.' (En gros...)", opts: ['Basically','Actually','Fair enough','Kind of'], ans: 'Basically', hint: "Basically = En gros, pour résumer." },
      { q: "Compléter : '___, let me check.' (Attends...)", opts: ['Hang on','Never mind','Actually','Fair enough'], ans: 'Hang on', hint: "Hang on = Attends une seconde." },
      { q: "Compléter : '___, let's do it your way.' (C'est juste...)", opts: ['Fair enough','Never mind','Actually','Hang on'], ans: 'Fair enough', hint: "Fair enough = C'est juste / D'accord." },
      { q: "Comment dire 'Ça dépend de toi.' ?", opts: ['It depends on you','It depends you','Depends of you','You depend on it'], ans: 'It depends on you', hint: "It depends on + personne/situation." },
      { q: "Comment dire 'Tu vois ce que je veux dire ?' ?", opts: ['You know what I mean?','You understand my mean?','You get my idea?','You know what I say?'], ans: 'You know what I mean?', hint: "You know what I mean? = expression idiomatique." },
    ],
  ],
  'it-structures': [
    [
      { q: "It's worth ___ (demander)", opts: ['asking','to ask','ask','asked'], ans: 'asking', hint: "It's worth + gérondif (V-ing)." },
      { q: "It's no use ___ (se plaindre)", opts: ['complaining','to complain','complain','complained'], ans: 'complaining', hint: "It's no use + gérondif (V-ing)." },
      { q: "It's time ___ (être honnête)", opts: ['to be honest','being honest','be honest','been honest'], ans: 'to be honest', hint: "It's time to + infinitif." },
      { q: "Traduction : 'C'est à elle de décider.'", opts: ["It's up to her to decide","It's up to she to decide","It's worth her deciding","It's her time to decide"], ans: "It's up to her to decide", hint: "It's up to + personne + to + infinitif." },
      { q: "Traduction : 'Il est temps de passer à autre chose.'", opts: ["It's time to move on","It's worth moving on","It's no use moving on","It's up to you to move"], ans: "It's time to move on", hint: "Il est temps de → It's time to + infinitif." },
      { q: "Traduction : 'Ça vaut la peine d'y réfléchir.'", opts: ["It's worth thinking about","It's time to think about","It's no use thinking","It's up to think about"], ans: "It's worth thinking about", hint: "Ça vaut la peine → It's worth + V-ing." },
    ],
    [
      { q: "It's worth ___ (chaque centime)", opts: ['every penny','to every penny','for every penny','of every penny'], ans: 'every penny', hint: "It's worth + nom aussi possible (not just V-ing)." },
      { q: "Choisir la bonne structure : 'Il est temps de prendre une décision.'", opts: ["It's time to make a decision","It's worth making a decision","It's no use making a decision","It's up to make a decision"], ans: "It's time to make a decision", hint: "Il est temps de → It's time to + infinitif." },
      { q: "Choisir la bonne structure : 'Ça ne sert à rien de se disputer.'", opts: ["It's no use arguing","It's worth arguing","It's time to argue","It's up to argue"], ans: "It's no use arguing", hint: "Ça ne sert à rien → It's no use + V-ing." },
      { q: "Choisir la bonne structure : 'C'est à eux de choisir.'", opts: ["It's up to them to choose","It's up to they to choose","It's no use them choosing","It's worth them choosing"], ans: "It's up to them to choose", hint: "It's up to + pronom tonique + to + infinitif." },
      { q: "Traduction : 'Ça vaut la peine d'essayer.'", opts: ["It's worth trying","It's time trying","It's no use to try","It's up to try"], ans: "It's worth trying", hint: "Ça vaut la peine → It's worth + V-ing." },
      { q: "Traduction : 'Ça ne sert à rien d'attendre.'", opts: ["It's no use waiting","It's worth waiting","It's time to wait","It's up to wait"], ans: "It's no use waiting", hint: "Ça ne sert à rien → It's no use + V-ing." },
    ],
  ],
  'refusal-expressions': [
    [
      { q: "Comment dire 'Je ne veux pas' ?", opts: ["I don't want to","I won't want","I can't want","I don't like to"], ans: "I don't want to", hint: "Je ne veux pas → I don't want to." },
      { q: "Comment dire 'Je n'ai pas le temps' ?", opts: ["I don't have time","I have no times","I'm out of times","I missing time"], ans: "I don't have time", hint: "Pas le temps → I don't have time." },
      { q: "Comment dire 'Désolé, je suis occupé' ?", opts: ["Sorry, I'm busy","Sorry, I'm bored","Sorry, I'm taken","Sorry, I'm missing"], ans: "Sorry, I'm busy", hint: "Je suis occupé → I'm busy." },
      { q: "Comment dire 'Je ne pense pas' (refus poli) ?", opts: ["I don't think so","I'm not thinking","I don't believe","I can't think"], ans: "I don't think so", hint: "Je ne pense pas → I don't think so." },
      { q: "Comment dire 'C'est pas possible' ?", opts: ["It's not possible","It's impossible to","It can't possible","That's no possible"], ans: "It's not possible", hint: "C'est pas possible → It's not possible." },
      { q: "Comment dire 'Je vais décliner' (soutenu) ?", opts: ["I'll pass","I'll decline it","I pass away","I won't accept"], ans: "I'll pass", hint: "Je vais décliner / passer → I'll pass." },
    ],
    [
      { q: "Traduction : 'Non, merci — ça va.'", opts: ["No, thanks — I'm fine","No, thank — I'm okay","Not, thanks — I fine","No thanks — I'm good it"], ans: "No, thanks — I'm fine", hint: "Non merci → No, thanks." },
      { q: "Traduction : 'Je suis pris ce soir.'", opts: ["I'm taken tonight","I'm busy tonight","I'm not free tonight","I'm occupied tonight"], ans: "I'm taken tonight", hint: "Je suis pris → I'm taken (informal)." },
      { q: "Compléter : 'Sorry, ___ right now.' (je suis occupé)", opts: ["I'm busy","I'm taken","I can't","I'm not free"], ans: "I'm busy", hint: "Occupé → busy." },
      { q: "Compléter : '___ — maybe next time.' (peut-être une autre fois)", opts: ["Maybe another time","Not this time maybe","Another time perhaps","Maybe some time"], ans: "Maybe another time", hint: "Peut-être une autre fois → Maybe another time." },
      { q: "Traduction : 'C'est pas vraiment pour moi.'", opts: ["It's not really for me","It's not really mine","It's really not me","It really isn't about me"], ans: "It's not really for me", hint: "Pas pour moi → not for me." },
      { q: "Traduction : 'Je suis désolé, je ne peux pas venir.'", opts: ["I'm sorry, I can't make it","I'm sorry, I won't come","I'm sorry, I don't come","I'm sorry, I'm not coming"], ans: "I'm sorry, I can't make it", hint: "Je ne peux pas venir → I can't make it (idiomatique)." },
    ],
  ],
  'polite-refusals': [
    [
      { q: "Comment dire 'Je n'en ai pas vraiment envie' ?", opts: ["I'm not really up for it","I don't really want it","I'm not really into it","I don't really feel it"], ans: "I'm not really up for it", hint: "Pas vraiment envie → not really up for it." },
      { q: "Comment dire 'Merci d'avoir pensé à moi, mais...' ?", opts: ["Thanks for thinking of me, but...","Thanks to think of me, but...","Thank you to thought of me...","Thanks for your thinking, but..."], ans: "Thanks for thinking of me, but...", hint: "Merci d'avoir pensé à moi → Thanks for thinking of me." },
      { q: "Traduction : 'Ça ne m'arrange pas, désolé.'", opts: ["That doesn't work for me, sorry.","That's not my problem, sorry.","That doesn't help me, sorry.","That won't work, I'm sorry."], ans: "That doesn't work for me, sorry.", hint: "Ça ne m'arrange pas → That doesn't work for me." },
      { q: "Compléter : 'I'd love ___, but I've got plans.'", opts: ["to","doing it","that","it"], ans: "to", hint: "I'd love to (infinitif sous-entendu)." },
      { q: "Compléter : 'I'm ___ I can't make it.' (très poli)", opts: ["afraid","sorry","scared","worried"], ans: "afraid", hint: "I'm afraid I can't = formule très polie." },
      { q: "Traduction : 'Je préfèrerais pas, si ça ne te dérange pas.'", opts: ["I'd rather not, if that's okay.","I prefer not, if it's okay.","I don't want to, if okay.","Rather not, if that's fine."], ans: "I'd rather not, if that's okay.", hint: "I'd rather not = forme conditionnelle polie." },
    ],
    [
      { q: "Quelle formule montre un regret sincère ?", opts: ["I'd love to, but...","I can't, no.","Not possible.","I don't want to."], ans: "I'd love to, but...", hint: "I'd love to, but... exprime un regret sincère avant de refuser." },
      { q: "Quelle formule est la plus formelle ?", opts: ["I'm afraid I can't","I'd rather not","I'm not up for it","I'll pass"], ans: "I'm afraid I can't", hint: "I'm afraid I can't = plus formel et poli." },
      { q: "Compléter : 'I'm going to ___ this one out.'", opts: ["sit","pass","skip","leave"], ans: "sit", hint: "Sit this one out = expression idiomatique pour passer son tour." },
      { q: "Traduction : 'J'adorerais, mais j'ai déjà quelque chose de prévu.'", opts: ["I'd love to, but I've already got plans.","I would love but I have plans.","I'd loved to but got plans.","I love to, but I've plans."], ans: "I'd love to, but I've already got plans.", hint: "I'd love to, but... + I've already got plans." },
      { q: "Que signifie 'sit this one out' ?", opts: ['Passer son tour','Rester assis','Quitter la pièce','Ignorer quelqu\'un'], ans: 'Passer son tour', hint: "To sit out = ne pas participer cette fois." },
      { q: "Traduction : 'Merci d'avoir pensé à moi, mais je vais passer mon tour.'", opts: ["Thanks for thinking of me, but I'm going to sit this one out.","Thanks to think of me but I pass my turn.","Thank you for me, but I'll sit out.","Thanks thinking of me, but I sit this out."], ans: "Thanks for thinking of me, but I'm going to sit this one out.", hint: "Thanks for thinking of me + sit this one out." },
    ],
  ],
  'everyday-expressions': [
    [
      { q: "Comment dire 'Je n'en ai pas envie' ?", opts: ["I don't feel like it","I don't want it","I'm not into it","I don't like it"], ans: "I don't feel like it", hint: "Je n'en ai pas envie → I don't feel like it." },
      { q: "Comment dire 'Comme tu veux' ?", opts: ["As you wish","As you want","Like you want","Whatever you say"], ans: "As you wish", hint: "Comme tu veux → As you wish." },
      { q: "Comment dire 'À quoi bon ?' ?", opts: ["Why bother?","Why try?","What's the point?","Why care?"], ans: "Why bother?", hint: "À quoi bon ? → Why bother?" },
      { q: "Comment dire 'Que veux-tu dire ?' ?", opts: ["What do you mean?","What are you saying?","What do you say?","What do you want to say?"], ans: "What do you mean?", hint: "Que veux-tu dire ? → What do you mean?" },
      { q: "Comment dire 'Bien sûr' (informal) ?", opts: ["For sure","Of course","Certainly","Absolutely"], ans: "For sure", hint: "Bien sûr → For sure (familier et naturel)." },
      { q: "Comment dire 'Pas du tout' ?", opts: ["Not at all","Not really","Never","Not ever"], ans: "Not at all", hint: "Pas du tout → Not at all." },
    ],
    [
      { q: "Compléter : '___ — the floor is wet!' (Fais attention)", opts: ["Watch out","Look there","Take care","Be safe"], ans: "Watch out", hint: "Fais attention → Watch out." },
      { q: "Compléter : '___ — I don't have to explain myself.' (Comme tu veux)", opts: ["As you wish","If you like","Whatever","As you want"], ans: "As you wish", hint: "As you wish = comme tu veux (légèrement formel)." },
      { q: "Traduction : 'Prends ton temps, ce n'est pas pressé.'", opts: ["Take your time, there's no rush.","Take the time, no hurry.","Have your time, no rush.","Keep calm, no hurry."], ans: "Take your time, there's no rush.", hint: "Prends ton temps → Take your time + there's no rush." },
      { q: "Traduction : 'Ça ne me dérange pas du tout.'", opts: ["I don't mind at all.","I don't care at all.","It's fine by me all.","I really don't care."], ans: "I don't mind at all.", hint: "I don't mind + at all pour renforcer." },
      { q: "Que signifie 'Why bother?' dans ce contexte : 'Why bother learning if you won't practice?' ?", opts: ['À quoi bon','Pourquoi essayer','Pour quelle raison','Comment savoir'], ans: 'À quoi bon', hint: "Why bother = à quoi bon (sentiment de futilité)." },
      { q: "Traduction : 'C'est parti — on commence !'", opts: ["Here we go — let's start!","We go — let's begin!","Here we start — let's go!","Off we are — starting!"], ans: "Here we go — let's start!", hint: "C'est parti → Here we go." },
    ],
    [
      { q: "Comment dire 'Tiens bon !' ?", opts: ["Hang in there!","Hold on tight!","Stay strong!","Keep it up!"], ans: "Hang in there!", hint: "Tiens bon ! → Hang in there!" },
      { q: "Comment dire 'C'est ma faute !' ?", opts: ["My bad!","My fault!","It's my fault!","I'm wrong!"], ans: "My bad!", hint: "C'est ma faute ! → My bad! (très familier)." },
      { q: "Comment dire 'Je plaisante !' ?", opts: ["Just kidding!","I'm joking!","It's a joke!","Only joking!"], ans: "Just kidding!", hint: "Je plaisante ! → Just kidding! (plus courant que I'm joking)." },
      { q: "Comment dire 'Quand on parle du loup !' ?", opts: ["Speak of the devil!","Talk of the devil!","Here comes trouble!","What a coincidence!"], ans: "Speak of the devil!", hint: "Quand on parle du loup → Speak of the devil!" },
      { q: "'Hang in there' correspond à quel sentiment ?", opts: ['Encouragement','Surprise','Colère','Regret'], ans: 'Encouragement', hint: "Hang in there = tiens bon — c'est une expression d'encouragement." },
      { q: "'My bad' s'utilise pour exprimer…", opts: ['Une excuse rapide','Un compliment','Un remerciement','Une question'], ans: 'Une excuse rapide', hint: "My bad = c'est ma faute — excuser de façon informelle." },
    ],
  ],
  'compliments': [
    [
      { q: "Comment dire 'Tu as un beau sourire' ?", opts: ["You have a beautiful smile","You have a nice smile","Your smile is beautiful","You smile beautifully"], ans: "You have a beautiful smile", hint: "Tu as un beau sourire → You have a beautiful smile." },
      { q: "Comment dire 'Ta coupe de cheveux te va très bien' ?", opts: ["Your haircut looks great","Your haircut is great","Your hair looks great","Your haircut suits you"], ans: "Your haircut looks great", hint: "Te va très bien → looks great (sans 'on you' ici)." },
      { q: "Comment dire 'Tu t'habilles toujours très bien' ?", opts: ["You always dress so well","You always wear so well","You always look so well","You always dress very good"], ans: "You always dress so well", hint: "Tu t'habilles bien → you dress well." },
      { q: "Comment dire 'Tu es très soigné(e)' ?", opts: ["You look so neat and clean","You look very tidy","You look well-groomed","You appear very clean"], ans: "You look so neat and clean", hint: "Soigné → neat and clean." },
      { q: "Comment dire 'Tu as l'air très confiant(e)' ?", opts: ["You look very confident","You seem very confident","You appear very confident","You are very confident"], ans: "You look very confident", hint: "Tu as l'air → You look (apparence perçue)." },
      { q: "Comment dire 'Tu es éblouissant(e) ce soir' ?", opts: ["You look stunning tonight","You look amazing tonight","You're gorgeous tonight","You look brilliant tonight"], ans: "You look stunning tonight", hint: "Éblouissant → stunning (très fort comme compliment)." },
    ],
    [
      { q: "Comment dire 'Tu as de beaux yeux' ?", opts: ["You have beautiful eyes","Your eyes are beautiful","You've got nice eyes","Your eyes look beautiful"], ans: "You have beautiful eyes", hint: "Tu as de beaux yeux → You have beautiful eyes." },
      { q: "Comment dire 'Tu es vraiment beau' ?", opts: ["You look really handsome","You're really handsome","You look very handsome","You seem really handsome"], ans: "You look really handsome", hint: "Vraiment beau → really handsome (pour un homme)." },
      { q: "Comment dire 'Tu es vraiment jolie' ?", opts: ["You look really pretty","You're really pretty","You look so pretty","You seem really pretty"], ans: "You look really pretty", hint: "Vraiment jolie → really pretty (pour une femme)." },
      { q: "Traduction : 'J'adore ton style — tu l'as trouvé où ?'", opts: ["I love your style — where did you get that?","I like your style — where you found it?","I love your style — where is it from?","I adore your style — from where?"], ans: "I love your style — where did you get that?", hint: "Where did you get that? = tu l'as trouvé où ?" },
      { q: "Traduction : 'Cette couleur te va très bien !'", opts: ["That color looks great on you!","That color is perfect on you!","This color looks amazing on you!","That color suits you perfectly!"], ans: "That color looks great on you!", hint: "Te va bien → looks great on you." },
      { q: "Traduction : 'Tu rayonnes — tu as l'air tellement heureuse !'", opts: ["You're glowing — you look so happy!","You're shining — you look so glad!","You glow — you appear so happy!","You're glowing — you're so happy!"], ans: "You're glowing — you look so happy!", hint: "You're glowing + you look so happy." },
    ],
  ],
  'practical-phrases': [
    [
      { q: "Comment dire 'C'est suffisant' ?", opts: ["That's enough","It's sufficient","That's sufficient","It's enough"], ans: "That's enough", hint: "C'est suffisant → That's enough." },
      { q: "Comment dire 'Je ne comprends toujours pas' ?", opts: ["I still don't understand","I still can't understand","I don't understand yet","I never understand"], ans: "I still don't understand", hint: "Toujours pas → still don't." },
      { q: "Comment dire 'Je ne peux pas décider' ?", opts: ["I can't decide","I cannot decide it","I'm unable to decide","I don't decide"], ans: "I can't decide", hint: "Je ne peux pas décider → I can't decide." },
      { q: "Comment dire 'C'est une bonne idée' ?", opts: ["That's a good idea","It's a good idea","This is a good idea","That's great idea"], ans: "That's a good idea", hint: "C'est une bonne idée → That's a good idea." },
      { q: "Comment dire 'Je veux savoir pourquoi' ?", opts: ["I want to know why","I want to know the why","I'd like to know why","I need to know why"], ans: "I want to know why", hint: "Je veux savoir pourquoi → I want to know why." },
      { q: "Comment dire 'Je suis disponible' ?", opts: ["I'm available","I'm free","I'm open","I'm ready"], ans: "I'm available", hint: "Je suis disponible → I'm available." },
    ],
    [
      { q: "Comment dire 'Je dois trouver une solution' ?", opts: ["I need to find a solution","I must find a solution","I have to find a solution","I need to solve this"], ans: "I need to find a solution", hint: "Je dois → I need to (plus naturel qu'I must)." },
      { q: "Comment dire 'Je n'ai rien à dire' ?", opts: ["I have nothing to say","I have nothing to tell","I don't have anything to say","I've nothing to say"], ans: "I have nothing to say", hint: "Je n'ai rien à dire → I have nothing to say." },
      { q: "Comment dire 'C'est évident' ?", opts: ["It's obvious","It's evident","It's clear","It's certain"], ans: "It's obvious", hint: "C'est évident → It's obvious." },
      { q: "Traduction : 'Je suis bloqué — tu peux m'aider ?'", opts: ["I'm stuck — can you help me?","I'm blocked — can you help?","I'm frozen — help me?","I'm stuck — help me please?"], ans: "I'm stuck — can you help me?", hint: "Bloqué → stuck + can you help me?" },
      { q: "Traduction : 'Je ne veux pas attendre.'", opts: ["I don't want to wait","I won't wait","I don't want waiting","I can't wait"], ans: "I don't want to wait", hint: "Je ne veux pas + attendre → don't want to + wait." },
      { q: "Traduction : 'Je suis de retour ! J'ai raté quelque chose ?'", opts: ["I'm back! Did I miss anything?","I'm back! Did I miss something?","I returned! Miss anything?","I'm back! Have I missed anything?"], ans: "I'm back! Did I miss anything?", hint: "I'm back + Did I miss anything? (prétérit)." },
    ],
  ],
  'use-of-else': [
    [
      { q: "Compléter : 'Ask ___ — I don't know.' (quelqu'un d'autre)", opts: ["someone else","anyone else","somebody other","another one"], ans: "someone else", hint: "Quelqu'un d'autre → someone else." },
      { q: "Compléter : '___ could they be?' (Où d'autre)", opts: ["Where else","What else","Who else","How else"], ans: "Where else", hint: "Où d'autre → where else." },
      { q: "Compléter : '___ was present at the meeting?' (Qui d'autre)", opts: ["Who else","What else","Whoever else","Which else"], ans: "Who else", hint: "Qui d'autre → who else." },
      { q: "Compléter : 'Hurry up, ___ we'll miss the bus.' (sinon)", opts: ["or else","if not","otherwise","or other"], ans: "or else", hint: "Sinon (conséquence) → or else." },
      { q: "Compléter : 'Everything ___ is closed.' (tout le reste)", opts: ["else","other","more","another"], ans: "else", hint: "Everything else = tout le reste." },
      { q: "Compléter : 'Is there ___ I can do?' (autre chose)", opts: ["anything else","something else","nothing else","everything else"], ans: "anything else", hint: "En question → anything else." },
    ],
    [
      { q: "Choisir la bonne phrase : 'Je ne veux rien d'autre.'", opts: ["I want nothing else.","I want anything else.","I don't want something else.","I need nothing other."], ans: "I want nothing else.", hint: "Rien d'autre → nothing else." },
      { q: "Compléter : '___ would he go to the bakery?' (Sinon pourquoi)", opts: ["Why else","How else","What else","Who else"], ans: "Why else", hint: "Pourquoi d'autre / Sinon pourquoi → why else." },
      { q: "Compléter : '___ could he have entered?' (Comment d'autre)", opts: ["How else","What else","Where else","Why else"], ans: "How else", hint: "Comment d'autre → how else." },
      { q: "Choisir la bonne phrase : 'Tout le monde d'autre est parti.'", opts: ["Everyone else had gone.","All else has gone.","Everybody other left.","Everyone other went."], ans: "Everyone else had gone.", hint: "Tout le monde d'autre → everyone else." },
      { q: "Choisir la bonne phrase : 'Personne d'autre n'était là.'", opts: ["Nobody else was there.","No one other was there.","Nobody other was present.","No else was there."], ans: "Nobody else was there.", hint: "Personne d'autre → nobody else." },
      { q: "Traduction : 'On mange ce qu'on trouve, sinon on fait les courses.'", opts: ["We eat what we find, or else we go shopping.","We eat what we find, if not we shop.","We eat what we find, otherwise else we shop.","We eat whatever, or else go shopping."], ans: "We eat what we find, or else we go shopping.", hint: "Sinon → or else." },
    ],
  ],
  'do-you-questions': [
    [
      { q: "'Tu veux boire ?' en anglais ?", opts: ['Do you want to drink?','Do you want water?','Are you thirsty?','Do you want to eat?'], ans: 'Do you want to drink?', hint: "Tu veux boire ? → Do you want to drink?" },
      { q: "'Tu veux venir ?' en anglais ?", opts: ['Do you want to come?','Do you want to go?','Will you come?','Are you coming?'], ans: 'Do you want to come?', hint: "Tu veux venir ? → Do you want to come?" },
      { q: "'Tu aimes le café ?' en anglais ?", opts: ['Do you like coffee?','Do you want coffee?','Do you drink coffee?','Do you enjoy coffee?'], ans: 'Do you like coffee?', hint: "Tu aimes le café ? → Do you like coffee?" },
      { q: "'Tu comprends ?' en anglais ?", opts: ['Do you understand?','Do you follow?','Do you know?','Can you understand?'], ans: 'Do you understand?', hint: "Tu comprends ? → Do you understand?" },
      { q: "'Tu vas où ?' en anglais ?", opts: ['Where are you going?','Where do you go?','Where are you?','Where will you go?'], ans: 'Where are you going?', hint: "Tu vas où ? → Where are you going?" },
      { q: "'Tu es fatigué(e) ?' en anglais ?", opts: ['Are you tired?','Are you sleepy?','Do you feel tired?','Are you exhausted?'], ans: 'Are you tired?', hint: "Tu es fatigué(e) ? → Are you tired?" },
    ],
    [
      { q: "'Tu veux apprendre ?' en anglais ?", opts: ['Do you want to learn?','Do you want to study?','Do you want to know?','Do you want to understand?'], ans: 'Do you want to learn?', hint: "Tu veux apprendre ? → Do you want to learn?" },
      { q: "'Tu as besoin d'aide ?' en anglais ?", opts: ['Do you need help?','Do you want help?','Can I help you?','Do you need support?'], ans: 'Do you need help?', hint: "Tu as besoin d'aide ? → Do you need help?" },
      { q: "'Tu viens quand ?' en anglais ?", opts: ['When are you coming?','When will you come?','When do you come?','When are you arriving?'], ans: 'When are you coming?', hint: "Tu viens quand ? → When are you coming?" },
      { q: "'Tu es heureux/heureuse ?' en anglais ?", opts: ['Are you happy?','Are you glad?','Are you joyful?','Do you feel happy?'], ans: 'Are you happy?', hint: "Tu es heureux/heureuse ? → Are you happy?" },
      { q: "'Tu es d'accord ?' en anglais ?", opts: ['Do you agree?','Are you okay?','Do you accept?','Is that fine?'], ans: 'Do you agree?', hint: "Tu es d'accord ? → Do you agree?" },
      { q: "'Pourquoi tu es triste ?' en anglais ?", opts: ['Why are you sad?','Why are you upset?','Why do you feel sad?','What makes you sad?'], ans: 'Why are you sad?', hint: "Pourquoi tu es triste ? → Why are you sad?" },
    ],
  ],
  'essential-sentences': [
    [
      { q: "'Parle plus lentement' en anglais ?", opts: ['Speak more slowly','Talk slower','Slow your speech','Speak slowly please'], ans: 'Speak more slowly', hint: "Parle plus lentement → Speak more slowly." },
      { q: "'Écris-le' en anglais ?", opts: ['Write it down','Write it','Note it down','Put it in writing'], ans: 'Write it down', hint: "Écris-le → Write it down." },
      { q: "'Viens avec moi' en anglais ?", opts: ['Come with me','Follow me','Walk with me','Come along'], ans: 'Come with me', hint: "Viens avec moi → Come with me." },
      { q: "'Je suis en retard' en anglais ?", opts: ["I'm late","I'm delayed","I'm behind","I'm slow"], ans: "I'm late", hint: "Je suis en retard → I'm late." },
      { q: "'Je ne suis pas d'accord' en anglais ?", opts: ['I disagree','I refuse','I oppose','I don\'t agree with that'], ans: 'I disagree', hint: "Je ne suis pas d'accord → I disagree." },
      { q: "'À demain' en anglais ?", opts: ['See you tomorrow','Until tomorrow','Bye for now','Talk tomorrow'], ans: 'See you tomorrow', hint: "À demain → See you tomorrow." },
    ],
    [
      { q: "'Ouvre la porte' en anglais ?", opts: ['Open the door','Unlock the door','Push the door','Enter the door'], ans: 'Open the door', hint: "Ouvre la porte → Open the door." },
      { q: "'Ferme la fenêtre' en anglais ?", opts: ['Close the window','Shut the window','Lock the window','Block the window'], ans: 'Close the window', hint: "Ferme la fenêtre → Close the window." },
      { q: "'Je vais bien' en anglais ?", opts: ["I'm doing well","I'm fine","I'm good","I'm okay"], ans: "I'm doing well", hint: "Je vais bien → I'm doing well." },
      { q: "'Lève-toi' en anglais ?", opts: ['Stand up','Get up','Rise up','Get on your feet'], ans: 'Stand up', hint: "Lève-toi → Stand up." },
      { q: "'Lis ceci' en anglais ?", opts: ['Read this','Look at this','See this','Check this'], ans: 'Read this', hint: "Lis ceci → Read this." },
      { q: "'Bon voyage' en anglais ?", opts: ['Have a safe trip','Safe travels','Bon voyage','Have a good journey'], ans: 'Have a safe trip', hint: "Bon voyage → Have a safe trip." },
    ],
  ],
  'slang-expressions': [
    [
      { q: "'Ça me saoule' en anglais ?", opts: ['That bugs me','That annoys me','I hate that','That bothers me'], ans: 'That bugs me', hint: "Ça me saoule → That bugs me." },
      { q: "'Pas mon problème' en anglais ?", opts: ['Not my business','Not my problem','Not my concern','Not my deal'], ans: 'Not my business', hint: "Pas mon problème → Not my business." },
      { q: "'Tu m'étonnes' en anglais ?", opts: ['You amaze me','You surprise me','I can\'t believe you','You shock me'], ans: 'You amaze me', hint: "Tu m'étonnes → You amaze me." },
      { q: "'On fait comment ?' en anglais ?", opts: ['What do we do?','How do we do it?','What shall we do?','How do we manage?'], ans: 'What do we do?', hint: "On fait comment ? → What do we do?" },
      { q: "Traduction : 'Je capte rien à ce cours'", opts: ['I have no clue about this lesson','I understand nothing here','This lesson is unclear','I can\'t follow this'], ans: 'I have no clue about this lesson', hint: "Je capte rien → I have no clue." },
      { q: "Traduction : 'On gère, pas de panique !'", opts: ["We got this, don't panic!","We manage, no panic!","We handle it, calm down!","We're fine, no worries!"], ans: "We got this, don't panic!", hint: "On gère → We got this." },
    ],
    [
      { q: "Traduction : 'C'est la galère ce projet'", opts: ["This project is a struggle","This project is difficult","This project is hard","This project is a mess"], ans: "This project is a struggle", hint: "C'est la galère → It's a struggle." },
      { q: "Traduction : 'J'ai la flemme d'y aller'", opts: ["I feel lazy about going","I don't want to go","I'm too tired to go","I can't go"], ans: "I feel lazy about going", hint: "J'ai la flemme → I feel lazy." },
      { q: "Traduction : 'T'es sérieux là ? C'est pas possible !'", opts: ["Are you serious? That can't be!","Are you joking? Impossible!","Really? I can't believe it!","Is this real? No way!"], ans: "Are you serious? That can't be!", hint: "T'es sérieux là ? → Are you serious?" },
      { q: "Laquelle traduit 'Ça me saoule qu'il soit en retard' ?", opts: ["It bugs me that he's late","He annoys me being late","His lateness bothers me","I hate his lateness"], ans: "It bugs me that he's late", hint: "Ça me saoule → That bugs me / It bugs me." },
      { q: "Que signifie 'We got this' ?", opts: ['On gère','On y va','On a ça','On peut le faire'], ans: 'On gère', hint: "We got this → On gère (on a la situation en main)." },
      { q: "Que signifie 'Not my business' ?", opts: ['Pas mon problème','Pas mes affaires','Ce n\'est pas pour moi','Ça ne me regarde pas'], ans: 'Pas mon problème', hint: "Not my business → Pas mon problème." },
    ],
  ],
  'social-expressions': [
    [
      { q: "'Ravi(e) de vous voir' en anglais ?", opts: ['Glad to see you','Nice to see you','Happy to meet you','Good to see you'], ans: 'Glad to see you', hint: "Ravi(e) de vous voir → Glad to see you." },
      { q: "'Pas mal !' en anglais ?", opts: ['Not bad!','Not great!','Pretty good!','Could be better!'], ans: 'Not bad!', hint: "Pas mal ! → Not bad!" },
      { q: "'Joyeux anniversaire !' en anglais ?", opts: ['Happy birthday!','Happy anniversary!','Many happy returns!','Congrats!'], ans: 'Happy birthday!', hint: "Joyeux anniversaire ! → Happy birthday!" },
      { q: "'Joyeuses fêtes !' en anglais ?", opts: ['Happy holidays!','Merry Christmas!','Happy new year!','Season greetings!'], ans: 'Happy holidays!', hint: "Joyeuses fêtes ! → Happy holidays! (expression générale)." },
      { q: "'Passe une bonne journée !' en anglais ?", opts: ['Have a great day!','Have a good day!','Enjoy your day!','Good day to you!'], ans: 'Have a great day!', hint: "Passe une bonne journée ! → Have a great day!" },
      { q: "'Sois prudent(e) !' en anglais ?", opts: ['Stay safe!','Be careful!','Watch out!','Take care!'], ans: 'Stay safe!', hint: "Sois prudent(e) ! → Stay safe!" },
    ],
    [
      { q: "'Dors bien !' en anglais ?", opts: ['Sleep well!','Good night!','Sweet dreams!','Rest well!'], ans: 'Sleep well!', hint: "Dors bien ! → Sleep well!" },
      { q: "'À bientôt !' en anglais ?", opts: ['See you soon.','See you later.','Catch you later.','Goodbye for now.'], ans: 'See you soon.', hint: "À bientôt ! → See you soon." },
      { q: "'Dis-moi.' en anglais ?", opts: ['Tell me.','Say it.','Speak to me.','Let me know.'], ans: 'Tell me.', hint: "Dis-moi. → Tell me." },
      { q: "'Je ne comprends pas.' en anglais ?", opts: ["I don't understand.","I can't follow.","I'm lost.","This is unclear."], ans: "I don't understand.", hint: "Je ne comprends pas. → I don't understand." },
      { q: "'Ce n'est pas correct.' en anglais ?", opts: ["That's not correct.","That's wrong.","Not right.","Incorrect!"], ans: "That's not correct.", hint: "Ce n'est pas correct. → That's not correct." },
      { q: "'Appelle-moi.' en anglais ?", opts: ['Call me.','Ring me.','Phone me.','Text me.'], ans: 'Call me.', hint: "Appelle-moi. → Call me." },
    ],
  ],
  'driving-expressions': [
    [
      { q: "'Je tourne à droite' en anglais ?", opts: ['I turn right','I go right','I drive right','I turn rightward'], ans: 'I turn right', hint: "Je tourne à droite → I turn right." },
      { q: "'Je mets ma ceinture' en anglais ?", opts: ['I put on my seatbelt','I wear my belt','I fasten my belt','I put my belt'], ans: 'I put on my seatbelt', hint: "Je mets ma ceinture → I put on my seatbelt." },
      { q: "'Je roule doucement' en anglais ?", opts: ['I drive slowly','I go slowly','I roll gently','I move slowly'], ans: 'I drive slowly', hint: "Je roule doucement → I drive slowly." },
      { q: "'Je démarre la voiture' en anglais ?", opts: ['I start the car','I launch the car','I turn the car','I ignite the car'], ans: 'I start the car', hint: "Je démarre la voiture → I start the car." },
      { q: "'On prend la route' en anglais ?", opts: ['We hit the road','We take the road','We drive away','We start driving'], ans: 'We hit the road', hint: "On prend la route → We hit the road." },
      { q: "'Je change de voie' en anglais ?", opts: ['I change lanes','I switch roads','I change path','I move over'], ans: 'I change lanes', hint: "Je change de voie → I change lanes." },
    ],
    [
      { q: "'I turn left' en français ?", opts: ['Je tourne à gauche','Je vais à gauche','Je conduis à gauche','Je penche à gauche'], ans: 'Je tourne à gauche', hint: "I turn left → Je tourne à gauche." },
      { q: "'I brake' en français ?", opts: ['Je freine','Je stoppe','Je ralentis','Je bloque'], ans: 'Je freine', hint: "I brake → Je freine." },
      { q: "'I speed up' en français ?", opts: ["J'accélère",'Je roule vite','Je fonce','Je vais plus vite'], ans: "J'accélère", hint: "I speed up → J'accélère." },
      { q: "'I put on my seatbelt' en français ?", opts: ['Je mets ma ceinture','Je boucle ma ceinture','Je porte ma ceinture','Je fixe ma ceinture'], ans: 'Je mets ma ceinture', hint: "I put on my seatbelt → Je mets ma ceinture." },
      { q: "'We hit the road' en français ?", opts: ['On prend la route','On part sur la route','On démarre','On va sur la route'], ans: 'On prend la route', hint: "We hit the road → On prend la route." },
      { q: "'There's traffic' en français ?", opts: ['Il y a des embouteillages','Il y a de la circulation','La route est bloquée','Il y a des voitures'], ans: 'Il y a des embouteillages', hint: "There's traffic → Il y a des embouteillages." },
    ],
  ],
  'french-proverbs': [
    [
      { q: "'Qui ne tente rien n'a rien' en anglais ?", opts: ['He who dares nothing wins nothing','Nothing is free in life','Try hard or fail','Risk nothing, get nothing'], ans: 'He who dares nothing wins nothing', hint: "Qui ne tente rien n'a rien → He who dares nothing wins nothing." },
      { q: "Quel proverbe correspond à 'Hope keeps us going' ?", opts: ["L'espoir fait vivre",'La patience est une vertu','On apprend de ses erreurs','Mieux vaut être seul'], ans: "L'espoir fait vivre", hint: "Hope keeps us going → L'espoir fait vivre." },
      { q: "Quel proverbe correspond à 'Patience is a virtue' ?", opts: ['La patience est une vertu','La vérité éclate',"L'espoir fait vivre",'On apprend de ses erreurs'], ans: 'La patience est une vertu', hint: "Patience is a virtue → La patience est une vertu." },
      { q: "Quel proverbe correspond à 'The truth always comes out' ?", opts: ['La vérité finit toujours par éclater',"Il n'y a pas de fumée sans feu",'On apprend de ses erreurs','La patience est une vertu'], ans: 'La vérité finit toujours par éclater', hint: "The truth always comes out → La vérité finit toujours par éclater." },
      { q: "Quel proverbe correspond à 'Where there's smoke, there's fire' ?", opts: ["Il n'y a pas de fumée sans feu",'La vérité finit par éclater',"Qui ne tente rien n'a rien","L'espoir fait vivre"], ans: "Il n'y a pas de fumée sans feu", hint: "Where there's smoke, there's fire → Il n'y a pas de fumée sans feu." },
      { q: "Quel proverbe correspond à 'We learn from our mistakes' ?", opts: ['On apprend de ses erreurs','La patience est une vertu','Mieux vaut être seul',"Qui ne tente rien n'a rien"], ans: 'On apprend de ses erreurs', hint: "We learn from our mistakes → On apprend de ses erreurs." },
    ],
    [
      { q: "Quel proverbe correspond à 'Better be alone than in bad company' ?", opts: ['Mieux vaut être seul que mal accompagné','La patience est une vertu',"Il n'y a pas de fumée sans feu",'On apprend de ses erreurs'], ans: 'Mieux vaut être seul que mal accompagné', hint: "Better be alone than in bad company → Mieux vaut être seul que mal accompagné." },
      { q: "Complète : 'L'espoir fait ___'", opts: ['vivre','aller','grandir','avancer'], ans: 'vivre', hint: "L'espoir fait vivre — Hope keeps us going." },
      { q: "Complète : 'La vérité finit toujours par ___'", opts: ['éclater','venir','paraître','sortir'], ans: 'éclater', hint: "La vérité finit toujours par éclater — The truth always comes out." },
      { q: "Complète : 'Il n'y a pas de fumée sans ___'", opts: ['feu','raison','cause','flamme'], ans: 'feu', hint: "Il n'y a pas de fumée sans feu — Where there's smoke, there's fire." },
      { q: "Complète : 'Mieux vaut être seul que mal ___'", opts: ['accompagné','entouré','conseillé','guidé'], ans: 'accompagné', hint: "Mieux vaut être seul que mal accompagné." },
      { q: "Complète : 'On apprend de ses ___'", opts: ['erreurs','fautes','échecs','problèmes'], ans: 'erreurs', hint: "On apprend de ses erreurs — We learn from our mistakes." },
    ],
  ],
  'negotiation-expressions': [
    [
      { q: "Traduction de 'To clarify expectations'", opts: ['Clarifier les attentes','Préciser les objectifs','Expliquer les règles','Définir les critères'], ans: 'Clarifier les attentes', hint: "To clarify expectations → Clarifier les attentes." },
      { q: "Traduction de 'To explore options'", opts: ['Explorer les options','Chercher des solutions','Analyser les possibilités','Examiner les choix'], ans: 'Explorer les options', hint: "To explore options → Explorer les options." },
      { q: "Traduction de 'To assess the risks'", opts: ['Évaluer les risques','Mesurer les dangers','Analyser les problèmes','Identifier les menaces'], ans: 'Évaluer les risques', hint: "To assess the risks → Évaluer les risques." },
      { q: "Traduction de 'To seek an agreement'", opts: ['Rechercher un accord','Trouver un terrain commun','Négocier un deal','Viser un consensus'], ans: 'Rechercher un accord', hint: "To seek an agreement → Rechercher un accord." },
      { q: "Traduction de 'To gain benefits'", opts: ['Obtenir des avantages','Gagner des points','Avoir des bénéfices','Remporter des gains'], ans: 'Obtenir des avantages', hint: "To gain benefits → Obtenir des avantages." },
      { q: "Traduction de 'To strengthen your position'", opts: ['Renforcer votre position','Améliorer votre stance','Consolider votre place','Défendre votre terrain'], ans: 'Renforcer votre position', hint: "To strengthen your position → Renforcer votre position." },
    ],
    [
      { q: "Traduction de 'To propose a solution'", opts: ['Proposer une solution','Suggérer une idée','Offrir une alternative','Présenter un plan'], ans: 'Proposer une solution', hint: "To propose a solution → Proposer une solution." },
      { q: "Traduction de 'To compare alternatives'", opts: ['Comparer les alternatives','Analyser les options','Évaluer les choix','Peser les possibilités'], ans: 'Comparer les alternatives', hint: "To compare alternatives → Comparer les alternatives." },
      { q: "Traduction de 'To negotiate the terms'", opts: ['Négocier les termes','Discuter les conditions','Revoir le contrat','Ajuster les clauses'], ans: 'Négocier les termes', hint: "To negotiate the terms → Négocier les termes." },
      { q: "Traduction de 'To keep your composure'", opts: ['Garder votre calme','Rester concentré','Maintenir votre sérieux','Conserver votre sang-froid'], ans: 'Garder votre calme', hint: "To keep your composure → Garder votre calme." },
      { q: "Traduction de 'To take your time'", opts: ['Prendre votre temps','Ne pas vous presser','Avancer lentement','Gérer le timing'], ans: 'Prendre votre temps', hint: "To take your time → Prendre votre temps." },
      { q: "Traduction de 'To stay flexible'", opts: ['Rester flexible','Être adaptable','Garder des options','Éviter la rigidité'], ans: 'Rester flexible', hint: "To stay flexible → Rester flexible." },
    ],
  ],
  'tout-expressions': [
    [
      { q: "'Après tout' en anglais ?", opts: ['After all','Above all','Despite everything','All things considered'], ans: 'After all', hint: "Après tout → After all." },
      { q: "'Avant tout' en anglais ?", opts: ['Above all','First of all','After all','Before everything'], ans: 'Above all', hint: "Avant tout → Above all." },
      { q: "'De tout cœur' en anglais ?", opts: ['Wholeheartedly','With all heart','From the heart','Sincerely'], ans: 'Wholeheartedly', hint: "De tout cœur → Wholeheartedly." },
      { q: "'Tout à coup' en anglais ?", opts: ['All of a sudden','All at once','Right away','Suddenly enough'], ans: 'All of a sudden', hint: "Tout à coup → All of a sudden." },
      { q: "'Une fois pour toutes' en anglais ?", opts: ['Once and for all','One time for all','Once for everything','All at once'], ans: 'Once and for all', hint: "Une fois pour toutes → Once and for all." },
      { q: "'Tout de même' en anglais ?", opts: ['All the same','All the way','Despite all','Just the same'], ans: 'All the same', hint: "Tout de même → All the same / Still." },
    ],
    [
      { q: "'En tout cas' en anglais ?", opts: ['In any case','In all cases','Anyway','No matter what'], ans: 'In any case', hint: "En tout cas → In any case." },
      { q: "'Tout compte fait' en anglais ?", opts: ['All things considered','After all','Above all','In any case'], ans: 'All things considered', hint: "Tout compte fait → All things considered." },
      { q: "'Tout droit' en anglais ?", opts: ['Straight ahead','All right','Right away','Directly'], ans: 'Straight ahead', hint: "Tout droit → Straight ahead." },
      { q: "'Tout seul' en anglais ?", opts: ['Alone','By myself','All alone','On your own'], ans: 'Alone', hint: "Tout seul / toute seule → Alone." },
      { q: "'À tout prix' en anglais ?", opts: ['At all costs','At any price','Whatever the cost','By all means'], ans: 'At all costs', hint: "À tout prix → At all costs." },
      { q: "Quelle est la différence entre 'à tout à l'heure' et 'tout à l'heure' ?", opts: ["À tout à l'heure = au revoir ; tout à l'heure = plus tôt/plus tard aujourd'hui","Ce sont des synonymes","À tout à l'heure = plus tôt ; tout à l'heure = au revoir","Aucune différence"], ans: "À tout à l'heure = au revoir ; tout à l'heure = plus tôt/plus tard aujourd'hui", hint: "À tout à l'heure = see you later ; tout à l'heure = earlier/later today." },
    ],
  ],
  'discourse-connectors': [
    [
      { q: "Compléter : '___, preheat the oven. ___, mix the ingredients.' (d'abord / ensuite)", opts: ['First / Then','Next / After that','Meanwhile / Finally','First / After that'], ans: 'First / Then', hint: "First → d'abord ; Then → ensuite (ordre logique)." },
      { q: "Que signifie 'After that' ?", opts: ['Après cela','Ensuite seulement','En même temps','Enfin'], ans: 'Après cela', hint: "After that → après cela (suit une action précédente)." },
      { q: "Compléter : '___ she was cooking, the kids were playing.' (pendant ce temps)", opts: ['Meanwhile','At the same time','Then','After that'], ans: 'Meanwhile', hint: "Meanwhile → pendant ce temps (deux actions parallèles, narration)." },
      { q: "Compléter : '___, we need to act now.' (en conclusion)", opts: ['In conclusion','To sum up','Last but not least','Finally'], ans: 'In conclusion', hint: "In conclusion → en conclusion (formule de clôture)." },
      { q: "Quel connecteur introduit le dernier point important d'une liste ?", opts: ['Last but not least','Finally','In conclusion','After that'], ans: 'Last but not least', hint: "Last but not least → dernier mais tout aussi important." },
      { q: "Que signifie 'At the same time' ?", opts: ['En même temps','Pendant ce temps','Après cela',"D'abord"], ans: 'En même temps', hint: "At the same time → en même temps (simultanéité factuelle)." },
    ],
    [
      { q: "Mettre dans le bon ordre : discours structuré", opts: ['First / Next / Then / After that / Finally','Next / First / Then / Finally / After that','Then / First / Next / Finally / After that','First / Finally / Next / Then / After that'], ans: 'First / Next / Then / After that / Finally', hint: "Ordre naturel : First → Next → Then → After that → Finally." },
      { q: "Compléter : '___ the project was a success.' (pour résumer)", opts: ['To sum up,','In conclusion,','Finally,','Last but not least,'], ans: 'To sum up,', hint: "To sum up → pour résumer (synthèse concise)." },
      { q: "Compléter : 'He drove ___ he talked on the phone.' (en même temps)", opts: ['at the same time as','meanwhile','after that','while next'], ans: 'at the same time as', hint: "At the same time as → en même temps que (simultanéité)." },
      { q: "Différence entre 'To sum up' et 'In conclusion' ?", opts: ["To sum up = résumé bref ; In conclusion = conclusion formelle","Ce sont des synonymes","In conclusion = résumé ; To sum up = conclusion","Pas de différence en anglais"], ans: "To sum up = résumé bref ; In conclusion = conclusion formelle", hint: "To sum up est plus informel ; In conclusion est plus académique/formel." },
      { q: "Quel connecteur est le plus narratif (récit) ?", opts: ['Meanwhile','At the same time','After that','Next'], ans: 'Meanwhile', hint: "Meanwhile est plus utilisé dans les récits et la narration." },
      { q: "Compléter : '___, I'd like to mention the volunteers.' (dernier mais important)", opts: ['Last but not least','Finally','To sum up','In conclusion'], ans: 'Last but not least', hint: "Last but not least → pour valoriser le dernier point d'une liste." },
    ],
  ],
  'such-expressions': [
    [
      { q: "Choisir la bonne phrase : 'He is the president, and ___ he has power.'", opts: ['as such','such and such','no such','to such an extent'], ans: 'as such', hint: "As such → à ce titre / en tant que tel." },
      { q: "Compléter : '___ thing as a free lunch.' (ça n'existe pas)", opts: ["There's no such","There's no such a","There's no as such","There's such no"], ans: "There's no such", hint: "There's no such thing as… → ça n'existe pas." },
      { q: "Que signifie 'to such an extent that' ?", opts: ['Tellement… que','En tant que','Tel ou tel','Rien de tel'], ans: 'Tellement… que', hint: "To such an extent that → tellement… que (conséquence forte)." },
      { q: "Compléter : 'She told me to meet her at ___ a place.' (lieu vague)", opts: ['such and such','as such','no such','such an extent'], ans: 'such and such', hint: "Such and such a place → tel ou tel endroit (non précisé)." },
      { q: "\"Tu as menti !\" \"___\" (déni ferme)", opts: ['I did no such thing!','There is no such thing!','I am as such!','No such thing I did!'], ans: 'I did no such thing!', hint: "I did no such thing! → Je n'ai rien fait de tel !" },
      { q: "Traduire : 'Le véhicule était tellement endommagé qu'il ne pouvait pas être réparé.'", opts: ['The vehicle was damaged to such an extent that it could not be repaired.','The vehicle was such damaged that it could not be repaired.','As such, the vehicle could not be repaired.','No such vehicle could be repaired.'], ans: 'The vehicle was damaged to such an extent that it could not be repaired.', hint: "To such an extent that → tellement… que." },
    ],
    [
      { q: "Quelle construction signifie 'en lui-même / à ce titre' ?", opts: ['As such','Such and such','No such thing','To such an extent'], ans: 'As such', hint: "As such → en soi / à ce titre / en tant que tel." },
      { q: "Compléter : 'It's not a problem ___, but it could become one.'", opts: ['as such','such and such','no such','to such an extent'], ans: 'as such', hint: "As such entre virgules → en lui-même / proprement dit." },
      { q: "Compléter : 'The noise was ___ that nobody could sleep.'", opts: ['to such an extent','as such','such and such','no such'], ans: 'to such an extent', hint: "To such an extent that → tellement fort que." },
      { q: "Compléter : 'There was ___ thing as electric blankets in those days.'", opts: ['no such','as such','such and such','no as such'], ans: 'no such', hint: "No such thing (as) → ça n'existait pas." },
      { q: "Compléter : 'He said he would do ___ in the garden.' (tâches vagues)", opts: ['such and such','as such','to such an extent','no such thing'], ans: 'such and such', hint: "Such and such → des choses vagues ou non précisées." },
      { q: "Traduire : 'Elle est manager et, à ce titre, elle prend les décisions.'", opts: ["She's the manager and, as such, she makes the decisions.","She's the manager and, such and such, she decides.","She's the manager to such an extent she decides.","There's no such manager as her."], ans: "She's the manager and, as such, she makes the decisions.", hint: "And, as such → et, à ce titre / en tant que tel." },
    ],
  ],
  'ing-ed-adjectives': [
    [
      { q: "The new rules were very ___. Nobody understood them.", opts: ['confusing','confused','confuse','confusingly'], ans: 'confusing', hint: "Les règles (chose) → confusing. Les gens → confused." },
      { q: "He was ___ by the filthy kitchen.", opts: ['disgusted','disgusting','disgust','disgustedly'], ans: 'disgusted', hint: "-ED pour la personne : he was disgusted." },
      { q: "That's an ___ remark! (insultant)", opts: ['insulting','insulted','insult','insultingly'], ans: 'insulting', hint: "La remarque (chose) → insulting." },
      { q: "Alice felt ___ by the remark.", opts: ['insulted','insulting','insult','offended'], ans: 'insulted', hint: "Alice (personne) ressent → insulted (-ED)." },
      { q: "The speech was ___. Everyone listened. (hypnotisant)", opts: ['hypnotizing','hypnotized','hypnotize','hypnotic'], ans: 'hypnotizing', hint: "Le discours (chose) → hypnotizing." },
      { q: "They were ___ by the speech.", opts: ['hypnotized','hypnotizing','hypnotize','captivated'], ans: 'hypnotized', hint: "Ils (personnes) → hypnotized (-ED)." },
    ],
    [
      { q: "Choisir la bonne forme : 'Je m'ennuyais pendant la réunion.'", opts: ["I was bored during the meeting.","The meeting was bored.","I was boring during the meeting.","The meeting bored."], ans: "I was bored during the meeting.", hint: "Vous (personne) ressentez → bored (-ED)." },
      { q: "Choisir la bonne forme : 'La réunion était ennuyeuse.'", opts: ["The meeting was boring.","The meeting was bored.","I was boring.","The meeting bored me."], ans: "The meeting was boring.", hint: "La réunion (chose) → boring (-ING)." },
      { q: "Quelle phrase est correcte ?", opts: ["The kids were excited about the circus.","The kids were exciting about the circus.","The circus was excited.","The kids excited the circus."], ans: "The kids were excited about the circus.", hint: "Les enfants (personnes) ressentent → excited (-ED)." },
      { q: "Quelle phrase est correcte ?", opts: ["A circus is exciting for children.","A circus is excited for children.","Children are exciting the circus.","The circus excites children."], ans: "A circus is exciting for children.", hint: "Le cirque (chose) → exciting (-ING)." },
      { q: "Traduire : 'La randonnée était fatigante mais nous étions contents.'", opts: ["The hike was tiring but we were pleased.","The hike was tired but we were pleased.","We were tiring but pleased.","The hike was tiring but we were pleasing."], ans: "The hike was tiring but we were pleased.", hint: "La randonnée → tiring ; nous → pleased (-ED)." },
      { q: "Règle clé : -ING vs -ED ?", opts: ["-ING = la chose ; -ED = la personne","-ED = la chose ; -ING = la personne","-ING et -ED = même sens","Pas de règle fixe"], ans: "-ING = la chose ; -ED = la personne", hint: "La chose provoque (-ING) ; la personne ressent (-ED)." },
    ],
  ],
  'disagreement-expressions': [
    [
      { q: "Comment dire 'Je ne partage pas ton avis' ?", opts: ["I don't share your opinion","I disagree with you","I see it differently","I'm not convinced"], ans: "I don't share your opinion", hint: "I don't share your opinion → Je ne partage pas ton avis (formel et diplomatique)." },
      { q: "Que signifie 'I refuse' ?", opts: ["Je refuse","Je ne veux pas","Je n'accepte pas","Je m'y oppose"], ans: "Je refuse", hint: "I refuse → Je refuse (ferme et direct)." },
      { q: "Laquelle est la plus diplomatique pour exprimer le désaccord ?", opts: ["I see it differently","You're wrong","That's not true","I refuse"], ans: "I see it differently", hint: "I see it differently → présente votre point de vue sans attaquer l'autre." },
      { q: "Traduire : 'Je ne crois pas que ce soit la bonne solution.'", opts: ["I don't believe so — that's not the right solution.","I don't think so about the solution.","I'm not sure this is right.","That's not a good idea."], ans: "I don't believe so — that's not the right solution.", hint: "I don't believe so → Je ne crois pas." },
      { q: "Que signifie 'I'm not convinced this is the right approach' ?", opts: ["Je ne suis pas convaincu que c'est la bonne approche","Je ne crois pas que c'est juste","Je vois les choses autrement","Je ne suis pas sûr de l'approche"], ans: "Je ne suis pas convaincu que c'est la bonne approche", hint: "I'm not convinced → Je ne suis pas convaincu(e)." },
      { q: "Compléter : '___ to sign this contract.' (Je refuse)", opts: ["I refuse","I don't believe so","I'm not convinced","I won't agree"], ans: "I refuse", hint: "I refuse + to + verbe → Je refuse de…" },
    ],
    [
      { q: "Mettre en ordre du plus doux au plus direct :", opts: ["I see it differently / I'm not convinced / You're wrong","You're wrong / I'm not convinced / I see it differently","I'm not convinced / You're wrong / I see it differently","I see it differently / You're wrong / I'm not convinced"], ans: "I see it differently / I'm not convinced / You're wrong", hint: "Du plus diplomatique au plus direct : I see it differently < I'm not convinced < You're wrong." },
      { q: "Dans quel contexte utiliser 'That's not true' ?", opts: ["Pour corriger un fait incorrect","Pour exprimer poliment un désaccord","En réunion formelle","Pour refuser une proposition"], ans: "Pour corriger un fait incorrect", hint: "That's not true → Ce n'est pas vrai — pour contredire un fait." },
      { q: "Traduire : 'Ce n'est pas une bonne idée de se précipiter.'", opts: ["It's not a good idea to rush.","That's not a good plan to rush.","I don't think rushing is right.","I refuse to rush."], ans: "It's not a good idea to rush.", hint: "It's not a good idea + to + verbe → Ce n'est pas une bonne idée de…" },
      { q: "Que signifie 'I don't share your opinion on this matter' ?", opts: ["Je ne partage pas ton avis là-dessus","Je ne suis pas d'accord avec toi","Je vois les choses différemment","Je refuse cette idée"], ans: "Je ne partage pas ton avis là-dessus", hint: "I don't share your opinion → Je ne partage pas ton/votre avis." },
      { q: "Comment contredire poliment en réunion ?", opts: ["I see it differently — let me explain.","You're wrong, let me explain.","That's not true — here's why.","I refuse this proposal."], ans: "I see it differently — let me explain.", hint: "I see it differently → présente une vision alternative sans agressivité." },
      { q: "Compléter : '___ this contract.' (Je refuse de signer)", opts: ["I refuse to sign","I don't believe in signing","It's not a good idea to sign","I'm not convinced to sign"], ans: "I refuse to sign", hint: "I refuse to + infinitif → Je refuse de + infinitif." },
    ],
  ],
  'i-dont-know-alternatives': [
    [
      { q: "Laquelle est une alternative polie à 'I don't know' ?", opts: ["I'm not certain","It beats me","I haven't got a clue","I don't have a clue"], ans: "I'm not certain", hint: "I'm not certain → Je ne suis pas certain(e) — poli et neutre." },
      { q: "Compléter : '___ about the new policy.' (Je ne suis pas au courant)", opts: ["I'm not aware","I'm not sure","I can't say","I wouldn't know"], ans: "I'm not aware", hint: "I'm not aware of / about → Je ne suis pas au courant de." },
      { q: "Que signifie 'I'm unsure' ?", opts: ["Je ne suis pas sûr(e)","Je suis perdu(e)","Je ne comprends pas","Je ne suis pas prêt(e)"], ans: "Je ne suis pas sûr(e)", hint: "I'm unsure → Je ne suis pas sûr(e) (synonyme de I'm not sure)." },
      { q: "Quelle expression montre qu'on ignore complètement ?", opts: ["I don't have a clue","I'm not sure","I'm not aware","I can't say"], ans: "I don't have a clue", hint: "I don't have a clue → Je n'ai aucune idée (très familier)." },
      { q: "Comment dire 'Ce n'est pas mon domaine' élégamment ?", opts: ["I wouldn't know","I can't say","It beats me","I'm not certain"], ans: "I wouldn't know", hint: "I wouldn't know → Je ne saurais pas dire — implique que ce n'est pas son domaine." },
      { q: "Choisir la plus familière parmi ces alternatives", opts: ["It beats me","I'm not sure","I'm not certain","I can't say"], ans: "It beats me", hint: "It beats me → très familier et expressif." },
    ],
    [
      { q: "Traduire : 'Je ne suis pas sûr(e) — renseigne-toi auprès du manager.'", opts: ["I'm not sure — ask the manager.","I don't know — ask the manager.","I can't say — ask the manager.","I'm unsure — see the manager."], ans: "I'm not sure — ask the manager.", hint: "I'm not sure est la formulation la plus naturelle ici." },
      { q: "Traduire : 'Ça me dépasse pourquoi il est parti si tôt.'", opts: ["It beats me why he left so early.","I don't know why he left early.","I haven't got a clue why he left.","I'm unsure why he left early."], ans: "It beats me why he left so early.", hint: "It beats me why… → Ça me dépasse pourquoi… (idiome familier)." },
      { q: "Traduire : 'Je n'ai pas la moindre idée où sont mes clés.'", opts: ["I haven't got a clue where my keys are.","I don't know where my keys are.","I'm not aware of my keys.","I can't say where my keys are."], ans: "I haven't got a clue where my keys are.", hint: "I haven't got a clue → je n'ai pas la moindre idée (très familier)." },
      { q: "Dans quel cas utilise-t-on surtout 'I can't say' ?", opts: ["Quand c'est confidentiel ou incertain","Quand on ignore totalement","Quand on manque de vocabulaire","Quand on est très familier"], ans: "Quand c'est confidentiel ou incertain", hint: "I can't say peut indiquer la confidentialité ou l'incertitude." },
      { q: "Quelle phrase est la plus formelle ?", opts: ["I'm not certain","It beats me","I haven't got a clue","I don't have a clue"], ans: "I'm not certain", hint: "I'm not certain → le plus formel et poli des quatre." },
      { q: "Compléter : '___ — it's not my area.' (Je ne saurais pas dire)", opts: ["I wouldn't know","I'm not sure","I can't say","I'm unsure"], ans: "I wouldn't know", hint: "I wouldn't know — it's not my area → Je ne saurais pas dire — ce n'est pas mon domaine." },
    ],
  ],
  'away-phrasal-verbs': [
    [
      { q: "Que signifie 'look away' ?", opts: ['Détourner les yeux','Se détourner','Partir','Regarder au loin'], ans: 'Détourner les yeux', hint: "Look away → détourner les yeux (regarder ailleurs)." },
      { q: "Compléter : '___ — I'm trying to concentrate!' (Pars !)", opts: ['Go away','Run away','Stay away','Get away'], ans: 'Go away', hint: "Go away → partir / disparaître complètement." },
      { q: "Que signifie 'take away' ?", opts: ['Enlever','Ranger','Jeter','Donner'], ans: 'Enlever', hint: "Take away → enlever, retirer quelque chose." },
      { q: "Compléter : 'She ___ her old clothes to charity.'", opts: ['gave away','threw away','put away','ran away'], ans: 'gave away', hint: "Give away → donner gratuitement (à une association)." },
      { q: "Que signifie 'run away' ?", opts: ["S'enfuir","Partir","Se détourner","Rester à distance"], ans: "S'enfuir", hint: "Run away → s'enfuir rapidement." },
      { q: "Compléter : 'Please ___ your toys before dinner.'", opts: ['put away','throw away','take away','give away'], ans: 'put away', hint: "Put away → ranger à sa place." },
    ],
    [
      { q: "Traduire : 'La police lui a retiré son permis de conduire.'", opts: ["The police took away his driving licence.","The police put away his driving licence.","The police threw away his driving licence.","The police gave away his driving licence."], ans: "The police took away his driving licence.", hint: "Take away → enlever, retirer quelque chose à quelqu'un." },
      { q: "Compléter : 'He ___, embarrassed.' (détourna les yeux)", opts: ['looked away','turned away','ran away','stayed away'], ans: 'looked away', hint: "Look away → détourner les yeux par gêne ou refus." },
      { q: "Différence entre 'throw away' et 'put away' ?", opts: ["Throw away = jeter ; put away = ranger","Throw away = ranger ; put away = jeter","Ils sont synonymes","Throw away = donner ; put away = enlever"], ans: "Throw away = jeter ; put away = ranger", hint: "Throw away = à la poubelle ; put away = à sa place." },
      { q: "Compléter : 'Don't ___ that — we can still use it!'", opts: ['throw away','put away','give away','take away'], ans: 'throw away', hint: "Throw away → jeter définitivement à la poubelle." },
      { q: "Compléter : 'The dog ___ when it heard the thunder.'", opts: ['ran away','went away','stayed away','got away'], ans: 'ran away', hint: "Run away → s'enfuir (réaction de frayeur)." },
      { q: "Quel verbe signifie 's'échapper d'un danger' ?", opts: ['Get away','Go away','Run away','Turn away'], ans: 'Get away', hint: "Get away = s'échapper avec succès. Run away = fuir en courant." },
    ],
  ],
  'question-expressions': [
    [
      { q: "Compléter : '___ did they call the meeting?' (dans quel but)", opts: ['What for','How come','By whom','From when'], ans: 'What for', hint: "What for → dans quel but, pourquoi." },
      { q: "Compléter : '___ you didn't tell me?' (comment se fait-il que)", opts: ["How come","What for","In what way","For what reason"], ans: "How come", hint: "How come → comment se fait-il que (informel, sans inversion)." },
      { q: "Que signifie 'By whom' ?", opts: ['Par qui','Avec qui','Pour qui','Par où'], ans: 'Par qui', hint: "By whom → par qui (passif formel)." },
      { q: "Compléter : '___ were you abroad?' (pendant combien de temps)", opts: ['During what time','Until when','From when','At what time'], ans: 'During what time', hint: "During what time → pendant combien de temps." },
      { q: "Que signifie 'To where' ?", opts: ['Vers où','D\'où','Depuis quand','Jusqu\'à quand'], ans: 'Vers où', hint: "To where → vers où, en direction de quel endroit." },
      { q: "Comment dire 'Sous quelle condition' ?", opts: ['Under what condition','In what way','On what occasion','For what reason'], ans: 'Under what condition', hint: "Under what condition → sous quelle condition." },
    ],
    [
      { q: "Que signifie 'On what occasion' ?", opts: ['À quelle occasion','À quelle heure','Dans quel but','Par qui'], ans: 'À quelle occasion', hint: "On what occasion → à quelle occasion." },
      { q: "Quelle question est la plus formelle pour demander 'avec qui' ?", opts: ['With whom','Who with','Who did you go with','Who were you with'], ans: 'With whom', hint: "With whom → forme formelle. Who with → forme informelle." },
      { q: "Compléter : '___ will you be in Paris?' (jusqu'à quand)", opts: ['Until when','From when','At which time','After what time'], ans: 'Until when', hint: "Until when → jusqu'à quand." },
      { q: "Différence entre 'From when' et 'Since when' ?", opts: ["Même sens — depuis quand","From when = jusqu'à quand","Since when = vers où","From when = par qui"], ans: "Même sens — depuis quand", hint: "From when et since when → depuis quand (depuis quel moment)." },
      { q: "Compléter : '___ should I arrive?' (avant quelle heure)", opts: ['Before what time','After what time','At what time','Until when'], ans: 'Before what time', hint: "Before what time → avant quelle heure." },
      { q: "Que signifie 'In what way' ?", opts: ['De quelle manière','Pour quelle raison','Dans quel but','Depuis quand'], ans: 'De quelle manière', hint: "In what way → de quelle manière, comment exactement." },
    ],
  ],
  'linking-expressions': [
    [
      { q: "Compléter : '___ you study, you'll pass.' (à condition que)", opts: ['Provided that','In case','Even if','As long as'], ans: 'Provided that', hint: "Provided that → à condition que (condition stricte)." },
      { q: "Compléter : 'Take an umbrella ___ it rains.' (au cas où)", opts: ['in case','even if','so that','provided that'], ans: 'in case', hint: "In case → au cas où (précaution préventive)." },
      { q: "Que signifie 'Even if' ?", opts: ['Même si','Tant que','Puisque','Afin que'], ans: 'Même si', hint: "Even if → même si (concession hypothétique)." },
      { q: "Compléter : '___ your help, we succeeded.' (grâce à)", opts: ['Thanks to','Due to','Because of','In spite of'], ans: 'Thanks to', hint: "Thanks to → grâce à (cause positive)." },
      { q: "Que signifie 'In addition to' ?", opts: ['En plus de','À cause de','Malgré','Afin de'], ans: 'En plus de', hint: "In addition to → en plus de (ajout)." },
      { q: "Compléter : 'She whispered ___ nobody would hear.' (afin que)", opts: ['so that','so as to','in order to','because'], ans: 'so that', hint: "So that + sujet + verbe → afin que." },
    ],
    [
      { q: "Différence entre 'so that' et 'so as to' ?", opts: ["So that + sujet + verbe ; so as to + infinitif","Ce sont des synonymes","So as to + sujet ; so that + infinitif","Pas de différence"], ans: "So that + sujet + verbe ; so as to + infinitif", hint: "So that she can… / so as to avoid… — structures différentes." },
      { q: "Compléter : '___ English, she speaks Japanese.' (en plus de)", opts: ['In addition to','Thanks to','In spite of','Due to'], ans: 'In addition to', hint: "In addition to → en plus de (ajout d'élément)." },
      { q: "Que signifie 'Since' dans 'Since you're here, let's start' ?", opts: ['Puisque (cause)','Depuis (temps)','Tant que','Même si'], ans: 'Puisque (cause)', hint: "Since = puisque (cause logique) ou depuis (temps) — contexte décisif." },
      { q: "Compléter : '___ the budget, we'll discuss it later.' (quant à)", opts: ['As for','As to','As long as','As soon as'], ans: 'As for', hint: "As for → quant à (introduit un nouveau sujet)." },
      { q: "Que signifie 'In spite of' ?", opts: ['Malgré','En plus de','À cause de','Grâce à'], ans: 'Malgré', hint: "In spite of → malgré, en dépit de (= despite)." },
      { q: "Compléter : 'She left early ___ avoid traffic.' (de manière à)", opts: ['so as to','so that','in order that','because'], ans: 'so as to', hint: "So as to + infinitif → de manière à + infinitif." },
    ],
  ],
  'verb-types': [
    [
      { q: "Identifier le verbe fini : 'She is running every morning.'", opts: ['is','running','every','morning'], ans: 'is', hint: "Is = verbe fini (présent, 3e personne). Running = participe présent (non-fini)." },
      { q: "Quel est le rôle de 'do' dans 'Do you speak English?' ?", opts: ['Auxiliaire pour la question','Verbe principal','Verbe modal','Verbe non-fini'], ans: 'Auxiliaire pour la question', hint: "Do en début de question = auxiliaire primaire qui forme l'interrogatif." },
      { q: "Past participle de 'go' ?", opts: ['gone','went','going','to go'], ans: 'gone', hint: "Gone = past participle (V3) de go. Went = simple past (V2)." },
      { q: "Quel type est 'look forward to' ?", opts: ['Verb + Adverb + Preposition','Verb + Adverb','Verb + Preposition','Verbe fini'], ans: 'Verb + Adverb + Preposition', hint: "Look forward to = Verb + Adverb (forward) + Preposition (to)." },
      { q: "Quel verbe est non-fini dans 'He wants to leave' ?", opts: ['to leave','wants','He','wants to'], ans: 'to leave', hint: "To leave = infinitif (non-fini). Wants = verbe fini (accord sujet)." },
      { q: "Parmi les modaux, lequel exprime la permission ?", opts: ['may','must','should','will'], ans: 'may', hint: "May → permission ou possibilité. Must → nécessité. Should → conseil." },
    ],
    [
      { q: "Quel auxiliaire primaire sert à former le present perfect ?", opts: ['have','be','do','used to'], ans: 'have', hint: "Have/has + past participle → present perfect : She has finished." },
      { q: "Quel auxiliaire primaire forme la voix passive ?", opts: ['be','have','do','modal'], ans: 'be', hint: "Be + past participle → voix passive : The letter was written by him." },
      { q: "Quelle est la différence entre 'look at' et 'look forward to' ?", opts: ["Look at = Verb+Prep ; look forward to = Verb+Adv+Prep","Ce sont des synonymes","Look at = non-fini ; look forward to = fini","Look at = modal ; look forward to = auxiliaire"], ans: "Look at = Verb+Prep ; look forward to = Verb+Adv+Prep", hint: "Look at (V+Prep) vs look forward to (V+Adv+Prep) — deux structures différentes." },
      { q: "Identifier le gerund : 'Running is good for health.'", opts: ['Running','is','good','health'], ans: 'Running', hint: "Running en début de phrase = gérondif (non-fini) qui sert de sujet." },
      { q: "Quelle liste contient uniquement des modaux ?", opts: ['can, could, may, must, shall','be, do, have, must','am, is, are, can','go, come, take, will'], ans: 'can, could, may, must, shall', hint: "Les modaux : can, could, may, might, shall, should, will, would, must, ought to…" },
      { q: "Que signifie 'depend on' comme phrasal verb ?", opts: ['Dépendre de','Compter à','Regarder sur','Attendre pour'], ans: 'Dépendre de', hint: "Depend on (Verb + Preposition) → dépendre de, compter sur." },
    ],
  ],
  'idioms-work-learning': [
    [
      { q: "Que signifie 'go the extra mile' ?", opts: ['Faire plus que nécessaire','Parcourir une grande distance','Travailler plus longtemps','Aller au bureau à pied'], ans: 'Faire plus que nécessaire', hint: "Go the extra mile → fournir un effort supplémentaire au-delà des attentes." },
      { q: "Que signifie 'cut corners' ?", opts: ['Rogner sur la qualité / faire les choses à moitié','Prendre des raccourcis physiques','Économiser sur tout','Réduire les coûts'], ans: 'Rogner sur la qualité / faire les choses à moitié', hint: "Cut corners → faire quelque chose plus vite ou moins bien pour économiser." },
      { q: "Que signifie 'leave no stone unturned' ?", opts: ['Tout essayer / ne rien laisser au hasard','Chercher partout','Ne rien oublier','Retourner les pierres'], ans: 'Tout essayer / ne rien laisser au hasard', hint: "Leave no stone unturned → faire tout ce qui est possible pour trouver une solution." },
      { q: "Que signifie 'hit the nail on the head' ?", opts: ['Dire exactement ce qu\'il faut / mettre le doigt dessus','Réussir du premier coup','Trouver la solution rapidement','Frapper juste'], ans: "Dire exactement ce qu'il faut / mettre le doigt dessus", hint: "Hit the nail on the head → identifier parfaitement le problème ou la solution." },
      { q: "Que signifie 'get the hang of it' ?", opts: ['Prendre le coup de main / comprendre comment faire','Accrocher quelque chose','Commencer à apprécier','Attraper le rythme'], ans: 'Prendre le coup de main / comprendre comment faire', hint: "Get the hang of it → apprendre à maîtriser quelque chose après de la pratique." },
      { q: "Que signifie 'know the ropes' ?", opts: ['Connaître les ficelles du métier','Apprendre les bases','Maîtriser les détails techniques','Comprendre les règles'], ans: 'Connaître les ficelles du métier', hint: "Know the ropes → comprendre comment les choses fonctionnent dans un domaine." },
    ],
    [
      { q: "Traduire : 'Elle a tout essayé pour retrouver son chien.'", opts: ["She left no stone unturned to find her dog.","She missed the boat to find her dog.","She burned the midnight oil to find her dog.","She hit the jackpot finding her dog."], ans: "She left no stone unturned to find her dog.", hint: "Leave no stone unturned → faire tout ce qui est possible." },
      { q: "Que signifie 'in over your head' ?", opts: ['Être dépassé par les événements','Être submergé de travail','Avoir trop de responsabilités','Avoir accepté trop de projets'], ans: 'Être dépassé par les événements', hint: "In over your head → trop impliqué pour gérer la situation." },
      { q: "Que signifie \"don't count your chickens before they hatch\" ?", opts: ["Ne vendez pas la peau de l'ours","Soyez patient","Ne présumez pas du succès","Ne comptez pas sur l'avenir"], ans: "Ne vendez pas la peau de l'ours", hint: "Don't count your chickens → ne présumez pas d'un résultat avant qu'il soit acquis." },
      { q: "Que signifie 'no pain, no gain' ?", opts: ['Sans effort, pas de résultat','Il faut souffrir pour réussir','Le travail est difficile','La réussite demande du sacrifice'], ans: 'Sans effort, pas de résultat', hint: "No pain, no gain → pas de progrès sans effort et sans difficultés." },
      { q: "Que signifie 'get out of hand' ?", opts: ['Devenir incontrôlable','Dépasser les bornes','Échapper à tout contrôle','Toutes ces réponses'], ans: 'Toutes ces réponses', hint: "Get out of hand → une situation qui devient impossible à contrôler." },
      { q: "Traduire : 'Pour résumer, c'était une réussite totale.'", opts: ["To make a long story short, it was a complete success.","To cut to the chase, it was a complete success.","All in all, it was a complete success.","To cut corners, it was a complete success."], ans: "To make a long story short, it was a complete success.", hint: "Make a long story short → résumer en sautant les détails." },
    ],
  ],
  'idioms-communication': [
    [
      { q: "Que signifie 'cut to the chase' ?", opts: ["En venir au fait / aller droit au but","Couper court à la conversation","Interrompre quelqu'un","Changer de sujet"], ans: "En venir au fait / aller droit au but", hint: "Cut to the chase → venir directement à l'essentiel sans détours." },
      { q: "Que signifie 'read between the lines' ?", opts: ['Lire entre les lignes / comprendre le sens caché','Analyser en détail','Chercher le double sens','Interpréter un texte'], ans: 'Lire entre les lignes / comprendre le sens caché', hint: "Read between the lines → comprendre ce qui n'est pas dit explicitement." },
      { q: "Que signifie 'your guess is as good as mine' ?", opts: ["Je n'en sais pas plus que toi","On a les mêmes chances","Je suppose la même chose","On pense pareil"], ans: "Je n'en sais pas plus que toi", hint: "Your guess is as good as mine → je suis aussi ignorant que toi sur ce sujet." },
      { q: "Que signifie 'rain on someone's parade' ?", opts: ["Gâcher la fête / briser les plans de quelqu'un","Critiquer quelqu'un en public","Décevoir quelqu'un","Ruiner les efforts de quelqu'un"], ans: "Gâcher la fête / briser les plans de quelqu'un", hint: "Rain on someone's parade → gâcher le bonheur ou les plans de quelqu'un." },
      { q: "Que signifie 'twist someone's arm' ?", opts: ["Forcer la main à quelqu'un / convaincre sous pression","Blesser quelqu'un","Exercer une pression physique","Convaincre facilement"], ans: "Forcer la main à quelqu'un / convaincre sous pression", hint: "Twist someone's arm → persuader quelqu'un contre son gré." },
      { q: "Que signifie 'give someone the cold shoulder' ?", opts: ["Ignorer quelqu'un volontairement","Être froid avec quelqu'un","Traiter quelqu'un avec mépris","Éviter quelqu'un"], ans: "Ignorer quelqu'un volontairement", hint: "Give someone the cold shoulder → ignorer délibérément quelqu'un." },
    ],
    [
      { q: "Traduire : 'Arrête de tourner autour du pot et dis-moi la vérité.'", opts: ["Stop beating around the bush and tell me the truth.","Stop cutting corners and tell me the truth.","Stop rocking the boat and tell me the truth.","Stop spilling the beans and tell me the truth."], ans: "Stop beating around the bush and tell me the truth.", hint: "Beat around the bush → tourner autour du pot, éviter le sujet." },
      { q: "Que signifie 'break the ice' ?", opts: ["Briser la glace / créer une atmosphère détendue","Commencer une réunion","Résoudre un problème","Faire une blague"], ans: "Briser la glace / créer une atmosphère détendue", hint: "Break the ice → faire quelque chose pour détendre l'atmosphère dans un groupe." },
      { q: "Que signifie 'pass the buck' ?", opts: ["Se décharger de la responsabilité","Passer l'argent à quelqu'un","Déléguer une tâche","Éviter une obligation"], ans: "Se décharger de la responsabilité", hint: "Pass the buck → transférer la responsabilité à quelqu'un d'autre." },
      { q: "Que signifie 'rock the boat' ?", opts: ["Faire des vagues / semer le trouble","Provoquer une crise","Créer des problèmes dans une situation stable","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Rock the boat → perturber une situation stable et fonctionnelle." },
      { q: "Que signifie 'steal someone's thunder' ?", opts: ["Voler la vedette à quelqu'un","Utiliser les idées de quelqu'un","Prendre le mérite de quelqu'un","Interrompre quelqu'un"], ans: "Voler la vedette à quelqu'un", hint: "Steal someone's thunder → attirer l'attention à la place de quelqu'un d'autre." },
      { q: "Que signifie 'wrap your head around' ?", opts: ["Arriver à comprendre quelque chose de difficile","Analyser en profondeur","Étudier attentivement","Chercher à comprendre"], ans: "Arriver à comprendre quelque chose de difficile", hint: "Wrap your head around → réussir à comprendre quelque chose de complexe." },
    ],
  ],
  'idioms-feelings-situations': [
    [
      { q: "Que signifie 'every cloud has a silver lining' ?", opts: ['Après la pluie le beau temps / il y a du bon dans chaque mauvaise situation','Chaque problème a une solution','Soyez optimiste','Il faut toujours espérer'], ans: 'Après la pluie le beau temps / il y a du bon dans chaque mauvaise situation', hint: "Every cloud has a silver lining → même dans une mauvaise situation, il y a un aspect positif." },
      { q: "Que signifie 'keep your chin up' ?", opts: ['Garde la tête haute / courage','Sois fier','Ne montre pas tes faiblesses','Reste positif'], ans: 'Garde la tête haute / courage', hint: "Keep your chin up → rester courageux et optimiste malgré les difficultés." },
      { q: "Que signifie 'blow off steam' ?", opts: ["Décompresser / évacuer sa frustration","Exploser de colère","Faire de l'exercice","Se défouler physiquement"], ans: "Décompresser / évacuer sa frustration", hint: "Blow off steam → libérer sa tension ou sa frustration accumulée." },
      { q: "Que signifie 'in the same boat' ?", opts: ['Dans la même galère / même situation','Avoir les mêmes problèmes','Être solidaires','Faire face aux mêmes difficultés'], ans: 'Dans la même galère / même situation', hint: "In the same boat → être dans la même situation difficile que quelqu'un d'autre." },
      { q: "Que signifie 'add insult to injury' ?", opts: ["En rajouter / aggraver une mauvaise situation","Blesser et insulter quelqu'un","Cumuler les problèmes","Frapper quelqu'un de mots"], ans: "En rajouter / aggraver une mauvaise situation", hint: "Add insult to injury → rendre une mauvaise situation encore pire." },
      { q: "Que signifie 'get cold feet' ?", opts: ["Avoir la frousse / perdre courage au dernier moment","Avoir froid","Hésiter avant de commencer","Renoncer à un projet"], ans: "Avoir la frousse / perdre courage au dernier moment", hint: "Get cold feet → perdre courage et hésiter juste avant de faire quelque chose." },
    ],
    [
      { q: "Que signifie 'better late than never' ?", opts: ['Mieux vaut tard que jamais','Il faut s\'excuser quand on est en retard','Un retard vaut mieux qu\'une absence','Il vaut mieux agir même tardivement'], ans: "Mieux vaut tard que jamais", hint: "Better late than never → il vaut mieux faire quelque chose tard que de ne pas le faire du tout." },
      { q: "Que signifie 'the best of both worlds' ?", opts: ['Le meilleur des deux mondes / tous les avantages','Le meilleur choix possible','Avoir le beurre et l\'argent du beurre','Profiter de tout'], ans: 'Le meilleur des deux mondes / tous les avantages', hint: "The best of both worlds → profiter des avantages de deux options différentes." },
      { q: "Que signifie 'easy does it' ?", opts: ['Doucement / vas-y mollo','Simplicité avant tout','Ne te complique pas la vie','Le plus facile d\'abord'], ans: 'Doucement / vas-y mollo', hint: "Easy does it → conseil de prudence : faire quelque chose lentement et avec soin." },
      { q: "Que signifie 'on the ball' ?", opts: ['Vif et efficace / réactif','À l\'aise','Concentré','Performant'], ans: 'Vif et efficace / réactif', hint: "On the ball → être alerte, compétent et réactif." },
      { q: "Que signifie 'up in the air' ?", opts: ["Dans l'incertitude / pas encore décidé","Sans fondement","Impossible","En suspension"], ans: "Dans l'incertitude / pas encore décidé", hint: "Up in the air → une situation encore incertaine, pas encore résolue." },
      { q: "Que signifie 'on thin ice' ?", opts: ['Sur un terrain glissant / situation risquée',"Dans une position délicate","En danger","À la limite"], ans: 'Sur un terrain glissant / situation risquée', hint: "On thin ice → dans une situation précaire où une erreur pourrait avoir de graves conséquences." },
    ],
  ],
  'idioms-decisions-risks': [
    [
      { q: "Que signifie 'sit on the fence' ?", opts: ['Rester neutre / ne pas se décider','Éviter les conflits','Refuser de choisir','Être indécis'], ans: 'Rester neutre / ne pas se décider', hint: "Sit on the fence → refuser de prendre position dans un débat ou une décision." },
      { q: "Que signifie 'take the bull by the horns' ?", opts: ["Prendre le taureau par les cornes / affronter directement","S'attaquer à un problème difficile","Agir avec courage","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Take the bull by the horns → affronter un problème difficile avec courage et décision." },
      { q: "Que signifie 'let sleeping dogs lie' ?", opts: ["Ne pas réveiller le chat qui dort / ne pas ranimer un vieux problème","Laisser les choses aller","Ignorer les problèmes","Éviter les conflits"], ans: "Ne pas réveiller le chat qui dort / ne pas ranimer un vieux problème", hint: "Let sleeping dogs lie → ne pas soulever un problème qui s'est calmé." },
      { q: "Que signifie 'off the hook' ?", opts: ["Tiré d'affaire / hors de cause","Libre de toute obligation","Sans responsabilité","Hors de danger"], ans: "Tiré d'affaire / hors de cause", hint: "Off the hook → ne plus être tenu responsable ou en difficulté." },
      { q: "Que signifie 'costs an arm and a leg' ?", opts: ["Coûter les yeux de la tête","Être très cher","Être hors de prix","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Costs an arm and a leg → quelque chose d'extrêmement cher." },
      { q: "Que signifie 'cold turkey' ?", opts: ["Arrêter quelque chose d'un coup / sevrage brutal","Manger sainement","Être très courageux","Ne rien dire"], ans: "Arrêter quelque chose d'un coup / sevrage brutal", hint: "Cold turkey → arrêter une addiction ou une habitude brutalement, sans aide progressive." },
    ],
    [
      { q: "Traduire : 'Il a dû assumer les conséquences de sa décision.'", opts: ["He had to face the music for his decision.","He had to throw in the towel for his decision.","He had to bite the bullet for his decision.","He had to jump the gun for his decision."], ans: "He had to face the music for his decision.", hint: "Face the music → assumer les conséquences, souvent désagréables." },
      { q: "Que signifie 'cry over spilled milk' ?", opts: ["Se lamenter en vain / pleurer sur du lait renversé","Regretter ses erreurs","Ressasser le passé","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Cry over spilled milk → se lamenter sur quelque chose qui ne peut pas être changé." },
      { q: "Que signifie 'jump on the bandwagon' ?", opts: ['Suivre la tendance / faire comme tout le monde','Profiter d\'une opportunité','Rejoindre un mouvement populaire','Faire ce que font les autres'], ans: "Suivre la tendance / faire comme tout le monde", hint: "Jump on the bandwagon → adopter une mode ou une idée parce que tout le monde le fait." },
      { q: "Que signifie 'take it with a grain of salt' ?", opts: ["Ne pas prendre trop au sérieux","Remettre en question","Accueillir avec scepticisme","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Take it with a grain of salt → ne pas croire ou accepter quelque chose entièrement." },
      { q: "Que signifie 'the ball is in your court' ?", opts: ["C'est à toi de jouer / c'est ta décision","Tu as la responsabilité","C'est ton tour d'agir","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "The ball is in your court → c'est maintenant à l'autre personne d'agir ou de décider." },
      { q: "Que signifie \"don't put it past someone\" ?", opts: ["Croire quelqu'un capable du pire","Ne pas faire confiance","Soupçonner quelqu'un","Penser le pire de quelqu'un"], ans: "Croire quelqu'un capable du pire", hint: "Don't put it past someone → croire que cette personne est capable de faire quelque chose de mal." },
    ],
  ],
  'idioms-character-attitude': [
    [
      { q: "Que signifie 'a leopard can't change its spots' ?", opts: ["On ne change pas sa nature","Il faut accepter les gens","Les habitudes persistent","Tout le monde peut changer"], ans: "On ne change pas sa nature", hint: "A leopard can't change its spots → la nature profonde d'une personne ne change pas." },
      { q: "Que signifie 'barking up the wrong tree' ?", opts: ["Faire fausse route / se tromper de cible","Chercher au mauvais endroit","Accuser la mauvaise personne","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Barking up the wrong tree → chercher ou accuser dans la mauvaise direction." },
      { q: "Que signifie 'skeleton in the closet' ?", opts: ["Un secret honteux / un cadavre dans le placard","Un problème caché","Un secret de famille","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Skeleton in the closet → un secret embarrassant que quelqu'un cache." },
      { q: "Que signifie 'the tip of the iceberg' ?", opts: ["La partie visible d'un problème bien plus grand","Le début d'un problème","Un problème mineur","Le premier symptôme"], ans: "La partie visible d'un problème bien plus grand", hint: "The tip of the iceberg → ce qu'on voit n'est qu'une petite partie d'un problème plus vaste." },
      { q: "Que signifie 'to each their own' ?", opts: ["Chacun ses goûts / à chacun le sien","Tout le monde est différent","On a tous nos préférences","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "To each their own → chacun a le droit d'avoir ses propres goûts et préférences." },
      { q: "Que signifie 'not my cup of tea' ?", opts: ["Ce n'est pas mon truc / pas à mon goût","Je n'aime pas le thé","Ce n'est pas mon style","Je préfère autre chose"], ans: "Ce n'est pas mon truc / pas à mon goût", hint: "Not my cup of tea → quelque chose qui ne correspond pas à nos goûts ou préférences." },
    ],
    [
      { q: "Que signifie 'devil's advocate' ?", opts: ["Avocat du diable / argumenter par principe","Défendre une mauvaise cause","Prendre une position extrême","Provoquer un débat"], ans: "Avocat du diable / argumenter par principe", hint: "Devil's advocate → défendre une position à laquelle on ne croit pas forcément, pour stimuler le débat." },
      { q: "Que signifie 'keep your fingers crossed' ?", opts: ["Croiser les doigts / espérer bonne chance","Prier pour quelque chose","Espérer le meilleur","Faire un vœu"], ans: "Croiser les doigts / espérer bonne chance", hint: "Keep your fingers crossed → espérer que quelque chose se passe bien." },
      { q: "Que signifie 'under your nose' ?", opts: ["Sous ton nez / évident","Juste devant toi","Obvious","Pas difficile à trouver"], ans: "Sous ton nez / évident", hint: "Under your nose → quelque chose d'évident qui était là depuis le début sans être remarqué." },
      { q: "Que signifie 'go down in flames' ?", opts: ["Échouer de façon spectaculaire","Perdre complètement","Subir une défaite cuisante","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Go down in flames → échouer de manière dramatique et visible." },
      { q: "Que signifie 'not playing with a full deck' ?", opts: ["Ne pas avoir toute sa tête / un peu fou","Manquer d'intelligence","Avoir des lacunes","Être bizarre"], ans: "Ne pas avoir toute sa tête / un peu fou", hint: "Not playing with a full deck → manquer de bon sens ou de santé mentale." },
      { q: "Que signifie \"don't bite the hand that feeds you\" ?", opts: ["Ne mords pas la main qui te nourrit","Sois reconnaissant","Ne trahis pas ceux qui t'aident","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Don't bite the hand that feeds you → ne pas nuire à ceux dont on dépend." },
    ],
  ],
  'take-expressions': [
    [
      { q: "Compléter : 'Please ___ — the doctor will see you shortly.'", opts: ['take a seat','take a stand','take a break','take the floor'], ans: 'take a seat', hint: "Take a seat → s'asseoir / se mettre à sa place." },
      { q: "Que signifie 'take into account' ?", opts: ['Prendre en compte / tenir compte de','Prendre note','Prendre en considération uniquement','Compter sur quelqu\'un'], ans: 'Prendre en compte / tenir compte de', hint: "Take into account → tenir compte de, considérer dans sa réflexion." },
      { q: "Que signifie 'take the floor' ?", opts: ['Prendre la parole','Prendre le sol','Commencer à parler','Diriger la réunion'], ans: 'Prendre la parole', hint: "Take the floor → prendre la parole, s'adresser à un groupe." },
      { q: "Différence entre 'take a chance' et 'take your chance' ?", opts: ["Take a chance = tenter le coup (spontané) ; take your chance = saisir l'occasion","Ils sont synonymes","Take your chance est plus formel","Take a chance s'utilise uniquement au jeu"], ans: "Take a chance = tenter le coup (spontané) ; take your chance = saisir l'occasion", hint: "Take a chance (spontané) vs take your chance (occasion qui se présente)." },
      { q: "Compléter : 'Don't rush — ___ to review the terms.'", opts: ['take your time','take a break','take a stand','take action'], ans: 'take your time', hint: "Take your time → prendre son temps, ne pas se presser." },
      { q: "Que signifie 'take back your words' ?", opts: ['Retirer ce qu\'on a dit','Se corriger','S\'excuser','Revenir sur sa décision'], ans: "Retirer ce qu'on a dit", hint: "Take back your words → retirer ses paroles, admettre qu'on avait tort." },
    ],
    [
      { q: "Que signifie 'take action' ?", opts: ["Passer à l'action","Prendre des mesures","Agir concrètement","Toutes ces réponses"], ans: "Toutes ces réponses", hint: "Take action → agir, passer des paroles aux actes." },
      { q: "Compléter : '___ during the meeting — the boss expects it.'", opts: ['Take notes','Take a break','Take a stand','Take a nap'], ans: 'Take notes', hint: "Take notes → prendre des notes (pendant une réunion, un cours)." },
      { q: "Que signifie 'take a stand' ?", opts: ['Prendre position / défendre un point de vue','S\'affirmer','S\'opposer ouvertement','Toutes ces réponses'], ans: 'Toutes ces réponses', hint: "Take a stand → prendre position, défendre une opinion fermement." },
      { q: "Que signifie 'take care of yourself' ?", opts: ['Prendre soin de soi','S\'occuper de soi-même','Faire attention à sa santé','Toutes ces réponses'], ans: 'Toutes ces réponses', hint: "Take care of yourself → prendre soin de sa santé et de son bien-être." },
      { q: "Compléter : 'I ___ what I said — I was wrong.'", opts: ['take back','take out','take away','take apart'], ans: 'take back', hint: "Take back → retirer, rétracter ce qu'on a dit." },
      { q: "Que signifie 'take a role' ?", opts: ['Prendre un rôle / assumer une fonction','Jouer un personnage','Participer à quelque chose','Avoir une responsabilité'], ans: 'Prendre un rôle / assumer une fonction', hint: "Take a role → assumer un rôle, une responsabilité dans quelque chose." },
    ],
  ],
  'housework-vocabulary': [
    [
      { q: "Que signifie 'to mop' ?", opts: ['Laver le sol à la serpillière','Balayer','Nettoyer les vitres','Frotter'], ans: 'Laver le sol à la serpillière', hint: "To mop → passer la serpillière (mop) sur le sol." },
      { q: "Que signifie 'to dust' ?", opts: ['Épousseter','Balayer','Essuyer','Rincer'], ans: 'Épousseter', hint: "To dust → enlever la poussière (dust = poussière)." },
      { q: "Que signifie 'to iron' ?", opts: ['Repasser','Ranger','Plier','Étendre'], ans: 'Repasser', hint: "To iron → repasser les vêtements avec un fer à repasser." },
      { q: "Que signifie 'to tidy up' ?", opts: ['Ranger / mettre en ordre','Nettoyer','Faire la vaisselle','Essuyer'], ans: 'Ranger / mettre en ordre', hint: "To tidy up → ranger le désordre, mettre de l'ordre." },
      { q: "Que signifie 'to sweep' ?", opts: ['Balayer','Frotter','Laver le sol','Essuyer'], ans: 'Balayer', hint: "To sweep → balayer avec un balai (broom)." },
      { q: "Que signifie 'to air out' ?", opts: ['Aérer','Nettoyer en profondeur','Secouer les tapis','Ouvrir toutes les fenêtres'], ans: 'Aérer', hint: "To air out → ouvrir les fenêtres pour renouveler l'air d'une pièce." },
    ],
    [
      { q: "Que signifie 'to scrub' ?", opts: ['Frotter énergiquement','Laver','Essuyer','Rincer'], ans: 'Frotter énergiquement', hint: "To scrub → frotter avec force pour nettoyer (la baignoire, le sol…)." },
      { q: "Que signifie 'to fold the clothes' ?", opts: ['Plier les vêtements','Ranger les vêtements','Étendre le linge','Repasser'], ans: 'Plier les vêtements', hint: "To fold (the clothes) → plier soigneusement les vêtements après lavage." },
      { q: "Que signifie 'to hang clothes' ?", opts: ['Étendre le linge','Accrocher au mur','Ranger dans l\'armoire','Plier'], ans: 'Étendre le linge', hint: "To hang clothes → étendre le linge pour le faire sécher." },
      { q: "Que signifie 'to make the bed' ?", opts: ['Faire le lit','Ranger la chambre','Mettre les draps','Nettoyer le matelas'], ans: 'Faire le lit', hint: "To make the bed → arranger le lit après s'être levé." },
      { q: "Que signifie 'to wipe' ?", opts: ['Essuyer','Rincer','Frotter','Laver'], ans: 'Essuyer', hint: "To wipe → essuyer une surface avec un chiffon ou une éponge." },
      { q: "Mettre dans le bon ordre logique :", opts: ['Sweep → mop → dry','Mop → sweep → dry','Dry → sweep → mop','Sweep → dry → mop'], ans: 'Sweep → mop → dry', hint: "On balaye d'abord (sweep), puis on passe la serpillière (mop), puis on laisse sécher." },
    ],
  ],
  'fixed-prepositions-1': [
    [
      { q: "He confessed ___ the theft.", opts: ['to','about','for','of'], ans: 'to', hint: "Confess TO something = avouer quelque chose." },
      { q: "I believe ___ second chances.", opts: ['in','of','to','at'], ans: 'in', hint: "Believe IN an idea or principle = croire en quelque chose." },
      { q: "She invested all her savings ___ this company.", opts: ['in','on','for','at'], ans: 'in', hint: "Invest IN something = investir dans quelque chose." },
      { q: "Stop interfering ___ my work!", opts: ['with','in','on','against'], ans: 'with', hint: "Interfere WITH = s'immiscer dans / entraver." },
      { q: "She focused ___ her studies.", opts: ['on','in','for','at'], ans: 'on', hint: "Focus ON = se concentrer sur." },
      { q: "They laughed ___ his mistake.", opts: ['at','to','with','on'], ans: 'at', hint: "Laugh AT = se moquer de. Laugh WITH = rire ensemble." },
    ],
    [
      { q: "She applied ___ the manager position.", opts: ['for','to','at','in'], ans: 'for', hint: "Apply FOR a job or position = postuler à." },
      { q: "He escaped ___ prison last night.", opts: ['from','of','to','in'], ans: 'from', hint: "Escape FROM a place = s'échapper de." },
      { q: "I'm longing ___ my summer holiday.", opts: ['for','to','about','in'], ans: 'for', hint: "Long FOR something = désirer ardemment." },
      { q: "She consented ___ the operation.", opts: ['to','for','in','with'], ans: 'to', hint: "Consent TO = consentir à / accepter formellement." },
      { q: "I haven't heard ___ her in weeks.", opts: ['from','about','of','at'], ans: 'from', hint: "Hear FROM sb = avoir des nouvelles de quelqu'un." },
      { q: "Do you agree ___ me on this point?", opts: ['with','to','about','on'], ans: 'with', hint: "Agree WITH a person ; Agree TO a proposal." },
    ],
  ],
  'fixed-prepositions-2': [
    [
      { q: "Please refrain ___ using your phone during the meeting.", opts: ['from','to','of','in'], ans: 'from', hint: "Refrain FROM doing = s'abstenir de faire." },
      { q: "He reminded me ___ my appointment.", opts: ['of','about','to','for'], ans: 'of', hint: "Remind sb OF something = rappeler quelque chose à quelqu'un." },
      { q: "This accident will result ___ serious consequences.", opts: ['in','from','to','of'], ans: 'in', hint: "Result IN = aboutir à (la conséquence)." },
      { q: "She surrendered ___ temptation.", opts: ['to','in','for','at'], ans: 'to', hint: "Surrender TO = céder à quelque chose." },
      { q: "He objected ___ the new proposal.", opts: ['to','about','against','with'], ans: 'to', hint: "Object TO = s'opposer à quelque chose." },
      { q: "She was punished ___ cheating.", opts: ['for','of','to','in'], ans: 'for', hint: "Punish sb FOR something = punir quelqu'un de." },
    ],
    [
      { q: "Take advantage ___ this opportunity!", opts: ['of','from','in','to'], ans: 'of', hint: "Take advantage OF = profiter de." },
      { q: "Let's talk ___ this problem.", opts: ['about','with','of','on'], ans: 'about', hint: "Talk ABOUT something = parler de quelque chose." },
      { q: "She translated the book ___ Spanish.", opts: ['into','from','in','to'], ans: 'into', hint: "Translate INTO the target language. Translate FROM the source." },
      { q: "I trust him ___ my most important files.", opts: ['with','in','of','to'], ans: 'with', hint: "Trust sb WITH something = confier quelque chose à quelqu'un." },
      { q: "We should vote ___ the best candidate.", opts: ['for','to','in','at'], ans: 'for', hint: "Vote FOR a candidate = voter pour." },
      { q: "He yielded ___ the pressure.", opts: ['to','in','for','at'], ans: 'to', hint: "Yield TO = céder à une pression ou une demande." },
    ],
  ],
  'what-when-why-questions': [
    [
      { q: "___ happened yesterday?", opts: ['What','When','Why','Who'], ans: 'What', hint: "What happened? → WHAT pour un événement ou une information." },
      { q: "___ do you hesitate?", opts: ['Why','When','What','Where'], ans: 'Why', hint: "Why do you…? → WHY + do + sujet → présent simple." },
      { q: "___ do you want to leave?", opts: ['When','Why','What','How'], ans: 'When', hint: "When do you want to…? → WHEN pour une information temporelle." },
      { q: "What ___ you want?", opts: ['do','are','did','is'], ans: 'do', hint: "What DO you want? → présent simple avec do." },
      { q: "Why ___ you say that?", opts: ['did','do','are','were'], ans: 'did', hint: "Why DID you say that? → passé simple → did + base verbale." },
      { q: "When ___ you coming back?", opts: ['are','do','did','were'], ans: 'are', hint: "When ARE you coming back? → présent continu → are + -ing." },
    ],
    [
      { q: "___ do you want for dinner?", opts: ['What','When','Why','Which'], ans: 'What', hint: "WHAT = demande un objet ou une information spécifique." },
      { q: "___ are you coming back?", opts: ['When','Why','What','Where'], ans: 'When', hint: "WHEN = demande une information temporelle (heure, date)." },
      { q: "___ did you say that to her?", opts: ['Why','When','What','Where'], ans: 'Why', hint: "WHY = demande une raison ou une explication." },
      { q: "___ makes you smile every day?", opts: ['What','When','Why','How'], ans: 'What', hint: "What makes you…? → sujet = what, pas de do." },
      { q: "Why ___ this happen?", opts: ['did','does','is','was'], ans: 'did', hint: "Why DID this happen? → passé simple → did." },
      { q: "Why ___ you late?", opts: ['are','do','did','were'], ans: 'are', hint: "Why ARE you late? → être en retard = be late → are." },
    ],
  ],
  'out-phrasal-verbs': [
    [
      { q: "You should ___ this new café — it's amazing!", opts: ['check out','find out','give out','run out'], ans: 'check out', hint: "Check out = jeter un œil / examiner (informel)." },
      { q: "The movie will ___ next Friday.", opts: ['come out','turn out','work out','carry out'], ans: 'come out', hint: "Come out = sortir / devenir public (livre, film…)." },
      { q: "How did the party ___?", opts: ['turn out','hang out','give out','figure out'], ans: 'turn out', hint: "Turn out = s'avérer / donner un résultat." },
      { q: "The volunteers ___ free food to everyone.", opts: ['gave out','figured out','ran out','came out'], ans: 'gave out', hint: "Give out = distribuer à un groupe." },
      { q: "We nearly ___ of petrol on the motorway.", opts: ['ran out','carried out','hung out','checked out'], ans: 'ran out', hint: "Run out of = ne plus avoir de stock de quelque chose." },
      { q: "She ___ the mystery in just minutes.", opts: ['figured out','came out','gave out','turned out'], ans: 'figured out', hint: "Figure out = résoudre / comprendre par la réflexion." },
    ],
    [
      { q: "We ___ that the concert had been cancelled.", opts: ['found out','worked out','hung out','ran out'], ans: 'found out', hint: "Find out = apprendre une information (souvent une surprise)." },
      { q: "He goes to the gym to ___ every morning.", opts: ['work out','carry out','check out','give out'], ans: 'work out', hint: "Work out = faire de l'exercice / s'entraîner." },
      { q: "It ___ that she had been right.", opts: ['turned out','came out','found out','ran out'], ans: 'turned out', hint: "Turn out = s'avérer (it turned out that…)." },
      { q: "The manager ___ the new safety procedures.", opts: ['carried out','checked out','gave out','hung out'], ans: 'carried out', hint: "Carry out = mettre en œuvre / exécuter officiellement." },
      { q: "The truth will eventually ___.", opts: ['come out','figure out','work out','turn out'], ans: 'come out', hint: "Come out = devenir public / être révélé." },
      { q: "We ___ at the beach all afternoon.", opts: ['hung out','ran out','checked out','gave out'], ans: 'hung out', hint: "Hang out (past: hung out) = passer du temps ensemble à se détendre." },
    ],
  ],
  'connectors-advanced-1': [
    [
      { q: "I enjoy hiking. ___, my friend loves cycling.", opts: ['Likewise','Still','Hence','Given that'], ans: 'Likewise', hint: "Likewise = De même / Pareillement (parallélisme)." },
      { q: "The film was long. ___, it was worth watching.", opts: ['Still','Owing to','Besides','As well as'], ans: 'Still', hint: "Still = Pourtant / Malgré tout (concession)." },
      { q: "He is talented. ___, he is incredibly hardworking.", opts: ['Not only that','In contrast','Yet','Though'], ans: 'Not only that', hint: "Not only that = Non seulement ça (renforcement addition)." },
      { q: "The beach was crowded. ___, it was dirty.", opts: ["What's more",'Hence','That said','Just as'], ans: "What's more", hint: "What's more = Qui plus est (accumulation)." },
      { q: "___ this challenge, he faced a budget problem.", opts: ['Along with','Yet','Hence','Though'], ans: 'Along with', hint: "Along with = En plus de (addition d'un élément)." },
      { q: "___ the storm, all flights were grounded.", opts: ['On account of','Just as','Still','As well as'], ans: 'On account of', hint: "On account of + nom = En raison de / À cause de." },
    ],
    [
      { q: "She didn't like the idea. ___, she gave it a try.", opts: ['All the same','Hence','Owing to','Likewise'], ans: 'All the same', hint: "All the same = Malgré tout / Quand même." },
      { q: "She loves art. ___, she loves music.", opts: ['Just as','Hence','On account of','Yet'], ans: 'Just as', hint: "Just as = Tout comme (parallélisme renforcé)." },
      { q: "The plan was good. ___, it was too expensive.", opts: ['Yet','Owing to','Likewise','Not only that'], ans: 'Yet', hint: "Yet = Pourtant / Cependant (contraste après affirmation)." },
      { q: "Traffic was heavy. ___, we arrived late.", opts: ['Hence','Besides','All the same','In contrast'], ans: 'Hence', hint: "Hence = D'où / Par conséquent (conséquence)." },
      { q: "London is expensive. ___, smaller cities are affordable.", opts: ['In contrast','Hence','Just as','Along with'], ans: 'In contrast', hint: "In contrast = En revanche / Par contraste." },
      { q: "___ his delay, the meeting still went well.", opts: ['Despite this','Likewise','Hence','As well as'], ans: 'Despite this', hint: "Despite this = Malgré cela (concession)." },
    ],
  ],
  'connectors-advanced-2': [
    [
      { q: "Hurry up — ___ you miss the last train!", opts: ['lest','as such','in the same vein','thereafter'], ans: 'lest', hint: "Lest = De peur que (précaution soutenue, anglais formel)." },
      { q: "He worked hard. ___, he got the promotion.", opts: ['Indeed','Previously','In this manner','Firstly'], ans: 'Indeed', hint: "Indeed = En effet (confirmation ou renforcement)." },
      { q: "___ the new policy, they simplified the process.", opts: ['Through this','All in all','As such','Otherwise'], ans: 'Through this', hint: "Through this = Grâce à cela / Par ce moyen." },
      { q: "___, she had worked at a rival company.", opts: ['Previously','In short','Clearly','Coupled with'], ans: 'Previously', hint: "Previously = Auparavant (séquence temporelle)." },
      { q: "The plan is, ___, a waste of money.", opts: ['clearly','by doing so','thereafter','speaking of'], ans: 'clearly', hint: "Clearly = Clairement (emphase directe)." },
      { q: "___ her talent, her dedication made her stand out.", opts: ['Coupled with','In summary','Firstly','Thereafter'], ans: 'Coupled with', hint: "Coupled with = Associé à (addition de facteurs)." },
    ],
    [
      { q: "He smiled and waved. ___, he made a good impression.", opts: ['In this manner','Lest','As such','All in all'], ans: 'In this manner', hint: "In this manner = De cette manière (référence au comportement précédent)." },
      { q: "___, they expanded to new markets.", opts: ['Thereafter','Clearly','In the same vein','Otherwise'], ans: 'Thereafter', hint: "Thereafter = Par la suite (suite chronologique)." },
      { q: "___, the film was too long but still enjoyable.", opts: ['In summary','By doing so','As such','Through this'], ans: 'In summary', hint: "In summary = En résumé (bilan concis)." },
      { q: "___ we're talking about food — have you tried that new restaurant?", opts: ['Speaking of','Firstly','Indeed','All in all'], ans: 'Speaking of', hint: "Speaking of = En parlant de (transition conversationnelle)." },
      { q: "The data was unclear. ___, the decision was delayed.", opts: ['As such','Lest','Previously','In the same vein'], ans: 'As such', hint: "As such = De ce fait (conclusion tirée de la situation)." },
      { q: "___ the policy is clear — follow the rules or face consequences.", opts: ['Overall','In this manner','Thereafter','Coupled with'], ans: 'Overall', hint: "Overall = Dans l'ensemble (bilan ou vue d'ensemble)." },
    ],
  ],
  'allow-let-permit-enable': [
    [
      { q: "Her parents ___ her go to the cinema with her friends.", opts: ['let','allowed','permitted','enabled'], ans: 'let', hint: "Let + bare infinitive (sans 'to'). Let her go = la laisser partir." },
      { q: "The museum does not ___ photography inside.", opts: ['permit','allow','let','enable'], ans: 'permit', hint: "Permit = formel, règles officielles. The museum does not permit = règle de l'établissement." },
      { q: "My new glasses ___ me to read small print.", opts: ['enable','allow','permit','let'], ans: 'enable', hint: "Enable = rendre possible (les lunettes me donnent la capacité de lire). ≠ autoriser." },
      { q: "You're ___ one hour to complete the test.", opts: ['allowed','permitted','let','enabled'], ans: 'allowed', hint: "You're allowed = on vous autorise / on vous accorde (allow au passif, sens de 'disposer de')." },
      { q: "She paused to ___ her eyes to adjust to the darkness.", opts: ['allow','let','permit','enable'], ans: 'allow', hint: "Allow ici = laisser le temps / l'espace pour que quelque chose se produise (faciliter, pas autoriser)." },
      { q: "The new motorway will ___ traffic to avoid the city centre.", opts: ['enable','allow','let','permit'], ans: 'enable', hint: "Enable = rendre possible (la route donne la capacité d'éviter le centre). Objet inanimé → enable." },
    ],
    [
      { q: "Quel verbe s'utilise avec un infinitif SANS 'to' ?", opts: ['let','allow','permit','enable'], ans: 'let', hint: "Let + bare infinitive (sans 'to') — Dad let me drive. ≠ allow/permit/enable + to." },
      { q: "Quel verbe ne s'utilise JAMAIS à la voix passive ?", opts: ['let','allow','permit','enable'], ans: 'let', hint: "Let ne s'utilise jamais au passif. On ne dit pas 'I was let to go' — on dit 'I was allowed to go'." },
      { q: "Quel verbe signifie 'rendre possible', pas 'autoriser' ?", opts: ['enable','allow','permit','let'], ans: 'enable', hint: "Enable = donner la capacité / rendre possible. ≠ allow/let/permit qui signifient autoriser." },
      { q: "Quel verbe est le plus formel et associé aux règles officielles ?", opts: ['permit','allow','let','enable'], ans: 'permit', hint: "Permit = le plus formel. Souvent dans des contextes officiels, juridiques ou institutionnels." },
      { q: "Dad ___ me to drive his car. (avec 'to', forme neutre)", opts: ['allowed','let','permitted','enabled'], ans: 'allowed', hint: "Allow + objet + TO + infinitif. ≠ let qui prend un bare infinitive sans 'to'." },
      { q: "This software will ___ us to track sales. (rendre capable)", opts: ['enable','allow','permit','let'], ans: 'enable', hint: "Enable = donner la capacité de faire. Software/tools/conditions → enable, pas allow." },
    ],
  ],
  'daily-commands-phrases': [
    [
      { q: "___ up early every day — it changes everything.", opts: ['Wake','Get','Show','Pick'], ans: 'Wake', hint: "WAKE up = se réveiller. Wake up early = se réveiller tôt (ouvrir les yeux)." },
      { q: "___ off the TV before going to bed.", opts: ['Turn','Take','Put','Switch'], ans: 'Turn', hint: "TURN off = éteindre. Turn off the TV = éteins la télévision." },
      { q: "___ on the light — I can't see a thing.", opts: ['Turn','Put','Get','Take'], ans: 'Turn', hint: "TURN on = allumer. Turn on the light = allume la lumière." },
      { q: "___ off your jacket — it's warm in here.", opts: ['Take','Put','Turn','Get'], ans: 'Take', hint: "TAKE off = enlever (un vêtement). Take off your jacket = enlève ta veste." },
      { q: "___ down a little — you're going too fast.", opts: ['Slow','Sit','Calm','Cut'], ans: 'Slow', hint: "SLOW down = ralentir (vitesse ou rythme). A little = un peu." },
      { q: "___ up and get ready — we leave in 10 minutes.", opts: ['Get','Wake','Show','Pick'], ans: 'Get', hint: "GET up = se lever (sortir du lit). ≠ Wake up = se réveiller (ouvrir les yeux)." },
    ],
    [
      { q: "Tu veux dire à quelqu'un d'allumer la lumière :", opts: ['Turn on the light.','Turn off the TV.','Put on your shoes.','Take off your jacket.'], ans: 'Turn on the light.', hint: "Turn on = allumer. Turn on the light = allume la lumière." },
      { q: "Tu veux dire à quelqu'un d'enlever un vêtement :", opts: ['Take off your jacket.','Put on your shoes.','Turn off the TV.','Slow down a little.'], ans: 'Take off your jacket.', hint: "Take off = enlever (vêtement). Opposé : put on = mettre." },
      { q: "Tu veux dire à quelqu'un de ralentir son rythme :", opts: ['Slow down a little.','Sit down and relax.','Turn off the TV.','Get up and get ready.'], ans: 'Slow down a little.', hint: "Slow down a little = ralentis un peu (rythme ou vitesse)." },
      { q: "Tu veux dire à quelqu'un de s'asseoir et se détendre :", opts: ['Sit down and relax.','Slow down a little.','Wake up early every day.','Get up and get ready.'], ans: 'Sit down and relax.', hint: "Sit down and relax = assieds-toi et détends-toi (deux impératifs en un)." },
      { q: "Tu veux dire à quelqu'un d'éteindre la télé :", opts: ['Turn off the TV.','Turn on the light.','Take off your jacket.','Slow down a little.'], ans: 'Turn off the TV.', hint: "Turn off = éteindre. Turn off the TV = éteins la télévision." },
      { q: "Tu veux dire à quelqu'un de se lever et se préparer :", opts: ['Get up and get ready.','Wake up early every day.','Sit down and relax.','Put on your shoes.'], ans: 'Get up and get ready.', hint: "Get up and get ready = lève-toi et prépare-toi (deux actions matinales)." },
    ],
  ],
  'motivational-phrases': [
    [
      { q: "___ humble — success won't last without it.", opts: ['Stay','Be','Keep','Act'], ans: 'Stay', hint: "STAY humble = reste humble (stay + adjectif = rester dans un état permanent)." },
      { q: "___ yourself — authenticity is your strength.", opts: ['Be','Stay','Push','Keep'], ans: 'Be', hint: "BE yourself = sois toi-même (be + pronom réfléchi = être authentique)." },
      { q: "___ big — your dreams shape your reality.", opts: ['Dream','Think','Act','Work'], ans: 'Dream', hint: "DREAM big = rêve grand (avoir de grandes ambitions pour l'avenir)." },
      { q: "___ now — the right moment is always now.", opts: ['Act','Move','Work','Push'], ans: 'Act', hint: "ACT now = agis maintenant (passer à l'action sans attendre)." },
      { q: "___ focused — distractions are everywhere.", opts: ['Stay','Be','Keep','Push'], ans: 'Stay', hint: "STAY focused = reste concentré(e) (stay + adjectif = maintenir un état)." },
      { q: "___ it happen — no one will do it for you.", opts: ['Make','Let','Get','Do'], ans: 'Make', hint: "MAKE it happen = fais en sorte que ça arrive (make it happen = concrétiser)." },
    ],
    [
      { q: "You want to say 'avance, ne reste pas bloqué(e)' :", opts: ['Move forward.','Act now.','Stay focused.','Keep learning.'], ans: 'Move forward.', hint: "Move forward = avance / ne reste pas bloqué(e) dans le passé." },
      { q: "You want to say 'pense en grand, vise haut' (vision stratégique) :", opts: ['Think big.','Dream big.','Work hard.','Push yourself.'], ans: 'Think big.', hint: "Think big = pense grand (vision stratégique). Dream big = rêve grand (ambitions)." },
      { q: "You want to say 'sois toi-même' :", opts: ['Be yourself.','Stay humble.','Be kind.','Stay strong.'], ans: 'Be yourself.', hint: "Be yourself = sois toi-même — l'une des phrases motivantes les plus universelles." },
      { q: "You want to encourage someone to give 100% :", opts: ['Push yourself.','Work hard.','Stay focused.','Act now.'], ans: 'Push yourself.', hint: "Push yourself = donne-toi à fond / dépasse tes limites." },
      { q: "You want to say 'n'abandonne jamais' :", opts: ['Never give up.','Stay strong.','Move forward.',"Don't wait."], ans: 'Never give up.', hint: "Never give up = n'abandonne jamais — la phrase de motivation la plus universelle." },
      { q: "You want to say 'agis, n'attends pas' :", opts: ["Don't wait.",'Act now.','Move forward.','Make it happen.'], ans: "Don't wait.", hint: "Don't wait = n'attends pas — encouragement direct à passer à l'action." },
    ],
  ],
  'good-mood-expressions': [
    [
      { q: "I'm ___ with joy — this is the best news ever!", opts: ['bursting','full','shining','overflowing'], ans: 'bursting', hint: "I'm bursting WITH joy = je déborde de joie (bursting = débordant / explosant)." },
      { q: "I'm on cloud ___.", opts: ['nine','seven','ten','high'], ans: 'nine', hint: "I'm on cloud NINE = je suis aux anges — expression idiomatique, toujours 'nine'." },
      { q: "Nothing can ___ my day.", opts: ['ruin','break','stop','spoil'], ans: 'ruin', hint: "Nothing can RUIN my day = rien ne peut gâcher ma journée." },
      { q: "I'm ___ this moment.", opts: ['enjoying','loving','living','feeling'], ans: 'enjoying', hint: "I'm ENJOYING this moment = je profite pleinement de ce moment (présent continu)." },
      { q: "I'm ___ of energy this morning.", opts: ['full','burst','packed','loaded'], ans: 'full', hint: "I'm FULL of energy = je suis plein(e) d'énergie (full of = plein de)." },
      { q: "I'm ___ a great day.", opts: ['having','making','doing','getting'], ans: 'having', hint: "I'm HAVING a great day = je passe une excellente journée (have a day = passer une journée)." },
    ],
    [
      { q: "You want to express euphoric, top-of-the-world happiness:", opts: ["I'm on cloud nine.","I'm in a good mood.","I feel great.","I'm having a great day."], ans: "I'm on cloud nine.", hint: "I'm on cloud nine = état de bonheur extrême / être aux anges." },
      { q: "You feel vibrant and alive with energy:", opts: ["I'm full of energy.","I'm doing great!","I'm in a good mood.","I feel great."], ans: "I'm full of energy.", hint: "I'm full of energy = je suis plein(e) d'énergie (vitalité et dynamisme)." },
      { q: "You want to say you're thrilled by good news (formal):", opts: ["I'm delighted.","I'm so happy.","I feel fantastic.","I'm in a great mood."], ans: "I'm delighted.", hint: "I'm delighted = je suis ravi(e) — plus formel, souvent en réponse à une bonne nouvelle." },
      { q: "You're overflowing with happiness and want to show it:", opts: ["I'm bursting with joy.","I feel alive.","I'm doing great!","I'm on cloud nine."], ans: "I'm bursting with joy.", hint: "I'm bursting with joy = je déborde de joie (très expressif et enthousiaste)." },
      { q: "You want to say nothing can spoil your happiness today:", opts: ["Nothing can ruin my day.","I'm enjoying this moment.","I'm having a great day.","I'm in a great mood today."], ans: "Nothing can ruin my day.", hint: "Nothing can ruin my day = rien ne peut gâcher ma journée (sérénité absolue)." },
      { q: "You're fully present and savoring a special moment:", opts: ["I'm enjoying this moment.","I feel alive.","I'm on cloud nine.","I'm doing great!"], ans: "I'm enjoying this moment.", hint: "I'm enjoying this moment = je profite pleinement de ce moment (être pleinement présent)." },
    ],
  ],
  'basic-phrasal-verbs': [
    [
      { q: "___ ! The alarm has been ringing for 10 minutes.", opts: ['Wake up','Sit down','Come back','Show up'], ans: 'Wake up', hint: "Wake up = se réveiller. Impératif : Wake up! = Réveille-toi !" },
      { q: "Please ___ — the meeting is about to start.", opts: ['sit down','give up','come back','turn on'], ans: 'sit down', hint: "Sit down = s'asseoir. Please sit down = veuillez vous asseoir (formel)." },
      { q: "She spent an hour ___ her missing passport.", opts: ['looking for','picking up','figuring out','turning on'], ans: 'looking for', hint: "Look for = chercher activement quelque chose ou quelqu'un." },
      { q: "I'll ___ you ___ at the station at 8.", opts: ['pick / up','turn / on','come / back','show / up'], ans: 'pick / up', hint: "Pick up = venir chercher quelqu'un. I'll pick you up = je viendrai te chercher." },
      { q: "He ___ late to the party.", opts: ['showed up','gave up','woke up','came back'], ans: 'showed up', hint: "Show up (past: showed up) = se présenter / arriver quelque part." },
      { q: "She couldn't ___ the problem.", opts: ['figure out','look for','give up','show up'], ans: 'figure out', hint: "Figure out = comprendre / trouver la solution à quelque chose." },
    ],
    [
      { q: "___ the TV — the news is starting.", opts: ['Turn on','Put on','Wake up','Come back'], ans: 'Turn on', hint: "Turn on = allumer (télévision, radio, ordinateur…). Opposé : turn off." },
      { q: "Can you ___ my bag while I pay?", opts: ['pick up','look for','give up','turn on'], ans: 'pick up', hint: "Pick up = ramasser / prendre quelque chose. Can you pick it up? = peux-tu le ramasser ?" },
      { q: "Don't forget to ___ your coat — it's freezing!", opts: ['put on','turn on','pick up','look for'], ans: 'put on', hint: "Put on = enfiler / mettre un vêtement. Opposé : take off = enlever." },
      { q: "I ___ every morning at 6 am.", opts: ['wake up','show up','sit down','give up'], ans: 'wake up', hint: "Wake up = se réveiller. I wake up at 6 = je me réveille à 6h." },
      { q: "They never ___ even when things get tough.", opts: ['give up','show up','sit down','come back'], ans: 'give up', hint: "Give up = abandonner. They never give up = ils n'abandonnent jamais." },
      { q: "I couldn't ___ why the computer wasn't working.", opts: ['figure out','look for','give up','turn on'], ans: 'figure out', hint: "Figure out = comprendre / trouver la cause. I couldn't figure out why… = je n'arrivais pas à comprendre pourquoi…" },
    ],
  ],
  'assertive-phrases': [
    [
      { q: "That's not how ___ works.", opts: ['this','it','that','things'], ans: 'this', hint: "That's not how THIS works — 'this' renvoie à la situation ou la règle en question." },
      { q: "You ___ be kidding!", opts: ['must','should','could','might'], ans: 'must', hint: "You MUST be kidding = tu plaisantes j'espère — 'must' exprime l'incrédulité forte." },
      { q: "___ what you want — I know the truth.", opts: ['Believe','Think','Say','Do'], ans: 'Believe', hint: "BELIEVE what you want = crois ce que tu veux (refus de convaincre davantage)." },
      { q: "I don't need ___.", opts: ['approval','attention','permission','advice'], ans: 'approval', hint: "I don't need APPROVAL = je n'ai pas besoin d'approbation (affirmation d'indépendance)." },
      { q: "Don't ___ me.", opts: ['disappoint','ignore','blame','judge'], ans: 'disappoint', hint: "Don't DISAPPOINT me = ne me déçois pas (exprimer une attente forte envers quelqu'un)." },
      { q: "You made your ___.", opts: ['choice','mind','point','decision'], ans: 'choice', hint: "You made your CHOICE = tu as fait ton choix — 'choice' insiste sur la responsabilité personnelle." },
    ],
    [
      { q: "Someone shocks you with unexpected news. You say:", opts: ['You must be kidding!','Believe what you want.','You made your choice.',"That's not how this works."], ans: 'You must be kidding!', hint: "You must be kidding! = réaction d'incrédulité face à une information choquante ou surprenante." },
      { q: "Someone keeps misunderstanding a rule. You say:", opts: ["That's not how this works.",'I\'m not arguing.','Believe what you want.',"Don't disappoint me."], ans: "That's not how this works.", hint: "That's not how this works. = recadrer quelqu'un qui applique mal une règle ou un processus." },
      { q: "Someone insists on debating. You shut it down:", opts: ['I\'m not arguing.','Believe what you want.',"You made your choice.",'I don\'t need approval.'], ans: 'I\'m not arguing.', hint: "I'm not arguing. = je ne vais pas débattre davantage — fermer la discussion sans agressivité." },
      { q: "Someone questions your decision without your asking. You say:", opts: ["I don't need approval.",'I\'m not arguing.','Believe what you want.',"You must be kidding."], ans: "I don't need approval.", hint: "I don't need approval. = je n'ai pas besoin de justification ou de permission (indépendance)." },
      { q: "Someone refuses to believe you despite your explanations:", opts: ['Believe what you want.','I\'m not arguing.',"Don't disappoint me.","That's not how this works."], ans: 'Believe what you want.', hint: "Believe what you want. = se désengager élégamment d'un débat sans issue." },
      { q: "Someone made an irreversible decision. You acknowledge it:", opts: ['You made your choice.','You must be kidding.',"I don't need approval.",'Believe what you want.'], ans: 'You made your choice.', hint: "You made your choice. = constater qu'une décision a été prise — sous-entend des conséquences." },
    ],
  ],
  'changing-subject-expressions': [
    [
      { q: "___ — have you tried the new restaurant on Main Street?", opts: ['On a different note','Enough about that','Anyway',"Let's not go there"], ans: 'On a different note', hint: "On a different note = sur un autre sujet (transition polie vers un nouveau thème)." },
      { q: "___ — could we discuss something more pleasant?", opts: ["Let's talk about something else","Let's change the subject",'Anyway','By the way'], ans: "Let's talk about something else", hint: "Let's talk about something else = parlons d'autre chose (changement clair de sujet)." },
      { q: "We've talked about work all evening. ___ for a change!", opts: ["Let's change the subject","Let's not go there",'Anyway','Enough about that'], ans: "Let's change the subject", hint: "Let's change the subject = changeons de sujet (demande directe et explicite)." },
      { q: "___ — you mentioned something about a trip earlier.", opts: ['While I remember','By the way','Anyway','Before I forget'], ans: 'While I remember', hint: "While I remember = pendant que j'y pense (pour ne pas oublier de revenir sur un point)." },
      { q: "___ — I need to tell you something important before we go.", opts: ['Before I forget','Anyway',"Let's not go there",'Enough about that'], ans: 'Before I forget', hint: "Before I forget = avant que j'oublie (digression urgente avant la fin de la conversation)." },
      { q: "The weather there was amazing. ___ Paris last spring.", opts: ['That reminds me of','By the way','Anyway','On a different note'], ans: 'That reminds me of', hint: "That reminds me of = ça me fait penser à (lien par association d'idées)." },
    ],
    [
      { q: "___ — I have to leave in five minutes.", opts: ['Anyway','By the way','On a different note',"Let's not go there"], ans: 'Anyway', hint: "Anyway = bref (pour reprendre ou conclure après une digression)." },
      { q: "Politics is a touchy subject. ___.", opts: ["Let's not go there","Enough about that","Let's change the subject",'Anyway'], ans: "Let's not go there", hint: "Let's not go there = évitons ce sujet (pour un sujet délicat ou potentiellement conflictuel)." },
      { q: "___ — are you free this weekend?", opts: ['By the way','Anyway','On a different note','Enough about that'], ans: 'By the way', hint: "By the way = au fait (pour glisser une question sans lien avec le sujet précédent)." },
      { q: "___ the concert — I had tickets for that same venue last year!", opts: ['That reminds me of','While I remember','Before I forget','On a different note'], ans: 'That reminds me of', hint: "That reminds me of = ça me fait penser à (rebond naturel par association)." },
      { q: "___ — I think we've discussed this enough for today.", opts: ['Enough about that',"Let's not go there",'Anyway',"Let's change the subject"], ans: 'Enough about that', hint: "Enough about that = on a assez parlé de ça (clôture polie et définitive du sujet)." },
      { q: "___ — could you send me that document before Friday?", opts: ['While I remember','By the way','Anyway','Before I forget'], ans: 'While I remember', hint: "While I remember = pendant que j'y pense (pour glisser une demande pratique)." },
    ],
  ],
  'mind-expressions': [
    [
      { q: "Did it ___ that she might be upset?", opts: ['cross your mind','make up your mind','change your mind','bear in mind'], ans: 'cross your mind', hint: "Cross your mind = venir à l'esprit soudainement / traverser l'esprit." },
      { q: "Emma doesn't need advice — she has ___.", opts: ['a mind of her own','a one-track mind','two minds','her mind changed'], ans: 'a mind of her own', hint: "Have a mind of your own = penser par soi-même / prendre ses propres décisions." },
      { q: "The boy has ___; football is all he ever talks about.", opts: ['a one-track mind','a mind of his own','two minds','a changed mind'], ans: 'a one-track mind', hint: "One-track mind = n'avoir la tête qu'à une seule chose / être obsédé." },
      { q: "He's going to cycle around the world alone? Has he ___?", opts: ['gone out of his mind','changed his mind','made up his mind','crossed his mind'], ans: 'gone out of his mind', hint: "Gone out of your mind = avoir perdu la tête / être complètement fou." },
      { q: "Watch your words in front of the children — please ___!", opts: ['mind your language','speak your mind','mind your own business','never mind'], ans: 'mind your language', hint: "Mind your language = surveille ton langage / fais attention à ce que tu dis." },
      { q: "Andy always ___ — even when it makes people uncomfortable.", opts: ['speaks his mind','minds his business','changes his mind','makes up his mind'], ans: 'speaks his mind', hint: "Speak your mind = dire ce que l'on pense franchement, sans se censurer." },
    ],
    [
      { q: "Julie wasn't ___ when she spent all her savings on shoes.", opts: ['in her right mind','in two minds','out of her mind','of her own mind'], ans: 'in her right mind', hint: "Not in your right mind = ne pas avoir toute sa tête / agir de façon irrationnelle." },
      { q: "I was going to cancel, but I ___ when I saw the invitation again.", opts: ['changed my mind','crossed my mind','spoke my mind','made up my mind'], ans: 'changed my mind', hint: "Change your mind = revenir sur une décision initialement prise." },
      { q: "We haven't booked yet, but we have a hotel ___.", opts: ['in mind','on our minds','in two minds','across our minds'], ans: 'in mind', hint: "Have something in mind = avoir quelque chose en tête / envisager quelque chose." },
      { q: "It suddenly ___ that I had left the keys in the car.", opts: ['crossed my mind','made up my mind','changed my mind','bore in mind'], ans: 'crossed my mind', hint: "Cross your mind = traverser l'esprit soudainement / réaliser quelque chose tout à coup." },
      { q: "___ that all work must be submitted by midnight.", opts: ['Keep in mind','Speak your mind','Cross your mind','Make up your mind'], ans: 'Keep in mind', hint: "Keep in mind = garder à l'esprit (interchangeable avec bear in mind)." },
      { q: "Is she really going to quit her job? She must have ___!", opts: ['gone out of her mind','changed her mind','made up her mind','a one-track mind'], ans: 'gone out of her mind', hint: "Gone out of your mind = avoir complètement perdu la tête (étonnement / incrédulité)." },
    ],
  ],
  'correlative-conjunctions': [
    [
      { q: "Jack didn't know ___ to call or to send a letter.", opts: ['whether','either','both','neither'], ans: 'whether', hint: "Whether…or = si…ou (alternative dans une subordonnée, souvent avec know/decide)." },
      { q: "Emma liked ___ the location and the restaurant.", opts: ['both','either','not only','neither'], ans: 'both', hint: "Both…and = à la fois…et (les deux éléments sont vrais ensemble)." },
      { q: "They'd rather go to the beach ___ play tennis.", opts: ['than','or','and','but'], ans: 'than', hint: "Rather…than = plutôt…que (préférence entre deux options, souvent avec would)." },
      { q: "We had barely finished the game ___ it started to rain.", opts: ['when','than','that','as'], ans: 'when', hint: "Barely/hardly/scarcely…when — la paire correcte est 'when' (pas 'than')." },
      { q: "It's ___ a lack of money but a lack of planning.", opts: ['not','neither','either','both'], ans: 'not', hint: "Not…but = non pas…mais (correction / rectification d'une idée reçue)." },
      { q: "There are as ___ chairs as there are guests.", opts: ['many','much','more','most'], ans: 'many', hint: "As many…as = autant de (+ nom dénombrable) que — comparaison de quantité." },
    ],
    [
      { q: "___ travel and work, he had a tiring schedule.", opts: ['Between','Both','What with','Either'], ans: 'Between', hint: "Between…and = entre…et (deux éléments qui créent ensemble une situation)." },
      { q: "___ my job and the children, I have no free time.", opts: ['What with','Between','Both','Either'], ans: 'What with', hint: "What with…and = avec tout ce que représente (contexte d'explication ou de plainte)." },
      { q: "No sooner had she sat down ___ the alarm went off.", opts: ['than','when','that','as'], ans: 'than', hint: "No sooner…than — la paire exige obligatoirement 'than', jamais 'when'." },
      { q: "She is ___ talented but also incredibly hardworking.", opts: ['not only','neither','either','both'], ans: 'not only', hint: "Not only…but also = non seulement…mais aussi (double affirmation)." },
      { q: "Hugo was neither willing ___ able to help us.", opts: ['nor','or','and','but'], ans: 'nor', hint: "Neither…nor — 'nor' est la seconde partie obligatoire (jamais 'or' avec neither)." },
      { q: "___ a difficult exam was it that half the class failed.", opts: ['Such','So','Too','Very'], ans: 'Such', hint: "Such…that = si/tellement…que (such + groupe nominal, ici 'such a difficult exam')." },
    ],
  ],
  'across-phrasal-verbs': [
    [
      { q: "She ___ an amazing recipe in her grandmother's notebook.", opts: ['stumbled across','came across','ran across','went across'], ans: 'stumbled across', hint: "Stumble across = découvrir par accident, de manière totalement inattendue." },
      { q: "Can you ___ to get the remote control?", opts: ['reach across','look across','spread across','cut across'], ans: 'reach across', hint: "Reach across = tendre le bras par-dessus quelque chose pour attraper." },
      { q: "They need to ___ the river to reach the village.", opts: ['go across','cut across','come across','spread across'], ans: 'go across', hint: "Go across = traverser / se déplacer d'un côté à l'autre." },
      { q: "He managed to ___ his message despite the language barrier.", opts: ['get across','go across','come across','look across'], ans: 'get across', hint: "Get across = réussir à communiquer / faire passer un message clairement." },
      { q: "The fire ___ the hillside very quickly.", opts: ['spread across','reached across','ran across','cut across'], ans: 'spread across', hint: "Spread across = s'étendre / se propager sur une large surface." },
      { q: "She ___ the lake at the beautiful sunset.", opts: ['looked across','stumbled across','went across','reached across'], ans: 'looked across', hint: "Look across = porter son regard vers l'autre côté, vers ce qui est en face." },
    ],
    [
      { q: "I ___ my old diary while packing my bags.", opts: ['came across','ran across','went across','looked across'], ans: 'came across', hint: "Come across = trouver par hasard lors d'une autre activité." },
      { q: "He ___ an old friend at the railway station.", opts: ['ran across','came across','stumbled across','looked across'], ans: 'ran across', hint: "Run across = tomber sur quelqu'un que l'on connaît, par hasard." },
      { q: "We ___ the fields to avoid the traffic jam.", opts: ['cut across','spread across','go across','came across'], ans: 'cut across', hint: "Cut across = traverser en coupant pour prendre un chemin plus court." },
      { q: "The paint ___ the whole wall in seconds.", opts: ['spread across','reached across','looked across','cut across'], ans: 'spread across', hint: "Spread across = s'étaler / se répandre sur toute une surface." },
      { q: "She couldn't ___ the importance of the deadline.", opts: ['get across','go across','spread across','come across'], ans: 'get across', hint: "Get across = faire comprendre / communiquer clairement une idée urgente." },
      { q: "He ___ the old manuscript in the library archives.", opts: ['stumbled across','came across','ran across','went across'], ans: 'stumbled across', hint: "Stumble across = tomber par hasard sur une découverte inattendue." },
    ],
  ],
  'job-interview-phrases': [
    [
      { q: "Strength signifie :", opts: ['Force','Faiblesse','Compétence','Flexibilité'], ans: 'Force', hint: "Strength = force, point fort (opposé de weakness = faiblesse)." },
      { q: "Deadline signifie :", opts: ['Date limite','Efficacité','Disponibilité','Intérêt'], ans: 'Date limite', hint: "Deadline = date limite, délai à ne pas dépasser (dead + line)." },
      { q: "Aimez-vous travailler en équipe ?", opts: ['Do you like teamwork?','Do you prefer working alone?','How do you handle stress?','What are your strengths?'], ans: 'Do you like teamwork?', hint: "Teamwork = travail en équipe. Like + V-ing = aimer faire quelque chose.", _isSentence: true },
      { q: "Quelle expérience avez-vous ?", opts: ['What experience do you have?','What are your strengths?','What are your career goals?','What motivates you?'], ans: 'What experience do you have?', hint: "Experience = expérience professionnelle. Do you have = avez-vous ?", _isSentence: true },
      { q: "Efficiency signifie :", opts: ['Efficacité','Flexibilité','Disponibilité','Capacité'], ans: 'Efficacité', hint: "Efficiency = efficacité (faire plus avec moins, résultat optimal)." },
      { q: "Pourquoi devrions-nous vous embaucher ?", opts: ['Why should we hire you?','Why do you want this job?','What motivates you?','Tell me about yourself.'], ans: 'Why should we hire you?', hint: "Hire = embaucher (recruter). Should we hire you = devrions-nous vous embaucher ?", _isSentence: true },
    ],
    [
      { q: "Flexibility signifie :", opts: ['Flexibilité','Efficacité','Disponibilité','Intérêt'], ans: 'Flexibilité', hint: "Flexibility = flexibilité (capacité à s'adapter à des situations changeantes)." },
      { q: "Availability signifie :", opts: ['Disponibilité','Flexibilité','Capacité','Compétence'], ans: 'Disponibilité', hint: "Availability = disponibilité (être disponible pour prendre un poste)." },
      { q: "Qu'est-ce qui vous motive ?", opts: ['What motivates you?','What inspires you?','What interests you?','What challenges you?'], ans: 'What motivates you?', hint: "Motivate = motiver (ce qui vous pousse à agir et à vous investir).", _isSentence: true },
      { q: "Quelles sont vos forces ?", opts: ['What are your strengths?','What are your skills?','What are your goals?','What are your interests?'], ans: 'What are your strengths?', hint: "Strengths (pluriel de strength) = forces, points forts.", _isSentence: true },
      { q: "Interest signifie :", opts: ['Intérêt','Expertise','Capacité','Force'], ans: 'Intérêt', hint: "Interest = intérêt, centre d'intérêt (ce qui vous passionne)." },
      { q: "Quels sont vos objectifs de carrière ?", opts: ['What are your career goals?','What are your career plans?','What do you want to achieve?','What are your ambitions?'], ans: 'What are your career goals?', hint: "Career goals = objectifs de carrière. Goals = buts, objectifs à atteindre.", _isSentence: true },
    ],
  ],
  'at-work-phrases': [
    [
      { q: "Restons en contact.", opts: ["Let's keep in touch.","Let's stay connected.","Let's remain friends.","Let's keep close."], ans: "Let's keep in touch.", hint: "Keep in touch = rester en contact, ne pas se perdre de vue.", _isSentence: true },
      { q: "Peux-tu clarifier ce point, s'il te plaît ?", opts: ["Could you please clarify this point?","Can you explain this point?","Would you mind clarifying?","Please explain this issue."], ans: "Could you please clarify this point?", hint: "Could you please = formule très polie. Clarify = clarifier, expliquer plus clairement.", _isSentence: true },
      { q: "Organisons nos tâches.", opts: ["Let's organize our tasks.","Let's plan our work.","Let's sort our duties.","Let's structure our day."], ans: "Let's organize our tasks.", hint: "Let's + verbe = proposer de faire quelque chose ensemble. Tasks = tâches à accomplir.", _isSentence: true },
      { q: "J'ai presque terminé.", opts: ["I'm almost finished.","I'm nearly done.","I'm about to finish.","I'm nearly there."], ans: "I'm almost finished.", hint: "Almost = presque. I'm almost finished = j'ai presque terminé / j'en suis presque à la fin.", _isSentence: true },
      { q: "Nous devons établir des priorités.", opts: ["We need to prioritize.","We need to organize.","We need to plan more.","We need to focus better."], ans: "We need to prioritize.", hint: "Prioritize = prioriser, décider ce qui est le plus urgent et important à traiter en premier.", _isSentence: true },
      { q: "Merci pour ton soutien.", opts: ["Thanks for your support.","Thanks for your help.","Thanks for your effort.","Thanks for your presence."], ans: "Thanks for your support.", hint: "Support = soutien (aide morale ou pratique). Thanks for = merci pour.", _isSentence: true },
    ],
    [
      { q: "Pouvons-nous réfléchir ensemble ?", opts: ["Can we brainstorm together?","Can we think together?","Can we plan together?","Can we work together?"], ans: "Can we brainstorm together?", hint: "Brainstorm = faire un brainstorming (réfléchir librement à plusieurs pour générer des idées).", _isSentence: true },
      { q: "Résolvons ce problème ensemble.", opts: ["Let's solve this problem together.","Let's fix this together.","Let's deal with this together.","Let's tackle this together."], ans: "Let's solve this problem together.", hint: "Solve a problem = résoudre un problème. Together = ensemble (coopération).", _isSentence: true },
      { q: "'Workload' signifie :", opts: ['Charge de travail','Liste de tâches','Planning quotidien','Réunion de travail'], ans: 'Charge de travail', hint: "Workload = charge de travail (la quantité de travail à accomplir par une personne ou une équipe)." },
      { q: "'Due' dans un contexte pro signifie :", opts: ['Attendu / prévu pour une date','Terminé et livré','En cours de révision','Reporté à plus tard'], ans: 'Attendu / prévu pour une date', hint: "Due = attendu pour une date précise. This report is due today = ce rapport est à rendre aujourd'hui." },
      { q: "Je te tiendrai informé.", opts: ["I'll keep you updated.","I'll keep you informed.","I'll let you know later.","I'll send you an update."], ans: "I'll keep you updated.", hint: "Keep someone updated = tenir quelqu'un au courant (updated = mis à jour). Très courant dans un contexte pro.", _isSentence: true },
      { q: "'Prioritize' signifie :", opts: ['Établir des priorités','Organiser son agenda','Gérer son temps','Planifier ses réunions'], ans: 'Établir des priorités', hint: "Prioritize = prioriser, choisir ce qui est le plus urgent et important à faire en premier." },
    ],
  ],
  'farewell-expressions': [
    [
      { q: "On se parle bientôt.", opts: ["Speak soon.","Talk to you later.","See you soon.","Speak later."], ans: "Speak soon.", hint: "Speak soon = on se parle bientôt (forme courte, souvent en fin d'appel ou par message).", _isSentence: true },
      { q: "On se rattrape plus tard.", opts: ["Catch you later.","See you later.","Talk to you later.","Meet you later."], ans: "Catch you later.", hint: "Catch you later = on se rattrape plus tard (très familier, image de 'rattraper' quelqu'un).", _isSentence: true },
      { q: "Je dois partir maintenant.", opts: ["I have to go now.","I've got to go.","I'm off right now.","I need to leave soon."], ans: "I have to go now.", hint: "I have to go now = je dois partir maintenant. Now insiste sur l'urgence immédiate.", _isSentence: true },
      { q: "Je m'en vais.", opts: ["I'm off.","I'm going.","I'm leaving.","I'm out of here."], ans: "I'm off.", hint: "I'm off = je m'en vais. Forme très courte. On peut aussi dire 'I'm heading off' (je me casse).", _isSentence: true },
      { q: "On se parle plus tard.", opts: ["Talk to you later.","Speak to you soon.","Call you later.","See you later."], ans: "Talk to you later.", hint: "Talk to you later = on se parle plus tard. Très courant pour finir un appel ou un message.", _isSentence: true },
      { q: "À plus tard.", opts: ["See you later.","Catch you later.","Talk to you later.","See you soon."], ans: "See you later.", hint: "See you later = à plus tard. Plus vague que 'See you soon' qui implique un délai court.", _isSentence: true },
    ],
    [
      { q: "'Speak soon' correspond à :", opts: ["On se parle bientôt.","On se rattrape plus tard.","On se parle plus tard.","On se retrouve bientôt."], ans: "On se parle bientôt.", hint: "Speak soon = on se parle bientôt. Speak = parler, soon = bientôt." },
      { q: "'Catch you later' signifie :", opts: ["On se rattrape plus tard.","À plus tard.","On se parle plus tard.","On se retrouve bientôt."], ans: "On se rattrape plus tard.", hint: "Catch you later = on se rattrape plus tard (catch = rattraper, rejoindre quelqu'un)." },
      { q: "'I'm off' est synonyme de :", opts: ["I have to go now.","See you later.","Talk to you later.","Catch you later."], ans: "I have to go now.", hint: "I'm off = je m'en vais — même sens que 'I have to go now' mais plus bref et informel." },
      { q: "Quelle expression utilise 'catch' ?", opts: ["Catch you later.","See you later.","Talk to you later.","Speak soon."], ans: "Catch you later.", hint: "Catch you later = on se rattrape plus tard. Catch = rattraper, rejoindre quelqu'un." },
      { q: "Pour dire 'Je dois y aller' (contraction informelle) :", opts: ["I've got to go.","I have to go.","I need to leave.","I must go now."], ans: "I've got to go.", hint: "I've got to go = I have got to go (contraction). Got to = have to. Très oral et informel." },
      { q: "Différence entre 'See you soon' et 'See you later' :", opts: ["Soon = bientôt, Later = plus tard","Aucune différence","Soon = formel, Later = informel","Soon = oral, Later = écrit"], ans: "Soon = bientôt, Later = plus tard", hint: "See you soon (à bientôt) → délai court. See you later (à plus tard) → délai vague." },
    ],
  ],
  'tired-expressions': [
    [
      { q: "Beat (familier) signifie :", opts: ["Claqué / épuisé","Battu / frappé","Vaincu","Assommé"], ans: "Claqué / épuisé", hint: "I'm beat (fam.) = Je suis claqué / à plat. Ne pas confondre avec beat = battre ou rythme musical." },
      { q: "Drained signifie :", opts: ["Vidé / épuisé","Mouillé","Stressé","Drainé"], ans: "Vidé / épuisé", hint: "Drained = vidé (comme un réservoir vide). To drain = vider, drainer." },
      { q: "Worn out signifie :", opts: ["Crevé / usé","Porté dehors","Fatigué seulement","Brisé"], ans: "Crevé / usé", hint: "Worn out = crevé (personne) ou usé (objet). Wear out = épuiser, user jusqu'à l'usure." },
      { q: "Je me sens somnolent.", opts: ["I feel drowsy.","I feel sleepy.","I feel tired.","I feel drained."], ans: "I feel drowsy.", hint: "Drowsy = somnolent (envie de s'assoupir, souvent après un repas ou un médicament).", _isSentence: true },
      { q: "J'ai tellement sommeil.", opts: ["I'm so sleepy.","I'm so tired.","I feel so drowsy.","I'm dead tired."], ans: "I'm so sleepy.", hint: "Sleepy = qui a sommeil (l'envie de dormir). So = tellement.", _isSentence: true },
      { q: "Je suis crevé.", opts: ["I'm worn out.","I'm beat.","I'm exhausted.","I'm drained."], ans: "I'm worn out.", hint: "I'm worn out = Je suis crevé (worn out vient de 'wear out' = user jusqu'à l'usure).", _isSentence: true },
    ],
    [
      { q: "Exhausted signifie :", opts: ["Épuisé","Claqué","Somnolent","Fatigué"], ans: "Épuisé", hint: "Exhausted = épuisé. Intensité croissante : tired → beat/drained/worn out → exhausted/dead tired." },
      { q: "Quelle expression décrit la somnolence (envie de s'assoupir) ?", opts: ["I feel drowsy.","I'm drained.","I'm beat.","I'm worn out."], ans: "I feel drowsy.", hint: "Drowsy = somnolent (envie de s'assoupir, différent de 'tired' qui est une fatigue générale)." },
      { q: "Rest signifie :", opts: ["Repos","Reste","Repose","Arrêt"], ans: "Repos", hint: "Rest = repos. To rest = se reposer. Some rest = un peu de repos. The rest = le reste." },
      { q: "Quelle est la traduction correcte de 'Je suis claqué' ?", opts: ["I'm beat.","I'm bored.","I'm done.","I feel lazy."], ans: "I'm beat.", hint: "I'm beat (fam.) = Je suis claqué. Bored = ennuyé. Done = terminé. Lazy = paresseux." },
      { q: "Laquelle de ces expressions est la PLUS intense ?", opts: ["I'm dead tired.","I'm tired.","I feel drowsy.","I need some rest."], ans: "I'm dead tired.", hint: "'Dead tired' est la plus forte : mort de fatigue. Tired = neutre. Drowsy = somnolent seulement." },
      { q: "Quel adjectif vient du verbe 'to drain' (vider) ?", opts: ["Drained","Tired","Sleepy","Worn"], ans: "Drained", hint: "Drained vient de 'to drain' = vider. I'm drained = je suis vidé (comme une batterie à plat)." },
    ],
  ],
  'times-of-day': [
    [
      { q: "Sunrise signifie :", opts: ["Le lever du soleil","Le coucher du soleil","L'aube","Le crépuscule"], ans: "Le lever du soleil", hint: "Sunrise = lever du soleil. Sun = soleil, rise = se lever. ≠ Sunset (coucher)." },
      { q: "Evening correspond à quelle plage horaire ?", opts: ["16h00–18h00","12h00–16h00","18h00–20h00","20h00–minuit"], ans: "16h00–18h00", hint: "Evening = la soirée (4–6 PM). En anglais, evening commence plus tôt qu'en français (avant sunset)." },
      { q: "Twilight est synonyme de :", opts: ["Dusk","Dawn","Sunset","Night"], ans: "Dusk", hint: "Twilight et Dusk sont synonymes : tous deux désignent le crépuscule (lumière déclinante avant l'obscurité)." },
      { q: "Quel moment précède immédiatement noon ?", opts: ["Morning","Afternoon","Evening","Dawn"], ans: "Morning", hint: "Morning (6h30–12h00) précède noon (midi). Après noon vient afternoon." },
      { q: "Midday est synonyme de :", opts: ["Noon","Evening","Morning","Midnight"], ans: "Noon", hint: "Midday = noon = midi (12h00). Mid = milieu, day = jour. ≠ Midnight (minuit)." },
      { q: "Dans quelle période se situe 7h du matin ?", opts: ["Morning","Dawn","Sunrise","Afternoon"], ans: "Morning", hint: "Morning = 6h30–12h00. 7h est bien dans la matinée. Dawn = avant 6h, Sunrise ≈ 6h–6h30." },
    ],
    [
      { q: "Quelle est la différence entre Dawn et Sunrise ?", opts: ["Dawn = première lueur, Sunrise = soleil visible","Aucune différence","Dawn = après midi, Sunrise = le matin","Dawn = le soir, Sunrise = l'aube"], ans: "Dawn = première lueur, Sunrise = soleil visible", hint: "Dawn précède sunrise : d'abord la première lueur (dawn), puis le soleil apparaît à l'horizon (sunrise)." },
      { q: "Dusk se produit :", opts: ["Après le coucher du soleil","Avant le lever du soleil","À midi","En début de soirée"], ans: "Après le coucher du soleil", hint: "Dusk = crépuscule, après sunset (18h30–20h00). À ne pas confondre avec dawn (avant sunrise)." },
      { q: "En anglais, 'Good evening' s'utilise à partir de :", opts: ["~16h00","~12h00","~20h00","~18h30"], ans: "~16h00", hint: "Evening commence vers 16h (4 PM). Good evening peut s'utiliser dès la fin d'après-midi, bien plus tôt qu'en français." },
      { q: "Que signifie 'I'll see you at noon' ?", opts: ["Je te verrai à midi.","Je te verrai ce soir.","Je te verrai demain matin.","Je te verrai à minuit."], ans: "Je te verrai à midi.", hint: "Noon = midi (12h00). Midnight = minuit. At noon = à midi pile." },
      { q: "Quel mot désigne la période entre sunset et l'obscurité totale ?", opts: ["Dusk","Dawn","Evening","Morning"], ans: "Dusk", hint: "Dusk (twilight) = transition entre sunset et night (18h30–20h00). Dawn est à l'opposé (avant sunrise)." },
      { q: "Quel est le contraire de sunrise ?", opts: ["Sunset","Dusk","Dawn","Night"], ans: "Sunset", hint: "Sunrise (lever) ↔ Sunset (coucher). Sun = soleil, rise = se lever, set = se coucher." },
    ],
  ],
  'who-which-where-questions': [
    [
      { q: "Où habites-tu ?", opts: ["Where do you live?","Where are you from?","Where do you go?","Where are you?"], ans: "Where do you live?", hint: "WHERE + do you + V = question au présent sur une habitude. Live = habiter, vivre.", _isSentence: true },
      { q: "Qui est ton professeur ?", opts: ["Who is your teacher?","Whose is the teacher?","Which teacher is yours?","Whom is your teacher?"], ans: "Who is your teacher?", hint: "WHO = qui (sujet, personne). Who is your teacher? → Mr. Smith.", _isSentence: true },
      { q: "Quelle est la différence entre WHICH et WHAT ?", opts: ["WHICH = choix limité, WHAT = ouvert","Aucune différence","WHAT = personnes, WHICH = choses","WHICH = formel, WHAT = informel"], ans: "WHICH = choix limité, WHAT = ouvert", hint: "WHICH = choix dans un ensemble connu (which colour?). WHAT = question ouverte sans ensemble prédéfini." },
      { q: "Qui as-tu appelé ? (forme formelle)", opts: ["Whom did you call?","Who did you call?","Which person did you call?","Whose did you call?"], ans: "Whom did you call?", hint: "WHOM = forme objet formelle de WHO. En informel courant, on dit souvent 'Who did you call?'", _isSentence: true },
      { q: "WHERE peut répondre à :", opts: ["Où… ?","Quand… ?","Pourquoi… ?","Combien… ?"], ans: "Où… ?", hint: "WHERE = où. Il répond toujours à une question de lieu : Where are you? — I'm at home." },
      { q: "Lequel de ces mots interrogatifs exprime la POSSESSION ?", opts: ["WHOSE","WHO","WHICH","WHERE"], ans: "WHOSE", hint: "WHOSE = possessif interrogatif. Whose = à qui / de qui. ≠ WHO (sujet personne)." },
    ],
    [
      { q: "WHO vs WHOM : laquelle est la forme SUJET ?", opts: ["WHO","WHOM","WHOSE","WHICH"], ans: "WHO", hint: "WHO = sujet (Who called? = Qui a appelé ?). WHOM = objet (Whom did you call? = Qui as-tu appelé ?)." },
      { q: "Lequel de ces livres préfères-tu ?", opts: ["Which of these books do you prefer?","What of these books do you prefer?","Who of these books do you prefer?","Whose of these books do you prefer?"], ans: "Which of these books do you prefer?", hint: "WHICH + of these = lequel de ces... (choix parmi un ensemble défini).", _isSentence: true },
      { q: "Dans 'Where are you from?', WHERE demande :", opts: ["L'origine / la provenance","La destination","La durée","Le lieu actuel"], ans: "L'origine / la provenance", hint: "Where are you from? = D'où viens-tu ? (origine). ≠ Where are you? (lieu actuel)." },
      { q: "WHOSE signifie :", opts: ["De qui / À qui","Qui (sujet)","Où","Lequel"], ans: "De qui / À qui", hint: "WHOSE interroge sur le possesseur. Whose is this? = C'est à qui ? / De qui est-ce ?" },
      { q: "Lequel veux-tu ?", opts: ["Which one do you want?","What one do you want?","Who do you want?","Where do you want?"], ans: "Which one do you want?", hint: "WHICH one = lequel. One fait référence à un objet déjà mentionné.", _isSentence: true },
      { q: "Quelle question utilise WHOM correctement ?", opts: ["Whom did you invite?","Whom is coming?","Whom book is this?","Whom do you live?"], ans: "Whom did you invite?", hint: "WHOM = objet (you invited WHOM → whom). 'Whom is coming?' est faux (sujet → who). Whose book, où → where." },
    ],
  ],
  'grow-phrasal-verbs': [
    [
      { q: "Grow from signifie :", opts: ["Résulter de / Se développer à partir de","Cultiver depuis","Grandir depuis","Provenir physiquement de"], ans: "Résulter de / Se développer à partir de", hint: "Grow from = résulter de, émerger de. 'Mutual understanding grew from the discussions.'" },
      { q: "Grow together signifie :", opts: ["Se rapprocher progressivement","Pousser côte à côte","Vieillir ensemble","Travailler en équipe"], ans: "Se rapprocher progressivement", hint: "Grow together = tisser un lien plus fort progressivement. ≠ Grow apart (s'éloigner)." },
      { q: "Grow out (cheveux) signifie :", opts: ["Laisser repousser pour effacer une coupe/teinture","Couper très court","Raser","Teindre à nouveau"], ans: "Laisser repousser pour effacer une coupe/teinture", hint: "Grow out = laisser les cheveux repousser jusqu'à ce que la coupe ou la teinture disparaisse." },
      { q: "Quelle phrase utilise 'grow apart' correctement ?", opts: ["We've grown apart since she moved away.","They grew apart the mountain quickly.","She grew apart her sister.","He grew apart with old age."], ans: "We've grown apart since she moved away.", hint: "Grow apart est intransitif — pas d'objet direct. 'They grew apart' = ils se sont éloignés." },
      { q: "Traduction : 'The boy grew into a responsible man.'", opts: ["Le garçon est devenu un homme responsable.","Le garçon a grandi vers un homme responsable.","Le garçon s'est développé dans un homme.","Le garçon a grandi à l'intérieur d'un homme."], ans: "Le garçon est devenu un homme responsable.", hint: "Grow into + nom = évoluer en, devenir (changement progressif au fil du temps)." },
      { q: "Traduction : 'The idea is growing on me.'", opts: ["L'idée finit par me plaire.","L'idée pousse sur moi.","L'idée me dépasse.","L'idée me grandit."], ans: "L'idée finit par me plaire.", hint: "Grow on someone = finir par apprécier progressivement. 'It's growing on me' = ça commence à me plaire." },
    ],
    [
      { q: "Différence entre 'grow out' et 'grow out of' :", opts: ["Grow out = cheveux/coupe, Grow out of = vêtements trop petits","Aucune différence","Grow out of = cheveux, Grow out = vêtements","Les deux s'utilisent uniquement pour les cheveux"], ans: "Grow out = cheveux/coupe, Grow out of = vêtements trop petits", hint: "Grow out = laisser repousser les cheveux. Grow out of = devenir trop grand pour (vêtements, habits, phases)." },
      { q: "Grow out of peut aussi signifier :", opts: ["Dépasser une habitude / une phase","Sortir d'une plante","Grandir hors de","Repousser à l'extérieur"], ans: "Dépasser une habitude / une phase", hint: "Grow out of = aussi : dépasser une phase. 'He grew out of his shyness.' = il a dépassé sa timidité." },
      { q: "Quelle expression signifie 'finir par aimer' ?", opts: ["Grow on someone","Grow together","Grow from","Grow into"], ans: "Grow on someone", hint: "Grow on someone = finir par apprécier quelque chose. 'This song is growing on me.' = cette chanson commence à me plaire." },
      { q: "Grow up peut signifier :", opts: ["Grandir (enfance) ET devenir adulte/mature","Monter physiquement","Cultiver en hauteur","Vieillir uniquement"], ans: "Grandir (enfance) ET devenir adulte/mature", hint: "Grow up = passer son enfance ('I grew up in Paris') ET devenir adulte / mûrir ('Grow up!' = arrête de faire l'enfant)." },
      { q: "Grow from est proche de :", opts: ["Stem from / Come from","Break from","Stay from","Fall from"], ans: "Stem from / Come from", hint: "Grow from ≈ stem from / come from = résulter de, provenir de. 'The conflict grew from a misunderstanding.'" },
        { q: "Grow together est le contraire de :", opts: ["Grow apart","Grow back","Grow up","Grow out"], ans: "Grow apart", hint: "Grow together (se rapprocher) ↔ Grow apart (s'éloigner). Antonymes parfaits pour décrire l'évolution d'une relation." },
    ],
  ],
  'credible-expressions': [
    [
      { q: "In other words reformule :", opts: ["Ce qu'on vient de dire en termes plus clairs","Un exemple concret","Une opposition","Une conclusion"], ans: "Ce qu'on vient de dire en termes plus clairs", hint: "In other words = en d'autres termes (reformulation). 'He's very busy. In other words, he can't make it.'" },
      { q: "FAUX AMI — 'Actually' signifie :", opts: ["En fait","Actuellement","En ce moment","Vraiment"], ans: "En fait", hint: "Actually ≠ actuellement. Actually = en fait (correction ou précision). Actuellement = currently / at the moment." },
      { q: "Pour 'par exemple' :", opts: ["For example,","In other words,","That is to say,","In general,"], ans: "For example,", hint: "For example = par exemple. ≈ For instance. 'I enjoy sports, for example, cycling and swimming.'" },
      { q: "However et Nevertheless expriment tous deux :", opts: ["Une opposition / concession","Une explication","Un exemple","Une conclusion"], ans: "Une opposition / concession", hint: "However (toutefois) et Nevertheless (néanmoins) marquent tous deux une opposition. Nevertheless insiste davantage sur le contraste malgré les faits." },
      { q: "Quelle expression est proche de 'In my opinion' ?", opts: ["From my point of view,","To tell the truth,","Actually,","In other words,"], ans: "From my point of view,", hint: "From my point of view = de mon point de vue (proche de 'In my opinion', met l'accent sur la perspective personnelle)." },
      { q: "That said signifie :", opts: ["Cela dit,","C'est-à-dire,","Néanmoins,","Toutefois,"], ans: "Cela dit,", hint: "That said = cela dit (reconnaît ce qui précède avant d'introduire une nuance). 'It's a good plan. That said, there are risks.'" },
    ],
  ],
  'church-expressions': [
    [
      { q: "Allons à l'église.", opts: ["Let's go to church.","Let's pray.","See you at church.","Let's celebrate."], ans: "Let's go to church.", hint: "Let's go to church = Allons à l'église. Let's + verbe = invitation collective. Church = église.", _isSentence: true },
      { q: "L'office commence.", opts: ["Church service is starting.","Church Celebration.","Let's go to church.","Joy in the house of the LORD."], ans: "Church service is starting.", hint: "Church service is starting = L'office commence. Church service = office ou service religieux. Starting = en train de commencer.", _isSentence: true },
      { q: "Célébration à l'église.", opts: ["Church Celebration.","Church service is starting.","Joy in the house of the LORD.","Let's sing for the LORD."], ans: "Church Celebration.", hint: "Church Celebration = Célébration à l'église, fête religieuse. Désigne un moment de fête communautaire à l'église.", _isSentence: true },
      { q: "Joie dans la maison du Seigneur.", opts: ["Joy in the house of the LORD.","Praise the LORD.","Let's sing for the LORD.","May God guide you."], ans: "Joy in the house of the LORD.", hint: "Joy in the house of the LORD = Joie dans la maison du Seigneur. Joy = joie, house = maison, LORD = Seigneur.", _isSentence: true },
      { q: "Que Dieu te guide.", opts: ["May God guide you.","God bless you.","May God open doors.","Let's pray."], ans: "May God guide you.", hint: "May God guide you = Que Dieu te guide. May + sujet + verbe = souhait ou prière. Guide = guider, orienter.", _isSentence: true },
      { q: "Que Dieu ouvre des portes.", opts: ["May God open doors.","May God guide you.","God bless you.","Joy in the house of the LORD."], ans: "May God open doors.", hint: "May God open doors = Que Dieu ouvre des portes (souhait d'opportunités). Open doors = ouvrir des portes, créer des opportunités.", _isSentence: true },
    ],
    [
      { q: "Bless signifie :", opts: ["Bénir","Prier","Louer","Guider"], ans: "Bénir", hint: "Bless = bénir. God bless you = Que Dieu te bénisse. To bless = accorder une bénédiction divine." },
      { q: "Praise signifie :", opts: ["Louer / Glorifier","Prier","Bénir","Chanter"], ans: "Louer / Glorifier", hint: "Praise = louer, glorifier. Praise the LORD = Gloire à Dieu. Praise (nom) = louange, éloge." },
      { q: "Pray signifie :", opts: ["Prier","Louer","Bénir","Chanter"], ans: "Prier", hint: "Pray = prier. Let's pray = Prions. Prayer (nom) = prière. Pray for someone = prier pour quelqu'un." },
      { q: "LORD (tout en majuscules) désigne :", opts: ["Dieu / le Seigneur (tradition chrétienne)","Un titre royal","Un chef de communauté","Un professeur religieux"], ans: "Dieu / le Seigneur (tradition chrétienne)", hint: "LORD en majuscules = le Seigneur / Dieu dans la Bible. Lord (minuscules) = seigneur, titre de noblesse ou de respect." },
      { q: "May God... est une formule de :", opts: ["Souhait / Prière","Ordre","Question","Reproche"], ans: "Souhait / Prière", hint: "May + sujet + verbe = souhait ou prière en anglais. May God bless you = Que Dieu te bénisse. May God open doors = Que Dieu t'ouvre des portes." },
      { q: "Church service signifie :", opts: ["Office religieux / Service religieux","Construction d'église","Service communautaire","Chorale d'église"], ans: "Office religieux / Service religieux", hint: "Church service = office religieux, service religieux (la célébration à l'église). 'Church service is starting' = L'office commence." },
    ],
  ],
};

function getTopicSeries(topicId) {
  const s1 = _GFIX[topicId];
  if (!s1) return [];
  const extra = _GFIX_SERIES[topicId] || [];
  return [s1, ...extra];
}

function getSeriesDone() {
  try { return new Set(JSON.parse(localStorage.getItem('grammar_series_done') || '[]')); }
  catch { return new Set(); }
}

function markSeriesDone(key) {
  const done = getSeriesDone();
  done.add(key);
  localStorage.setItem('grammar_series_done', JSON.stringify([...done]));
}

function getDailySession() {
  const today = morningDate();
  try {
    const stored = JSON.parse(localStorage.getItem('grammar_daily') || 'null');
    if (stored?.date === today) return stored;
  } catch {}
  const allTopics = Object.keys(_GFIX);
  const done = getSeriesDone();
  const dayNum = Math.floor(Date.now() / 86400000);
  const scored = allTopics.map((id, i) => ({
    id,
    doneCount: [...done].filter(k => k.startsWith(id + ':')).length,
    order: (i + dayNum) % allTopics.length,
  }));
  scored.sort((a, b) => a.doneCount - b.doneCount || a.order - b.order);
  const topics = scored.slice(0, 3).map(t => t.id);
  const session = { date: today, topics, done: [false, false, false] };
  localStorage.setItem('grammar_daily', JSON.stringify(session));
  return session;
}

function saveDailySession(session) {
  localStorage.setItem('grammar_daily', JSON.stringify(session));
}

function getDailyTopicSeriesIdx(topicId) {
  const done = getSeriesDone();
  const series = getTopicSeries(topicId);
  for (let i = 0; i < series.length; i++) {
    if (!done.has(`${topicId}:${i}`)) return i;
  }
  return 0;
}

function startDailySession() {
  const session = getDailySession();
  const nextIdx = session.done.findIndex(d => !d);
  if (nextIdx !== -1) startDailyTopicAtIdx(session, nextIdx);
}

function startDailyTopicAtIdx(session, idx) {
  const topicId = session.topics[idx];
  const seriesIdx = getDailyTopicSeriesIdx(topicId);
  const series = getTopicSeries(topicId);
  const bank = series[seriesIdx];
  if (!bank) return;
  const topicTitle = (grammarData && grammarData.find(t => t.id === topicId))?.title || topicId;
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = `${topicTitle} — S${seriesIdx + 1}`;
  state.mode = 'srs';
  state.grammarSeriesKey = `${topicId}:${seriesIdx}`;
  state.dailySession = { session, topicIdx: idx };
  state.questions = bank.map(t => {
    const item = _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + topicId;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

function renderDailySessionCard() {
  const card = $('grammar-daily-card');
  if (!card || grammarLang !== 'en') { if (card) card.classList.add('hidden'); return; }
  const session = getDailySession();
  const doneCount = session.done.filter(Boolean).length;
  const allDone = doneCount === 3;
  const rows = session.topics.map((id, i) => {
    const t = grammarData && grammarData.find(t => t.id === id);
    const isDone = session.done[i];
    return `<div class="daily-topic-row">
      <span class="daily-topic-badge${isDone ? ' done' : ''}">${isDone ? '✓' : i + 1}</span>
      <span class="daily-topic-label${isDone ? ' done' : ''}">${esc(t ? t.title : id)}</span>
    </div>`;
  }).join('');
  card.innerHTML = `
    <div class="daily-header">
      <span class="daily-title">📅 Session du jour</span>
      <span class="daily-progress">${doneCount}/3</span>
    </div>
    <div class="daily-topics">${rows}</div>
    ${allDone
      ? `<p class="daily-done-msg">✅ Complétée — à demain !</p>`
      : `<button id="btn-start-daily" class="primary daily-start-btn">${doneCount > 0 ? '▶ Continuer' : '▶ Commencer'}</button>`
    }`;
  card.classList.remove('hidden');
  if (!allDone) $('btn-start-daily').addEventListener('click', startDailySession);
}

function startGrammarQuizSeries(topicId, seriesIdx) {
  const series = getTopicSeries(topicId);
  const bank = series[seriesIdx];
  if (!bank) return;
  const topicTitle = (grammarData && grammarData.find(t => t.id === topicId))?.title || topicId;
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = `${topicTitle} — S${seriesIdx + 1}`;
  state.mode = 'srs';
  state.onQuizFinish = null;
  state.grammarSeriesKey = `${topicId}:${seriesIdx}`;
  state.questions = bank.map(t => {
    const item = _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + topicId;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

function grammarWrongTopics() {
  const srs = getSrs(GRAMMAR_KEY);
  return Object.keys(_GFIX).filter(id => {
    const e = srs['gen-' + id];
    return e && e.seen > 0 && (e.last === 'ko' || e.wrong > e.correct);
  });
}

function startGrammarReview() {
  const topics = grammarWrongTopics();
  if (!topics.length) return;
  const allItems = [];
  topics.forEach(id => {
    getTopicSeries(id).flat().forEach(t => {
      allItems.push(_mkItem(id, t.q, shuffle([...t.opts]), t.ans, t.hint));
    });
  });
  const count = Math.min(grammarCustomCount, allItems.length);
  state.kind = 'grammar';
  state.level = 'Global';
  state.badge = `⟳ Révision (${topics.length} concept${topics.length > 1 ? 's' : ''})`;
  state.mode = 'review';
  state.questions = shuffle(allItems).slice(0, count).map(item => {
    const q = buildGrammarQuestion(item);
    q.word = 'gen-' + item.topic;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

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

// ---------- TOEIC ----------
const _TOEIC_P5 = {
  'word-forms': [
    { q: 'The ___ of the meeting was confirmed yesterday.', opts: ['cancellation','cancel','cancelled','cancelling'], ans: 'cancellation', hint: 'Sujet de phrase → nom : cancellation.' },
    { q: 'She is ___ for managing the entire sales team.', opts: ['responsible','responsibility','responsibly','respond'], ans: 'responsible', hint: 'Attribut après be → adjectif : responsible.' },
    { q: 'We need to ___ the budget before the deadline.', opts: ['finalise','final','finally','finalisation'], ans: 'finalise', hint: 'Après to → verbe : finalise.' },
    { q: 'He gave a very ___ presentation to the board.', opts: ['impressive','impression','impress','impressively'], ans: 'impressive', hint: 'Épithète avant nom → adjectif : impressive.' },
    { q: "The company's ___ has increased by 20% this year.", opts: ['productivity','productive','productively','produce'], ans: 'productivity', hint: 'Sujet de phrase → nom : productivity.' },
    { q: 'All employees must attend the ___ safety training.', opts: ['mandatory','mandate','mandatorily','mandated'], ans: 'mandatory', hint: 'Épithète devant nom → adjectif : mandatory.' },
    { q: 'The contract was signed with the ___ of both parties.', opts: ['approval','approve','approved','approvingly'], ans: 'approval', hint: 'Après préposition with → nom : approval.' },
    { q: 'Please handle this matter as ___ as possible.', opts: ['efficiently','efficient','efficiency','efficience'], ans: 'efficiently', hint: 'Modifie un verbe → adverbe : efficiently.' },
  ],
  'prepositions': [
    { q: 'She is ___ charge of the marketing department.', opts: ['in','on','at','for'], ans: 'in', hint: 'in charge of = responsable de.' },
    { q: 'Please submit your report ___ Friday at the latest.', opts: ['by','on','at','until'], ans: 'by', hint: 'by = au plus tard (deadline) → by Friday.' },
    { q: 'The CEO is responsible ___ the final decision.', opts: ['for','of','to','about'], ans: 'for', hint: 'responsible for = responsable de.' },
    { q: '___ the latest report, sales are up 12%.', opts: ['According to','Despite','In spite of','Owing'], ans: 'According to', hint: 'According to = selon (source de donnée).' },
    { q: 'We are looking ___ a new warehouse manager.', opts: ['for','at','into','to'], ans: 'for', hint: 'look for = chercher.' },
    { q: 'The meeting was postponed ___ short notice.', opts: ['at','on','with','by'], ans: 'at', hint: 'at short notice = au dernier moment.' },
    { q: 'The invoice must be paid ___ 30 days.', opts: ['within','by','for','until'], ans: 'within', hint: 'within 30 days = dans un délai de 30 jours.' },
    { q: 'The merger was completed ahead ___ schedule.', opts: ['of','to','for','on'], ans: 'of', hint: 'ahead of schedule = en avance sur le calendrier.' },
  ],
  'conjunctions': [
    { q: 'Sales were down last quarter; ___, profits increased.', opts: ['however','therefore','moreover','although'], ans: 'however', hint: 'Contraste entre deux idées → however (cependant).' },
    { q: '___ the bad weather, the conference was a great success.', opts: ['Despite','Although','However','Therefore'], ans: 'Despite', hint: 'Despite + nom/gérondif = malgré.' },
    { q: 'She worked extremely hard; ___, she was promoted.', opts: ['therefore','however','despite','unless'], ans: 'therefore', hint: 'Conséquence logique → therefore (donc).' },
    { q: '___ the project is delayed, we will miss the launch date.', opts: ['If','Unless','Although','Despite'], ans: 'If', hint: 'Condition → if (si).' },
    { q: 'The contract was signed; ___, work can begin immediately.', opts: ['therefore','however','despite','whereas'], ans: 'therefore', hint: 'Conséquence → therefore.' },
    { q: 'The results were positive, ___ there is still room for improvement.', opts: ['although','despite','however','therefore'], ans: 'although', hint: 'although + proposition = bien que.' },
    { q: '___ you complete the form, your application will be processed.', opts: ['Once','Unless','Despite','However'], ans: 'Once', hint: 'Once = dès que (cause déclencheur).' },
    { q: 'The new policy applies to all staff, ___ their seniority.', opts: ['regardless of','in spite','however','despite to'], ans: 'regardless of', hint: 'regardless of = quelle que soit.' },
  ],
  'vocabulary': [
    { q: 'Please ___ the attached document before the meeting.', opts: ['review','revise','renew','recall'], ans: 'review', hint: 'review a document = examiner/relire un document.' },
    { q: 'We need to ___ a new strategy for next fiscal year.', opts: ['develop','deliver','decline','deduct'], ans: 'develop', hint: 'develop a strategy = élaborer une stratégie.' },
    { q: 'The manager will ___ the results at the annual conference.', opts: ['present','prevent','pretend','preserve'], ans: 'present', hint: 'present results = présenter les résultats.' },
    { q: 'All applications must be ___ by 5 p.m. on Friday.', opts: ['submitted','subscribed','subtracted','substituted'], ans: 'submitted', hint: 'submit an application = déposer/soumettre une candidature.' },
    { q: 'Could you please ___ the meeting to next Monday?', opts: ['reschedule','resume','recall','replace'], ans: 'reschedule', hint: 'reschedule = reporter/reprogrammer.' },
    { q: 'The company decided to ___ with a local supplier.', opts: ['partner','participate','perform','pursue'], ans: 'partner', hint: 'partner with = s\'associer avec.' },
    { q: 'The board approved the ___ of three new branches.', opts: ['expansion','expense','exposure','expertise'], ans: 'expansion', hint: 'expansion = expansion/développement (here: ouverture de nouvelles agences).' },
    { q: 'We must ___ costs without affecting product quality.', opts: ['reduce','refuse','refund','retain'], ans: 'reduce', hint: 'reduce costs = réduire les coûts.' },
    { q: 'The supplier failed to ___ the order on time.', opts: ['deliver','delay','deny','deposit'], ans: 'deliver', hint: 'deliver an order = livrer une commande.' },
    { q: 'Please ___ the following documents to your application.', opts: ['attach','add','apply','appeal'], ans: 'attach', hint: 'attach documents = joindre des documents.' },
    { q: 'The company decided to ___ its partnership with the vendor.', opts: ['extend','expand','express','exceed'], ans: 'extend', hint: 'extend a partnership = prolonger un partenariat.' },
    { q: 'The new conference centre will ___ up to 300 delegates.', opts: ['accommodate','accompany','accomplish','account'], ans: 'accommodate', hint: 'accommodate = accueillir/avoir la capacité pour.' },
    { q: 'We need to ___ our resources more effectively across departments.', opts: ['allocate','allow','adapt','assign'], ans: 'allocate', hint: 'allocate resources = allouer/répartir les ressources.' },
    { q: 'The company plans to ___ its headquarters to a larger building.', opts: ['relocate','replace','remove','return'], ans: 'relocate', hint: 'relocate = déménager/délocaliser.' },
    { q: 'The sales team managed to ___ its annual target by 10%.', opts: ['exceed','extend','expose','exhaust'], ans: 'exceed', hint: 'exceed a target = dépasser un objectif.' },
    { q: 'All employees are encouraged to ___ to the company wellness programme.', opts: ['contribute','attribute','distribute','constitute'], ans: 'contribute', hint: 'contribute to = contribuer à.' },
  ],
  'finance': [
    { q: "The company's annual ___ increased by 12% this quarter.", opts: ['revenue','salary','income','cost'], ans: 'revenue', hint: 'revenue = chiffre d\'affaires (total des recettes brutes).' },
    { q: 'All travel expenses will be ___ within 10 business days.', opts: ['reimbursed','returned','refunded','reviewed'], ans: 'reimbursed', hint: 'reimburse = rembourser des frais professionnels.' },
    { q: 'The project was delivered two weeks early and ___ budget.', opts: ['under','below','within','beneath'], ans: 'under', hint: 'under budget = en dessous du budget prévu.' },
    { q: 'The government awarded a ___ to support the research programme.', opts: ['grant','loan','bonus','fund'], ans: 'grant', hint: 'grant = subvention accordée sans obligation de remboursement.' },
    { q: 'The auditors discovered a significant ___ in the accounts.', opts: ['discrepancy','difference','dispute','defect'], ans: 'discrepancy', hint: 'discrepancy = écart/anomalie dans les comptes.' },
    { q: 'The new ___ plan outlines spending for the next fiscal year.', opts: ['budget','billing','balance','base'], ans: 'budget', hint: 'budget plan = plan de budgétisation.' },
    { q: 'Please submit all receipts to accounting for ___.', opts: ['reimbursement','return','refusal','recovery'], ans: 'reimbursement', hint: 'reimbursement = remboursement de frais professionnels.' },
    { q: 'We need to closely ___ our expenses this quarter.', opts: ['monitor','control','manage','observe'], ans: 'monitor', hint: 'monitor expenses = surveiller/suivre les dépenses de près.' },
  ],
  'ressources-humaines': [
    { q: 'The company plans to ___ 30 new engineers this year.', opts: ['recruit','record','recover','reduce'], ans: 'recruit', hint: 'recruit = recruter.' },
    { q: 'New employees must complete a two-week ___ programme.', opts: ['induction','introduction','instruction','inspection'], ans: 'induction', hint: 'induction programme = programme d\'intégration des nouveaux employés.' },
    { q: 'The position requires ___ experience in project management.', opts: ['extensive','expensive','explicit','exceptional'], ans: 'extensive', hint: 'extensive experience = une solide et vaste expérience.' },
    { q: 'The manager will ___ a team of 15 sales representatives.', opts: ['oversee','overlook','overcome','override'], ans: 'oversee', hint: 'oversee = superviser/gérer une équipe.' },
    { q: 'Employees who meet their targets will receive an annual ___.', opts: ['bonus','prize','award','pension'], ans: 'bonus', hint: 'bonus = prime annuelle liée aux performances.' },
    { q: 'The HR department is responsible for ___ disputes between staff.', opts: ['resolving','refusing','removing','reducing'], ans: 'resolving', hint: 'resolve disputes = résoudre des conflits au sein de l\'équipe.' },
    { q: 'All candidates will be ___ based on their skills and experience.', opts: ['evaluated','elevated','eliminated','elaborated'], ans: 'evaluated', hint: 'evaluate candidates = évaluer les candidats.' },
    { q: 'The company offers a competitive ___ package to attract top talent.', opts: ['compensation','commission','contribution','condition'], ans: 'compensation', hint: 'compensation package = ensemble de la rémunération (salaire + avantages).' },
  ],
  'communication': [
    { q: 'The meeting has been ___ until further notice.', opts: ['postponed','proposed','prepared','prevented'], ans: 'postponed', hint: 'postpone = reporter/remettre à une date ultérieure.' },
    { q: "Please find the ___ for tomorrow's board meeting attached.", opts: ['agenda','schedule','program','summary'], ans: 'agenda', hint: 'agenda = ordre du jour d\'une réunion.' },
    { q: 'The secretary was asked to take ___ during the conference.', opts: ['minutes','notes','records','reports'], ans: 'minutes', hint: 'take the minutes = rédiger le compte rendu officiel de la réunion.' },
    { q: 'Could you please ___ receipt of this email?', opts: ['acknowledge','accept','agree','announce'], ans: 'acknowledge', hint: 'acknowledge receipt = accuser réception.' },
    { q: "The CEO gave a brief ___ of the company's new direction.", opts: ['overview','overlook','outcome','output'], ans: 'overview', hint: 'overview = aperçu/présentation générale.' },
    { q: 'Please ___ your attendance for the training session by Monday.', opts: ['confirm','correct','convey','consider'], ans: 'confirm', hint: 'confirm attendance = confirmer sa présence.' },
    { q: 'I would like to ___ a meeting with your team for next week.', opts: ['arrange','attend','avoid','address'], ans: 'arrange', hint: 'arrange a meeting = organiser/planifier une réunion.' },
    { q: 'The report was ___ to all department heads before the meeting.', opts: ['circulated','considered','completed','confirmed'], ans: 'circulated', hint: 'circulate a report = diffuser/distribuer un rapport en interne.' },
  ],
  'collocations': [
    { q: 'She needs to ___ a decision before the deadline.', opts: ['make','do','take','have'], ans: 'make', hint: 'make a decision = prendre une décision.' },
    { q: 'The team will ___ a detailed report on the findings.', opts: ['submit','send','say','show'], ans: 'submit', hint: 'submit a report = soumettre un rapport.' },
    { q: 'We need to ___ a contract with the new client.', opts: ['sign','make','do','write'], ans: 'sign', hint: 'sign a contract = signer un contrat.' },
    { q: 'Can you ___ an appointment for next Tuesday?', opts: ['make','do','take','have'], ans: 'make', hint: 'make an appointment = prendre un rendez-vous.' },
    { q: 'The company plans to ___ costs by 15% next year.', opts: ['cut','make','do','lower'], ans: 'cut', hint: 'cut costs = réduire les coûts.' },
    { q: 'We will ___ a meeting to discuss the annual budget.', opts: ['hold','make','do','take'], ans: 'hold', hint: 'hold a meeting = organiser/tenir une réunion.' },
    { q: 'The HR department will ___ interviews next week.', opts: ['conduct','make','do','perform'], ans: 'conduct', hint: 'conduct interviews = mener des entretiens.' },
    { q: 'Please ___ the attached files before closing the document.', opts: ['save','keep','store','record'], ans: 'save', hint: 'save files = enregistrer les fichiers.' },
  ],
};

const TOEIC_P5_LABELS = {
  'word-forms':          'Formes de mots (nom/verbe/adj/adv)',
  'prepositions':        'Prépositions business',
  'conjunctions':        'Connecteurs logiques',
  'vocabulary':          'Vocabulaire en contexte',
  'finance':             'Vocabulaire finance & comptabilité',
  'ressources-humaines': 'Vocabulaire RH & recrutement',
  'communication':       'Vocabulaire communication & réunions',
  'collocations':        'Collocations courantes',
};

function generateToeicItem(topicId) {
  const bank = _TOEIC_P5[topicId];
  if (!bank) return null;
  const t = _rnd(bank);
  return _mkItem(topicId, t.q, shuffle([...t.opts]), t.ans, t.hint);
}

function renderToeicMenu() {
  const list = $('toeic-list');
  list.innerHTML = Object.keys(_TOEIC_P5).map(topic => {
    const label = TOEIC_P5_LABELS[topic] || topic;
    return `<button class="grammar-item" data-topic="${esc(topic)}"><span class="gi-title">${esc(label)}</span><span class="gi-sub">Génération aléatoire</span></button>`;
  }).join('');
  list.querySelectorAll('.grammar-item').forEach(b =>
    b.addEventListener('click', () => startToeicPart5(b.dataset.topic))
  );
  renderChips('.toeic-chip', state.count, 'count');
}

function openToeic() {
  renderToeicMenu();
  showView('toeic');
}

function startToeicPart5(topicId) {
  const topics = topicId ? [topicId] : Object.keys(_TOEIC_P5);
  const count = state.count;
  const items = [];
  for (let i = 0; i < count; i++) {
    const t = topics[i % topics.length];
    const item = generateToeicItem(t);
    if (item) items.push(item);
  }
  if (!items.length) return;
  state.kind = 'toeic';
  state.level = 'Global';
  state.badge = topicId ? (TOEIC_P5_LABELS[topicId] || topicId) : 'TOEIC Part 5';
  state.mode = 'srs';
  state.questions = shuffle(items).map(item => {
    const q = buildGrammarQuestion(item);
    q.word = 'toeic-' + item.topic;
    return q;
  });
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

async function startToeicVocab() {
  if (!cache['en']) cache['en'] = await (await fetch(LANGS['en'].file)).json();
  const b1b2 = cache['en'].filter(w => w.level === 'B1' || w.level === 'B2');
  state.kind = 'vocab';
  state.lang = 'en';
  state.level = 'B1/B2';
  state.badge = 'Vocabulaire B1/B2';
  state.words = b1b2;
  startSession('srs');
}

$('btn-toeic').addEventListener('click', openToeic);
$('btn-toeic-p5').addEventListener('click', () => startToeicPart5(null));
$('btn-toeic-vocab').addEventListener('click', startToeicVocab);
$('btn-toeic-home').addEventListener('click', () => showView('home'));
document.querySelectorAll('.toeic-chip').forEach(c => c.addEventListener('click', () => {
  state.count = +c.dataset.count;
  renderChips('.toeic-chip', state.count, 'count');
}));

// ---------- phrases à compléter (méga-quiz cross-mode) ----------
let phrasesPool = null;

async function loadPhrasesPool() {
  if (!fauxAmisData)  fauxAmisData  = await (await fetch(FAUX_AMIS_FILE)).json();
  if (!famillesData)  famillesData  = await (await fetch(FAMILLES_FILE)).json();
  phrasesPool = [
    ...Object.entries(_GFIX).flatMap(([topic, bank]) =>
      bank.map(t => ({ type: 'grammar', data: _mkItem(topic, t.q, [...t.opts], t.ans, t.hint) }))
    ),
    ...TENSES_TOPIC_ORDER.flatMap(topic => {
      const fixed = (_TFIX[topic] || []).map(t => ({ type: 'tenses', data: _mkItem(topic, t.q, [...t.opts], t.ans, t.hint) }));
      const param = _TGEN[topic] ? Array.from({ length: 8 }, () => ({ type: 'tenses', data: _TGEN[topic]() })) : [];
      return [...fixed, ...param];
    }),
    ...fauxAmisData.map(x  => ({ type: 'faux-amis', data: x })),
    ...famillesData.map(x  => ({ type: 'familles',  data: x })),
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
const ALL_DAILY_KEYS = () => ['en', 'es', VERBS_KEY, GRAMMAR_KEY, FAUX_AMIS_KEY, FAMILLES_KEY, COGNATES_KEY, TENSES_KEY, PHRASES_KEY, TOEIC_KEY];

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
$('tab-home-stats').addEventListener('click', () => { showView('stats'); renderStatsView(); });
$('tab-home-accueil').addEventListener('click', () => { /* already on home */ });
$('tab-stats-accueil').addEventListener('click', () => { showView('home'); renderStats(); });
$('tab-stats-stats').addEventListener('click', () => { /* already on stats */ });
$('btn-toggle-settings').addEventListener('click', () => {
  const panel = $('settings-panel');
  const arrow = $('settings-toggle-arrow');
  const open = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', open);
  arrow.textContent = open ? '▾' : '▴';
});
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
renderChips('.newratio-chip', settings.newRatio, 'ratio');
document.querySelectorAll('.newratio-chip').forEach(c => c.addEventListener('click', () => {
  settings.newRatio = +c.dataset.ratio;
  saveSettings();
  renderChips('.newratio-chip', settings.newRatio, 'ratio');
}));
$('btn-check-update').addEventListener('click', function () {
  if (typeof window.checkForUpdate === 'function') window.checkForUpdate(this);
});

if (settings.notifications) scheduleReviewNotification();

// ==================== MODULES VOCABULAIRE (crossword + matching) ====================
function getModeKey(mode) {
  if (mode === 'toeic') return TOEIC_KEY;
  if (mode === 'faux-amis') return FAUX_AMIS_KEY;
  if (mode === 'familles') return FAMILLES_KEY;
  return state.lang;
}

async function getModeWords(mode) {
  if (mode === 'toeic') {
    if (!cache['en']) cache['en'] = await (await fetch(LANGS['en'].file)).json();
    return cache['en'].filter(w => w.level === 'B1' || w.level === 'B2');
  }
  if (mode === 'faux-amis') {
    if (!fauxAmisData) fauxAmisData = await (await fetch(FAUX_AMIS_FILE)).json();
    return fauxAmisData.map(f => ({ word: f.en, fr: f.fr }));
  }
  if (mode === 'familles') {
    if (!famillesData) famillesData = await (await fetch(FAMILLES_FILE)).json();
    return famillesData.flatMap(f => f.words);
  }
  return levelWords();
}

// ==================== MOTS CROISÉS ====================
const CW_ROWS = 13, CW_COLS = 13;
let cwGrid, cwPlaced, cwSelectedId = null, cwCursorPos = 0, cwWordCount = 5, cwSrsLang, cwMode = 'vocab';

function cwInitGrid() {
  cwGrid = Array.from({length: CW_ROWS}, () => Array(CW_COLS).fill(null));
}

function cwCanPlace(letters, row, col, dir) {
  const len = letters.length;
  if (dir === 'across') {
    if (col < 0 || col + len > CW_COLS) return false;
    if (col > 0 && cwGrid[row][col - 1]) return false;
    if (col + len < CW_COLS && cwGrid[row][col + len]) return false;
  } else {
    if (row < 0 || row + len > CW_ROWS) return false;
    if (row > 0 && cwGrid[row - 1][col]) return false;
    if (row + len < CW_ROWS && cwGrid[row + len][col]) return false;
  }
  for (let i = 0; i < len; i++) {
    const r = dir === 'across' ? row : row + i;
    const c = dir === 'across' ? col + i : col;
    const cell = cwGrid[r][c];
    if (cell) {
      if (cell.letter !== letters[i]) return false;
      if (dir === 'across' && cell.acrossId !== null) return false;
      if (dir === 'down' && cell.downId !== null) return false;
    } else {
      if (dir === 'across') {
        if (r > 0 && cwGrid[r - 1][c]) return false;
        if (r < CW_ROWS - 1 && cwGrid[r + 1][c]) return false;
      } else {
        if (c > 0 && cwGrid[r][c - 1]) return false;
        if (c < CW_COLS - 1 && cwGrid[r][c + 1]) return false;
      }
    }
  }
  return true;
}

function cwDoPlace(letters, id, row, col, dir) {
  for (let i = 0; i < letters.length; i++) {
    const r = dir === 'across' ? row : row + i;
    const c = dir === 'across' ? col + i : col;
    if (!cwGrid[r][c]) cwGrid[r][c] = {letter: letters[i], acrossId: null, downId: null, filled: ''};
    if (dir === 'across') cwGrid[r][c].acrossId = id;
    else cwGrid[r][c].downId = id;
  }
}

function cwScorePlacement(letters, row, col, dir) {
  let score = 0;
  for (let i = 0; i < letters.length; i++) {
    const r = dir === 'across' ? row : row + i;
    const c = dir === 'across' ? col + i : col;
    if (cwGrid[r][c]) score += 2;
  }
  const cr = row + (dir === 'down' ? letters.length / 2 : 0);
  const cc = col + (dir === 'across' ? letters.length / 2 : 0);
  score -= (Math.abs(cr - CW_ROWS / 2) + Math.abs(cc - CW_COLS / 2)) * 0.15;
  return score;
}

function cwGenerate(wordPool) {
  cwInitGrid();
  cwPlaced = [];
  const candidates = shuffle(wordPool)
    .filter(w => /^[a-zA-Z]+$/.test(w.word) && w.word.length >= 3 && w.word.length <= 11)
    .slice(0, Math.min(wordPool.length, cwWordCount * 8));
  if (!candidates.length) return false;

  const first = candidates[0];
  const fl = first.word.toUpperCase();
  const sr = Math.floor(CW_ROWS / 2);
  const sc = Math.floor((CW_COLS - fl.length) / 2);
  if (!cwCanPlace(fl, sr, sc, 'across')) return false;
  cwDoPlace(fl, 0, sr, sc, 'across');
  cwPlaced.push({word: first.word, clue: first.fr, row: sr, col: sc, dir: 'across', len: fl.length, solved: false, number: 0});

  for (let wi = 1; wi < candidates.length && cwPlaced.length < cwWordCount; wi++) {
    const w = candidates[wi];
    const letters = w.word.toUpperCase();
    let best = null, bestScore = -Infinity;

    for (let r = 0; r < CW_ROWS; r++) {
      for (let c = 0; c < CW_COLS; c++) {
        if (!cwGrid[r][c]) continue;
        const gl = cwGrid[r][c].letter;
        for (let li = 0; li < letters.length; li++) {
          if (letters[li] !== gl) continue;
          if (cwGrid[r][c].acrossId === null) {
            const ar = r, ac = c - li;
            if (cwCanPlace(letters, ar, ac, 'across')) {
              const s = cwScorePlacement(letters, ar, ac, 'across');
              if (s > bestScore) { bestScore = s; best = {row: ar, col: ac, dir: 'across'}; }
            }
          }
          if (cwGrid[r][c].downId === null) {
            const dr = r - li, dc = c;
            if (cwCanPlace(letters, dr, dc, 'down')) {
              const s = cwScorePlacement(letters, dr, dc, 'down');
              if (s > bestScore) { bestScore = s; best = {row: dr, col: dc, dir: 'down'}; }
            }
          }
        }
      }
    }

    if (best) {
      const id = cwPlaced.length;
      cwDoPlace(letters, id, best.row, best.col, best.dir);
      cwPlaced.push({word: w.word, clue: w.fr, row: best.row, col: best.col, dir: best.dir, len: letters.length, solved: false, number: 0});
    }
  }
  return cwPlaced.length >= 2;
}

function cwGetBounds() {
  let minR = CW_ROWS, maxR = 0, minC = CW_COLS, maxC = 0;
  for (let r = 0; r < CW_ROWS; r++) {
    for (let c = 0; c < CW_COLS; c++) {
      if (cwGrid[r][c]) {
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
    }
  }
  return {r0: Math.max(0, minR), r1: Math.min(CW_ROWS - 1, maxR), c0: Math.max(0, minC), c1: Math.min(CW_COLS - 1, maxC)};
}

function cwCellsOfWord(wid) {
  const w = cwPlaced[wid];
  return Array.from({length: w.len}, (_, i) => ({
    r: w.dir === 'down' ? w.row + i : w.row,
    c: w.dir === 'across' ? w.col + i : w.col,
  }));
}

function cwBuildNumbers() {
  const numMap = {};
  const sorted = cwPlaced.slice().sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
  let num = 1;
  sorted.forEach(w => {
    const key = `${w.row},${w.col}`;
    if (!numMap[key]) numMap[key] = num++;
    w.number = numMap[key];
  });
  return numMap;
}

function cwRenderGrid() {
  const tbl = $('cw-grid');
  tbl.innerHTML = '';
  const {r0, r1, c0, c1} = cwGetBounds();
  const numCols = c1 - c0 + 1;
  const avail = Math.min(330, (window.innerWidth || 375) - 44);
  const cellSz = Math.min(30, Math.floor(avail / numCols));
  const numMap = cwBuildNumbers();

  for (let r = r0; r <= r1; r++) {
    const tr = document.createElement('tr');
    for (let c = c0; c <= c1; c++) {
      const td = document.createElement('td');
      td.style.cssText = `width:${cellSz}px;height:${cellSz}px;padding:1px`;
      const cell = cwGrid[r][c];
      if (cell) {
        const div = document.createElement('div');
        div.className = 'cw-cell';
        div.dataset.r = r;
        div.dataset.c = c;
        const inner = cellSz - 2;
        div.style.cssText = `width:${inner}px;height:${inner}px;font-size:${Math.max(9, inner - 14)}px`;
        const numKey = `${r},${c}`;
        if (numMap[numKey]) {
          const ns = document.createElement('span');
          ns.className = 'cw-num';
          ns.textContent = numMap[numKey];
          div.appendChild(ns);
        }
        if (cell.filled) {
          const isSolved = [cell.acrossId, cell.downId].some(id => id !== null && cwPlaced[id] && cwPlaced[id].solved);
          div.classList.add(isSolved || cell.filled === cell.letter ? 'correct' : 'error');
          div.appendChild(document.createTextNode(cell.filled));
        }
        div.addEventListener('click', () => cwCellClick(r, c));
        td.appendChild(div);
      }
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  cwUpdateHighlight();
}

function cwUpdateHighlight() {
  document.querySelectorAll('.cw-cell').forEach(el => el.classList.remove('selected', 'cursor'));
  if (cwSelectedId === null) return;
  cwCellsOfWord(cwSelectedId).forEach(({r, c}, i) => {
    const el = document.querySelector(`.cw-cell[data-r="${r}"][data-c="${c}"]`);
    if (el) el.classList.add(i === cwCursorPos ? 'cursor' : 'selected');
  });
}

function cwCellClick(r, c) {
  const cell = cwGrid[r][c];
  if (!cell) return;
  const {acrossId, downId} = cell;
  if (acrossId !== null && downId !== null) {
    cwSelectedId = (cwSelectedId === acrossId) ? downId : acrossId;
  } else {
    cwSelectedId = acrossId !== null ? acrossId : downId;
  }
  if (cwSelectedId === null) return;
  const w = cwPlaced[cwSelectedId];
  cwCursorPos = w.dir === 'across' ? c - w.col : r - w.row;
  cwUpdateClue();
  cwUpdateHighlight();
  $('cw-input').focus();
}

function cwUpdateClue() {
  const box = $('cw-clue-box');
  if (cwSelectedId === null) { box.textContent = 'Sélectionnez une case'; return; }
  const w = cwPlaced[cwSelectedId];
  const sym = w.dir === 'across' ? '→' : '↓';
  box.innerHTML = `<span class="cw-clue-word">${sym}${w.number}</span> ${w.clue}`;
}

function cwIsWordComplete(wid) {
  const letters = cwPlaced[wid].word.toUpperCase();
  return cwCellsOfWord(wid).every(({r, c}, i) => cwGrid[r][c].filled === letters[i]);
}

function cwTypeChar(ch) {
  if (cwSelectedId === null) return;
  const w = cwPlaced[cwSelectedId];
  if (cwCursorPos >= w.len) return;
  const r = w.dir === 'down' ? w.row + cwCursorPos : w.row;
  const c = w.dir === 'across' ? w.col + cwCursorPos : w.col;
  cwGrid[r][c].filled = ch;

  if (cwCursorPos < w.len - 1) cwCursorPos++;

  let anyNewlySolved = false;
  const cell = cwGrid[r][c];
  [cell.acrossId, cell.downId].forEach(wid => {
    if (wid !== null && !cwPlaced[wid].solved && cwIsWordComplete(wid)) {
      cwPlaced[wid].solved = true;
      anyNewlySolved = true;
      srsUpdate(state.lang, cwPlaced[wid].word, true);
      saveSrs(state.lang);
      logDaily(cwSrsLang, true);
      beep(true);
      vibrate(true);
    }
  });

  cwRenderGrid();
  cwUpdateHighlight();
  cwRenderWordList();

  const solved = cwPlaced.filter(p => p.solved).length;
  $('cw-progress').textContent = `${solved}/${cwPlaced.length} trouvés`;

  if (anyNewlySolved) {
    if (solved === cwPlaced.length) {
      $('cw-clue-box').innerHTML = '🎉 Félicitations ! Toute la grille est complétée !';
    } else {
      setTimeout(() => {
        const next = cwPlaced.findIndex(p => !p.solved);
        if (next >= 0) { cwSelectedId = next; cwCursorPos = 0; cwUpdateClue(); cwUpdateHighlight(); }
      }, 600);
    }
  } else {
    cwUpdateClue();
  }
}

function cwBackspace() {
  if (cwSelectedId === null) return;
  const w = cwPlaced[cwSelectedId];
  const r = w.dir === 'down' ? w.row + cwCursorPos : w.row;
  const c = w.dir === 'across' ? w.col + cwCursorPos : w.col;
  if (cwGrid[r][c].filled) {
    cwGrid[r][c].filled = '';
  } else if (cwCursorPos > 0) {
    cwCursorPos--;
    const r2 = w.dir === 'down' ? w.row + cwCursorPos : w.row;
    const c2 = w.dir === 'across' ? w.col + cwCursorPos : w.col;
    cwGrid[r2][c2].filled = '';
  }
  cwRenderGrid();
  cwUpdateHighlight();
  cwUpdateClue();
}

function cwRenderWordList() {
  const list = $('cw-words-list');
  list.innerHTML = '';
  const across = cwPlaced.filter(p => p.dir === 'across').sort((a, b) => a.number - b.number);
  const down = cwPlaced.filter(p => p.dir === 'down').sort((a, b) => a.number - b.number);
  [[across, '→', 'Horizontal'], [down, '↓', 'Vertical']].forEach(([group, sym, label]) => {
    if (!group.length) return;
    const lbl = document.createElement('span');
    lbl.className = 'cw-dir-label';
    lbl.textContent = label;
    list.appendChild(lbl);
    group.forEach(pw => {
      const tag = document.createElement('div');
      tag.className = 'cw-word-tag' + (pw.solved ? ' solved' : '');
      tag.innerHTML = `<span class="cw-word-num">${sym}${pw.number}</span> ${pw.clue}${pw.solved ? ' ✓' : ''}`;
      tag.addEventListener('click', () => {
        cwSelectedId = cwPlaced.indexOf(pw);
        cwCursorPos = 0;
        cwUpdateClue();
        cwUpdateHighlight();
        $('cw-input').focus();
      });
      list.appendChild(tag);
    });
  });
}

function openCrossword() {
  cwSrsLang = getModeKey(cwMode);
  showView('crossword');
  renderChips('.cwcount-chip', cwWordCount, 'count');
  renderChips('.cwmode-chip', cwMode, 'mode');
  $('cw-grid-wrap').classList.add('hidden');
  $('cw-clue-box').classList.add('hidden');
  $('cw-words-list').classList.add('hidden');
  $('btn-cw-new').classList.add('hidden');
  $('btn-cw-start').classList.remove('hidden');
  $('cw-progress').textContent = '';
  cwSelectedId = null;
  cwCursorPos = 0;
}

async function startCrossword() {
  const words = await getModeWords(cwMode);
  cwSrsLang = getModeKey(cwMode);
  let ok = false;
  for (let t = 0; t < 15 && !ok; t++) ok = cwGenerate(words);
  if (!ok) {
    $('cw-clue-box').textContent = 'Impossible de créer la grille — essayez un autre niveau.';
    $('cw-clue-box').classList.remove('hidden');
    return;
  }
  cwBuildNumbers();
  cwSelectedId = null;
  cwCursorPos = 0;
  cwRenderGrid();
  cwRenderWordList();
  $('cw-grid-wrap').classList.remove('hidden');
  $('cw-clue-box').classList.remove('hidden');
  $('cw-words-list').classList.remove('hidden');
  $('btn-cw-new').classList.remove('hidden');
  $('btn-cw-start').classList.add('hidden');
  $('cw-progress').textContent = `0/${cwPlaced.length} trouvés`;
  $('cw-clue-box').textContent = 'Sélectionnez une case pour commencer';
}

$('btn-crossword').addEventListener('click', () => openCrossword());
$('btn-cw-start').addEventListener('click', () => startCrossword());
$('btn-cw-new').addEventListener('click', () => startCrossword());
$('btn-cw-home').addEventListener('click', () => exitToHome());
document.querySelectorAll('.cwcount-chip').forEach(c => c.addEventListener('click', () => {
  cwWordCount = +c.dataset.count;
  renderChips('.cwcount-chip', cwWordCount, 'count');
}));
document.querySelectorAll('.cwmode-chip').forEach(c => c.addEventListener('click', () => {
  cwMode = c.dataset.mode;
  cwSrsLang = getModeKey(cwMode);
  renderChips('.cwmode-chip', cwMode, 'mode');
}));

const cwInput = $('cw-input');
cwInput.addEventListener('input', function () {
  const val = this.value;
  this.value = '';
  if (!val || cwSelectedId === null) return;
  const ch = val.slice(-1).toUpperCase();
  if (/[A-Z]/.test(ch)) cwTypeChar(ch);
});
cwInput.addEventListener('keydown', function (e) {
  if (e.key === 'Backspace') { e.preventDefault(); cwBackspace(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (cwSelectedId !== null) { cwCursorPos = Math.min(cwPlaced[cwSelectedId].len - 1, cwCursorPos + 1); cwUpdateHighlight(); }
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (cwSelectedId !== null) { cwCursorPos = Math.max(0, cwCursorPos - 1); cwUpdateHighlight(); }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (cwSelectedId !== null) { cwSelectedId = (cwSelectedId + 1) % cwPlaced.length; cwCursorPos = 0; cwUpdateClue(); cwUpdateHighlight(); }
  }
});

// ==================== MOTS À RELIER ====================
const MR_COLORS = ['#27B3FF','#4CE0D2','#35D07F','#A855F7','#FF6B35','#F97316','#EF4444','#F59E0B','#10B981','#1B5CFF'];
let mrWords = [], mrLeft = [], mrRight = [], mrSelected = null, mrPaired = new Map(), mrColorIdx = 0, mrWordCount = 5, mrSrsLang, mrMode = 'vocab';

function openMatching() {
  mrSrsLang = getModeKey(mrMode);
  showView('matching');
  renderChips('.mrcount-chip', mrWordCount, 'count');
  renderChips('.mrmode-chip', mrMode, 'mode');
  $('mr-container').classList.add('hidden');
  $('mr-result').classList.add('hidden');
  $('btn-mr-new').classList.add('hidden');
  $('btn-mr-start').classList.remove('hidden');
  $('mr-progress').textContent = '';
}

async function startMatching() {
  const pool = (await getModeWords(mrMode)).filter(w => w.fr && w.word);
  mrSrsLang = getModeKey(mrMode);
  if (pool.length < 2) return;
  mrWords = shuffle(pool).slice(0, Math.min(mrWordCount, pool.length));
  mrLeft = shuffle(mrWords.map((w, i) => ({word: w.word, fr: w.fr, idx: i})));
  mrRight = shuffle(mrWords.map((w, i) => ({word: w.word, fr: w.fr, idx: i})));
  mrSelected = null;
  mrPaired = new Map();
  mrColorIdx = 0;
  mrRenderCols();
  $('mr-container').classList.remove('hidden');
  $('mr-result').classList.add('hidden');
  $('btn-mr-new').classList.remove('hidden');
  $('btn-mr-start').classList.add('hidden');
  $('mr-progress').textContent = `0/${mrWords.length} reliés`;
}

function mrRenderCols() {
  [['mr-col-left', mrLeft, 'left', w => display(w.word)],
   ['mr-col-right', mrRight, 'right', w => display(w.fr)]].forEach(([colId, list, side, label]) => {
    const col = $(colId);
    col.innerHTML = '';
    list.forEach(w => {
      const btn = document.createElement('button');
      btn.className = `mr-cell mr-${side}`;
      btn.dataset.idx = w.idx;
      btn.textContent = label(w);
      const ci = mrPaired.get(w.idx);
      if (ci !== undefined) {
        btn.classList.add('paired');
        btn.style.borderColor = MR_COLORS[ci];
        btn.style.color = MR_COLORS[ci];
      } else if (mrSelected?.side === side && mrSelected.idx === w.idx) {
        btn.classList.add('selected');
      }
      btn.addEventListener('click', () => mrClick(side, w.idx));
      col.appendChild(btn);
    });
  });
  requestAnimationFrame(mrDrawLines);
}

function mrDrawLines() {
  const svg = $('mr-svg');
  const container = $('mr-container');
  svg.innerHTML = '';
  const cRect = container.getBoundingClientRect();
  if (!cRect.width) return;
  svg.setAttribute('width', cRect.width);
  svg.setAttribute('height', cRect.height);
  svg.setAttribute('viewBox', `0 0 ${cRect.width} ${cRect.height}`);

  mrPaired.forEach((ci, wordIdx) => {
    const lEl = document.querySelector(`.mr-left[data-idx="${wordIdx}"]`);
    const rEl = document.querySelector(`.mr-right[data-idx="${wordIdx}"]`);
    if (!lEl || !rEl) return;
    const lR = lEl.getBoundingClientRect();
    const rR = rEl.getBoundingClientRect();
    const x1 = lR.right - cRect.left;
    const y1 = lR.top + lR.height / 2 - cRect.top;
    const x2 = rR.left - cRect.left;
    const y2 = rR.top + rR.height / 2 - cRect.top;
    const cx = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`);
    path.setAttribute('stroke', MR_COLORS[ci]);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  });
}

function mrClick(side, idx) {
  if (mrPaired.has(idx)) return;

  if (!mrSelected) { mrSelected = {side, idx}; mrRenderCols(); return; }

  if (mrSelected.side === side) {
    mrSelected = mrSelected.idx === idx ? null : {side, idx};
    mrRenderCols();
    return;
  }

  const a = mrSelected;
  mrSelected = null;

  if (a.idx === idx) {
    mrPaired.set(idx, mrColorIdx % MR_COLORS.length);
    mrColorIdx++;
    srsUpdate(state.lang, mrWords[idx].word, true);
    saveSrs(state.lang);
    logDaily(mrSrsLang, true);
    beep(true); vibrate(true);
    mrRenderCols();
    const done = mrPaired.size;
    $('mr-progress').textContent = `${done}/${mrWords.length} reliés`;
    if (done === mrWords.length) {
      setTimeout(() => { $('mr-result').textContent = '🎉 Tous les mots sont reliés !'; $('mr-result').classList.remove('hidden'); }, 400);
    }
  } else {
    beep(false); vibrate(false);
    mrRenderCols();
    setTimeout(() => {
      [document.querySelector(`.mr-${a.side}[data-idx="${a.idx}"]`),
       document.querySelector(`.mr-${side}[data-idx="${idx}"]`)].forEach(el => el && el.classList.add('error'));
      setTimeout(() => document.querySelectorAll('.mr-cell.error').forEach(el => el.classList.remove('error')), 500);
    }, 10);
  }
}

$('btn-matching').addEventListener('click', () => openMatching());
$('btn-mr-start').addEventListener('click', () => startMatching());
$('btn-mr-new').addEventListener('click', () => startMatching());
$('btn-mr-home').addEventListener('click', () => exitToHome());
document.querySelectorAll('.mrcount-chip').forEach(c => c.addEventListener('click', () => {
  mrWordCount = +c.dataset.count;
  renderChips('.mrcount-chip', mrWordCount, 'count');
}));
document.querySelectorAll('.mrmode-chip').forEach(c => c.addEventListener('click', () => {
  mrMode = c.dataset.mode;
  mrSrsLang = getModeKey(mrMode);
  renderChips('.mrmode-chip', mrMode, 'mode');
}));
