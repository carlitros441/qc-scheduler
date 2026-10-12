import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function worker(email) {
  const sent = [];
  const context = vm.createContext({
    GmailApp: { sendEmail: (...args) => sent.push(args) },
    Utilities: { newBlob: (text) => text },
    Session: { getActiveUser: () => ({ getEmail: () => 'sender@example.com' }) }
  });
  vm.runInContext(readFileSync(new URL('../google-apps-script/Code.gs', import.meta.url), 'utf8'), context);
  context.getProperty_ = (_name, fallback) => fallback || 'https://example.com';
  context.getFirestoreDocument_ = path => ({ fields: path.endsWith('/main') ? { name: 'Main Analyst', email } : { name: 'Other Person', email: 'other@example.com' } });
  context.patchFirestore_ = () => {};
  return { context, sent };
}
const schedule = { assignee_id: 'main', reviewer_id: 'reviewer', trainee_id: 'trainee', trainee_2_id: 'trainee2', test_name: 'Test', batch_number: 'B1', is_all_day: true, start_time: '2026-10-13', duration_days: 1 };
test('All performing analyst addresses receive the invite without copying reviewer or trainees', () => {
  for (const [email, expected] of [
    ['main@example.com', ['main@example.com']],
    [' main@example.com, second@example.com', ['main@example.com', 'second@example.com']],
    ['main@example.com;second@example.com', ['main@example.com', 'second@example.com']],
    ['main@example.com;MAIN@example.com,,second@example.com;', ['main@example.com', 'second@example.com']]
  ]) {
    const { context, sent } = worker(email);
    context.sendScheduleInvite_('schedule1', schedule);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], expected.join(','));
    assert.equal(sent[0][3].cc, undefined);
    assert.equal(sent[0][3].bcc, undefined);
    const attendees = sent[0][3].attachments[0].split('\r\n').filter(line => line.startsWith('ATTENDEE;'));
    assert.deepEqual(attendees.map(line => line.split(':mailto:')[1]), expected);
  }
});
test('Missing or invalid performing analyst email fails without sending to reviewer', () => {
  for (const email of ['', 'invalid', 'main@example.com;invalid', 'main@example.com\r\nBcc:copy@example.com']) {
    const { context, sent } = worker(email);
    assert.throws(() => context.sendScheduleInvite_('schedule1', schedule), /missing or invalid email/);
    assert.equal(sent.length, 0);
  }
});
