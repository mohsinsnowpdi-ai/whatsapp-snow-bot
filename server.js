require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Set these as Environment Variables in Render.com dashboard — never hardcode
const {
  VERIFY_TOKEN,          // any string you choose, e.g. "mySecretToken123"
  WHATSAPP_TOKEN,        // Meta permanent access token from developer dashboard
  PHONE_NUMBER_ID,       // From Meta → WhatsApp → Getting Started
  SN_INSTANCE,           // e.g. https://dev12345.service-now.com
  SN_USERNAME,           // PDI service account username
  SN_PASSWORD,           // PDI service account password
  PORT = 3000
} = process.env;

// ─── INTENT PARSER ───────────────────────────────────────────────────────────
function parseIntent(messageText) {
  const text = messageText.trim().toLowerCase();

  // CREATE INCIDENT patterns
  if (/^(create|raise|log|new|open)\s+(incident|inc|ticket|issue)/i.test(text)) {
    const descMatch = messageText.match(/:\s*(.+)$/);
    return {
      action: 'create_incident',
      description: descMatch ? descMatch[1].trim() : messageText,
      priority: detectPriority(text)
    };
  }

  // STATUS CHECK patterns
  if (/^(status|check|what.s|where.s|update on)\s+(inc\d+|ritm\d+|my ticket|my inc)/i.test(text)) {
    const numMatch = messageText.match(/\b(INC|RITM|REQ)\d+\b/i);
    return {
      action: 'check_status',
      ticketNumber: numMatch ? numMatch[0].toUpperCase() : null
    };
  }

  // LIST MY TICKETS
  if (/\b(my tickets|my incidents|what do i have open|show my)\b/i.test(text)) {
    return { action: 'list_tickets' };
  }

  // UPDATE TICKET
  if (/^(update|comment|add note)\s+(inc\d+|ritm\d+)/i.test(text)) {
    const numMatch = messageText.match(/\b(INC|RITM)\d+\b/i);
    const commentMatch = messageText.match(/:\s*(.+)$/);
    return {
      action: 'update_ticket',
      ticketNumber: numMatch ? numMatch[0].toUpperCase() : null,
      comment: commentMatch ? commentMatch[1].trim() : null
    };
  }

  // HELP
  if (/^(help|\?|commands|what can you do)/i.test(text)) {
    return { action: 'help' };
  }

  return { action: 'unknown', rawText: messageText };
}

function detectPriority(text) {
  if (/\b(critical|p1|priority 1|urgent|down|outage)\b/.test(text)) return '1';
  if (/\b(high|p2|priority 2)\b/.test(text)) return '2';
  if (/\b(low|p4|priority 4|minor)\b/.test(text)) return '4';
  return '3'; // default Medium
}

// ─── SERVICENOW HELPERS ──────────────────────────────────────────────────────
const snAxios = axios.create({
  baseURL: SN_INSTANCE,
  auth: { username: SN_USERNAME, password: SN_PASSWORD },
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
});

async function findCallerBySysId(phoneNumber) {
  try {
    // Strip + and spaces from phone for lookup
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const res = await snAxios.get('/api/now/table/sys_user', {
      params: {
        sysparm_query: `mobile_phone=${cleanPhone}^ORphone=${cleanPhone}`,
        sysparm_fields: 'sys_id,name,email',
        sysparm_limit: 1
      }
    });
    return res.data.result[0] || null;
  } catch {
    return null;
  }
}

async function createIncident(callerSysId, description, priority, phoneNumber) {
  const res = await snAxios.post('/api/now/table/incident', {
    caller_id: callerSysId || '',
    short_description: description.substring(0, 160),
    description: description,
    priority: priority,
    contact_type: 'self-service',
    comments: `Created via WhatsApp from ${phoneNumber}`
  });
  return res.data.result;
}

async function checkDuplicateOpenIncident(callerSysId, description) {
  if (!callerSysId) return null;
  const words = description.split(' ').slice(0, 3).join(' ');
  const res = await snAxios.get('/api/now/table/incident', {
    params: {
      sysparm_query: `caller_id=${callerSysId}^state!=6^state!=7^short_descriptionLIKE${words}`,
      sysparm_fields: 'number,short_description,state',
      sysparm_limit: 1
    }
  });
  return res.data.result[0] || null;
}

