import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyProgress, questionMap, restoreProgress, createSession, recordAnswer, finishSession, resultFor, statsFor } from '../public/model.js';

const data = JSON.parse(await readFile(new URL('../public/questions.json', import.meta.url), 'utf8'));
const map = questionMap(data.tickets);
const first = data.tickets[0].questions[0];
const options = { ticketId: 1, minutes: 10, allowedErrors: 1 };

test('deduplicated question bank has 116 unique questions in 12 study tickets', () => {
  assert.equal(data.tickets.length, 12);
  assert.equal(map.size, 116);
  for (const ticket of data.tickets) {
    assert.equal(ticket.questions.length, ticket.id === 12 ? 6 : 10);
    for (const question of ticket.questions) {
      assert.equal(question.options.length, 3);
      assert.ok(question.text.length > 10);
      assert.ok(question.options.some(option => option.id === question.correctOptionId));
    }
  }
});

test('correct retry removes a mistake while accuracy reflects every attempt', () => {
  const progress = emptyProgress();
  const wrong = first.options.find(option => option.id !== first.correctOptionId).id;
  assert.equal(recordAnswer(progress, first, wrong), false);
  assert.deepEqual(progress.mistakes, [first.id]);
  recordAnswer(progress, first, wrong);
  assert.deepEqual(progress.mistakes, [first.id]);
  assert.equal(recordAnswer(progress, first, first.correctOptionId), true);
  assert.deepEqual(progress.mistakes, []);
  assert.deepEqual(statsFor(progress, map.size), { studied: 1, total: map.size, attempts: 3, accuracy: 33, mistakes: 0 });
});

test('sessions select all, one ticket, random exam ticket or only recorded mistakes', () => {
  const progress = emptyProgress();
  assert.equal(createSession(data.tickets, 'learn', {}, progress).questionIds.length, 116);
  assert.deepEqual(createSession(data.tickets, 'learn', options, progress).questionIds, data.tickets[0].questions.map(question => question.id));
  const exam = createSession(data.tickets, 'exam', { ...options, ticketId: 0 }, progress, 1000, () => 0.95);
  assert.equal(exam.ticketId, 12);
  assert.equal(exam.questionIds.length, 6);
  assert.equal(exam.deadline, 601000);
  assert.equal(createSession(data.tickets, 'mistakes', {}, progress), null);
  progress.mistakes = [first.id];
  assert.deepEqual(createSession(data.tickets, 'mistakes', {}, progress).questionIds, [first.id]);
  assert.equal(createSession(data.tickets, 'mistakes', { ticketId: 2 }, progress), null);
});

test('exam grades the final selected responses once and counts unanswered as errors', () => {
  const progress = emptyProgress();
  progress.modes.exam.session = createSession(data.tickets, 'exam', options, progress, 1000);
  for (const question of data.tickets[0].questions.slice(0, 9)) progress.modes.exam.session.responses[question.id] = question.correctOptionId;
  assert.equal(statsFor(progress, map.size).attempts, 0);
  finishSession(progress, map, 'exam', 11000);
  assert.deepEqual(resultFor(progress.modes.exam.session, map), { total: 10, correct: 9, answered: 9, errors: 1, passed: true });
  assert.equal(progress.exams.length, 1);
  assert.equal(progress.exams[0].duration, 10000);
  assert.equal(statsFor(progress, map.size, 'exam').attempts, 10);
  assert.equal(statsFor(progress, map.size, 'learn').attempts, 0);
  assert.deepEqual(progress.mistakes, [data.tickets[0].questions[9].id]);
  finishSession(progress, map, 'exam', 12000);
  assert.equal(progress.exams.length, 1);
  assert.equal(statsFor(progress, map.size, 'exam').attempts, 10);
});

test('unanswered expiry fails and bounds elapsed time to the exam deadline', () => {
  const progress = emptyProgress();
  progress.modes.exam.session = createSession(data.tickets, 'exam', options, progress, 1000);
  finishSession(progress, map, 'exam', 900000);
  assert.equal(progress.exams[0].passed, false);
  assert.equal(progress.exams[0].duration, 600000);
  assert.equal(progress.exams[0].errors, 10);
  assert.equal(progress.mistakes.length, 10);
});

test('learning result excludes selected answers that have not been checked', () => {
  const progress = emptyProgress();
  const session = createSession(data.tickets, 'learn', options, progress);
  session.responses[first.id] = first.correctOptionId;
  assert.equal(resultFor(session, map).correct, 0);
  session.checked.push(first.id);
  assert.equal(resultFor(session, map).correct, 1);
});

