import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyProgress, questionMap, restoreProgress, createSession, recordAnswer, finishSession, resultFor, statsFor } from '../public/model.js';

const data = JSON.parse(await readFile(new URL('../public/questions.json', import.meta.url), 'utf8'));
const map = questionMap(data.tickets);
const first = data.tickets[0].questions[0];
const options = { ticketId: 1, minutes: 10, allowedErrors: 1 };

test('DOCX question bank has 20 complete tickets and valid unique question IDs', () => {
  assert.equal(data.tickets.length, 20);
  assert.equal(map.size, 200);
  for (const ticket of data.tickets) {
    assert.equal(ticket.questions.length, 10);
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
  assert.deepEqual(statsFor(progress, 200), { studied: 1, total: 200, attempts: 3, accuracy: 33, mistakes: 0 });
});

test('sessions select all, one ticket, random exam ticket or only recorded mistakes', () => {
  const progress = emptyProgress();
  assert.equal(createSession(data.tickets, 'learn', {}, progress).questionIds.length, 200);
  assert.deepEqual(createSession(data.tickets, 'learn', options, progress).questionIds, data.tickets[0].questions.map(question => question.id));
  const exam = createSession(data.tickets, 'exam', { ...options, ticketId: 0 }, progress, 1000, () => 0.95);
  assert.equal(exam.ticketId, 20);
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
  assert.equal(statsFor(progress, 200).attempts, 0);
  finishSession(progress, map, 11000);
  assert.deepEqual(resultFor(progress.session, map), { total: 10, correct: 9, answered: 9, errors: 1, passed: true });
  assert.equal(progress.exams.length, 1);
  assert.equal(progress.exams[0].duration, 10000);
  assert.equal(statsFor(progress, 200).attempts, 10);
  assert.deepEqual(progress.mistakes, [data.tickets[0].questions[9].id]);
  finishSession(progress, map, 12000);
  assert.equal(progress.exams.length, 1);
  assert.equal(statsFor(progress, 200).attempts, 10);
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
