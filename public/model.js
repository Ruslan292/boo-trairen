export const STORAGE_KEY = 'boo-trainer:v1';
const MODES = ['learn', 'exam', 'mistakes'];

export function emptyProgress() {
  return {
    version: 3, selectedMode: 'learn',
    modes: {
      learn: { answers: {}, session: null, settings: { ticketId: 0 } },
      exam: { answers: {}, session: null, settings: { ticketId: 0, minutes: 10, allowedErrors: 1 } },
      mistakes: { answers: {}, session: null, settings: { ticketId: 0 } },
    },
    mistakes: [], exams: [],
  };
}

export function questionMap(tickets) {
  return new Map(tickets.flatMap(ticket => ticket.questions.map(question => [question.id, { ...question, ticketId: ticket.id }])));
}

export function restoreProgress(raw, questions) {
  const progress = emptyProgress();
  if (!raw || ![1, 2, 3].includes(raw.version)) return progress;
  const aliases = new Map();
  for (const question of questions.values()) {
    for (const id of question.aliases || [question.id]) aliases.set(id, question.id);
  }
  const canonicalId = id => questions.has(id) ? id : aliases.get(id);
  const bankVersion = raw.version === 1 ? 1 : 2;
  const validTicketIds = new Set([...questions.values()].map(question => question.ticketId));
  const restoreAnswers = answers => {
    const restored = {};
    for (const [id, value] of Object.entries(answers || {})) {
      const canonical = canonicalId(id);
      if (canonical && Number.isInteger(value?.attempts) && value.attempts > 0 && Number.isInteger(value.correct) && value.correct >= 0 && value.correct <= value.attempts) {
        const previous = restored[canonical] || { attempts: 0, correct: 0 };
        restored[canonical] = { attempts: previous.attempts + value.attempts, correct: previous.correct + value.correct };
      }
    }
    return restored;
  };

  // Before v3 all modes shared answers. Preserve every old answer in learning;
  // the original data cannot reliably tell which mode produced an attempt.
  if (raw.version < 3) progress.modes.learn.answers = restoreAnswers(raw.answers);
  progress.mistakes = [...new Set(Array.isArray(raw.mistakes) ? raw.mistakes.map(canonicalId).filter(Boolean) : [])];
  progress.exams = Array.isArray(raw.exams) ? raw.exams.filter(exam => Number.isFinite(exam?.finishedAt) && Number.isInteger(exam.total) && exam.total > 0 && Number.isInteger(exam.correct) && exam.correct >= 0 && exam.correct <= exam.total && Number.isInteger(exam.allowedErrors) && exam.allowedErrors >= 0).slice(-50).map(exam => ({ ...exam, bankVersion: [1, 2].includes(exam.bankVersion) ? exam.bankVersion : bankVersion })) : [];

  const restoreSession = (session, mode) => {
    if (!(session && session.mode === mode && ['active', 'finished'].includes(session.status) && Array.isArray(session.questionIds) && session.questionIds.length && session.questionIds.every(id => canonicalId(id)) && Number.isInteger(session.index) && session.index >= 0 && session.index < session.questionIds.length && Number.isFinite(session.startedAt) && (mode !== 'exam' || (Number.isFinite(session.deadline) && Number.isInteger(session.allowedErrors) && session.allowedErrors >= 0)))) return null;
    const questionIds = [...new Set(session.questionIds.map(canonicalId))];
    const responses = {};
    const checked = new Set();
    const sourceChecked = new Set(Array.isArray(session.checked) ? session.checked : []);
    for (const sourceId of session.questionIds) {
      const id = canonicalId(sourceId);
      const response = session.responses?.[sourceId];
      if (questions.get(id).options.some(option => option.id === response)) {
        const wasChecked = sourceChecked.has(sourceId);
        if (!checked.has(id) || wasChecked) responses[id] = response;
        if (wasChecked) checked.add(id);
      }
    }
    const currentId = canonicalId(session.questionIds[session.index]);
    let index = questionIds.indexOf(currentId);
    let status = session.status;
    if (status === 'active' && mode !== 'exam' && checked.has(currentId) && !sourceChecked.has(session.questionIds[session.index])) {
      const nextId = session.questionIds.slice(session.index).map(canonicalId).find(id => !checked.has(id)) || questionIds.find(id => !checked.has(id));
      if (nextId) index = questionIds.indexOf(nextId);
      else status = 'finished';
    }
    const restored = { ...session, questionIds, index, responses, checked: [...checked], status, bankVersion: [1, 2].includes(session.bankVersion) ? session.bankVersion : bankVersion };
    if (status === 'finished' && session.status !== 'finished') restored.finishedAt = Date.now();
    return restored;
  };

  if (raw.version === 3) {
    progress.selectedMode = MODES.includes(raw.selectedMode) ? raw.selectedMode : 'learn';
    for (const mode of MODES) {
      const saved = raw.modes?.[mode];
      const state = progress.modes[mode];
      state.answers = restoreAnswers(saved?.answers);
      state.session = restoreSession(saved?.session, mode);
      const ticketId = Number(saved?.settings?.ticketId);
      if (ticketId === 0 || validTicketIds.has(ticketId)) state.settings.ticketId = ticketId;
      if (mode === 'exam') {
        const minutes = Number(saved?.settings?.minutes);
        const allowedErrors = Number(saved?.settings?.allowedErrors);
        if (Number.isFinite(minutes) && minutes > 0) state.settings.minutes = minutes;
        if (Number.isInteger(allowedErrors) && allowedErrors >= 0) state.settings.allowedErrors = allowedErrors;
      }
    }
  } else if (MODES.includes(raw.session?.mode)) {
    progress.selectedMode = raw.session.mode;
    progress.modes[raw.session.mode].session = restoreSession(raw.session, raw.session.mode);
  }
  return progress;
}

