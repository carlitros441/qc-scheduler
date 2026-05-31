from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone, timedelta
import smtplib
import os
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import uuid

# ==================== SMTP CONFIGURATION ====================
EMAIL_PROVIDER = 'gmail' # Toggle: 'gmail' or 'outlook'

# Gmail credentials (requires Google App Password)
GMAIL_SMTP_SERVER = "smtp.gmail.com"
GMAIL_SMTP_PORT = 587
GMAIL_USERNAME = os.getenv("GMAIL_USERNAME", "")
GMAIL_PASSWORD = os.getenv("GMAIL_PASSWORD", "")

# Outlook credentials (requires SMTP AUTH enabled)
OUTLOOK_SMTP_SERVER = "smtp.office365.com"
OUTLOOK_SMTP_PORT = 587
OUTLOOK_USERNAME = os.getenv("OUTLOOK_USERNAME", "")
OUTLOOK_PASSWORD = os.getenv("OUTLOOK_PASSWORD", "")

# SENDER_EMAIL must match the authenticated user to avoid 'on behalf of' warnings
SENDER_EMAIL = GMAIL_USERNAME if EMAIL_PROVIDER == 'gmail' else OUTLOOK_USERNAME
# ============================================================

app = FastAPI(title="QC Scheduler API")

# Updated CORS to allow the specified local IP
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000", 
        "http://127.0.0.1:3000",
        "http://172.16.11.51:3000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

db = None
try:
    # REVERTED TO LOCAL BACKEND FOLDER
    cred = credentials.Certificate('serviceAccountKey.json')
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print('Firestore connected.')
except Exception as e:
    print('Error connecting to Firestore (did you add serviceAccountKey.json?):', e)

# ==================== PYDANTIC MODELS ====================
class TestAssignment(BaseModel):
    product_id: str
    batch_number: str
    product_type: str
    test_name: str
    assignee_id: str
    start_time: str
    end_time: Optional[str] = ""
    is_all_day: bool
    duration_days: Optional[int] = 1

class ScheduleUpdate(BaseModel):
    product_id: str
    batch_number: str
    product_type: str
    test_name: str
    assignee_id: str
    start_time: str
    end_time: Optional[str] = ""
    is_all_day: bool
    duration_days: Optional[int] = 1
    status: str

class Product(BaseModel):
    name: str
    description: str
    product_type: str
    test_frequency: str

class Protocol(BaseModel):
    name: str
    protocol_id: str
    product_type: str
    tests: List[str]

class Personnel(BaseModel):
    name: str
    email: str
    role: str
    active: bool

# ==================== HELPER FUNCTIONS ====================
def generate_ics_string(schedule_id: str, data: dict, assignee_name: str, assignee_email: str) -> str:
    now_utc = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    start_time = data.get('start_time', '')
    end_time = data.get('end_time', '')
    is_all_day = data.get('is_all_day', False)
    duration_days = data.get('duration_days', 1)

    initials = "".join([part[0].upper() for part in assignee_name.split() if part]) if assignee_name else "XX"
    summary = f"{initials}_{data.get('product_id')}_{data.get('batch_number')}_{data.get('test_name')}"

    if is_all_day:
        try:
            start_dt = datetime.strptime(start_time[:10], "%Y-%m-%d")
            end_dt = start_dt + timedelta(days=duration_days)
            dtstart = f"DTSTART;VALUE=DATE:{start_dt.strftime('%Y%m%d')}"
            dtend = f"DTEND;VALUE=DATE:{end_dt.strftime('%Y%m%d')}"
        except Exception as e:
            print("Date parse error:", e)
            dtstart = f"DTSTART;VALUE=DATE:{start_time[:10].replace('-', '')}"
            dtend = dtstart.replace('DTSTART', 'DTEND')
    else:
        dtstart = f"DTSTART:{start_time.replace('-', '').replace(':', '')}00Z"
        dtend = f"DTEND:{end_time.replace('-', '').replace(':', '')}00Z"

    ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//QC Scheduler//EN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        f"UID:{schedule_id}",
        f"DTSTAMP:{now_utc}",
        dtstart,
        dtend,
        f"SUMMARY:{summary}",
        f"DESCRIPTION:Product: {data.get('product_id')} | Batch: {data.get('batch_number')}\\nProduct Type: {data.get('product_type')}\\nAssigned To: {assignee_name} ({assignee_email})\\nLab: QC Laboratory",
        "LOCATION:QC Laboratory",
        f"ORGANIZER;CN=QC Scheduler:mailto:{SENDER_EMAIL}",
        f"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN={assignee_name}:mailto:{assignee_email}",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR"
    ]
    return "\r\n".join(ics)

