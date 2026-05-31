"use strict";

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();

const smtpHost = defineSecret("SMTP_HOST");
const smtpPort = defineSecret("SMTP_PORT");
const smtpUser = defineSecret("SMTP_USER");
const smtpPassword = defineSecret("SMTP_PASSWORD");
const mailFrom = defineSecret("MAIL_FROM");

const EMAIL_SECRETS = [smtpHost, smtpPort, smtpUser, smtpPassword, mailFrom];

function makeTransport() {
  return nodemailer.createTransport({
    host: smtpHost.value(),
    port: Number(smtpPort.value() || 587),
    secure: Number(smtpPort.value()) === 465,
    auth: {
      user: smtpUser.value(),
      pass: smtpPassword.value()
    }
  });
}

function calendarDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function calendarDateTime(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeText(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

function senderEmailAddress() {
  const from = mailFrom.value();
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

function buildCalendarInvite(scheduleId, schedule, assignee) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const productId = schedule.product_id || "";
  const batchNumber = schedule.batch_number || "";
  const testName = schedule.test_name || "QC Test";
  const summary = `${productId} ${testName}`.trim();
  let startLine;
  let endLine;

  if (schedule.is_all_day) {
    const start = new Date(`${String(schedule.start_time).split("T")[0]}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + (schedule.duration_days || 1));
    startLine = `DTSTART;VALUE=DATE:${calendarDate(start)}`;
    endLine = `DTEND;VALUE=DATE:${calendarDate(end)}`;
  } else {
    startLine = `DTSTART:${calendarDateTime(schedule.start_time)}`;
    endLine = `DTEND:${calendarDateTime(schedule.end_time)}`;
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//QC Scheduler//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${scheduleId}@qc-scheduler`,
    `DTSTAMP:${stamp}`,
    startLine,
    endLine,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:Product: ${escapeText(productId)} | Batch: ${escapeText(batchNumber)}\\nProduct Type: ${escapeText(schedule.product_type)}\\nAssigned To: ${escapeText(assignee.name)} (${escapeText(assignee.email)})`,
    "LOCATION:QC Laboratory",
    `ORGANIZER;CN=QC Scheduler:mailto:${senderEmailAddress()}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeText(assignee.name)}:mailto:${assignee.email}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
}

async function getAssignee(schedule) {
  if (!schedule.assignee_id) {
    throw new Error("Schedule has no assignee_id.");
  }

  const personnelSnap = await admin.firestore()
    .collection("personnel")
    .doc(schedule.assignee_id)
    .get();

  if (!personnelSnap.exists) {
    throw new Error(`Personnel record ${schedule.assignee_id} was not found.`);
  }

  const assignee = personnelSnap.data();
  if (!assignee.email) {
    throw new Error(`Personnel record ${schedule.assignee_id} has no email address.`);
  }

  return {
    name: assignee.name || "QC team member",
    email: assignee.email
  };
}

async function sendScheduleInvite(scheduleId, schedule) {
  const assignee = await getAssignee(schedule);
  const calendarInvite = buildCalendarInvite(scheduleId, schedule, assignee);
  const subject = `QC Test Assignment: ${schedule.test_name || "Schedule"}`;

  await makeTransport().sendMail({
    from: mailFrom.value(),
    to: assignee.email,
    subject,
    text: `Hello ${assignee.name},\n\nYou have been assigned a QC test: ${schedule.test_name || "Schedule"}.\nPlease find the calendar invite attached.`,
    icalEvent: {
      filename: "invite.ics",
      method: "REQUEST",
      content: calendarInvite
    }
  });

  await admin.firestore().collection("schedules").doc(scheduleId).set({
    email_status: "sent",
    email_sent_at: admin.firestore.FieldValue.serverTimestamp(),
    email_error: admin.firestore.FieldValue.delete()
  }, { merge: true });

  logger.info("Schedule invite sent.", { scheduleId, to: assignee.email });
}

exports.sendScheduleInviteOnCreate = onDocumentCreated({
  document: "schedules/{scheduleId}",
  region: "us-central1",
  secrets: EMAIL_SECRETS
}, async (event) => {
  const scheduleId = event.params.scheduleId;
  const schedule = event.data.data();

  try {
    await sendScheduleInvite(scheduleId, schedule);
  } catch (error) {
    logger.error("Schedule invite failed.", { scheduleId, error: error.message });
    await admin.firestore().collection("schedules").doc(scheduleId).set({
      email_status: "failed",
      email_error: error.message,
      email_failed_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
});

exports.resendScheduleInvite = onDocumentCreated({
  document: "mailRequests/{requestId}",
  region: "us-central1",
  secrets: EMAIL_SECRETS
}, async (event) => {
  const requestId = event.params.requestId;
  const request = event.data.data();
  const scheduleId = request.schedule_id;

  if (!scheduleId) {
    await event.data.ref.set({
      status: "failed",
      error: "Missing schedule_id.",
      completed_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  try {
    const scheduleSnap = await admin.firestore().collection("schedules").doc(scheduleId).get();
    if (!scheduleSnap.exists) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }

    await sendScheduleInvite(scheduleId, scheduleSnap.data());
    await event.data.ref.set({
      status: "sent",
      completed_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    logger.error("Requested invite resend failed.", { requestId, scheduleId, error: error.message });
    await event.data.ref.set({
      status: "failed",
      error: error.message,
      completed_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
});
