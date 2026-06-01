'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const tls = require('tls');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SENT_PATH = path.join(DATA_DIR, 'sent-reminders.json');
const PORT = Number(process.env.PORT || 3000);

const defaultSettings = {
  enabled: false,
  gmailUser: '',
  recipient: '',
  appPassword: '',
  leadMinutes: 15
};

let lastCheck = {
  at: null,
  status: 'waiting',
  sent: 0,
  error: null
};
let reminderCheckInFlight = false;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read ${filePath}: ${error.message}`);
    }
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getTasks() {
  return readJson(TASKS_PATH, []);
}

function loadSettings() {
  const settings = { ...defaultSettings, ...readJson(SETTINGS_PATH, {}) };
  settings.leadMinutes = clampNumber(settings.leadMinutes, 1, 120, 15);
  settings.enabled = Boolean(settings.enabled);
  return settings;
}

function saveSettings(nextSettings) {
  const previous = loadSettings();
  const settings = {
    enabled: Boolean(nextSettings.enabled),
    gmailUser: String(nextSettings.gmailUser || '').trim(),
    recipient: String(nextSettings.recipient || '').trim(),
    appPassword:
      typeof nextSettings.appPassword === 'string' && nextSettings.appPassword.length > 0
        ? nextSettings.appPassword.replace(/\s+/g, '')
        : previous.appPassword,
    leadMinutes: clampNumber(nextSettings.leadMinutes, 1, 120, 15)
  };

  writeJson(SETTINGS_PATH, settings);
  return settings;
}

function publicSettings(settings = loadSettings()) {
  return {
    enabled: settings.enabled,
    gmailUser: settings.gmailUser,
    recipient: settings.recipient,
    leadMinutes: settings.leadMinutes,
    hasAppPassword: Boolean(settings.appPassword)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function parseClock(clock) {
  const [hours, minutes] = String(clock).split(':').map(Number);
  return hours * 60 + minutes;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addMinutesToDateMidnight(baseDate, minutes) {
  const date = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    0,
    0,
    0,
    0
  );
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

function minutesToLabel(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${pad2(minute)} ${suffix}`;
}

function taskWithLabels(task) {
  return {
    ...task,
    startLabel: minutesToLabel(parseClock(task.start)),
    endLabel: minutesToLabel(parseClock(task.end)),
    minutesStart: parseClock(task.start),
    minutesEnd: parseClock(task.end)
  };
}

function occurrenceToJson(occurrence) {
  if (!occurrence) return null;
  return {
    ...taskWithLabels(occurrence.task),
    occurrenceKey: occurrence.key,
    startAt: occurrence.start.toISOString(),
    endAt: occurrence.end.toISOString(),
    reminderAt: occurrence.reminderAt ? occurrence.reminderAt.toISOString() : null
  };
}

function getOccurrencesAround(now, leadMinutes = 15) {
  const tasks = getTasks();
  const occurrences = [];

  for (const dayOffset of [-1, 0, 1, 2]) {
    const baseDate = new Date(now);
    baseDate.setDate(now.getDate() + dayOffset);

    for (const task of tasks) {
      const startMinutes = parseClock(task.start);
      const endMinutes = parseClock(task.end);
      const start = addMinutesToDateMidnight(baseDate, startMinutes);
      const end = addMinutesToDateMidnight(baseDate, endMinutes);

      if (end <= start) {
        end.setDate(end.getDate() + 1);
      }

      const reminderAt = new Date(start.getTime() - leadMinutes * 60 * 1000);

      occurrences.push({
        task,
        start,
        end,
        reminderAt,
        key: `${dateKey(start)}:${task.id}`
      });
    }
  }

  return occurrences.sort((a, b) => a.start - b.start);
}

function getScheduleStatus(now = new Date()) {
  const settings = loadSettings();
  const occurrences = getOccurrencesAround(now, settings.leadMinutes);
  const current = occurrences.find((item) => now >= item.start && now < item.end) || null;
  const next = occurrences.find((item) => item.start > now) || null;
  const afterNext = occurrences.find((item) => next && item.start > next.start) || null;
  const currentProgress = current
    ? Math.round(((now - current.start) / (current.end - current.start)) * 100)
    : 0;

  return {
    now: now.toISOString(),
    localDate: dateKey(now),
    current: occurrenceToJson(current),
    next: occurrenceToJson(next),
    afterNext: occurrenceToJson(afterNext),
    currentProgress: Math.max(0, Math.min(100, currentProgress)),
    settings: publicSettings(settings),
    lastCheck
  };
}

