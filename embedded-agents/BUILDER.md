# Embedded Agent Builder Notes

This directory defines the planned internal AI assistant for the event-management app.

Start from Opal chat with:

> בוא נתחיל לבנות את ה־Embedded Agent הפנימי לפי ההחלטות בשיחה.

Build rules:
1. Inspect `index.html` and `_worker.js` first.
2. Propose file changes before editing.
3. Keep `/api/event-agent` bounded to structured actions.
4. Require explicit UI confirmation for WhatsApp sending, deletion, payments, bulk updates, or deploy.
5. Do not create an OpenClaw sub-agent. This is an embedded app component.
