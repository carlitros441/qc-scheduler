"use strict";

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const requiredEnv = [
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_FROM"
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
});

const db = admin.firestore();

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

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
  const from = process.env.MAIL_FROM;
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

  const personnelSnap = await db.collection("personnel").doc(schedule.assignee_id).get();
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

  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to: assignee.email,
    subject: `QC Test Assignment: ${schedule.test_name || "Schedule"}`,
    text: `Hello ${assignee.name},\n\nYou have been assigned a QC test: ${schedule.test_name || "Schedule"}.\nPlease find the calendar invite attached.`,
    icalEvent: {
      filename: "invite.ics",
      method: "REQUEST",
      content: calendarInvite
    }
  });

  await db.collection("schedules").doc(scheduleId).set({
    email_status: "sent",
    email_sent_at: admin.firestore.FieldValue.serverTimestamp(),
    email_error: admin.firestore.FieldValue.delete()
  }, { merge: true });

  console.log(`Sent schedule invite ${scheduleId} to ${assignee.email}`);
}

async function processPendingSchedules() {
  const snapshot = await db.collection("schedules")
    .where("email_status", "==", "pending")
    .limit(25)
    .get();

  for (const doc of snapshot.docs) {
    try {
      await doc.ref.set({
        email_status: "processing",
        email_processing_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await sendScheduleInvite(doc.id, doc.data());
    } catch (error) {
      console.error(`Failed schedule invite ${doc.id}: ${error.message}`);
      await doc.ref.set({
        email_status: "failed",
        email_error: error.message,
        email_failed_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
}

async function processMailRequests() {
  const snapshot = await db.collection("mailRequests")
    .where("status", "==", "pending")
    .limit(25)
    .get();

  for (const doc of snapshot.docs) {
    const request = doc.data();
    try {
      await doc.ref.set({
        status: "processing",
        processing_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (!request.schedule_id) {
        throw new Error("Missing schedule_id.");
      }

      const scheduleSnap = await db.collection("schedules").doc(request.schedule_id).get();
      if (!scheduleSnap.exists) {
        throw new Error(`Schedule ${request.schedule_id} was not found.`);
      }

      await sendScheduleInvite(scheduleSnap.id, scheduleSnap.data());
      await doc.ref.set({
        status: "sent",
        completed_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error(`Failed mail request ${doc.id}: ${error.message}`);
      await doc.ref.set({
        status: "failed",
        error: error.message,
        completed_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
}

async function main() {
  await processPendingSchedules();
  await processMailRequests();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
