'use strict';

const QUESTION_COUNT = 5;
const OPTION_COUNT = 4;

const LANGS = {
  en: { label: 'Anglais', file: 'data/wordlist_en.json', levels: ['Global', 'A1', 'A2', 'B1', 'B2', 'C', 'D'] },
  es: { label: 'Espagnol', file: 'data/wordlist_es.json', levels: ['Global', 'A1-A2', 'B1-B2', 'C1-C2'] },
};

const state = {
  lang: 'en',
  level: 'Global',
  words: [],          // loaded wordlist for current lang
  questions: [],
  answers: [],
  index: 0,
};

const cache = {}; // lang -> words array

// ---------- storage ----------
function statsKey(lang) { return `quizlangue:stats:${lang}:v1`; }
function defaultStats() { return { totalCompleted: 0, totalPoints: 0, perfectStreak: 0, perfectTotal: 0, lastScore: 0 }; }
function loadStats(lang) {
  try {
    const raw = localStorage.getItem(statsKey(lang));
    return raw ? Object.assign(defaultStats(), JSON.parse(raw)) : defaultStats();
  } catch (e) { return defaultStats(); }
}
function saveStats(lang, stats) {
  try { localStorage.setItem(statsKey(lang), JSON.stringify(stats)); } catch (e) {}
}

// ---------- helpers ----------
function display(value) { return String(value || '').replace(/_/g, ' '); }

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickUnique(list, count) {
  if (count >= list.length) return list.slice();
  const used = new Set();
  const out = [];
  while (out.length < count) {
    const idx = Math.floor(Math.random() * list.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(list[idx]);
  }
  return out;
}

function buildQuestion(item, pool) {
  const correct = item.fr;
  const options = [correct];
  const used = new Set([correct]);
  let guard = 0;
  while (options.length < OPTION_COUNT && guard < 4000) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!used.has(cand)) { used.add(cand); options.push(cand); }
    guard++;
  }
  const shuffled = shuffle(options);
  return {
    wordDisplay: display(item.word),
    level: item.level || '',
    options: shuffled.map(display),
    correctIndex: shuffled.indexOf(correct),
    correctText: display(correct),
  };
}

function buildQuiz(words, level, count) {
  const filtered = level && level !== 'Global' ? words.filter(w => w.level === level) : words;
  const source = filtered.length >= count ? filtered : words;
  const pool = source.map(w => w.fr);
  return pickUnique(source, count).map(it => buildQuestion(it, pool));
}

async function loadWords(lang) {
  if (cache[lang]) return cache[lang];
  const res = await fetch(LANGS[lang].file);
  const data = await res.json();
  cache[lang] = data;
  return data;
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const views = { home: $('view-home'), quiz: $('view-quiz'), result: $('view-result') };

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  window.scrollTo(0, 0);
}

function renderLangChips() {
  document.querySelectorAll('.lang-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.lang === state.lang);
  });
}

function renderLevelChips() {
  const row = $('level-row');
  row.innerHTML = '';
  LANGS[state.lang].levels.forEach(lv => {
    const b = document.createElement('button');
    b.className = 'level-chip' + (lv === state.level ? ' active' : '');
    b.textContent = lv;
    b.addEventListener('click', () => {
      state.level = lv;
      renderLevelChips();
      updatePool();
    });
    row.appendChild(b);
  });
}

function renderStats() {
  const s = loadStats(state.lang);
  $('stat-last').textContent = `${s.lastScore}/5`;
  $('stat-total').textContent = s.totalCompleted;
  $('stat-points').textContent = s.totalPoints;
  $('stat-streak').textContent = s.perfectStreak;
  $('stat-perfect').textContent = s.perfectTotal;
}

function updatePool() {
  const lv = state.level;
  const words = state.words;
  const n = (lv && lv !== 'Global') ? words.filter(w => w.level === lv).length : words.length;
  $('stat-pool').textContent = n;
}

async function selectLang(lang) {
  state.lang = lang;
  state.level = 'Global';
  state.words = await loadWords(lang);
  renderLangChips();
  renderLevelChips();
  renderStats();
  updatePool();
}

// ---------- quiz flow ----------
function startQuiz() {
  state.questions = buildQuiz(state.words, state.level, QUESTION_COUNT);
  state.answers = [];
  state.index = 0;
  showView('quiz');
  renderQuestion();
}

function renderQuestion() {
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  $('quiz-progress').textContent = `Question ${state.index + 1}/${state.questions.length}`;
  $('quiz-level').textContent = state.level;
  $('quiz-word').textContent = q.wordDisplay;

  const box = $('quiz-options');
  box.innerHTML = '';
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
    fb.textContent = a.correct ? 'Correct' : `Faux. Bonne réponse : ${q.correctText}`;
    fb.className = 'feedback ' + (a.correct ? 'good' : 'bad');
  } else {
    fb.textContent = '';
    fb.className = 'feedback';
  }

  const next = $('btn-next');
  next.disabled = !a;
  next.textContent = state.index < state.questions.length - 1 ? 'Suivant' : 'Voir le score';
}

function selectOption(idx) {
  if (state.answers[state.index]) return;
  const q = state.questions[state.index];
  state.answers[state.index] = { selectedIndex: idx, correct: idx === q.correctIndex };
  renderQuestion();
}

function goNext() {
  if (!state.answers[state.index]) return;
  if (state.index < state.questions.length - 1) {
    state.index++;
    renderQuestion();
  } else {
    finishQuiz();
  }
}

function finishQuiz() {
  const score = state.answers.filter(a => a && a.correct).length;
  const wrong = state.questions.map((q, i) => {
    const a = state.answers[i];
    return { word: q.wordDisplay, correct: q.correctText, isCorrect: a ? a.correct : false };
  }).filter(x => !x.isCorrect);

  const prev = loadStats(state.lang);
  const perfect = score === QUESTION_COUNT;
  const next = {
    totalCompleted: prev.totalCompleted + 1,
    totalPoints: prev.totalPoints + score,
    perfectStreak: perfect ? prev.perfectStreak + 1 : 0,
    perfectTotal: perfect ? prev.perfectTotal + 1 : prev.perfectTotal,
    lastScore: score,
  };
  saveStats(state.lang, next);

  $('result-score').textContent = `${score}/5`;
  const wbox = $('result-wrong');
  if (wrong.length) {
    wbox.innerHTML = '<span class="wrong-title">Erreurs</span>' +
      wrong.map(w => `<div class="wrong-row"><span class="wrong-word">${w.word}</span><span class="wrong-answer">${w.correct}</span></div>`).join('');
  } else {
    wbox.innerHTML = '<span class="wrong-title">Parfait</span><span class="wrong-answer">Aucune erreur</span>';
  }
  showView('result');
}

// ---------- wire up ----------
document.querySelectorAll('.lang-chip').forEach(chip => {
  chip.addEventListener('click', () => selectLang(chip.dataset.lang));
});
$('btn-start').addEventListener('click', startQuiz);
$('btn-next').addEventListener('click', goNext);
$('btn-replay').addEventListener('click', () => { showView('home'); renderStats(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

selectLang('en');
