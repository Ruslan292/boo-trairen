import { STORAGE_KEY, emptyProgress, questionMap, restoreProgress, createSession, recordAnswer, finishSession, resultFor, statsFor } from './model.js';

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
let settings = { ticketId: 0, minutes: 10, allowedErrors: 1 };
let storageWarning = false;
let pendingStart = null;

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); }
  catch { storageWarning = true; }
}

function ticketOptions() {
  return `<option value="0">${selectedMode === 'exam' ? 'Случайный билет' : 'Все билеты'}</option>${data.tickets.map(ticket => `<option value="${ticket.id}" ${settings.ticketId === ticket.id ? 'selected' : ''}>Билет № ${ticket.id}</option>`).join('')}`;
}

function shell(content) {
  const stats = statsFor(progress, questions.size);
  const navigation = [['home', 'home', 'Обзор'], ['tickets', 'book', 'Все билеты'], ['mistakes', 'repeat', 'Мои ошибки'], ['history', 'chart', 'История']];
  app.innerHTML = `<div class="layout">
    <aside class="sidebar">
      <a class="brand" href="./" aria-label="БОО — главная"><span class="brand-mark">${icon('shield')}</span><span>БОО<span class="brand-caption">ТРЕНАЖЁР</span></span></a>
      <div class="nav-caption">ВАША ПОДГОТОВКА</div>
      <nav aria-label="Основная навигация">${navigation.map(([id, symbol, label]) => `<button class="nav-item ${page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${id === 'mistakes' && stats.mistakes ? `<span class="nav-count">${stats.mistakes}</span>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><span class="source-dot"></span>Билеты из документа · 2026<p>${data.tickets.length} билетов · ${questions.size} вопросов</p><span class="local-note">Прогресс хранится в этом браузере</span></div>
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

function home() {
  const stats = statsFor(progress, questions.size);
  const percent = Math.round(stats.studied / stats.total * 100);
  const session = progress.session;
  const modes = [
    ['learn', 'book', 'Обучение', 'Ответы и подсказки после каждого вопроса.'],
    ['exam', 'clock', 'Экзамен', 'Один билет, таймер и результат в конце.'],
    ['mistakes', 'repeat', 'Работа над ошибками', 'Повторите вопросы, которые вызвали трудности.'],
  ];
  const mode = modes.find(item => item[0] === selectedMode);
  shell(`${heading('ЗНАНИЯ, КОТОРЫЕ ДАЮТ УВЕРЕННОСТЬ', 'Подготовьтесь спокойно.', 'Все билеты в одном месте. Практикуйтесь, проверяйте себя и возвращайтесь к сложным вопросам.')}
    <section class="hero"><div class="hero-content"><span class="hero-tag">БЕЗОПАСНОСТЬ НАЧИНАЕТСЯ СО ЗНАНИЙ</span><h2>От первого вопроса<br>до уверенного ответа.</h2><p>Небольшая практика каждый день —<br>и сложное становится понятным.</p><button class="button hero-button" data-action="quick-learn">Начать обучение ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><svg viewBox="0 0 300 230"><circle cx="170" cy="115" r="98" fill="#d2e6d7"/><circle cx="170" cy="115" r="72" fill="none" stroke="#b6d2bc" stroke-dasharray="4 7"/><path d="m83 90 64-20 71 27-8 91-66-19-68 16z" fill="#fbfcf3" stroke="#176956" stroke-width="2"/><path d="m83 90 61 20 74-13M144 110v59" fill="none" stroke="#176956" stroke-width="2"/><path d="m96 112 33 10m-35 5 35 10m-36 5 35 10m25-31 47-8m-47 23 45-8m-45 22 31-5" stroke="#b7c6aa" stroke-width="3" stroke-linecap="round"/><path d="m190 33 39 14v28c0 26-26 43-39 50-13-7-39-24-39-50V47z" fill="#176956"/><path d="m172 76 13 13 24-28" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="77" cy="52" r="7" fill="#e3b86b"/><path d="M239 166v16m-8-8h16M59 115v12m-6-6h12" stroke="#176956" stroke-width="2"/><circle cx="224" cy="208" r="4" fill="#176956"/></svg></div></section>
    <section class="stats" aria-label="Ваш прогресс"><div class="stat-card"><span class="stat-icon">${icon('book')}</span><div><span class="stat-label">Изучено вопросов</span><strong>${stats.studied}<small> / ${stats.total}</small></strong></div></div><div class="stat-card"><span class="stat-icon">${icon('check')}</span><div><span class="stat-label">Точность ответов</span><strong>${stats.accuracy === null ? '—' : `${stats.accuracy}%`}</strong></div></div><div class="stat-card"><span class="stat-icon warm">${icon('repeat')}</span><div><span class="stat-label">Нужно повторить</span><strong>${stats.mistakes}<small> ${declension(stats.mistakes, ['вопрос', 'вопроса', 'вопросов'])}</small></strong></div></div></section>
    ${session?.status === 'active' ? `<div class="resume-card"><div>${icon('clock')}<span><strong>У вас есть незавершённая ${session.mode === 'exam' ? 'попытка экзамена' : 'тренировка'}</strong><small>Вопрос ${session.index + 1} из ${session.questionIds.length}${session.mode === 'exam' ? ' · таймер продолжает идти' : ''}</small></span></div><button class="button secondary" data-action="resume">Продолжить ${icon('arrow')}</button></div>` : ''}
    <div class="dashboard-columns"><section class="practice"><div class="section-title"><h2>Как будем готовиться?</h2><span>Выберите свой формат</span></div><div class="mode-grid">${modes.map(([id, symbol, name, description]) => `<button class="mode-card ${selectedMode === id ? 'selected' : ''}" data-action="mode" data-mode="${id}" aria-pressed="${selectedMode === id}"><span class="mode-top">${icon(symbol)}<span class="radio-dot"></span></span><strong>${name}</strong><span>${description}</span></button>`).join('')}</div><div class="launch-panel"><div class="settings-row"><label>Выберите билет<select id="ticket-select" data-setting="ticketId">${ticketOptions()}</select></label>${selectedMode === 'exam' ? `<label>Время<select data-setting="minutes"><option value="5" ${settings.minutes === 5 ? 'selected' : ''}>5 минут</option><option value="10" ${settings.minutes === 10 ? 'selected' : ''}>10 минут</option><option value="20" ${settings.minutes === 20 ? 'selected' : ''}>20 минут</option></select></label><label>Допустимо ошибок<select data-setting="allowedErrors">${[0, 1, 2].map(number => `<option value="${number}" ${settings.allowedErrors === number ? 'selected' : ''}>${number}</option>`).join('')}</select></label>` : ''}</div><button class="button primary" data-action="start" ${selectedMode === 'mistakes' && !stats.mistakes ? 'disabled' : ''}>${selectedMode === 'exam' ? 'Начать экзамен' : selectedMode === 'mistakes' ? 'Повторить ошибки' : 'Начать тренировку'} ${icon('arrow')}</button><p class="launch-note">${selectedMode === 'exam' ? 'Это настройки учебного экзамена. Ответы появятся после завершения.' : selectedMode === 'mistakes' ? (stats.mistakes ? 'Верный ответ уберёт вопрос из списка ошибок.' : 'Здесь появятся вопросы, на которые вы ответили неверно.') : 'Можно остановиться и продолжить позже.'}</p></div></section>
    <aside class="progress-card"><span class="eyebrow">ВАШ ПУТЬ</span><h2>Каждый ответ —<br>шаг вперёд.</h2><div class="progress-number">${percent}<span>%</span></div><progress value="${stats.studied}" max="${stats.total}" aria-label="Доля изученных вопросов"></progress><p>Вы ответили на ${countQuestions(stats.studied)} из ${stats.total}.</p><div class="tip">${icon('star')}<p>Начните с обучения, закрепите ошибки, а затем проверьте себя на экзамене.</p></div></aside></div>
    <div class="source-note">${icon('book')}<span>Источник вопросов и ответов: ${escape(data.source)}</span></div>`);
}

function ticketsPage() {
  shell(`${heading('БАЗА ВОПРОСОВ', 'Все билеты', `${data.tickets.length} билетов из исходного документа. Выберите любой для тренировки.`)}<div class="ticket-grid">${data.tickets.map(ticket => {
    const answered = ticket.questions.filter(question => progress.answers[question.id]).length;
    return `<article class="ticket-card"><span class="ticket-number">${String(ticket.id).padStart(2, '0')}</span><h2>Билет № ${ticket.id}</h2><p>${countQuestions(ticket.questions.length)}</p><progress value="${answered}" max="${ticket.questions.length}" aria-label="Прогресс билета ${ticket.id}"></progress><span class="ticket-progress">Изучено ${answered} из ${ticket.questions.length}</span><button class="button secondary" data-action="ticket-learn" data-ticket="${ticket.id}">Пройти билет ${icon('arrow')}</button></article>`;
  }).join('')}</div>`);
}

function mistakesPage() {
  const mistakes = progress.mistakes.map(id => questions.get(id));
  shell(`${heading('ЗАКРЕПЛЯЕМ ЗНАНИЯ', 'Мои ошибки', 'Повторяйте сложные вопросы. После правильного ответа вопрос исчезнет из этого списка.')}${mistakes.length ? `<div class="list-toolbar"><span>На повторение: ${countQuestions(mistakes.length)}</span><button class="button primary" data-action="review">Повторить все ${icon('arrow')}</button></div><div class="question-list">${mistakes.map(question => `<article class="list-question"><span class="eyebrow">БИЛЕТ № ${question.ticketId} · ВОПРОС ${question.number}</span><h2>${escape(question.text)}</h2><span class="list-tag">Нужно повторить</span></article>`).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('check')}</span><h2>Ошибок пока нет</h2><p>Начните тренировку — сложные вопросы будут собраны здесь.</p><button class="button primary" data-action="quick-learn">Перейти к обучению ${icon('arrow')}</button></div>`}`);
}

function historyPage() {
  shell(`${heading('РЕЗУЛЬТАТЫ ПОДГОТОВКИ', 'История экзаменов', 'Ваши последние 50 попыток сохраняются в этом браузере.')}${progress.exams.length ? `<div class="history-list">${[...progress.exams].reverse().map(exam => `<article class="history-item"><span class="result-mark ${exam.passed ? 'success' : 'failure'}">${icon(exam.passed ? 'check' : 'repeat')}</span><div><h2>Билет № ${exam.ticketId}</h2><p>${date(exam.finishedAt)} · ${time(exam.duration)}</p><small>Допустимо ошибок: ${exam.allowedErrors}</small></div><div class="history-score"><strong>${exam.correct} / ${exam.total}</strong><span>${exam.passed ? 'Экзамен сдан' : 'Нужно повторить'}</span></div></article>`).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('chart')}</span><h2>Всё ещё впереди</h2><p>Пройдите учебный экзамен, чтобы увидеть первый результат.</p><button class="button primary" data-action="choose-exam">Подготовиться к экзамену ${icon('arrow')}</button></div>`}`);
}

function sessionPage() {
  const session = progress.session;
  if (!session) { page = 'home'; home(); return; }
  if (session.status === 'finished') { resultsPage(); return; }
  const id = session.questionIds[session.index];
  const question = questions.get(id);
  const response = session.responses[id];
  const checked = session.checked.includes(id);
  const correct = response === question.correctOptionId;
  const exam = session.mode === 'exam';
  const answered = exam ? Object.keys(session.responses).length : session.checked.length;
  shell(`<div class="session-heading"><button class="text-button" data-action="navigate" data-page="home">${icon('chevron')} К обзору</button><span class="session-mode">${icon(exam ? 'clock' : session.mode === 'mistakes' ? 'repeat' : 'book')}${exam ? 'Учебный экзамен' : session.mode === 'mistakes' ? 'Работа над ошибками' : 'Обучение'}</span>${exam ? `<span class="timer" id="timer" aria-label="Оставшееся время">${icon('clock')}<span>${time(session.deadline - Date.now())}</span></span>` : ''}</div>
    <div class="exercise-layout"><section class="exercise"><div class="exercise-top"><span class="eyebrow">БИЛЕТ № ${question.ticketId}</span><span>Вопрос ${session.index + 1} из ${session.questionIds.length}</span></div><progress value="${answered}" max="${session.questionIds.length}" aria-label="Прогресс тренировки"></progress><h1 class="question-text">${escape(question.text)}</h1><div class="answers" role="group" aria-label="Варианты ответа">${question.options.map(option => {
      const selected = response === option.id;
      let state = selected ? 'chosen' : '';
      if (checked && !exam) state = option.id === question.correctOptionId ? 'correct' : selected ? 'incorrect' : '';
      return `<button class="answer ${state}" data-action="answer" data-option="${option.id}" aria-pressed="${selected}" ${checked && !exam ? 'disabled' : ''}><span class="answer-number">${option.id}</span><span>${escape(option.text)}</span><span class="answer-symbol">${state === 'correct' ? icon('check') : state === 'incorrect' ? icon('cross') : '<span class="answer-radio"></span>'}</span></button>`;
    }).join('')}</div>${checked && !exam ? `<div class="feedback ${correct ? 'positive' : 'negative'}" role="status">${icon(correct ? 'check' : 'repeat')}<div><strong>${correct ? 'Верно. Так держать!' : 'Не совсем. Давайте запомним.'}</strong><p>${correct ? 'Правильный ответ подтверждён исходным документом.' : `Правильный ответ — вариант ${question.correctOptionId}: ${escape(question.options.find(option => option.id === question.correctOptionId).text)}`}</p></div></div>` : `<p class="answer-hint">${exam ? 'Выберите ответ. До завершения экзамена его можно изменить.' : 'Выберите один вариант, затем проверьте ответ.'}</p>`}<div class="exercise-actions">${exam ? `<button class="button secondary" data-action="previous" ${session.index === 0 ? 'disabled' : ''}>${icon('chevron')} Назад</button><button class="button primary" data-action="${session.index === session.questionIds.length - 1 ? 'finish' : 'next'}">${session.index === session.questionIds.length - 1 ? 'Завершить экзамен' : 'Следующий вопрос'} ${icon('arrow')}</button>` : `<span class="keyboard-hint">Клавиши 1–3 · Enter</span><button class="button primary" data-action="${checked ? 'next' : 'check'}" ${!checked && response === undefined ? 'disabled' : ''}>${checked ? (session.index === session.questionIds.length - 1 ? 'Посмотреть результат' : 'Следующий вопрос') : 'Проверить ответ'} ${icon(checked ? 'arrow' : 'check')}</button>`}</div></section>
    <aside class="session-aside"><h2>${exam ? 'Ваш билет' : 'Ваша тренировка'}</h2><p>${answered} из ${session.questionIds.length} ${exam ? 'ответов выбрано' : 'ответов проверено'}</p>${exam ? `<div class="question-nav" aria-label="Навигация по вопросам">${session.questionIds.map((questionId, index) => `<button class="question-chip ${index === session.index ? 'current' : ''} ${session.responses[questionId] !== undefined ? 'answered' : ''}" data-action="jump" data-index="${index}" aria-label="Вопрос ${index + 1}" ${index === session.index ? 'aria-current="step"' : ''}>${index + 1}</button>`).join('')}</div><div class="aside-note">${icon('flag')}<p>Допустимо ошибок: ${session.allowedErrors}. Пропущенный вопрос считается ошибкой.</p></div><button class="text-button" data-action="finish">Завершить досрочно</button>` : `<div class="aside-note">${icon('book')}<p>Не спешите. Прочитайте все варианты, прежде чем выбрать ответ.</p></div><div class="aside-note">${icon('repeat')}<p>Ошибки сохраняются, чтобы вы могли к ним вернуться.</p></div>`}</aside></div>`);
}

function resultsPage() {
  const session = progress.session;
  const result = resultFor(session, questions);
  const exam = session.mode === 'exam';
  const passed = exam ? result.passed : result.correct === result.total;
  const incorrect = session.questionIds.filter(id => session.responses[id] !== questions.get(id).correctOptionId);
  shell(`<section class="results"><span class="result-mark large ${passed ? 'success' : 'failure'}">${icon(passed ? 'check' : 'book')}</span><span class="eyebrow">${exam ? 'РЕЗУЛЬТАТ ЭКЗАМЕНА' : 'ТРЕНИРОВКА ЗАВЕРШЕНА'}</span><h1>${exam ? passed ? 'Отлично, экзамен сдан!' : 'Ещё немного практики.' : 'Вы стали на шаг увереннее.'}</h1><p>${exam ? `Билет № ${session.ticketId} · допустимо ошибок: ${session.allowedErrors}` : 'Вернитесь к сложным вопросам, чтобы закрепить знания.'}</p><div class="result-stats"><div><strong>${result.correct}<small> / ${result.total}</small></strong><span>Правильных ответов</span></div><div><strong>${result.errors}</strong><span>Ошибок${result.answered < result.total ? ` (пропущено: ${result.total - result.answered})` : ''}</span></div><div><strong>${time(Math.max(0, Math.min(session.finishedAt, session.deadline || session.finishedAt) - session.startedAt))}</strong><span>Время подготовки</span></div></div><div class="results-actions">${progress.mistakes.length ? `<button class="button primary" data-action="review">Повторить ошибки ${icon('repeat')}</button>` : ''}<button class="button secondary" data-action="navigate" data-page="home">К обзору ${icon('arrow')}</button></div></section>${incorrect.length ? `<section class="review-results"><h2>Разбор ответов</h2><p class="muted">Правильные варианты из исходного документа.</p>${incorrect.map(id => {
    const question = questions.get(id);
    const chosen = question.options.find(option => option.id === session.responses[id]);
    const correct = question.options.find(option => option.id === question.correctOptionId);
    return `<article class="review-question"><span class="eyebrow">БИЛЕТ № ${question.ticketId} · ВОПРОС ${question.number}</span><h3>${escape(question.text)}</h3><p class="chosen-answer">Ваш ответ: ${chosen ? escape(chosen.text) : 'Вопрос пропущен'}</p><p class="correct-answer">${icon('check')}<span>Правильный ответ: ${escape(correct.text)}</span></p></article>`;
  }).join('')}</section>` : ''}`);
}

function render(focus = false) {
  ({ home, tickets: ticketsPage, mistakes: mistakesPage, history: historyPage, session: sessionPage }[page] || home)();
  if (focus) { document.querySelector('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
}

function start(mode, ticketId = settings.ticketId, replace = false) {
  if (progress.session?.status === 'active') {
    if (!replace) {
      pendingStart = { mode, ticketId };
      const dialog = document.querySelector('#confirm-dialog');
      dialog.querySelector('.eyebrow').textContent = 'НОВАЯ ТРЕНИРОВКА';
      dialog.querySelector('h2').textContent = 'Начать заново?';
      dialog.querySelector('#confirm-description').textContent = progress.session.mode === 'exam' ? 'Текущий экзамен будет завершён. Вопросы без ответа будут считаться ошибками. Ваш общий прогресс сохранится.' : 'Текущая тренировка будет закрыта. Все проверенные ответы и ваш общий прогресс сохранятся.';
      dialog.querySelector('[data-action="cancel-finish"]').textContent = 'Отмена';
      dialog.querySelector('[data-action="confirm-finish"]').textContent = 'Начать новую';
      dialog.showModal();
      return;
    }
    finishSession(progress, questions);
  }
  const session = createSession(data.tickets, mode, { ...settings, ticketId }, progress);
  if (!session) {
    page = 'mistakes'; render(true); return;
  }
  progress.session = session;
  save(); page = 'session'; render(true);
}

function finish() {
  finishSession(progress, questions);
  save(); page = 'session'; render(true);
}

function action(button) {
  const name = button.dataset.action;
  const session = progress.session;
  const active = session?.status === 'active';
  const id = active ? session.questionIds[session.index] : null;
  if (active && session.mode === 'exam' && Date.now() >= session.deadline) { finish(); return; }
  switch (name) {
    case 'navigate': page = button.dataset.page; render(true); break;
    case 'mode': selectedMode = button.dataset.mode; render(); break;
    case 'choose-exam': selectedMode = 'exam'; page = 'home'; render(true); break;
    case 'start': start(selectedMode); break;
    case 'quick-learn': start('learn', 0); break;
    case 'ticket-learn': start('learn', Number(button.dataset.ticket)); break;
    case 'review': start('mistakes', 0); break;
    case 'resume': page = 'session'; render(true); break;
    case 'answer':
      if (!active || (session.mode !== 'exam' && session.checked.includes(id))) return;
      session.responses[id] = Number(button.dataset.option); save(); render(); break;
    case 'check':
      if (!active || session.mode === 'exam' || session.checked.includes(id) || session.responses[id] === undefined) return;
      recordAnswer(progress, questions.get(id), session.responses[id]); session.checked.push(id); save(); render(); break;
    case 'next':
      if (!active || (session.mode !== 'exam' && !session.checked.includes(id))) return;
      if (session.index + 1 === session.questionIds.length) finish();
      else { session.index++; save(); render(true); }
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
    case 'cancel-finish': pendingStart = null; document.querySelector('#confirm-dialog').close(); break;
    case 'confirm-finish':
      if (pendingStart) { const next = pendingStart; pendingStart = null; start(next.mode, next.ticketId, true); }
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
  if (setting) settings[setting] = Number(event.target.value);
});
document.addEventListener('keydown', event => {
  if (page !== 'session' || progress?.session?.status !== 'active' || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(event.target.tagName) || event.ctrlKey || event.altKey || event.metaKey) return;
  let button;
  if (/^[1-3]$/.test(event.key)) button = document.querySelector(`[data-action="answer"][data-option="${event.key}"]`);
  else if (event.key === 'Enter') button = document.querySelector('.exercise-actions .primary');
  if (button && !button.disabled) { event.preventDefault(); action(button); }
});

try {
  const response = await fetch('./questions.json');
  if (!response.ok) throw new Error(`Не удалось загрузить вопросы (${response.status})`);
  data = await response.json();
  if (!Array.isArray(data.tickets) || !data.tickets.length) throw new Error('База вопросов пуста');
  questions = questionMap(data.tickets);
  progress = emptyProgress();
  try { progress = restoreProgress(JSON.parse(localStorage.getItem(STORAGE_KEY)), questions); }
  catch { storageWarning = true; }
  if (progress.session?.status === 'active' && progress.session.mode === 'exam' && progress.session.deadline <= Date.now()) { finishSession(progress, questions); save(); page = 'session'; }
  render();
  setInterval(() => {
    const session = progress.session;
    if (session?.status !== 'active' || session.mode !== 'exam') return;
    if (Date.now() >= session.deadline) { finish(); return; }
    const timer = document.querySelector('#timer span');
    if (timer) timer.textContent = time(session.deadline - Date.now());
    document.querySelector('#timer')?.classList.toggle('urgent', session.deadline - Date.now() < 60_000);
  }, 1000);
} catch (error) {
  app.innerHTML = `<div class="loading error-state"><h1>Не удалось открыть тренажёр</h1><p>${escape(error.message)}</p><p>Проверьте подключение и попробуйте обновить страницу.</p><button class="button primary" id="retry">Попробовать снова</button></div>`;
  document.querySelector('#retry').addEventListener('click', () => location.reload());
}