test('progress roundtrip retains the session and original deadline after reload', () => {
  const progress = emptyProgress();
  progress.modes.exam.session = createSession(data.tickets, 'exam', options, progress, 12345);
  progress.modes.exam.session.responses[first.id] = first.correctOptionId;
  recordAnswer(progress, first, first.correctOptionId);
  const restored = restoreProgress(JSON.parse(JSON.stringify(progress)), map);
  assert.deepEqual(restored, progress);
  assert.equal(restored.modes.exam.session.deadline, 612345);
});

test('invalid persisted data cannot poison statistics or reference missing questions', () => {
  const restored = restoreProgress({ version: 1, answers: { [first.id]: { attempts: 2, correct: 3 }, absent: { attempts: 3, correct: 2 } }, mistakes: [first.id, first.id, 'absent'], exams: [{ total: -1 }], session: { mode: 'exam', questionIds: ['absent'], status: 'active' } }, map);
  assert.deepEqual(restored.modes.learn.answers, {});
  assert.deepEqual(restored.mistakes, [first.id]);
  assert.deepEqual(restored.exams, []);
  assert.equal(restored.modes.exam.session, null);
  assert.deepEqual(restoreProgress({ version: 9 }, map), emptyProgress());
});

test('exam history keeps the last 50 results', () => {
  const progress = emptyProgress();
  for (let index = 0; index < 51; index++) {
    progress.modes.exam.session = createSession(data.tickets, 'exam', options, progress, index * 1000);
    finishSession(progress, map, 'exam', index * 1000 + 500);
  }
  assert.equal(progress.exams.length, 50);
  assert.equal(progress.exams[0].finishedAt, 1500);
});

test('all-question training and mistakes contain each complete question only once', () => {
  const signature = question => JSON.stringify([question.text.trim().replace(/\?$/, '').trim().toLocaleLowerCase('ru'), question.options.map(option => option.text.trim().toLocaleLowerCase('ru'))]);
  assert.equal(new Set([...map.values()].map(signature)).size, 116);
  const ids = [...map.values()].flatMap(question => question.aliases);
  assert.equal(ids.length, 200);
  assert.equal(new Set(ids).size, 200);
  const progress = emptyProgress();
  progress.mistakes = [...map.keys()];
  for (const mode of ['learn', 'mistakes']) {
    const session = createSession(data.tickets, mode, {}, progress);
    assert.equal(session.questionIds.length, 116);
    assert.equal(new Set(session.questionIds).size, 116);
  }
});

test('last short ticket is graded against its six questions', () => {
  const progress = emptyProgress();
  const ticket = data.tickets.at(-1);
  progress.modes.exam.session = createSession(data.tickets, 'exam', { ...options, ticketId: ticket.id }, progress, 1000);
  for (const question of ticket.questions) progress.modes.exam.session.responses[question.id] = question.correctOptionId;
  finishSession(progress, map, 'exam', 11000);
  assert.deepEqual(resultFor(progress.modes.exam.session, map), { total: 6, correct: 6, answered: 6, errors: 0, passed: true });
  assert.equal(progress.exams[0].bankVersion, 2);
});

test('legacy progress combines duplicate statistics, mistakes and checked responses once', () => {
  const repeated = [...map.values()].find(question => question.aliases.length > 1);
  const [a, b] = repeated.aliases;
  const distinct = [...map.values()].find(question => question.id !== repeated.id);
  const wrong = repeated.options.find(option => option.id !== repeated.correctOptionId).id;
  const legacy = {
    version: 1,
    answers: { [a]: { attempts: 2, correct: 1 }, [b]: { attempts: 3, correct: 2 } },
    mistakes: [a, b],
    exams: [{ finishedAt: 1000, total: 10, correct: 9, allowedErrors: 1, ticketId: 17 }],
    session: { mode: 'learn', status: 'active', startedAt: 500, ticketId: null, questionIds: [a, b, distinct.id], index: 2, responses: { [a]: repeated.correctOptionId, [b]: wrong }, checked: [a, b] },
  };
  const restored = restoreProgress(legacy, map);
  assert.equal(restored.version, 3);
  assert.deepEqual(restored.modes.learn.answers, { [repeated.id]: { attempts: 5, correct: 3 } });
  assert.deepEqual(restored.mistakes, [repeated.id]);
  assert.equal(restored.exams[0].bankVersion, 1);
  assert.equal(restored.exams[0].ticketId, 17);
  assert.deepEqual(restored.modes.learn.session.questionIds, [repeated.id, distinct.id]);
  assert.deepEqual(restored.modes.learn.session.checked, [repeated.id]);
  assert.deepEqual(restored.modes.learn.session.responses, { [repeated.id]: wrong });
  assert.equal(restored.modes.learn.session.index, 1);
  assert.deepEqual(restoreProgress(JSON.parse(JSON.stringify(restored)), map), restored);
});

