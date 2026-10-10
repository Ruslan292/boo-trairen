import { STORAGE_KEY, emptyProgress, questionMap, restoreProgress, createSession, learningContinuation, recordAnswer, finishSession, resultFor, statsFor, toggleDifficult, syncDifficultSession, nextDifficultQuestion } from './model.js?v=5';
import { renderDashboard } from './dashboard.js?v=5';

const app = document.querySelector('#app');
const paths = {
  shield: '<path d="m12 3 8 4v6c0 5-5 8-8 9-3-1-8-4-8-9V7z"/><path d="m8 12 3 3 5-6"/>',
  home: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  book: '<path d="M12 6c-3-3-7-3-10-1v14c3-2 7-2 10 1 3-3 7-3 10-1V5c-3-2-7-2-10 1zm0 0v14"/>',
  flag: '<path d="M5 22V3m0 1c5-3 9 3 15 0v11c-6 3-10-3-15 0"/>',
  repeat: '<path d="M20 7H5l3-3M4 17h15l-3 3M20 7v5M4 17v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
  chart: '<path d="M4 20V10m8 10V4m8 16v-7"/>',
  chevron: '<path d="m15 5-7 7 7 7"/>',
  star: '<path d="m12 3 3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z"/>',
};
const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const declension = (number, words) => words[number % 100 > 10 && number % 100 < 20 ? 2 : number % 10 === 1 ? 0 : number % 10 >= 2 && number % 10 <= 4 ? 1 : 2];
const countQuestions = number => `${number} ${declension(number, ['вопрос', 'вопроса', 'вопросов'])}`;
const date = timestamp => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(timestamp);
const time = milliseconds => { const seconds = Math.max(0, Math.ceil(milliseconds / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
let data, questions, progress;
let page = 'home';
let selectedMode = 'learn';
let sessionMode = 'learn';
let storageWarning = false;
let pendingStart = null;

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); }
  catch { storageWarning = true; }
}

const modeSession = (mode = sessionMode) => progress.modes[mode].session;
const modeSettings = (mode = selectedMode) => progress.modes[mode].settings;

function selectMode(mode) {
  selectedMode = progress.selectedMode = mode;
  save();
}

function openSession(mode) {
  selectMode(mode); sessionMode = mode; page = 'session'; render(true);
}

function resume(mode = selectedMode) {
  if (mode === 'learn') { start('learn'); return; }
  if (mode === 'difficult') { syncDifficultSession(progress, questions); save(); }
  if (modeSession(mode)) openSession(mode); else if (mode === 'difficult') { page = 'difficult'; render(true); }
}

function continueLearning() {
  const hasNewQuestions = Object.keys(progress.modes.learn.answers).length < questions.size;
  if (modeSession('learn')?.repeat && hasNewQuestions) {
    start('learn', 0, { fresh: true, replace: true });
  } else start('learn', 0);
}