export function createSession(tickets, mode, settings, progress, now = Date.now(), random = Math.random) {
  if (!tickets.length) return null;
  let selected = settings.ticketId ? tickets.filter(ticket => ticket.id === Number(settings.ticketId)) : tickets;
  if (mode === 'exam' && !settings.ticketId) selected = [tickets[Math.floor(random() * tickets.length)]];
  let questions = selected.flatMap(ticket => ticket.questions);
  if (mode === 'mistakes') questions = questions.filter(question => progress.mistakes.includes(question.id));
  if (mode === 'learn' && settings.remainingOnly) questions = questions.filter(question => !progress.modes.learn.answers[question.id]);
  if (!questions.length) return null;
  return {
    mode, ticketId: selected.length === 1 ? selected[0].id : null,
    questionIds: questions.map(question => question.id), index: 0,
    responses: {}, checked: [], startedAt: now,
    deadline: mode === 'exam' ? now + Number(settings.minutes || 10) * 60_000 : null,
    allowedErrors: Number(settings.allowedErrors ?? 1), status: 'active', bankVersion: 2,
  };
}

export function recordAnswer(progress, question, optionId, mode = 'learn') {
  const isCorrect = question.correctOptionId === optionId;
  const answers = progress.modes[mode].answers;
  const previous = answers[question.id] || { attempts: 0, correct: 0 };
  answers[question.id] = { attempts: previous.attempts + 1, correct: previous.correct + Number(isCorrect) };
  progress.mistakes = progress.mistakes.filter(id => id !== question.id);
  if (!isCorrect) progress.mistakes.push(question.id);
  return isCorrect;
}

export function resultFor(session, questions) {
  const total = session.questionIds.length;
  const correct = session.questionIds.filter(id => session.responses[id] === questions.get(id).correctOptionId && (session.mode === 'exam' || session.checked.includes(id))).length;
  const answered = session.questionIds.filter(id => session.responses[id] !== undefined && (session.mode === 'exam' || session.checked.includes(id))).length;
  return { total, correct, answered, errors: total - correct, passed: total - correct <= session.allowedErrors };
}

export function finishSession(progress, questions, mode = 'learn', now = Date.now()) {
  const session = progress.modes[mode].session;
  if (!session || session.status === 'finished') return;
  if (session.mode === 'exam') {
    for (const id of session.questionIds) recordAnswer(progress, questions.get(id), session.responses[id], 'exam');
    const result = resultFor(session, questions);
    progress.exams.push({ ...result, ticketId: session.ticketId, bankVersion: session.bankVersion, allowedErrors: session.allowedErrors, finishedAt: now, duration: Math.max(0, Math.min(now, session.deadline) - session.startedAt) });
    progress.exams = progress.exams.slice(-50);
  }
  session.status = 'finished';
  session.finishedAt = now;
}

export function statsFor(progress, total, mode = 'learn') {
  const values = Object.values(progress.modes[mode].answers);
  const attempts = values.reduce((sum, value) => sum + value.attempts, 0);
  const correct = values.reduce((sum, value) => sum + value.correct, 0);
  return { studied: values.length, total, attempts, accuracy: attempts ? Math.round(correct / attempts * 100) : null, mistakes: progress.mistakes.length };
}