test('legacy current duplicate advances to an unchecked question without repeating grading', () => {
  const repeated = [...map.values()].find(question => question.aliases.length > 1);
  const [a, b] = repeated.aliases;
  const distinct = [...map.values()].find(question => question.id !== repeated.id);
  const restored = restoreProgress({
    version: 1, answers: { [a]: { attempts: 1, correct: 1 } },
    session: { mode: 'learn', status: 'active', startedAt: 500, ticketId: null, questionIds: [a, b, distinct.id], index: 1, responses: { [a]: repeated.correctOptionId }, checked: [a] },
  }, map);
  assert.equal(restored.modes.learn.session.index, 1);
  assert.equal(restored.modes.learn.session.questionIds[1], distinct.id);
  assert.equal(statsFor(restored, map.size).attempts, 1);
});

test('legacy exam keeps its original deadline and maps duplicate aliases to canonical IDs', () => {
  const repeated = [...map.values()].find(question => question.aliases.length > 1);
  const alias = repeated.aliases[1];
  const restored = restoreProgress({ version: 1, session: { mode: 'exam', status: 'active', questionIds: [alias], index: 0, startedAt: 1000, deadline: 601000, allowedErrors: 1, ticketId: 20, responses: { [alias]: repeated.correctOptionId }, checked: [] } }, map);
  assert.equal(restored.modes.exam.session.deadline, 601000);
  assert.equal(restored.modes.exam.session.startedAt, 1000);
  assert.equal(restored.modes.exam.session.bankVersion, 1);
  assert.equal(restored.modes.exam.session.ticketId, 20);
  assert.deepEqual(restored.modes.exam.session.responses, { [repeated.id]: repeated.correctOptionId });
});

test('60 migrated studied questions resume as the remaining 56 without an old session', () => {
  const questions = [...map.values()];
  const answers = Object.fromEntries(questions.slice(0, 60).map(question => [question.id, { attempts: 1, correct: 1 }]));
  for (const version of [1, 2]) {
    const progress = restoreProgress({ version, answers, mistakes: [], exams: [], session: null }, map);
    assert.equal(statsFor(progress, map.size, 'learn').studied, 60);
    assert.equal(statsFor(progress, map.size, 'exam').studied, 0);
    assert.equal(statsFor(progress, map.size, 'mistakes').studied, 0);
    const continuation = createSession(data.tickets, 'learn', { ticketId: 0, remainingOnly: true }, progress);
    assert.deepEqual(continuation.questionIds, questions.slice(60).map(question => question.id));
    assert.equal(continuation.questionIds.length, 56);
    assert.equal(createSession(data.tickets, 'learn', { ticketId: 1, remainingOnly: true }, progress), null);
    assert.equal(createSession(data.tickets, 'learn', { remainingOnly: false }, progress).questionIds.length, 116);
    assert.deepEqual(restoreProgress(JSON.parse(JSON.stringify(progress)), map), progress);
  }
});

test('legacy v2 learning session resumes the 61st question without grading its first 60 again', () => {
  const questions = [...map.values()];
  const studied = questions.slice(0, 60);
  const legacy = {
    version: 2,
    answers: Object.fromEntries(studied.map(question => [question.id, { attempts: 1, correct: 1 }])),
    mistakes: [], exams: [],
    session: {
      mode: 'learn', ticketId: null, questionIds: questions.map(question => question.id), index: 60,
      responses: Object.fromEntries(studied.map(question => [question.id, question.correctOptionId])),
      checked: studied.map(question => question.id), startedAt: 1000, deadline: null,
      allowedErrors: 1, status: 'active', bankVersion: 2,
    },
  };
  const restored = restoreProgress(legacy, map);
  const session = restored.modes.learn.session;
  assert.equal(session.status, 'active');
  assert.equal(session.index, 60);
  assert.equal(session.questionIds[session.index], questions[60].id);
  assert.equal(session.checked.length, 60);
  assert.equal(statsFor(restored, map.size, 'learn').studied, 60);
  assert.equal(statsFor(restored, map.size, 'learn').attempts, 60);
  assert.equal(statsFor(restored, map.size, 'exam').studied, 0);
  assert.deepEqual(restoreProgress(JSON.parse(JSON.stringify(restored)), map), restored);
});