async function getIncidentByNumber(ticketNumber) {
  const table = ticketNumber.startsWith('RITM') ? 'sc_req_item' : 'incident';
  const field = ticketNumber.startsWith('RITM') ? 'number' : 'number';
  const res = await snAxios.get(`/api/now/table/${table}`, {
    params: {
      sysparm_query: `${field}=${ticketNumber}`,
      sysparm_fields: 'number,short_description,state,priority,assigned_to,sys_updated_on',
      sysparm_limit: 1
    }
  });
  return res.data.result[0] || null;
}

async function getOpenTicketsForCaller(callerSysId) {
  const res = await snAxios.get('/api/now/table/incident', {
    params: {
      sysparm_query: `caller_id=${callerSysId}^state!=6^state!=7^ORDERBYDESCsys_updated_on`,
      sysparm_fields: 'number,short_description,state,priority',
      sysparm_limit: 5
    }
  });
  return res.data.result || [];
}

async function addWorkNoteToIncident(ticketNumber, comment) {
  const inc = await getIncidentByNumber(ticketNumber);
  if (!inc) return null;
  const res = await snAxios.patch(`/api/now/table/incident/${inc.sys_id}`, {
    work_notes: comment
  });
  return res.data.result;
}

async function logWhatsAppInteraction(phoneNumber, message, action, incidentSysId, reply) {
  try {
    await snAxios.post('/api/now/table/x_1879900_wa_sno_0_wa_log', {
      u_caller_number: phoneNumber,
      u_message_body: message.substring(0, 500),
      u_action_taken: action,
      u_incident_sys_id: incidentSysId || '',
      u_response_sent: reply.substring(0, 500),
      u_timestamp: new Date().toISOString()
    });
  } catch (e) {
    // Non-fatal — log to console only
    console.error('WA log write failed:', e.message);
  }
}

// ─── STATE MAP ──────────────────────────────────────────────────────────────
const STATE_MAP = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '4': 'Awaiting Info', '5': 'Resolved', '6': 'Closed', '7': 'Cancelled' };
const PRIORITY_MAP = { '1': 'Critical', '2': 'High', '3': 'Medium', '4': 'Low' };

// ─── WHATSAPP SENDER ─────────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ─── RESPONSE BUILDER ────────────────────────────────────────────────────────
function buildHelpMessage() {
  return [
    '🤖 *ServiceNow Bot — Available Commands*',
    '',
    '*Create Incident:*',
    'create incident: <description>',
    'e.g. create incident: VPN not connecting',
    '',
    '*Check Status:*',
    'status INC0001234',
    '',
    '*My Open Tickets:*',
    'my tickets',
    '',
    '*Add Comment:*',
    'update INC0001234: <your comment>',
    '',
    '*Priority keywords:* critical, high, low (default: medium)'
  ].join('\n');
}

