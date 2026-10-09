export const STORAGE_KEY = 'boo-trainer:v1';

export function emptyProgress() {
  return { version: 2, answers: {}, mistakes: [], exams: [], session: null };
}

export function questionMap(tickets) {
  return new Map(tickets.flatMap(ticket => ticket.questions.map(question => [question.id, { ...question, ticketId: ticket.id }])));
}

export function restoreProgress(raw, questions) {
  const progress = emptyProgress();
  if (!raw || ![1, 2].includes(raw.version)) return progress;
  const aliases = new Map();
  for (const question of questions.values()) {
    for (const id of question.aliases || [question.id]) aliases.set(id, question.id);
  }
  const canonicalId = id => questions.has(id) ? id : aliases.get(id);
  for (const [id, value] of Object.entries(raw.answers || {})) {
    const canonical = canonicalId(id);
    if (canonical && Number.isInteger(value?.attempts) && value.attempts > 0 && Number.isInteger(value.correct) && value.correct >= 0 && value.correct <= value.attempts) {
      const previous = progress.answers[canonical] || { attempts: 0, correct: 0 };
      progress.answers[canonical] = { attempts: previous.attempts + value.attempts, correct: previous.correct + value.correct };
    }
  }
  progress.mistakes = [...new Set(Array.isArray(raw.mistakes) ? raw.mistakes.map(canonicalId).filter(Boolean) : [])];
  progress.exams = Array.isArray(raw.exams) ? raw.exams.filter(exam => Number.isFinite(exam.finishedAt) && Number.isInteger(exam.total) && exam.total > 0 && Number.isInteger(exam.correct) && exam.correct >= 0 && exam.correct <= exam.total && Number.isInteger(exam.allowedErrors) && exam.allowedErrors >= 0).slice(-50).map(exam => ({ ...exam, bankVersion: exam.bankVersion || raw.version })) : [];
  const session = raw.session;
  if (session && ['learn', 'exam', 'mistakes'].includes(session.mode) && ['active', 'finished'].includes(session.status) && Array.isArray(session.questionIds) && session.questionIds.length && session.questionIds.every(id => canonicalId(id)) && Number.isInteger(session.index) && session.index >= 0 && session.index < session.questionIds.length && Number.isFinite(session.startedAt) && (session.mode !== 'exam' || (Number.isFinite(session.deadline) && Number.isInteger(session.allowedErrors) && session.allowedErrors >= 0))) {
    const questionIds = [...new Set(session.questionIds.map(canonicalId))];
    const responses = {};
    const checked = new Set();
    for (const sourceId of session.questionIds) {
      const id = canonicalId(sourceId);
      const response = session.responses?.[sourceId];
      if (questions.get(id).options.some(option => option.id === response)) {
        const wasChecked = Array.isArray(session.checked) && session.checked.includes(sourceId);
        if (!checked.has(id) || wasChecked) responses[id] = response;
        if (wasChecked) checked.add(id);
      }
    }
    const currentId = canonicalId(session.questionIds[session.index]);
    let index = questionIds.indexOf(currentId);
    let status = session.status;
    if (status === 'active' && session.mode !== 'exam' && checked.has(currentId) && !session.checked.includes(session.questionIds[session.index])) {
      const nextId = session.questionIds.slice(session.index).map(canonicalId).find(id => !checked.has(id)) || questionIds.find(id => !checked.has(id));
      if (nextId) index = questionIds.indexOf(nextId);
      else status = 'finished';
    }
    progress.session = { ...session, questionIds, index, responses, checked: [...checked], status, bankVersion: session.bankVersion || raw.version };
    if (status === 'finished' && session.status !== 'finished') progress.session.finishedAt = Date.now();
  }
  return progress;
}

export function createSession(tickets, mode, settings, progress, now = Date.now(), random = Math.random) {
  let selected = settings.ticketId ? tickets.filter(ticket => ticket.id === Number(settings.ticketId)) : tickets;
  if (mode === 'exam' && !settings.ticketId) selected = [tickets[Math.floor(random() * tickets.length)]];
  let questions = selected.flatMap(ticket => ticket.questions);
  if (mode === 'mistakes') questions = questions.filter(question => progress.mistakes.includes(question.id));
  if (!questions.length) return null;
  return {
    mode, ticketId: selected.length === 1 ? selected[0].id : null,
    questionIds: questions.map(question => question.id), index: 0,
    responses: {}, checked: [], startedAt: now,
    deadline: mode === 'exam' ? now + Number(settings.minutes || 10) * 60_000 : null,
    allowedErrors: Number(settings.allowedErrors ?? 1), status: 'active', bankVersion: 2,
  };
}

export function recordAnswer(progress, question, optionId) {
  const isCorrect = question.correctOptionId === optionId;
  const previous = progress.answers[question.id] || { attempts: 0, correct: 0 };
  progress.answers[question.id] = { attempts: previous.attempts + 1, correct: previous.correct + Number(isCorrect) };
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

export function finishSession(progress, questions, now = Date.now()) {
  const session = progress.session;
  if (!session || session.status === 'finished') return;
  if (session.mode === 'exam') {
    for (const id of session.questionIds) recordAnswer(progress, questions.get(id), session.responses[id]);
    const result = resultFor(session, questions);
    progress.exams.push({ ...result, ticketId: session.ticketId, bankVersion: session.bankVersion, allowedErrors: session.allowedErrors, finishedAt: now, duration: Math.max(0, Math.min(now, session.deadline) - session.startedAt) });
    progress.exams = progress.exams.slice(-50);
  }
  session.status = 'finished';
  session.finishedAt = now;
}

export function statsFor(progress, total) {
  const values = Object.values(progress.answers);
  const attempts = values.reduce((sum, value) => sum + value.attempts, 0);
  const correct = values.reduce((sum, value) => sum + value.correct, 0);
  return { studied: values.length, total, attempts, accuracy: attempts ? Math.round(correct / attempts * 100) : null, mistakes: progress.mistakes.length };
}