test('legacy 60 studied answers and an active exam migrate into independent continuations', () => {
  const questions = [...map.values()];
  const studied = questions.slice(0, 60);
  const ticket = data.tickets[6];
  const legacy = {
    version: 2,
    answers: Object.fromEntries(studied.map(question => [question.id, { attempts: 1, correct: 1 }])),
    mistakes: [], exams: [],
    session: {
      mode: 'exam', ticketId: ticket.id, questionIds: ticket.questions.map(question => question.id), index: 3,
      responses: Object.fromEntries(ticket.questions.slice(0, 3).map(question => [question.id, question.correctOptionId])),
      checked: [], startedAt: 1000, deadline: 601000, allowedErrors: 1, status: 'active', bankVersion: 2,
    },
  };
  const restored = restoreProgress(legacy, map);
  assert.equal(restored.selectedMode, 'exam');
  assert.equal(restored.modes.learn.session, null);
  assert.deepEqual(restored.modes.exam.session, legacy.session);
  assert.equal(statsFor(restored, map.size, 'learn').studied, 60);
  assert.equal(statsFor(restored, map.size, 'exam').studied, 0);
  restored.modes.learn.session = createSession(data.tickets, 'learn', { remainingOnly: true }, restored, 2000);
  assert.deepEqual(restored.modes.learn.session.questionIds, questions.slice(60).map(question => question.id));
  assert.equal(restored.modes.learn.session.questionIds.length, 56);
  assert.deepEqual(restored.modes.exam.session, legacy.session);
  assert.deepEqual(restoreProgress(JSON.parse(JSON.stringify(restored)), map), restored);
});

test('finishing one mode keeps both other saved sessions active', () => {
  const progress = emptyProgress();
  progress.mistakes = [first.id];
  for (const mode of ['learn', 'exam', 'mistakes']) {
    progress.modes[mode].session = createSession(data.tickets, mode, options, progress, 1000);
  }
  const examBefore = structuredClone(progress.modes.exam);
  const mistakesBefore = structuredClone(progress.modes.mistakes);
  progress.selectedMode = 'learn';
  progress.modes.learn.session.index = 3;
  finishSession(progress, map, 'learn', 2000);
  assert.equal(progress.modes.learn.session.status, 'finished');
  assert.deepEqual(progress.modes.exam, examBefore);
  assert.deepEqual(progress.modes.mistakes, mistakesBefore);
  assert.equal(progress.exams.length, 0);
  assert.equal(progress.selectedMode, 'learn');
});

test('correcting a shared mistake updates only the mistakes-mode answers', () => {
  const progress = emptyProgress();
  const wrong = first.options.find(option => option.id !== first.correctOptionId).id;
  recordAnswer(progress, first, wrong, 'learn');
  const learning = structuredClone(progress.modes.learn);
  assert.equal(recordAnswer(progress, first, first.correctOptionId, 'mistakes'), true);
  assert.deepEqual(progress.modes.learn, learning);
  assert.deepEqual(progress.mistakes, []);
  assert.deepEqual(statsFor(progress, map.size, 'learn'), { studied: 1, total: 116, attempts: 1, accuracy: 0, mistakes: 0 });
  assert.deepEqual(statsFor(progress, map.size, 'mistakes'), { studied: 1, total: 116, attempts: 1, accuracy: 100, mistakes: 0 });
  assert.equal(statsFor(progress, map.size, 'exam').studied, 0);
});

test('exam timeout preserves ongoing learning and mistake-review sessions', () => {
  const progress = emptyProgress();
  recordAnswer(progress, first, first.correctOptionId, 'learn');
  progress.modes.learn.session = createSession(data.tickets, 'learn', { remainingOnly: true }, progress, 1000);
  progress.modes.learn.session.index = 5;
  progress.modes.learn.session.responses[progress.modes.learn.session.questionIds[5]] = 1;
  progress.mistakes = [first.id];
  progress.modes.mistakes.session = createSession(data.tickets, 'mistakes', {}, progress, 2000);
  progress.modes.exam.session = createSession(data.tickets, 'exam', options, progress, 1000);
  const learning = structuredClone(progress.modes.learn);
  const review = structuredClone(progress.modes.mistakes);
  finishSession(progress, map, 'exam', 900000);
  assert.deepEqual(progress.modes.learn, learning);
  assert.deepEqual(progress.modes.mistakes, review);
  assert.equal(progress.modes.exam.session.status, 'finished');
  assert.equal(progress.exams[0].duration, 600000);
  assert.equal(statsFor(progress, map.size, 'learn').attempts, 1);
  assert.equal(statsFor(progress, map.size, 'exam').attempts, 10);
  assert.equal(statsFor(progress, map.size, 'mistakes').attempts, 0);
});

