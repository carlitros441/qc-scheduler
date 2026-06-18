const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects';

function installEmailTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'processPendingEmailInvites')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('processPendingEmailInvites')
    .timeBased()
    .everyMinutes(1)
    .create();
}

function installStabilityReminderTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'sendWeeklyStabilityReminder')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('sendWeeklyStabilityReminder')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .everyWeeks(1)
    .create();
}

function processPendingEmailInvites() {
  processPendingSchedules_();
  processPendingMailRequests_();
}

function sendWeeklyStabilityReminder() {
  const personnelDocs = listFirestoreCollection_('personnel', 200);
  const personnelById = {};
  personnelDocs.forEach(doc => {
    personnelById[doc.id] = doc.fields;
  });

  const adminDoc = personnelDocs.find(doc => {
    const name = String(doc.fields.name || '').trim().toLowerCase();
    return name === 'stability admin' && doc.fields.active !== false && doc.fields.email;
  });
  if (!adminDoc) {
    throw new Error('Create an active Personnel record named Stability Admin with an email address.');
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = listFirestoreCollection_('schedules', 500)
    .map(doc => buildStabilityReminderRow_(doc, personnelById, today))
    .filter(row => row)
    .sort((a, b) => a.days_until - b.days_until);

  if (!rows.length) {
    return;
  }

  const senderName = getProperty_('MAIL_FROM_NAME', 'QC Scheduler');
  const subject = `QC Stability weekly reminder - ${rows.length} pending test${rows.length === 1 ? '' : 's'}`;
  GmailApp.sendEmail(adminDoc.fields.email, subject, buildStabilityReminderPlain_(rows), {
    name: senderName,
    htmlBody: buildStabilityReminderHtml_(rows)
  });
}

function processPendingSchedules_() {
  const docs = queryFirestore_('schedules', 'email_status', 'pending', 25);
  docs.forEach(doc => {
    const scheduleId = doc.id;
    const schedule = doc.fields;

    try {
      patchFirestore_(`schedules/${scheduleId}`, {
        email_status: 'processing',
        email_processing_at: new Date()
      });
      sendScheduleInvite_(scheduleId, schedule);
    } catch (error) {
      patchFirestore_(`schedules/${scheduleId}`, {
        email_status: 'failed',
        email_error: error.message,
        email_failed_at: new Date()
      });
      console.error(`Failed schedule invite ${scheduleId}: ${error.message}`);
    }
  });
}

function processPendingMailRequests_() {
  const docs = queryFirestore_('mailRequests', 'status', 'pending', 25);
  docs.forEach(doc => {
    const requestId = doc.id;
    const request = doc.fields;

    try {
      if (!request.schedule_id) {
        throw new Error('Missing schedule_id.');
      }

      patchFirestore_(`mailRequests/${requestId}`, {
        status: 'processing',
        processing_at: new Date()
      });

      const schedule = getFirestoreDocument_(`schedules/${request.schedule_id}`);
      sendScheduleInvite_(request.schedule_id, schedule.fields);
      patchFirestore_(`mailRequests/${requestId}`, {
        status: 'sent',
        completed_at: new Date()
      });
    } catch (error) {
      patchFirestore_(`mailRequests/${requestId}`, {
        status: 'failed',
        error: error.message,
        completed_at: new Date()
      });
      console.error(`Failed mail request ${requestId}: ${error.message}`);
    }
  });
}

function sendScheduleInvite_(scheduleId, schedule) {
  if (!schedule.assignee_id) {
    throw new Error('Schedule has no assignee_id.');
  }

  const assigneeDoc = getFirestoreDocument_(`personnel/${schedule.assignee_id}`);
  const assignee = assigneeDoc.fields;
  if (!assignee.email) {
    throw new Error(`Personnel record ${schedule.assignee_id} has no email address.`);
  }

  const trainee = getTrainee_(schedule);
  const reviewer = getReviewer_(schedule);
  const ics = buildCalendarInvite_(scheduleId, schedule, assignee, trainee, reviewer);
  const inviteTitle = buildInviteTitle_(schedule, assignee);
  const senderName = getProperty_('MAIL_FROM_NAME', 'QC Scheduler');
  const actionLinks = buildActionLinks_(scheduleId);
  const plainBody = `Hello ${assignee.name || 'QC team member'},\n\nYou have been assigned as the main analyst for a QC test: ${schedule.test_name || 'Schedule'}\n(${schedule.protocol_name || schedule.product_type || 'Protocol not specified'})\nBatch Number: ${schedule.batch_number || 'Not specified'}\nQC Sample ID: ${schedule.qc_sample_id || 'Not set'}\nTrainee Analyst: ${trainee && trainee.name ? trainee.name : 'None'}\n\nTest Completed: ${actionLinks.testCompleteUrl}\nReview Completed: ${actionLinks.reviewCompleteUrl}\n\nPlease find the calendar invite attached.`;
  const options = {
    name: senderName,
    htmlBody: buildEmailHtml_(schedule, assignee, trainee, reviewer, actionLinks),
    attachments: [
      Utilities.newBlob(ics, 'text/calendar', `${inviteTitle}.ics`)
    ]
  };
  const ccList = [trainee, reviewer]
    .filter(person => person && person.email && person.email !== assignee.email)
    .map(person => person.email);
  if (ccList.length) {
    options.cc = ccList.join(',');
  }

  GmailApp.sendEmail(
    assignee.email,
    inviteTitle,
    plainBody,
    options
  );

  patchFirestore_(`schedules/${scheduleId}`, {
    email_status: 'sent',
    email_sent_at: new Date(),
    email_error: null
  });
}

function buildCalendarInvite_(scheduleId, schedule, assignee, trainee, reviewer) {
  const stamp = calendarDateTime_(new Date());
  const product = schedule.product_name || schedule.product_id || '';
  const batch = schedule.batch_number || '';
  const test = schedule.test_name || 'QC Test';
  const summary = buildInviteTitle_(schedule, assignee);
  const description = [
    `You have been assigned a QC test: ${test}`,
    `(${schedule.protocol_name || schedule.product_type || 'Protocol not specified'})`,
    `Batch Number: ${batch || 'Not specified'}`,
    `QC Sample ID: ${schedule.qc_sample_id || 'Not set'}`,
    `Product: ${product || 'Not specified'}`,
    `Main Analyst: ${assignee.name || 'QC team member'} (${assignee.email || ''})`,
    trainee && trainee.email ? `Trainee Analyst: ${trainee.name || 'Trainee analyst'} (${trainee.email})` : 'Trainee Analyst: None',
    reviewer && reviewer.email ? `QC Reviewer: ${reviewer.name || 'QC reviewer'} (${reviewer.email})` : ''
  ].join('\n');
  let startLine;
  let endLine;

  if (schedule.is_all_day) {
    const start = new Date(`${String(schedule.start_time).split('T')[0]}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + Number(schedule.duration_days || 1));
    startLine = `DTSTART;VALUE=DATE:${calendarDate_(start)}`;
    endLine = `DTEND;VALUE=DATE:${calendarDate_(end)}`;
  } else {
    startLine = `DTSTART:${calendarDateTime_(new Date(schedule.start_time))}`;
    endLine = `DTEND:${calendarDateTime_(new Date(schedule.end_time))}`;
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//QC Scheduler//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${scheduleId}@qc-scheduler`,
    `DTSTAMP:${stamp}`,
    startLine,
    endLine,
    `SUMMARY:${escapeIcsText_(summary)}`,
    `DESCRIPTION:${escapeIcsText_(description)}`,
    'LOCATION:QC Laboratory',
    `ORGANIZER;CN=QC Scheduler:mailto:${getProperty_('MAIL_FROM_EMAIL', Session.getActiveUser().getEmail())}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeIcsText_(assignee.name || 'QC team member')}:mailto:${assignee.email}`,
    trainee && trainee.email ? `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeIcsText_(trainee.name || 'Trainee analyst')}:mailto:${trainee.email}` : '',
    reviewer && reviewer.email ? `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeIcsText_(reviewer.name || 'QC reviewer')}:mailto:${reviewer.email}` : '',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function getTrainee_(schedule) {
  if (!schedule.trainee_id) return null;
  const traineeDoc = getFirestoreDocument_(`personnel/${schedule.trainee_id}`);
  return traineeDoc.fields;
}

function getReviewer_(schedule) {
  if (!schedule.reviewer_id) return null;
  const reviewerDoc = getFirestoreDocument_(`personnel/${schedule.reviewer_id}`);
  return reviewerDoc.fields;
}

function buildActionLinks_(scheduleId) {
  const appUrl = getProperty_('APP_URL', 'https://carlitros441.github.io/QC-Planner/').replace(/\/?$/, '/');
  return {
    testCompleteUrl: `${appUrl}?schedule=${encodeURIComponent(scheduleId)}&action=test-complete`,
    reviewCompleteUrl: `${appUrl}?schedule=${encodeURIComponent(scheduleId)}&action=review-complete`
  };
}

function buildEmailHtml_(schedule, assignee, trainee, reviewer, actionLinks) {
  const test = escapeHtml_(schedule.test_name || 'Schedule');
  const protocol = escapeHtml_(schedule.protocol_name || schedule.product_type || 'Protocol not specified');
  const batch = escapeHtml_(schedule.batch_number || 'Not specified');
  const sampleId = escapeHtml_(schedule.qc_sample_id || 'Not set');
  const analyst = escapeHtml_(assignee.name || 'QC team member');
  const traineeName = escapeHtml_(trainee && trainee.name ? trainee.name : 'None');
  const reviewerName = escapeHtml_(reviewer && reviewer.name ? reviewer.name : 'Not assigned');
  return `
    <div style="font-family:Arial,sans-serif;color:#263238;line-height:1.45;max-width:640px">
      <div style="border-top:5px solid #b11226;border-radius:8px;border:1px solid #d8dee4;padding:20px;background:#ffffff">
        <p style="margin:0 0 6px;color:#b11226;font-weight:800;text-transform:uppercase">QC Planner</p>
        <h2 style="margin:0 0 14px;color:#263238">QC test assignment</h2>
        <p>Hello ${analyst},</p>
        <p>You have been assigned as the main analyst for a QC test: <strong>${test}</strong><br><strong>(${protocol})</strong></p>
        <p><strong>Batch Number:</strong> ${batch}<br><strong>QC Sample ID:</strong> ${sampleId}<br><strong>Trainee Analyst:</strong> ${traineeName}<br><strong>QC Reviewer:</strong> ${reviewerName}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:22px 0">
          <a href="${actionLinks.testCompleteUrl}" style="background:#b11226;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:7px;font-weight:800;display:inline-block">Test Completed</a>
          <a href="${actionLinks.reviewCompleteUrl}" style="background:#10b981;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:7px;font-weight:800;display:inline-block">Review Completed</a>
        </div>
        <p style="color:#64707a;font-size:13px">The buttons open QC Planner. Sign in if prompted, and the status update will be recorded with an audit trail entry.</p>
      </div>
    </div>
  `;
}

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildInviteTitle_(schedule, assignee) {
  const analystInitials = assignee.initials || initialsFromName_(assignee.name || 'QC Analyst');
  return `${analystInitials}_${schedule.batch_number || 'NoBatch'}_${schedule.test_name || 'QC Test'}`;
}

function initialsFromName_(name) {
  return String(name || 'QC Analyst')
    .trim()
    .split(/\s+/)
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .substring(0, 3) || 'QA';
}

function buildStabilityReminderRow_(doc, personnelById, today) {
  const schedule = doc.fields;
  if (!isIncompleteStabilitySchedule_(schedule)) return null;

  const basis = schedule.stability_window_start || schedule.stability_target_date || schedule.start_time;
  const daysUntil = daysUntil_(basis, today);
  if (!isFinite(daysUntil) || daysUntil > 90) return null;

  const analyst = personnelById[schedule.assignee_id] || {};
  const reviewer = personnelById[schedule.reviewer_id] || {};
  const appUrl = getProperty_('APP_URL', 'https://carlitros441.github.io/QC-Planner/').replace(/\/?$/, '/');
  return {
    id: doc.id,
    priority: daysUntil <= 30 ? 'High' : 'Low',
    days_until: daysUntil,
    product_name: schedule.product_name || 'Not specified',
    batch_number: schedule.batch_number || 'Not specified',
    time_point: schedule.stability_time_point_label || 'Stability',
    test_name: schedule.test_name || 'QC test',
    target_date: schedule.stability_target_date || schedule.start_time || '',
    window_start: schedule.stability_window_start || '',
    window_end: schedule.stability_window_end || '',
    analyst_name: analyst.name || schedule.assignee_id || 'Unassigned',
    reviewer_name: reviewer.name || schedule.reviewer_id || 'Unassigned',
    status: schedule.status || 'Scheduled',
    link: `${appUrl}?schedule=${encodeURIComponent(doc.id)}`
  };
}

function isIncompleteStabilitySchedule_(schedule) {
  if (!schedule.stability_program_id) return false;
  const status = String(schedule.status || '').toLowerCase();
  if (status === 'completed' || status === 'deleted') return false;
  if (Number(schedule.progress || 0) >= 100) return false;
  return true;
}

function daysUntil_(dateValue, today) {
  if (!dateValue) return Number.POSITIVE_INFINITY;
  const dateText = String(dateValue).split('T')[0];
  const date = new Date(`${dateText}T00:00:00`);
  if (isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function buildStabilityReminderPlain_(rows) {
  const highRows = rows.filter(row => row.priority === 'High');
  const lowRows = rows.filter(row => row.priority === 'Low');
  return [
    'QC Stability weekly reminder',
    '',
    `High priority within 30 days: ${highRows.length}`,
    `Upcoming within 90 days: ${lowRows.length}`,
    '',
    rows.map(row => `${row.priority}: ${row.batch_number} / ${row.time_point} / ${row.test_name} / Target ${formatReminderDate_(row.target_date)} / Analyst ${row.analyst_name} / ${row.link}`).join('\n')
  ].join('\n');
}

function buildStabilityReminderHtml_(rows) {
  const highRows = rows.filter(row => row.priority === 'High');
  const lowRows = rows.filter(row => row.priority === 'Low');
  return `
    <div style="font-family:Arial,sans-serif;color:#263238;line-height:1.45;max-width:960px">
      <div style="border-top:5px solid #b11226;border-radius:8px;border:1px solid #d8dee4;padding:20px;background:#ffffff">
        <p style="margin:0 0 6px;color:#b11226;font-weight:800;text-transform:uppercase">QC Planner</p>
        <h2 style="margin:0 0 14px;color:#263238">QC Stability weekly reminder</h2>
        <p><strong>${highRows.length}</strong> high priority pending test${highRows.length === 1 ? '' : 's'} within 30 days and <strong>${lowRows.length}</strong> upcoming pending test${lowRows.length === 1 ? '' : 's'} within 90 days.</p>
        ${buildStabilityReminderTable_('High priority', highRows, '#b11226')}
        ${buildStabilityReminderTable_('Upcoming', lowRows, '#0b4a7a')}
      </div>
    </div>
  `;
}

function buildStabilityReminderTable_(title, rows, color) {
  if (!rows.length) {
    return `<h3 style="margin:22px 0 8px;color:${color}">${title}</h3><p style="color:#64707a;margin:0 0 8px">No pending tests in this group.</p>`;
  }

  const body = rows.map(row => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml_(row.batch_number)}</strong><br><span style="color:#64707a">${escapeHtml_(row.product_name)}</span></td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml_(row.time_point)}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml_(row.test_name)}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb">${formatReminderDate_(row.target_date)}<br><span style="color:#64707a">${formatReminderDate_(row.window_start)} to ${formatReminderDate_(row.window_end)}</span></td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml_(row.analyst_name)}<br><span style="color:#64707a">Reviewer: ${escapeHtml_(row.reviewer_name)}</span></td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb"><a href="${row.link}" style="background:${color};color:#ffffff;text-decoration:none;padding:8px 10px;border-radius:6px;font-weight:800;display:inline-block">Open</a></td>
    </tr>
  `).join('');

  return `
    <h3 style="margin:22px 0 8px;color:${color}">${title}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f8fafc;text-align:left">
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Batch</th>
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Time Point</th>
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Test</th>
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Target / Window</th>
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Assignment</th>
          <th style="padding:10px;border-bottom:1px solid #d8dee4">Link</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function formatReminderDate_(value) {
  if (!value) return 'Not set';
  return String(value).split('T')[0];
}

function listFirestoreCollection_(collectionName, pageSize) {
  const projectId = getProperty_('FIREBASE_PROJECT_ID');
  const docs = [];
  let pageToken = '';

  do {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/${collectionName}?pageSize=${pageSize || 100}${tokenParam}`;
    const response = firestoreFetch_(url, 'get');
    (response.documents || []).forEach(doc => {
      docs.push({
        id: doc.name.split('/').pop(),
        fields: fromFirestoreFields_(doc.fields || {})
      });
    });
    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return docs;
}

function queryFirestore_(collection, field, value, limit) {
  const projectId = getProperty_('FIREBASE_PROJECT_ID');
  const url = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents:runQuery`;
  const payload = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: 'EQUAL',
          value: toFirestoreValue_(value)
        }
      },
      limit: limit || 25
    }
  };

  const response = firestoreFetch_(url, 'post', payload);
  return response
    .filter(row => row.document)
    .map(row => ({
      id: row.document.name.split('/').pop(),
      fields: fromFirestoreFields_(row.document.fields || {})
    }));
}

function getFirestoreDocument_(path) {
  const projectId = getProperty_('FIREBASE_PROJECT_ID');
  const url = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/${path}`;
  const doc = firestoreFetch_(url, 'get');
  return {
    id: doc.name.split('/').pop(),
    fields: fromFirestoreFields_(doc.fields || {})
  };
}

function patchFirestore_(path, values) {
  const projectId = getProperty_('FIREBASE_PROJECT_ID');
  const cleanValues = {};
  Object.keys(values).forEach(key => {
    if (values[key] !== null) cleanValues[key] = values[key];
  });

  const updateMask = Object.keys(values)
    .map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join('&');
  const url = `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/${path}?${updateMask}`;

  return firestoreFetch_(url, 'patch', {
    fields: toFirestoreFields_(cleanValues)
  });
}

function firestoreFetch_(url, method, payload) {
  const options = {
    method,
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${getAccessToken_()}`
    }
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(url, options);
  const text = response.getContentText();
  const data = text ? JSON.parse(text) : {};
  if (response.getResponseCode() >= 300) {
    throw new Error(data.error ? data.error.message : text);
  }
  return data;
}

function getAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('FIREBASE_ACCESS_TOKEN');
  const expiresAt = Number(props.getProperty('FIREBASE_ACCESS_TOKEN_EXPIRES_AT') || 0);
  if (cached && Date.now() < expiresAt - 60000) {
    return cached;
  }

  const clientEmail = getProperty_('FIREBASE_CLIENT_EMAIL');
  const privateKey = getProperty_('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url_(JSON.stringify({
    iss: clientEmail,
    scope: FIRESTORE_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  }));
  const signatureBytes = Utilities.computeRsaSha256Signature(`${header}.${claim}`, privateKey);
  const assertion = `${header}.${claim}.${base64UrlBytes_(signatureBytes)}`;

  const response = UrlFetchApp.fetch(TOKEN_URL, {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    },
    muteHttpExceptions: true
  });
  const data = JSON.parse(response.getContentText());
  if (!data.access_token) {
    throw new Error(`Unable to get Firebase access token: ${response.getContentText()}`);
  }

  props.setProperty('FIREBASE_ACCESS_TOKEN', data.access_token);
  props.setProperty('FIREBASE_ACCESS_TOKEN_EXPIRES_AT', String(Date.now() + (data.expires_in || 3600) * 1000));
  return data.access_token;
}

function toFirestoreFields_(obj) {
  const fields = {};
  Object.keys(obj).forEach(key => {
    fields[key] = toFirestoreValue_(obj[key]);
  });
  return fields;
}

function toFirestoreValue_(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (value === null) return { nullValue: null };
  return { stringValue: String(value) };
}

function fromFirestoreFields_(fields) {
  const obj = {};
  Object.keys(fields).forEach(key => {
    obj[key] = fromFirestoreValue_(fields[key]);
  });
  return obj;
}

function fromFirestoreValue_(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue_);
  if ('mapValue' in value) return fromFirestoreFields_(value.mapValue.fields || {});
  return null;
}

function calendarDate_(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function calendarDateTime_(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcsText_(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

function base64Url_(text) {
  return Utilities.base64EncodeWebSafe(text).replace(/=+$/, '');
}

function base64UrlBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function getProperty_(name, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value && fallback === undefined) {
    throw new Error(`Missing script property: ${name}`);
  }
  return value || fallback;
}