function loadSentReminders() {
  const sent = readJson(SENT_PATH, {});
  return sent && typeof sent === 'object' ? sent : {};
}

function saveSentReminders(sent) {
  writeJson(SENT_PATH, sent);
}

function cleanupSentReminders(sent, now = new Date()) {
  const cutoff = now.getTime() - 4 * 24 * 60 * 60 * 1000;

  for (const [key, value] of Object.entries(sent)) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time < cutoff) {
      delete sent[key];
    }
  }
}

function missingEmailSettings(settings) {
  const missing = [];
  if (!settings.gmailUser) missing.push('sender Gmail');
  if (!settings.recipient) missing.push('recipient Gmail');
  if (!settings.appPassword) missing.push('Gmail app password');
  return missing;
}

async function checkReminders(reason = 'tick') {
  if (reminderCheckInFlight) {
    return {
      ...lastCheck,
      status: 'already-checking'
    };
  }

  reminderCheckInFlight = true;
  const settings = loadSettings();
  const now = new Date();
  lastCheck = {
    at: now.toISOString(),
    status: 'checking',
    sent: 0,
    error: null
  };
  let sentReminders = null;

  try {
    if (!settings.enabled) {
      lastCheck.status = 'disabled';
      return lastCheck;
    }

    const missing = missingEmailSettings(settings);
    if (missing.length) {
      lastCheck.status = 'not-configured';
      lastCheck.error = `Missing ${missing.join(', ')}`;
      return lastCheck;
    }

    sentReminders = loadSentReminders();
    cleanupSentReminders(sentReminders, now);

    const due = getOccurrencesAround(now, settings.leadMinutes).filter((occurrence) => {
      const reminderKey = `${occurrence.key}:lead-${settings.leadMinutes}`;
      return now >= occurrence.reminderAt && now < occurrence.start && !sentReminders[reminderKey];
    });

    for (const occurrence of due) {
      const reminderKey = `${occurrence.key}:lead-${settings.leadMinutes}`;
      await sendReminderEmail(settings, occurrence, reason);
      sentReminders[reminderKey] = new Date().toISOString();
      lastCheck.sent += 1;
    }

    saveSentReminders(sentReminders);
    lastCheck.status = due.length ? 'sent' : 'no-due-reminders';
    return lastCheck;
  } catch (error) {
    lastCheck.status = 'error';
    lastCheck.error = error.message;
    if (sentReminders) saveSentReminders(sentReminders);
    console.error(error);
    return lastCheck;
  } finally {
    reminderCheckInFlight = false;
  }
}

