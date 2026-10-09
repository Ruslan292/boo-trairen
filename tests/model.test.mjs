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
  progress.session = createSession(data.tickets, 'exam', options, progress, 1000);
  for (const question of data.tickets[0].questions.slice(0, 9)) progress.session.responses[question.id] = question.correctOptionId;
  assert.equal(statsFor(progress, map.size).attempts, 0);
  finishSession(progress, map, 11000);
  assert.deepEqual(resultFor(progress.session, map), { total: 10, correct: 9, answered: 9, errors: 1, passed: true });
  assert.equal(progress.exams.length, 1);
  assert.equal(progress.exams[0].duration, 10000);
  assert.equal(statsFor(progress, map.size).attempts, 10);
  assert.deepEqual(progress.mistakes, [data.tickets[0].questions[9].id]);
  finishSession(progress, map, 12000);
  assert.equal(progress.exams.length, 1);
  assert.equal(statsFor(progress, map.size).attempts, 10);
});

test('unanswered expiry fails and bounds elapsed time to the exam deadline', () => {
  const progress = emptyProgress();
  progress.session = createSession(data.tickets, 'exam', options, progress, 1000);
  finishSession(progress, map, 900000);
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
  progress.session = createSession(data.tickets, 'exam', options, progress, 12345);
  progress.session.responses[first.id] = first.correctOptionId;
  recordAnswer(progress, first, first.correctOptionId);
  const restored = restoreProgress(JSON.parse(JSON.stringify(progress)), map);
  assert.deepEqual(restored, progress);
  assert.equal(restored.session.deadline, 612345);
});

test('invalid persisted data cannot poison statistics or reference missing questions', () => {
  const restored = restoreProgress({ version: 1, answers: { [first.id]: { attempts: 2, correct: 3 }, absent: { attempts: 3, correct: 2 } }, mistakes: [first.id, first.id, 'absent'], exams: [{ total: -1 }], session: { mode: 'exam', questionIds: ['absent'], status: 'active' } }, map);
  assert.deepEqual(restored.answers, {});
  assert.deepEqual(restored.mistakes, [first.id]);
  assert.deepEqual(restored.exams, []);
  assert.equal(restored.session, null);
  assert.deepEqual(restoreProgress({ version: 9 }, map), emptyProgress());
});

test('exam history keeps the last 50 results', () => {
  const progress = emptyProgress();
  for (let index = 0; index < 51; index++) {
    progress.session = createSession(data.tickets, 'exam', options, progress, index * 1000);
    finishSession(progress, map, index * 1000 + 500);
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
  progress.session = createSession(data.tickets, 'exam', { ...options, ticketId: ticket.id }, progress, 1000);
  for (const question of ticket.questions) progress.session.responses[question.id] = question.correctOptionId;
  finishSession(progress, map, 11000);
  assert.deepEqual(resultFor(progress.session, map), { total: 6, correct: 6, answered: 6, errors: 0, passed: true });
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
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.answers, { [repeated.id]: { attempts: 5, correct: 3 } });
  assert.deepEqual(restored.mistakes, [repeated.id]);
  assert.equal(restored.exams[0].bankVersion, 1);
  assert.equal(restored.exams[0].ticketId, 17);
  assert.deepEqual(restored.session.questionIds, [repeated.id, distinct.id]);
  assert.deepEqual(restored.session.checked, [repeated.id]);
  assert.deepEqual(restored.session.responses, { [repeated.id]: wrong });
  assert.equal(restored.session.index, 1);
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
  assert.equal(restored.session.index, 1);
  assert.equal(restored.session.questionIds[1], distinct.id);
  assert.equal(statsFor(restored, map.size).attempts, 1);
});

test('legacy exam keeps its original deadline and maps duplicate aliases to canonical IDs', () => {
  const repeated = [...map.values()].find(question => question.aliases.length > 1);
  const alias = repeated.aliases[1];
  const restored = restoreProgress({ version: 1, session: { mode: 'exam', status: 'active', questionIds: [alias], index: 0, startedAt: 1000, deadline: 601000, allowedErrors: 1, ticketId: 20, responses: { [alias]: repeated.correctOptionId }, checked: [] } }, map);
  assert.equal(restored.session.deadline, 601000);
  assert.equal(restored.session.startedAt, 1000);
  assert.equal(restored.session.bankVersion, 1);
  assert.equal(restored.session.ticketId, 20);
  assert.deepEqual(restored.session.responses, { [repeated.id]: repeated.correctOptionId });
});