function shell(content) {
  const stats = statsFor(progress, questions.size);
  const navigation = [['home', 'home', 'Обзор'], ['tickets', 'book', 'Все билеты'], ['mistakes', 'repeat', 'Мои ошибки'], ['difficult', 'star', 'Сложные вопросы'], ['history', 'chart', 'История']];
  app.innerHTML = `<div class="layout">
    <aside class="sidebar">
      <a class="brand" href="./" aria-label="БОО — главная"><span class="brand-mark">${icon('shield')}</span><span>БОО<span class="brand-caption">ТРЕНАЖЁР</span></span></a>
      <div class="nav-caption">ВАША ПОДГОТОВКА</div>
      <nav aria-label="Основная навигация">${navigation.map(([id, symbol, label]) => `<button class="nav-item ${page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${(id === 'mistakes' ? stats.mistakes : id === 'difficult' ? progress.difficult.length : 0) ? `<span class="nav-count">${id === 'mistakes' ? stats.mistakes : progress.difficult.length}</span>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><span class="source-dot"></span>Учебные билеты · 2026<p>${data.tickets.length} билетов · ${questions.size} вопросов</p><span class="local-note">Прогресс хранится в этом браузере</span></div>
    </aside>
    <div class="workspace"><header class="topbar"><span>Безопасное обращение с оружием</span><span class="edition">${icon('shield')} Подготовка · 2026</span></header>
      <main id="main" tabindex="-1">${storageWarning ? '<div class="notice">Браузер не разрешил сохранить прогресс. Текущая тренировка доступна, но после закрытия страницы её результаты могут потеряться.</div>' : ''}${content}</main>
      <footer>БОО Тренажёр <span>Учитесь в своём темпе.</span></footer>
    </div>
  </div><dialog id="confirm-dialog"><div class="dialog-content"><span class="eyebrow">УЧЕБНЫЙ ЭКЗАМЕН</span><h2>Завершить экзамен?</h2><p id="confirm-description"></p><div class="dialog-actions"><button class="button secondary" data-action="cancel-finish">Продолжить</button><button class="button primary" data-action="confirm-finish">Завершить</button></div></div></dialog>`;
}

function heading(eyebrow, title, description = '') {
  return `<div class="page-heading"><span class="eyebrow">${eyebrow}</span><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div>`;
}

function difficultButton(question) {
  const marked = progress.difficult.includes(question.id);
  return `<button class="button secondary difficult-toggle" data-action="toggle-difficult" data-question="${escape(question.id)}" aria-pressed="${marked}">${icon('star')} ${marked ? 'Убрать из сложных' : 'Отметить как сложный'}</button>`;
}

function difficultPage() {
  const saved = modeSession('difficult');
  const collection = progress.difficult.map(id => questions.get(id));
  shell(`${heading('ВАША ЛИЧНАЯ КОЛЛЕКЦИЯ', 'Сложные вопросы', 'Вы отмечаете эти вопросы сами. Повторяйте их по кругу: даже после правильного ответа они остаются здесь до ручного удаления.')}${collection.length ? `<div class="list-toolbar difficult-toolbar"><span>В коллекции: ${countQuestions(collection.length)}</span><button class="button primary" data-action="practice-difficult">${saved?.status === 'active' ? 'Продолжить повтор' : 'Повторять по кругу'} ${icon('repeat')}</button></div><div class="question-list">${collection.map(question => `<article class="list-question difficult-question"><span class="eyebrow">БИЛЕТ № ${question.ticketId} · ВОПРОС ${question.number}</span><h2>${escape(question.text)}</h2><div class="list-question-actions"><span class="list-tag">Сохранён вручную</span><button class="button secondary" data-action="remove-difficult" data-question="${escape(question.id)}">${icon('cross')} Удалить из раздела</button></div></article>`).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('star')}</span><h2>Добавьте сложные вопросы</h2><p>Нажмите «Отметить как сложный» рядом с вопросом — в обучении, работе над ошибками или разборе экзамена.</p><button class="button primary" data-action="quick-learn">Перейти к обучению ${icon('arrow')}</button></div>`}`);
}

function home() {
  shell(renderDashboard({ data, progress, selectedMode, icon, escape, countQuestions, time, heading }));
}

function ticketsPage() {
  const studied = Object.keys(progress.modes.learn.answers).length;
  const remaining = questions.size - studied;
  const continuation = studied && remaining ? `<div class="list-toolbar"><span>Осталось изучить: ${countQuestions(remaining)}</span><button class="button primary" data-action="continue-learn">Продолжить обучение ${icon('arrow')}</button></div>` : '';
  shell(`${heading('БАЗА ВОПРОСОВ', 'Все билеты', `${data.tickets.length} учебных билетов без повторов. Последний билет содержит ${countQuestions(data.tickets.at(-1).questions.length)}. Выберите любой для тренировки.`)}${continuation}<div class="ticket-grid">${data.tickets.map(ticket => {
    const answered = ticket.questions.filter(question => progress.modes.learn.answers[question.id]).length;
    const saved = modeSession('learn');
    const canResume = saved?.status === 'active' && saved.ticketId === ticket.id && saved.questionIds.some(id => !saved.checked.includes(id) && (saved.repeat || !progress.modes.learn.answers[id]));
    const repeat = !canResume && answered === ticket.questions.length;
    return `<article class="ticket-card"><span class="ticket-number">${String(ticket.id).padStart(2, '0')}</span><h2>Билет № ${ticket.id}</h2><p>${countQuestions(ticket.questions.length)}</p><progress value="${answered}" max="${ticket.questions.length}" aria-label="Прогресс билета ${ticket.id}"></progress><span class="ticket-progress">Изучено ${answered} из ${ticket.questions.length}</span><button class="button secondary" data-action="${repeat ? 'ticket-repeat' : 'ticket-learn'}" data-ticket="${ticket.id}">${repeat ? 'Повторить билет' : answered || canResume ? 'Продолжить билет' : 'Пройти билет'} ${icon('arrow')}</button></article>`;
  }).join('')}</div>`);
}

function mistakesPage() {
  const mistakes = progress.mistakes.map(id => questions.get(id));
  shell(`${heading('ЗАКРЕПЛЯЕМ ЗНАНИЯ', 'Мои ошибки', 'Повторяйте сложные вопросы. После правильного ответа вопрос исчезнет из этого списка.')}${mistakes.length ? `<div class="list-toolbar"><span>На повторение: ${countQuestions(mistakes.length)}</span><button class="button primary" data-action="review">Повторить все ${icon('arrow')}</button></div><div class="question-list">${mistakes.map(question => `<article class="list-question"><span class="eyebrow">БИЛЕТ № ${question.ticketId} · ВОПРОС ${question.number}</span><h2>${escape(question.text)}</h2><div class="list-question-actions"><span class="list-tag">Нужно повторить</span>${difficultButton(question)}</div></article>`).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('check')}</span><h2>Ошибок пока нет</h2><p>Начните тренировку — сложные вопросы будут собраны здесь.</p><button class="button primary" data-action="quick-learn">Перейти к обучению ${icon('arrow')}</button></div>`}`);
}

function historyPage() {
  shell(`${heading('РЕЗУЛЬТАТЫ ПОДГОТОВКИ', 'История экзаменов', 'Ваши последние 50 попыток сохраняются в этом браузере.')}${progress.exams.length ? `<div class="history-list">${[...progress.exams].reverse().map(exam => `<article class="history-item"><span class="result-mark ${exam.passed ? 'success' : 'failure'}">${icon(exam.passed ? 'check' : 'repeat')}</span><div><h2>${exam.bankVersion === 1 ? "Исходный билет" : "Билет"} № ${exam.ticketId}</h2><p>${date(exam.finishedAt)} · ${time(exam.duration)}</p><small>Допустимо ошибок: ${exam.allowedErrors}</small></div><div class="history-score"><strong>${exam.correct} / ${exam.total}</strong><span>${exam.passed ? 'Экзамен сдан' : 'Нужно повторить'}</span></div></article>`).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('chart')}</span><h2>Всё ещё впереди</h2><p>Пройдите учебный экзамен, чтобы увидеть первый результат.</p><button class="button primary" data-action="choose-exam">Подготовиться к экзамену ${icon('arrow')}</button></div>`}`);
}

function sessionPage() {
  const session = sessionMode === 'difficult' ? syncDifficultSession(progress, questions) : modeSession();
  if (!session) { page = sessionMode === 'difficult' ? 'difficult' : 'home'; (page === 'difficult' ? difficultPage : home)(); return; }
  if (session.status === 'finished') { resultsPage(); return; }
  const id = session.questionIds[session.index];
  const question = questions.get(id);
  const response = session.responses[id];
  const checked = session.checked.includes(id);
  const correct = response === question.correctOptionId;
  const exam = session.mode === 'exam';
  const difficult = session.mode === 'difficult';
  const answered = exam ? Object.keys(session.responses).length : session.checked.length;
  shell(`<div class="session-heading"><button class="text-button" data-action="navigate" data-page="${difficult ? 'difficult' : 'home'}">${icon('chevron')} ${difficult ? 'К сложным вопросам' : 'К обзору'}</button><span class="session-mode">${icon(exam ? 'clock' : difficult ? 'star' : session.mode === 'mistakes' ? 'repeat' : 'book')}${exam ? 'Учебный экзамен' : difficult ? 'Сложные вопросы' : session.mode === 'mistakes' ? 'Работа над ошибками' : 'Обучение'}</span>${exam ? `<span class="timer" id="timer" aria-label="Оставшееся время">${icon('clock')}<span>${time(session.deadline - Date.now())}</span></span>` : ''}</div>
    <div class="exercise-layout"><section class="exercise"><div class="exercise-top"><span class="eyebrow">${session.bankVersion === 1 && session.ticketId ? "ИСХОДНЫЙ БИЛЕТ № " + session.ticketId : "БИЛЕТ № " + question.ticketId}</span><span>${difficult ? `<span class="cycle-label">Круг ${session.round}</span> · ` : ''}Вопрос ${session.index + 1} из ${session.questionIds.length}</span></div><progress value="${answered}" max="${session.questionIds.length}" aria-label="Прогресс тренировки"></progress><div class="question-tools">${difficultButton(question)}${difficult ? '<span class="difficult-note">Остаётся в коллекции до ручного удаления</span>' : ''}</div><h1 class="question-text">${escape(question.text)}</h1><div class="answers" role="group" aria-label="Варианты ответа">${question.options.map(option => {
      const selected = response === option.id;
      let state = selected ? 'chosen' : '';
      if (checked && !exam) state = option.id === question.correctOptionId ? 'correct' : selected ? 'incorrect' : '';
      return `<button class="answer ${state}" data-action="answer" data-option="${option.id}" aria-pressed="${selected}" ${checked && !exam ? 'disabled' : ''}><span class="answer-number">${option.id}</span><span>${escape(option.text)}</span><span class="answer-symbol">${state === 'correct' ? icon('check') : state === 'incorrect' ? icon('cross') : '<span class="answer-radio"></span>'}</span></button>`;
    }).join('')}</div>${checked && !exam ? `<div class="feedback ${correct ? 'positive' : 'negative'}" role="status">${icon(correct ? 'check' : 'repeat')}<div><strong>${correct ? 'Верно. Так держать!' : 'Не совсем. Давайте запомним.'}</strong><p>${correct ? 'Правильный ответ подтверждён исходным документом.' : `Правильный ответ — вариант ${question.correctOptionId}: ${escape(question.options.find(option => option.id === question.correctOptionId).text)}`}</p></div></div>` : `<p class="answer-hint">${exam ? 'Выберите ответ. До завершения экзамена его можно изменить.' : 'Выберите один вариант, затем проверьте ответ.'}</p>`}<div class="exercise-actions">${exam ? `<button class="button secondary" data-action="previous" ${session.index === 0 ? 'disabled' : ''}>${icon('chevron')} Назад</button><button class="button primary" data-action="${session.index === session.questionIds.length - 1 ? 'finish' : 'next'}">${session.index === session.questionIds.length - 1 ? 'Завершить экзамен' : 'Следующий вопрос'} ${icon('arrow')}</button>` : `<span class="keyboard-hint">Клавиши 1–3 · Enter</span><button class="button primary" data-action="${checked ? 'next' : 'check'}" ${!checked && response === undefined ? 'disabled' : ''}>${checked ? (difficult && session.checked.length === session.questionIds.length ? 'Начать следующий круг' : !difficult && session.index === session.questionIds.length - 1 ? 'Посмотреть результат' : 'Следующий вопрос') : 'Проверить ответ'} ${icon(checked ? 'arrow' : 'check')}</button>`}</div></section>
    <aside class="session-aside"><h2>${exam ? 'Ваш билет' : difficult ? `Круг ${session.round}` : 'Ваша тренировка'}</h2><p>${answered} из ${session.questionIds.length} ${exam ? 'ответов выбрано' : 'ответов проверено'}</p>${exam ? `<div class="question-nav" aria-label="Навигация по вопросам">${session.questionIds.map((questionId, index) => `<button class="question-chip ${index === session.index ? 'current' : ''} ${session.responses[questionId] !== undefined ? 'answered' : ''}" data-action="jump" data-index="${index}" aria-label="Вопрос ${index + 1}" ${index === session.index ? 'aria-current="step"' : ''}>${index + 1}</button>`).join('')}</div><div class="aside-note">${icon('flag')}<p>Допустимо ошибок: ${session.allowedErrors}. Пропущенный вопрос считается ошибкой.</p></div><button class="text-button" data-action="finish">Завершить досрочно</button>` : `<div class="aside-note">${icon('book')}<p>Не спешите. Прочитайте все варианты, прежде чем выбрать ответ.</p></div><div class="aside-note">${icon('repeat')}<p>${difficult ? 'После последнего вопроса начинается новый круг. Отметки остаются, пока вы сами их не снимете.' : 'Ошибки сохраняются, чтобы вы могли к ним вернуться.'}</p></div>`}</aside></div>`);
}

function resultsPage() {
  const session = modeSession();
  const result = resultFor(session, questions);
  const exam = session.mode === 'exam';
  const passed = exam ? result.passed : result.correct === result.total;
  const remainingToLearn = questions.size - Object.keys(progress.modes.learn.answers).length;
  const incorrect = session.questionIds.filter(id => session.responses[id] !== questions.get(id).correctOptionId);
  shell(`<section class="results"><span class="result-mark large ${passed ? 'success' : 'failure'}">${icon(passed ? 'check' : 'book')}</span><span class="eyebrow">${exam ? 'РЕЗУЛЬТАТ ЭКЗАМЕНА' : 'ТРЕНИРОВКА ЗАВЕРШЕНА'}</span><h1>${exam ? passed ? 'Отлично, экзамен сдан!' : 'Ещё немного практики.' : 'Вы стали на шаг увереннее.'}</h1><p>${exam ? `${session.bankVersion === 1 ? "Исходный билет" : "Билет"} № ${session.ticketId} · допустимо ошибок: ${session.allowedErrors}` : 'Вернитесь к сложным вопросам, чтобы закрепить знания.'}</p><div class="result-stats"><div><strong>${result.correct}<small> / ${result.total}</small></strong><span>Правильных ответов</span></div><div><strong>${result.errors}</strong><span>Ошибок${result.answered < result.total ? ` (пропущено: ${result.total - result.answered})` : ''}</span></div><div><strong>${time(Math.max(0, Math.min(session.finishedAt, session.deadline || session.finishedAt) - session.startedAt))}</strong><span>Время подготовки</span></div></div><div class="results-actions">${session.mode === 'learn' && remainingToLearn ? `<button class="button primary" data-action="continue-learn">Продолжить обучение ${icon('arrow')}</button>` : ''}${progress.mistakes.length ? `<button class="button primary" data-action="review">Повторить ошибки ${icon('repeat')}</button>` : ''}<button class="button secondary" data-action="navigate" data-page="home">К обзору ${icon('arrow')}</button></div></section>${incorrect.length ? `<section class="review-results"><h2>Разбор ответов</h2><p class="muted">Правильные варианты из исходного документа.</p>${incorrect.map(id => {
    const question = questions.get(id);
    const chosen = question.options.find(option => option.id === session.responses[id]);
    const correct = question.options.find(option => option.id === question.correctOptionId);
    return `<article class="review-question"><span class="eyebrow">БИЛЕТ № ${question.ticketId} · ВОПРОС ${question.number}</span><h3>${escape(question.text)}</h3><p class="chosen-answer">Ваш ответ: ${chosen ? escape(chosen.text) : 'Вопрос пропущен'}</p><p class="correct-answer">${icon('check')}<span>Правильный ответ: ${escape(correct.text)}</span></p>${difficultButton(question)}</article>`;
  }).join('')}</section>` : ''}`);
}

function render(focus = false) {
  ({ home, tickets: ticketsPage, mistakes: mistakesPage, difficult: difficultPage, history: historyPage, session: sessionPage }[page] || home)();
  if (focus) { document.querySelector('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
}

function start(mode, ticketId = modeSettings(mode).ticketId, { fresh = false, repeat = false, replace = false } = {}) {
  if (mode === 'difficult') syncDifficultSession(progress, questions);
  const previous = modeSession(mode);
  if (mode === 'learn' && !fresh) {
    const next = learningContinuation(data.tickets, progress, ticketId);
    if (!next) { selectMode(mode); page = 'home'; render(true); return; }
    if (next === previous) { openSession(mode); return; }
    if (previous?.status === 'active') finishSession(progress, questions, mode);
    progress.modes.learn.session = next;
    modeSettings(mode).ticketId = next.ticketId || 0;
    openSession(mode); return;
  }
  if (mode === 'learn' && fresh && !repeat && previous?.status === 'active' && previous.ticketId === ticketId) { start(mode, ticketId); return; }
  if (previous?.status === 'active') {
    if (!fresh) { resume(mode); return; }
    if (!replace) {
      pendingStart = { mode, ticketId, repeat };
      const dialog = document.querySelector('#confirm-dialog');
      dialog.querySelector('.eyebrow').textContent = mode === 'exam' ? 'НОВЫЙ ЭКЗАМЕН' : 'НОВАЯ ТРЕНИРОВКА';
      dialog.querySelector('h2').textContent = mode === 'learn' && !repeat ? 'Перейти к другому билету?' : 'Начать заново?';
      dialog.querySelector('#confirm-description').textContent = mode === 'exam' ? 'Текущий экзамен будет завершён. Вопросы без ответа будут считаться ошибками. Результаты сохранятся в истории.' : 'Текущая тренировка этого раздела будет закрыта. Все проверенные ответы и прогресс сохранятся.';
      dialog.querySelector('[data-action="cancel-finish"]').textContent = 'Отмена';
      dialog.querySelector('[data-action="confirm-finish"]').textContent = mode === 'learn' && !repeat ? 'Продолжить билет' : 'Начать новую';
      dialog.showModal();
      return;
    }
  }
  const settings = { ...modeSettings(mode), ticketId, remainingOnly: mode === 'learn' && !repeat, repeat };
  const session = createSession(data.tickets, mode, settings, progress);
  if (!session) { selectMode(mode); page = mode === 'learn' ? 'home' : mode === 'difficult' ? 'difficult' : 'mistakes'; render(true); return; }
  if (previous?.status === 'active') finishSession(progress, questions, mode);
  modeSettings(mode).ticketId = ticketId;
  progress.modes[mode].session = session;
  openSession(mode);
}

function finish() {
  finishSession(progress, questions, sessionMode);
  pendingStart = null;
  save(); page = 'session'; render(true);
}

function expireExam() {
  const exam = modeSession('exam');
  if (exam?.status !== 'active' || Date.now() < exam.deadline) return false;
  finishSession(progress, questions, 'exam');
  save();
  if (page === 'session' && sessionMode === 'exam') { pendingStart = null; render(true); }
  else if (['home', 'history', 'mistakes', 'difficult'].includes(page) && !document.querySelector('dialog[open]')) render();
  return true;
}

function action(button) {
  const name = button.dataset.action;
  const session = modeSession();
  const active = session?.status === 'active';
  const id = active ? session.questionIds[session.index] : null;
  if (expireExam() && page === 'session' && sessionMode === 'exam' && ['answer', 'previous', 'next', 'jump', 'finish', 'confirm-finish'].includes(name)) return;
  switch (name) {
    case 'navigate': page = button.dataset.page; render(true); break;
    case 'mode': selectMode(button.dataset.mode); render(); break;
    case 'choose-exam': selectMode('exam'); page = 'home'; render(true); break;
    case 'start': start(selectedMode); break;
    case 'new-session': start(selectedMode, modeSettings().ticketId, { fresh: true, repeat: true }); break;
    case 'quick-learn':
    case 'continue-learn': continueLearning(); break;
    case 'ticket-learn': start('learn', Number(button.dataset.ticket), { fresh: true }); break;
    case 'ticket-repeat': start('learn', Number(button.dataset.ticket), { fresh: true, repeat: true }); break;
    case 'review': start('mistakes', 0); break;
    case 'practice-difficult': start('difficult', 0); break;
    case 'toggle-difficult':
    case 'remove-difficult': {
      const questionId = button.dataset.question;
      if (!questions.has(questionId) || name === 'remove-difficult' && !progress.difficult.includes(questionId)) return;
      toggleDifficult(progress, questionId); syncDifficultSession(progress, questions); save();
      if (page === 'session' && sessionMode === 'difficult' && !modeSession()) page = 'difficult';
      render(); break;
    }
    case 'resume': resume(button.dataset.mode || selectedMode); break;
    case 'answer':
      if (!active || (session.mode !== 'exam' && session.checked.includes(id))) return;
      session.responses[id] = Number(button.dataset.option); save(); render(); break;
    case 'check':
      if (!active || session.mode === 'exam' || session.checked.includes(id) || session.responses[id] === undefined) return;
      recordAnswer(progress, questions.get(id), session.responses[id], sessionMode); session.checked.push(id); save(); render(); break;
    case 'next':
      if (!active || (session.mode !== 'exam' && !session.checked.includes(id))) return;
      if (session.mode === 'exam') {
        if (session.index + 1 === session.questionIds.length) finish();
        else { session.index++; save(); render(true); }
      } else if (session.mode === 'difficult') {
        nextDifficultQuestion(progress, questions); save(); render(true);
      } else {
        let nextIndex = session.questionIds.findIndex((questionId, index) => index > session.index && !session.checked.includes(questionId));
        if (nextIndex === -1) nextIndex = session.questionIds.findIndex(questionId => !session.checked.includes(questionId));
        if (nextIndex === -1) finish();
        else { session.index = nextIndex; save(); render(true); }
      }
      break;
    case 'previous':
      if (active && session.mode === 'exam' && session.index > 0) { session.index--; save(); render(true); }
      break;
    case 'jump':
      if (active && session.mode === 'exam') { session.index = Number(button.dataset.index); save(); render(true); }
      break;
    case 'finish': {
      if (!active || session.mode !== 'exam') return;
      pendingStart = null;
      const remaining = session.questionIds.length - Object.keys(session.responses).length;
      document.querySelector('#confirm-description').textContent = remaining ? `Без ответа: ${countQuestions(remaining)}. Они будут считаться ошибками. После завершения ответы изменить нельзя.` : 'Все ответы выбраны. Вы увидите результат и разбор ошибок.';
      document.querySelector('#confirm-dialog').showModal();
      break;
    }
    case 'cancel-finish': pendingStart = null; document.querySelector('#confirm-dialog').close(); if (page === 'home') render(); break;
    case 'confirm-finish':
      if (pendingStart) { const next = pendingStart; pendingStart = null; start(next.mode, next.ticketId, { fresh: true, repeat: next.repeat, replace: true }); }
      else if (active && session.mode === 'exam') finish();
      break;
  }
}

app.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button && !button.disabled) action(button);
});
app.addEventListener('change', event => {
  const setting = event.target.dataset.setting;
  if (setting) { modeSettings()[setting] = Number(event.target.value); save(); if (page === 'home') render(); }
});
document.addEventListener('keydown', event => {
  if (page !== 'session' || progress?.modes?.[sessionMode]?.session?.status !== 'active' || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(event.target.tagName) || event.ctrlKey || event.altKey || event.metaKey) return;
  let button;
  if (/^[1-3]$/.test(event.key)) button = document.querySelector(`[data-action="answer"][data-option="${event.key}"]`);
  else if (event.key === 'Enter') button = document.querySelector('.exercise-actions .primary');
  if (button && !button.disabled) { event.preventDefault(); action(button); }
});

try {
  const response = await fetch('./questions.json?v=2');
  if (!response.ok) throw new Error(`Не удалось загрузить вопросы (${response.status})`);
  data = await response.json();
  if (!Array.isArray(data.tickets) || !data.tickets.length) throw new Error('База вопросов пуста');
  questions = questionMap(data.tickets);
  progress = emptyProgress();
  try {
    const previous = localStorage.getItem(STORAGE_KEY);
    const raw = JSON.parse(previous);
    progress = restoreProgress(raw, questions);
    if (raw && [1, 2].includes(raw.version) && !localStorage.getItem(`${STORAGE_KEY}:legacy-backup`)) {
      localStorage.setItem(`${STORAGE_KEY}:legacy-backup`, previous);
    }
  } catch { storageWarning = true; }
  selectedMode = progress.selectedMode;
  sessionMode = selectedMode;
  if (!storageWarning) save();
  const exam = modeSession('exam');
  if (exam?.status === 'active' && exam.deadline <= Date.now()) {
    finishSession(progress, questions, 'exam'); save();
    if (selectedMode === 'exam') page = 'session';
  }
  render();
  setInterval(() => {
    if (expireExam()) return;
    const exam = modeSession('exam');
    if (exam?.status !== 'active') return;
    const remaining = exam.deadline - Date.now();
    for (const timer of document.querySelectorAll('#timer span, [data-exam-time]')) timer.textContent = time(remaining);
    document.querySelector('#timer')?.classList.toggle('urgent', remaining < 60_000);
  }, 1000);
} catch (error) {
  app.innerHTML = `<div class="loading error-state"><h1>Не удалось открыть тренажёр</h1><p>${escape(error.message)}</p><p>Проверьте подключение и попробуйте обновить страницу.</p><button class="button primary" id="retry">Попробовать снова</button></div>`;
  document.querySelector('#retry').addEventListener('click', () => location.reload());
}