function createEmailBody(settings, occurrence) {
  const task = occurrence.task;
  const checklist = Array.isArray(task.checklist)
    ? task.checklist.map((item) => `- ${item}`).join('\n')
    : '';

  return [
    `${task.title} starts in ${settings.leadMinutes} minutes.`,
    '',
    `Time: ${minutesToLabel(parseClock(task.start))} - ${minutesToLabel(parseClock(task.end))}`,
    `Category: ${task.category}`,
    '',
    task.focus,
    '',
    checklist ? 'Checklist:' : '',
    checklist,
    '',
    'You asked for this reminder from your local DSA schedule site.'
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRawEmail({ from, to, subject, body }) {
  const messageId = `${crypto.randomUUID()}@dsa-reminder.local`;
  const headers = [
    `From: DSA Reminder <${from}>`,
    `To: ${to}`,
    `Subject: ${subject.replace(/\r?\n/g, ' ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ];

  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(body)}`;
}

function dotStuff(body) {
  return String(body)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

async function sendReminderEmail(settings, occurrence, reason = 'schedule') {
  const subject = `Reminder: ${occurrence.task.title} at ${minutesToLabel(parseClock(occurrence.task.start))}`;
  const body = createEmailBody(settings, occurrence);

  await sendGmailSmtp({
    username: settings.gmailUser,
    password: settings.appPassword,
    to: settings.recipient,
    subject,
    body
  });

  console.log(`[${new Date().toISOString()}] Sent ${reason} reminder for ${occurrence.task.title}`);
}

async function sendTestEmail() {
  const settings = loadSettings();
  const missing = missingEmailSettings(settings);
  if (missing.length) {
    const error = new Error(`Missing ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  await sendGmailSmtp({
    username: settings.gmailUser,
    password: settings.appPassword,
    to: settings.recipient,
    subject: 'DSA reminder test email',
    body: [
      'Your DSA reminder site can send Gmail messages.',
      '',
      `Reminder lead time: ${settings.leadMinutes} minutes`,
      `Sent at: ${new Date().toLocaleString()}`
    ].join('\n')
  });
}

function createSmtpReader(socket) {
  let lines = [];
  let partial = '';
  let pending = null;

  socket.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() || '';
    for (const line of parts) {
      if (line) lines.push(line);
    }
    flush();
  });

  socket.on('error', (error) => {
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(error);
    }
  });

  socket.on('end', () => {
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(new Error('SMTP connection closed'));
    }
  });

  function flush() {
    if (!pending || !lines.length) return;
    const last = lines[lines.length - 1];
    if (!/^\d{3} /.test(last)) return;

    const responseLines = lines;
    lines = [];
    const current = pending;
    pending = null;
    clearTimeout(current.timer);

    const code = Number(last.slice(0, 3));
    current.resolve({
      code,
      text: responseLines.join('\n')
    });
  }

  return {
    read(timeoutMs = 20000) {
      if (pending) {
        return Promise.reject(new Error('SMTP reader already waiting'));
      }

      return new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending = null;
            reject(new Error('SMTP response timed out'));
          }, timeoutMs)
        };
        flush();
      });
    }
  };
}

function expectSmtp(response, allowedCodes, label) {
  if (!allowedCodes.includes(response.code)) {
    throw new Error(`${label} failed with SMTP ${response.code}: ${response.text}`);
  }
}

async function sendGmailSmtp({ username, password, to, subject, body }) {
  const socket = tls.connect({
    host: 'smtp.gmail.com',
    port: 465,
    servername: 'smtp.gmail.com',
    rejectUnauthorized: true
  });

  const reader = createSmtpReader(socket);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Could not connect to smtp.gmail.com:465'));
      socket.destroy();
    }, 20000);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', reject);
  });

  async function command(line, allowedCodes, label) {
    socket.write(`${line}\r\n`);
    const response = await reader.read();
    expectSmtp(response, allowedCodes, label);
    return response;
  }

  try {
    expectSmtp(await reader.read(), [220], 'Greeting');
    await command('EHLO localhost', [250], 'EHLO');
    await command(`AUTH PLAIN ${Buffer.from(`\u0000${username}\u0000${password}`).toString('base64')}`, [235], 'AUTH');
    await command(`MAIL FROM:<${username}>`, [250], 'MAIL FROM');
    await command(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await command('DATA', [354], 'DATA');

    const rawEmail = buildRawEmail({
      from: username,
      to,
      subject,
      body
    });

    socket.write(`${rawEmail}\r\n.\r\n`);
    expectSmtp(await reader.read(), [250], 'Send message');
    await command('QUIT', [221], 'QUIT');
  } finally {
    socket.end();
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    sendJson(response, 200, {
      tasks: getTasks().map(taskWithLabels)
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, getScheduleStatus());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readRequestBody(request);
    const settings = saveSettings(JSON.parse(body || '{}'));
    sendJson(response, 200, {
      ok: true,
      settings: publicSettings(settings)
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/test-email') {
    await sendTestEmail();
    sendJson(response, 200, {
      ok: true,
      message: 'Test email sent'
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/check-now') {
    const result = await checkReminders('manual');
    sendJson(response, 200, {
      ok: true,
      result
    });
    return true;
  }

  return false;
}

function serveStatic(request, response, url) {
  const relativePath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  const relativeToPublic = path.relative(PUBLIC_DIR, filePath);

  if (relativeToPublic.startsWith('..') || path.isAbsolute(relativeToPublic)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': 'no-store'
    });
    response.end(data);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream'
  );
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(request, response, url);
      if (!handled) {
        sendJson(response, 404, { error: 'Unknown API route' });
      }
      return;
    }

    serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      error: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`DSA reminder site running at http://localhost:${PORT}`);
  checkReminders('startup');
  setInterval(() => {
    checkReminders('tick');
  }, 30 * 1000);
});
