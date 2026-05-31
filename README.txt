QC Scheduler Setup - Network Accessibility

1. Place your 'serviceAccountKey.json' file directly into the 'backend' folder (it has been reverted from the W: drive logic).
2. Set SMTP credentials as environment variables before starting the backend:
   - GMAIL_USERNAME and GMAIL_PASSWORD for Gmail
   - OUTLOOK_USERNAME and OUTLOOK_PASSWORD for Outlook
3. Open a terminal in the 'backend' folder and run:
   pip install -r requirements.txt

--- IMPORTANT: RUNNING ON YOUR LOCAL NETWORK ---

4. Still in the 'backend' folder, start the FastAPI server mapped to all network interfaces (0.0.0.0):
   python -m uvicorn main:app --host 0.0.0.0 --port 8000

5. Open a new terminal in the 'frontend' folder and run:
   npx serve public -l 3000

6. From other computers on your network, open a web browser and go to:
   http://172.16.11.51:3000

(Note: Make sure your host machine's firewall allows incoming connections on ports 8000 and 3000).