def send_email_invite(to_email: str, assignee_name: str, test_name: str, ics_content: str):
    msg = MIMEMultipart('alternative')
    msg['From'] = SENDER_EMAIL
    msg['To'] = to_email
    msg['Subject'] = f"QC Test Assignment: {test_name}"

    body = f"Hello {assignee_name},\n\nYou have been assigned a new QC test: {test_name}.\nPlease find the attached calendar invite."
    part_text = MIMEText(body, 'plain')
    msg.attach(part_text)

    part_cal = MIMEText(ics_content, 'calendar', 'utf-8')
    part_cal.set_param('method', 'REQUEST')
    msg.attach(part_cal)

    try:
        if EMAIL_PROVIDER == 'gmail':
            server = smtplib.SMTP(GMAIL_SMTP_SERVER, GMAIL_SMTP_PORT)
            server.starttls()
            server.login(GMAIL_USERNAME, GMAIL_PASSWORD)
        else:
            server = smtplib.SMTP(OUTLOOK_SMTP_SERVER, OUTLOOK_SMTP_PORT)
            server.starttls()
            server.login(OUTLOOK_USERNAME, OUTLOOK_PASSWORD)

        server.send_message(msg)
        server.quit()
        return True
    except Exception as e:
        print(f"Email failed to {to_email}: {e}")
        return False

# ==================== ENDPOINTS: SCHEDULES ====================
@app.post("/api/schedule/save")
def save_schedules(assignments: List[TestAssignment]):
    if not db: raise HTTPException(status_code=500, detail="Database not connected")
    results = []

    for assign in assignments:
        assign_dict = assign.model_dump()
        assign_dict['status'] = 'Scheduled'

        doc_ref = db.collection('schedules').document()
        doc_ref.set(assign_dict)
        schedule_id = doc_ref.id

        assignee_name, assignee_email = "Unknown", "unknown@example.com"
        personnel_ref = db.collection('personnel').document(assign.assignee_id).get()
        if personnel_ref.exists:
            p_data = personnel_ref.to_dict()
            assignee_name = p_data.get('name', assignee_name)
            assignee_email = p_data.get('email', assignee_email)

        ics_content = generate_ics_string(schedule_id, assign_dict, assignee_name, assignee_email)
        email_sent = send_email_invite(assignee_email, assignee_name, assign.test_name, ics_content)

        results.append({
            "schedule_id": schedule_id,
            "test_name": assign.test_name,
            "email_sent": email_sent
        })
    return {"message": "Schedules saved", "summary": results}

