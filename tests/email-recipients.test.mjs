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
test('Only performing analyst receives email and is an ICS attendee, including when a profile has copied addresses', () => {
  for (const email of ['main@example.com', ' main@example.com,reviewer@example.com', 'main@example.com;reviewer@example.com']) {
    const { context, sent } = worker(email);
    context.sendScheduleInvite_('schedule1', schedule);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'main@example.com');
    assert.equal(sent[0][3].cc, undefined);
    assert.equal(sent[0][3].bcc, undefined);
    const attendees = sent[0][3].attachments[0].split('\r\n').filter(line => line.startsWith('ATTENDEE;'));
    assert.equal(attendees.length, 1);
    assert.ok(attendees[0].endsWith(':mailto:main@example.com'));
  }
});
test('Missing or invalid performing analyst email fails without sending to reviewer', () => {
  for (const email of ['', 'invalid', ';reviewer@example.com', 'main@example.com\r\nBcc:copy@example.com']) {
    const { context, sent } = worker(email);
    assert.throws(() => context.sendScheduleInvite_('schedule1', schedule), /valid primary email/);
    assert.equal(sent.length, 0);
  }
});
