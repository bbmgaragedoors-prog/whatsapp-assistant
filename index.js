/**
 * WhatsApp Personal Assistant — Ben Gozlan
 * ─────────────────────────────────────────
 * Powered by OpenAI GPT-4o + Twilio WhatsApp
 * Manages: calendar, tasks, reminders, drafts, Q&A
 * Approval mode: previews all actions before executing
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Clients ────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OWNER_PHONE = process.env.OWNER_PHONE || 'whatsapp:+17135983837';
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

// ─── In-memory stores ────────────────────────────────
const tasks = [];           // { id, text, priority, due, done, createdAt }
const reminders = [];       // { id, message, remindAt, sent }
const pendingApprovals = {}; // { [phone]: { parsed, timestamp } }
const conversations = {};    // { [phone]: [{ role, content }] }

// ─── System Prompt ────────────────────────────────────
const SYSTEM_PROMPT = `You are Alex, a highly professional personal assistant for Ben Gozlan, a business owner in Houston, TX.

Ben messages you via WhatsApp. You help him manage his professional and personal life with maximum efficiency.

## WHAT YOU MANAGE
- 📅 Calendar & meetings (via Google Calendar API)
- ✅ Tasks & to-do lists (stored in memory)
- 🔔 Reminders (timed alerts)
- ✍️ Drafts (emails, messages, social posts)
- 💡 Quick research & answers
- 📊 Daily briefings & summaries

## TONE & STYLE
- Professional, concise, no fluff
- Use emojis sparingly for readability
- Always confirm what you did: "✅ Done — ..."
- Ask ONE clarifying question max when needed
- Never be verbose — Ben is a busy executive

## IMPORTANT RULES
- You NEVER send messages to other people on Ben's behalf without his explicit approval
- Always show a preview before taking any action
- Protect Ben's time — prioritize tasks by urgency

## RESPONSE FORMAT
Always respond in this JSON structure:
{
  "intent": "schedule_meeting|list_events|add_task|list_tasks|complete_task|set_reminder|list_reminders|draft|answer|daily_briefing",
  "data": {},
  "reply": "message to show Ben",
  "needs_approval": true/false
}

### Intents:
- schedule_meeting: { title, date (YYYY-MM-DD), time (HH:MM), duration_minutes, location, attendees[], notes }
- list_events: { period: "today|tomorrow|this_week|YYYY-MM-DD" }
- add_task: { text, priority: "high|medium|low", due: "YYYY-MM-DD|null" }
- list_tasks: {}
- complete_task: { task_id: number }
- set_reminder: { message, remind_at: "YYYY-MM-DDTHH:MM" }
- list_reminders: {}
- draft: { type: "email|text|linkedin|tweet", recipient, subject, content }
- answer: {} — just reply directly, needs_approval: false
- daily_briefing: {} — summary of today's tasks and schedule

## CURRENT CONTEXT
Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' })} CST (Houston, TX)`;

// ─── OpenAI: process message ──────────────────────────
async function processMessage(phone, userMessage) {
  if (!conversations[phone]) conversations[phone] = [];
  
  conversations[phone].push({ role: 'user', content: userMessage });
  
  // Keep last 20 messages for context
  const history = conversations[phone].slice(-20);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history
    ],
    temperature: 0.3,
    max_tokens: 600,
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  conversations[phone].push({ role: 'assistant', content });
  
  try {
    return JSON.parse(content);
  } catch {
    return { intent: 'answer', data: {}, reply: content, needs_approval: false };
  }
}

// ─── Send WhatsApp message ────────────────────────────
async function sendWhatsApp(to, message) {
  await twilioClient.messages.create({
    from: FROM_NUMBER,
    to,
    body: message
  });
}

// ─── Format approval preview ──────────────────────────
function formatPreview(parsed) {
  const { intent, data, reply } = parsed;
  let preview = `🤖 *Alex — Action Preview*\n`;
  preview += `─────────────────────\n`;

  switch (intent) {
    case 'schedule_meeting':
      preview += `📅 *Schedule Meeting*\n`;
      preview += `Title: ${data.title}\n`;
      preview += `Date: ${data.date} at ${data.time}\n`;
      if (data.duration_minutes) preview += `Duration: ${data.duration_minutes} min\n`;
      if (data.location) preview += `Location: ${data.location}\n`;
      if (data.attendees?.length) preview += `Attendees: ${data.attendees.join(', ')}\n`;
      if (data.notes) preview += `Notes: ${data.notes}\n`;
      break;
    case 'add_task':
      const pEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[data.priority] || '🟡';
      preview += `${pEmoji} *Add Task*\n${data.text}`;
      if (data.priority) preview += ` [${data.priority.toUpperCase()}]`;
      if (data.due) preview += `\n📅 Due: ${data.due}`;
      break;
    case 'complete_task':
      const t = tasks.find(x => x.id === data.task_id);
      preview += `☑️ *Complete Task*\n${t ? t.text : `#${data.task_id}`}`;
      break;
    case 'set_reminder':
      preview += `🔔 *Set Reminder*\n"${data.message}"\n📅 ${data.remind_at}`;
      break;
    case 'draft':
      preview += `✍️ *Draft ${data.type?.toUpperCase() || 'Message'}*`;
      if (data.recipient) preview += `\nTo: ${data.recipient}`;
      if (data.subject) preview += `\nSubject: ${data.subject}`;
      preview += `\n\n${data.content}`;
      break;
    default:
      preview += reply;
  }

  preview += `\n─────────────────────\nReply *yes* to confirm or *no* to cancel`;
  return preview;
}

// ─── Execute intent ───────────────────────────────────
async function executeIntent(parsed) {
  const { intent, data } = parsed;
  
  switch (intent) {
    case 'schedule_meeting': {
      // TODO: integrate with Google Calendar API
      // For now, store locally and return confirmation
      const meeting = { ...data, id: Date.now(), type: 'meeting' };
      tasks.push({ ...meeting, text: `Meeting: ${data.title}`, priority: 'high', done: false, createdAt: new Date() });
      return `✅ *Meeting Scheduled*\n\n📅 ${data.title}\n🕐 ${data.date} at ${data.time}${data.location ? '\n📍 ' + data.location : ''}\n\nAdded to your task list. Set up Google Calendar integration to sync automatically.`;
    }

    case 'list_events': {
      const meetings = tasks.filter(t => t.type === 'meeting' && !t.done);
      if (!meetings.length) return `📅 No meetings found. Your schedule is clear!`;
      return `📅 *Upcoming Meetings:*\n\n${meetings.map(m => `• ${m.title} — ${m.date} ${m.time}`).join('\n')}`;
    }

    case 'add_task': {
      const id = tasks.length + 1;
      const task = { id, text: data.text, priority: data.priority || 'medium', due: data.due || null, done: false, createdAt: new Date() };
      tasks.push(task);
      const pEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[task.priority] || '🟡';
      return `✅ Task added!\n\n${pEmoji} *${task.text}*${task.due ? '\n📅 Due: ' + task.due : ''}`;
    }

    case 'list_tasks': {
      const pending = tasks.filter(t => !t.done && t.type !== 'meeting');
      if (!pending.length) return `✅ No pending tasks. You're all caught up!`;
      const sorted = [...pending].sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.priority] || 1) - (order[b.priority] || 1);
      });
      const lines = sorted.map(t => {
        const p = { high: '🔴', medium: '🟡', low: '🟢' }[t.priority] || '🟡';
        return `${t.id}. ${p} ${t.text}${t.due ? ' · ' + t.due : ''}`;
      });
      return `📋 *Your Tasks (${pending.length}):*\n\n${lines.join('\n')}`;
    }

    case 'complete_task': {
      const task = tasks.find(t => t.id === data.task_id);
      if (!task) return `❓ Task #${data.task_id} not found. Type *tasks* to see your list.`;
      task.done = true;
      return `✅ Done! *${task.text}*\n\nGreat work! 🎉`;
    }

    case 'set_reminder': {
      const id = reminders.length + 1;
      reminders.push({ id, message: data.message, remindAt: new Date(data.remind_at), sent: false });
      return `🔔 Reminder set!\n\n"${data.message}"\n📅 ${data.remind_at}`;
    }

    case 'list_reminders': {
      const upcoming = reminders.filter(r => !r.sent);
      if (!upcoming.length) return `🔔 No upcoming reminders.`;
      return `🔔 *Upcoming Reminders:*\n\n${upcoming.map(r => `• ${r.message} — ${r.remindAt.toLocaleString('en-US', { timeZone: 'America/Chicago' })}`).join('\n')}`;
    }

    case 'daily_briefing': {
      const today = new Date().toISOString().slice(0, 10);
      const todayTasks = tasks.filter(t => !t.done && t.type !== 'meeting');
      const highPriority = todayTasks.filter(t => t.priority === 'high');
      const upcomingReminders = reminders.filter(r => !r.sent);
      
      let briefing = `☀️ *Good morning, Ben!*\n\n`;
      briefing += `📊 *Today's Overview:*\n`;
      briefing += `• ${todayTasks.length} pending tasks`;
      if (highPriority.length) briefing += ` (${highPriority.length} high priority)`;
      briefing += `\n• ${upcomingReminders.length} upcoming reminders\n\n`;
      
      if (highPriority.length) {
        briefing += `🔴 *High Priority:*\n`;
        highPriority.slice(0, 3).forEach(t => briefing += `• ${t.text}\n`);
      }
      return briefing;
    }

    default:
      return parsed.reply || "How can I help you?";
  }
}

// ─── Approval keywords ────────────────────────────────
const YES = ['yes', 'ok', 'send', 'do it', 'confirm', 'approve', 'go', '✅', 'yep', 'sure', 'y'];
const NO = ['no', 'cancel', 'stop', 'nope', '❌', 'n', 'nevermind'];

// ─── Main webhook ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('<Response></Response>');
  
  const incomingMessage = (req.body.Body || '').trim();
  const senderPhone = req.body.From || '';
  
  console.log(`[${new Date().toLocaleTimeString()}] ${senderPhone}: ${incomingMessage}`);

  // Security: only owner
  if (senderPhone !== OWNER_PHONE) {
    console.log('Ignored: not owner');
    return;
  }

  const msgLower = incomingMessage.toLowerCase();

  try {
    // ── Check for pending approval ──
    if (pendingApprovals[senderPhone]) {
      const { parsed, timestamp } = pendingApprovals[senderPhone];
      
      // Expire after 10 minutes
      if (Date.now() - timestamp > 600000) {
        delete pendingApprovals[senderPhone];
        await sendWhatsApp(senderPhone, '⏰ Approval expired. Send your request again.');
        return;
      }

      if (YES.some(w => msgLower === w || msgLower.startsWith(w + ' '))) {
        delete pendingApprovals[senderPhone];
        const result = await executeIntent(parsed);
        await sendWhatsApp(senderPhone, result);
        return;
      }

      if (NO.some(w => msgLower === w || msgLower.startsWith(w + ' '))) {
        delete pendingApprovals[senderPhone];
        await sendWhatsApp(senderPhone, '❌ Cancelled.');
        return;
      }

      // New message — discard old approval
      delete pendingApprovals[senderPhone];
    }

    // ── Process new message ──
    const parsed = await processMessage(senderPhone, incomingMessage);
    
    // No-approval intents: list, answer, briefing
    const autoExecute = ['list_tasks', 'list_events', 'list_reminders', 'answer', 'daily_briefing'].includes(parsed.intent);
    
    if (autoExecute || parsed.needs_approval === false) {
      const result = await executeIntent(parsed);
      await sendWhatsApp(senderPhone, result);
    } else {
      pendingApprovals[senderPhone] = { parsed, timestamp: Date.now() };
      await sendWhatsApp(senderPhone, formatPreview(parsed));
    }

  } catch (err) {
    console.error('Error:', err.message);
    await sendWhatsApp(senderPhone, `⚠️ Something went wrong: ${err.message}`).catch(() => {});
  }
});

// ─── Health check ──────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', assistant: 'Alex', version: '1.0.0' }));

// ─── Reminder cron job (checks every minute) ──────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  for (const reminder of reminders) {
    if (!reminder.sent && reminder.remindAt <= now) {
      reminder.sent = true;
      await sendWhatsApp(OWNER_PHONE, `🔔 *Reminder:* ${reminder.message}`).catch(console.error);
    }
  }
});

// ─── Daily briefing at 8am CST ────────────────────────
cron.schedule('0 8 * * *', async () => {
  const briefingResult = await executeIntent({ intent: 'daily_briefing', data: {} });
  await sendWhatsApp(OWNER_PHONE, briefingResult).catch(console.error);
}, { timezone: 'America/Chicago' });

// ─── Start server ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 Alex — Personal Assistant`);
  console.log(`✅ Running on port ${PORT}`);
  console.log(`📱 Webhook: POST /webhook`);
  console.log(`🕐 ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CST\n`);
});