test('v3 roundtrip saves each mode session, settings, answers and the exam deadline', () => {
  const progress = emptyProgress();
  progress.modes.learn.settings.ticketId = 2;
  progress.modes.exam.settings = { ticketId: 3, minutes: 5, allowedErrors: 0 };
  progress.modes.mistakes.settings.ticketId = 4;
  const reviewQuestion = data.tickets[3].questions[0];
  progress.mistakes = [reviewQuestion.id];
  for (const mode of ['learn', 'exam', 'mistakes']) {
    const state = progress.modes[mode];
    state.session = createSession(data.tickets, mode, state.settings, progress, 12345);
    const question = map.get(state.session.questionIds[0]);
    state.session.responses[question.id] = question.correctOptionId;
    if (mode !== 'exam') {
      recordAnswer(progress, question, question.correctOptionId, mode);
      state.session.checked.push(question.id);
    }
    progress.selectedMode = mode;
  }
  progress.modes.learn.session.index = 3;
  progress.modes.exam.session.index = 6;
  const restored = restoreProgress(JSON.parse(JSON.stringify(progress)), map);
  assert.deepEqual(restored, progress);
  assert.equal(restored.selectedMode, 'mistakes');
  assert.equal(restored.modes.exam.session.deadline, 312345);
  assert.equal(restored.modes.exam.session.bankVersion, 2);
  assert.equal(restored.modes.learn.session.index, 3);
  assert.equal(restored.modes.mistakes.session.index, 0);
});

test('v3 alias migration aggregates answers within each mode and stays idempotent', () => {
  const repeated = [...map.values()].find(question => question.aliases.length > 1);
  const [a, b] = repeated.aliases;
  const progress = emptyProgress();
  for (const [index, mode] of ['learn', 'exam', 'mistakes'].entries()) {
    progress.modes[mode].answers = {
      [a]: { attempts: index + 1, correct: index },
      [b]: { attempts: 1, correct: 1 },
    };
    progress.modes[mode].session = {
      mode, status: 'active', questionIds: [a, b], index: 0, responses: { [b]: repeated.correctOptionId }, checked: [],
      startedAt: 1000, deadline: mode === 'exam' ? 601000 : null, allowedErrors: 1, ticketId: null, bankVersion: 2,
    };
  }
  const restored = restoreProgress(progress, map);
  for (const [index, mode] of ['learn', 'exam', 'mistakes'].entries()) {
    assert.deepEqual(restored.modes[mode].answers, { [repeated.id]: { attempts: index + 2, correct: index + 1 } });
    assert.deepEqual(restored.modes[mode].session.questionIds, [repeated.id]);
    assert.deepEqual(restored.modes[mode].session.responses, { [repeated.id]: repeated.correctOptionId });
  }
  assert.equal(restored.modes.exam.session.deadline, 601000);
  assert.deepEqual(restoreProgress(JSON.parse(JSON.stringify(restored)), map), restored);
});

test('exam and review answer history does not exclude unstudied learning questions', () => {
  const progress = emptyProgress();
  recordAnswer(progress, first, first.correctOptionId, 'exam');
  recordAnswer(progress, first, first.correctOptionId, 'mistakes');
  const session = createSession(data.tickets, 'learn', { remainingOnly: true }, progress);
  assert.equal(session.questionIds.length, 116);
  assert.ok(session.questionIds.includes(first.id));
  assert.equal(statsFor(progress, map.size, 'learn').studied, 0);
});

test('corrupt mode state falls back independently and empty progress shares no objects', () => {
  const progress = emptyProgress();
  progress.selectedMode = 'invalid';
  progress.modes.exam.settings = { ticketId: 999, minutes: -1, allowedErrors: -1 };
  progress.modes.learn.answers[first.id] = { attempts: 2, correct: 1 };
  progress.modes.exam.session = createSession(data.tickets, 'learn', options, progress, 1000);
  progress.exams = [null, {}, { finishedAt: 1000, total: 10, correct: 5, allowedErrors: 1 }];
  const restored = restoreProgress(progress, map);
  assert.equal(restored.selectedMode, 'learn');
  assert.deepEqual(restored.modes.exam.settings, { ticketId: 0, minutes: 10, allowedErrors: 1 });
  assert.equal(restored.modes.exam.session, null);
  assert.deepEqual(restored.modes.learn.answers, progress.modes.learn.answers);
  assert.equal(restored.exams.length, 1);
  assert.equal(restored.exams[0].bankVersion, 2);
  const fresh = emptyProgress();
  recordAnswer(fresh, first, first.correctOptionId, 'learn');
  assert.deepEqual(fresh.modes.exam.answers, {});
  assert.deepEqual(emptyProgress().modes.learn.answers, {});
});