// ─── MAIN MESSAGE HANDLER ────────────────────────────────────────────────────
async function handleMessage(phoneNumber, messageText) {
  const intent = parseIntent(messageText);
  let reply = '';
  let incidentSysId = '';

  try {
    switch (intent.action) {

      case 'create_incident': {
        const caller = await findCallerBySysId(phoneNumber);

        // Duplicate check
        if (caller) {
          const dup = await checkDuplicateOpenIncident(caller.sys_id, intent.description);
          if (dup) {
            reply = `⚠️ You may already have a similar open ticket:\n*${dup.number}* — ${dup.short_description}\nState: ${STATE_MAP[dup.state] || dup.state}\n\nReply with *confirm* to create a new one anyway, or *status ${dup.number}* to check it.`;
            break;
          }
        }

        const inc = await createIncident(
          caller?.sys_id || null,
          intent.description,
          intent.priority,
          phoneNumber
        );
        incidentSysId = inc.sys_id;
        reply = [
          `✅ *Incident Created Successfully*`,
          ``,
          `📋 Number: *${inc.number}*`,
          `📝 Summary: ${inc.short_description}`,
          `🔴 Priority: ${PRIORITY_MAP[inc.priority] || inc.priority}`,
          `📊 State: ${STATE_MAP[inc.state] || inc.state}`,
          ``,
          `You will be updated when the status changes.`,
          `To check status later: *status ${inc.number}*`
        ].join('\n');
        break;
      }

      case 'check_status': {
        if (!intent.ticketNumber) {
          reply = '❓ Please include the ticket number.\nExample: *status INC0001234*';
          break;
        }
        const ticket = await getIncidentByNumber(intent.ticketNumber);
        if (!ticket) {
          reply = `❌ Ticket *${intent.ticketNumber}* not found. Please check the number and try again.`;
          break;
        }
        reply = [
          `📋 *${ticket.number}*`,
          `📝 ${ticket.short_description}`,
          `📊 State: *${STATE_MAP[ticket.state] || ticket.state}*`,
          `🔴 Priority: ${PRIORITY_MAP[ticket.priority] || ticket.priority}`,
          `👤 Assigned to: ${ticket.assigned_to?.display_value || 'Unassigned'}`,
          `🕐 Last updated: ${new Date(ticket.sys_updated_on).toLocaleString()}`
        ].join('\n');
        break;
      }

      case 'list_tickets': {
        const caller = await findCallerBySysId(phoneNumber);
        if (!caller) {
          reply = `❌ Your phone number (${phoneNumber}) is not registered in ServiceNow.\nPlease contact the helpdesk to link your account.`;
          break;
        }
        const tickets = await getOpenTicketsForCaller(caller.sys_id);
        if (!tickets.length) {
          reply = `✅ Great news — you have no open tickets right now!`;
          break;
        }
        const lines = tickets.map(t =>
          `• *${t.number}* [${PRIORITY_MAP[t.priority] || t.priority}] — ${t.short_description.substring(0, 50)} (${STATE_MAP[t.state] || t.state})`
        );
        reply = `📋 *Your Open Tickets (${caller.name})*\n\n${lines.join('\n')}\n\nType *status INC...* for details on any ticket.`;
        break;
      }

      case 'update_ticket': {
        if (!intent.ticketNumber || !intent.comment) {
          reply = '❓ Format: *update INC0001234: your comment here*';
          break;
        }
        const updated = await addWorkNoteToIncident(intent.ticketNumber, intent.comment);
        if (!updated) {
          reply = `❌ Could not find ticket *${intent.ticketNumber}* to update.`;
          break;
        }
        reply = `✅ Comment added to *${intent.ticketNumber}*:\n"${intent.comment}"`;
        break;
      }

      case 'help': {
        reply = buildHelpMessage();
        break;
      }

      default: {
        reply = [
          `🤔 I didn't understand that. Here's what I can do:`,
          ``,
          `• *create incident: <description>*`,
          `• *status INC0001234*`,
          `• *my tickets*`,
          `• *update INC0001234: <comment>*`,
          `• *help* — full command list`
        ].join('\n');
      }
    }
  } catch (err) {
    console.error('Handler error:', err.message);
    if (err.response?.status === 401) {
      reply = '🔐 Authentication error — please contact the administrator.';
    } else if (err.response?.status === 404) {
      reply = '❌ ServiceNow endpoint not found. Please contact the administrator.';
    } else {
      reply = '⚠️ Something went wrong on our end. Please try again in a moment.';
    }
  }

  await sendWhatsAppMessage(phoneNumber, reply);
  await logWhatsAppInteraction(phoneNumber, messageText, intent.action, incidentSysId, reply);
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
// Webhook verification (GET) — Meta calls this when you register the webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Inbound messages (POST) — Meta sends WhatsApp messages here
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always ACK immediately to avoid Meta retry storms

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages?.length) return; // Could be a status update, not a message

    const msg = messages[0];
    const phoneNumber = msg.from;
    const messageText = msg.text?.body;

    if (!messageText) return; // Ignore non-text (images, voice notes, etc.)

    console.log(`[${new Date().toISOString()}] FROM: ${phoneNumber} | MSG: ${messageText}`);
    await handleMessage(phoneNumber, messageText);

  } catch (err) {
    console.error('Webhook processing error:', err.message);
    console.log("Failed URL:", err.config?.url);
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`WhatsApp→SNow webhook listening on port ${PORT}`));