@app.post("/api/schedule/{schedule_id}/resend")
def resend_invite(schedule_id: str):
    if not db: raise HTTPException(status_code=500, detail="Database not connected")
    doc = db.collection('schedules').document(schedule_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Schedule not found")

    data = doc.to_dict()
    assignee_name, assignee_email = "Unknown", "unknown@example.com"
    personnel_ref = db.collection('personnel').document(data.get('assignee_id')).get()
    if personnel_ref.exists:
        p_data = personnel_ref.to_dict()
        assignee_name = p_data.get('name', assignee_name)
        assignee_email = p_data.get('email', assignee_email)

    ics_content = generate_ics_string(schedule_id, data, assignee_name, assignee_email)
    success = send_email_invite(assignee_email, assignee_name, data.get('test_name'), ics_content)

    if success:
        return {"message": "Invite resent successfully"}
    else:
        raise HTTPException(status_code=500, detail="Failed to resend email")

@app.get("/api/schedules")
def list_schedules():
    if not db: return []
    docs = db.collection('schedules').order_by('start_time', direction=firestore.Query.DESCENDING).stream()
    return [{"id": doc.id, **doc.to_dict()} for doc in docs]

@app.get("/api/schedule/{schedule_id}/ics")
def download_ics(schedule_id: str):
    doc = db.collection('schedules').document(schedule_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Schedule not found")

    data = doc.to_dict()
    assignee_name, assignee_email = "Unknown", "unknown@example.com"
    personnel_ref = db.collection('personnel').document(data.get('assignee_id')).get()
    if personnel_ref.exists:
        p_data = personnel_ref.to_dict()
        assignee_name = p_data.get('name', assignee_name)
        assignee_email = p_data.get('email', assignee_email)

    ics_content = generate_ics_string(schedule_id, data, assignee_name, assignee_email)
    return Response(content=ics_content, media_type="text/calendar", headers={"Content-Disposition": f"attachment; filename={schedule_id}.ics"})

@app.put("/api/schedule/{schedule_id}")
def update_schedule(schedule_id: str, payload: ScheduleUpdate):
    db.collection('schedules').document(schedule_id).set(payload.model_dump())
    return {"message": "Schedule updated"}

@app.put("/api/schedule/{schedule_id}/complete")
def complete_schedule(schedule_id: str):
    db.collection('schedules').document(schedule_id).update({"status": "Completed"})
    return {"message": "Schedule marked completed"}

@app.delete("/api/schedule/{schedule_id}")
def delete_schedule(schedule_id: str):
    db.collection('schedules').document(schedule_id).delete()
    return {"message": "Schedule deleted"}

# ==================== ENDPOINTS: PRODUCTS ====================
@app.get("/api/products")
def list_products():
    if not db: return []
    return [{"id": d.id, **d.to_dict()} for d in db.collection('products').stream()]

@app.post("/api/products")
def create_product(payload: Product):
    doc = db.collection('products').document()
    doc.set(payload.model_dump())
    return {"id": doc.id}

@app.put("/api/products/{product_id}")
def update_product(product_id: str, payload: Product):
    db.collection('products').document(product_id).set(payload.model_dump())
    return {"message": "Updated"}

@app.delete("/api/products/{product_id}")
def delete_product(product_id: str):
    db.collection('products').document(product_id).delete()
    return {"message": "Deleted"}

# ==================== ENDPOINTS: PROTOCOLS ====================
@app.get("/api/protocols")
def list_protocols():
    if not db: return []
    return [{"id": d.id, **d.to_dict()} for d in db.collection('protocols').stream()]

@app.post("/api/protocols")
def create_protocol(payload: Protocol):
    doc = db.collection('protocols').document()
    doc.set(payload.model_dump())
    return {"id": doc.id}

@app.put("/api/protocols/{protocol_id}")
def update_protocol(protocol_id: str, payload: Protocol):
    db.collection('protocols').document(protocol_id).set(payload.model_dump())
    return {"message": "Updated"}

@app.delete("/api/protocols/{protocol_id}")
def delete_protocol(protocol_id: str):
    db.collection('protocols').document(protocol_id).delete()
    return {"message": "Deleted"}

@app.get("/api/test-protocols")
def get_grouped_protocols():
    if not db: return {}
    docs = list(db.collection('protocols').stream())
    if not docs:
        return {}
    grouped = {}
    for doc in docs:
        data = doc.to_dict()
        ptype = data.get("product_type", "Unknown")
        if ptype not in grouped:
            grouped[ptype] = []
        grouped[ptype].extend(data.get("tests", []))
    for k in grouped:
        grouped[k] = list(set(grouped[k]))
    return grouped

# ==================== ENDPOINTS: PERSONNEL ====================
@app.get("/api/personnel")
def list_personnel():
    if not db: return []
    return [{"id": d.id, **d.to_dict()} for d in db.collection('personnel').stream()]

@app.post("/api/personnel")
def create_personnel(payload: Personnel):
    doc = db.collection('personnel').document()
    doc.set(payload.model_dump())
    return {"id": doc.id}

@app.put("/api/personnel/{personnel_id}")
def update_personnel(personnel_id: str, payload: Personnel):
    db.collection('personnel').document(personnel_id).set(payload.model_dump())
    return {"message": "Updated"}

@app.delete("/api/personnel/{personnel_id}")
def delete_personnel(personnel_id: str):
    db.collection('personnel').document(personnel_id).delete()
    return {"message": "Deleted"}
