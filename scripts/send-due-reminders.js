'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_PATH = path.join(ROOT_DIR, 'data', 'tasks.json');
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const LEAD_MINUTES = numberFromEnv('REMINDER_LEAD_MINUTES', 15);
const UTC_OFFSET_MINUTES = numberFromEnv('REMINDER_UTC_OFFSET_MINUTES', 330);

const settings = {
  gmailUser: process.env.GMAIL_USER || '',
  appPassword: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  recipient: process.env.REMINDER_TO || '',
  leadMinutes: LEAD_MINUTES
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const missing = missingSettings(settings);
  if (missing.length) {
    throw new Error(`Missing GitHub repository secrets: ${missing.join(', ')}`);
  }

  const tasks = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
  const schedule = getGitHubSchedule();
  const dueTasks = schedule ? tasksForSchedule(tasks, schedule) : tasksDueNow(tasks, new Date());

  if (!dueTasks.length) {
    console.log(schedule ? `No task mapped to cron "${schedule}".` : 'No reminders due right now.');
    return;
  }

  for (const task of dueTasks) {
    await sendReminderEmail(settings, task);
    console.log(`Sent reminder for ${task.title}`);
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function missingSettings(value) {
  const missing = [];
  if (!value.gmailUser) missing.push('GMAIL_USER');
  if (!value.appPassword) missing.push('GMAIL_APP_PASSWORD');
  if (!value.recipient) missing.push('REMINDER_TO');
  return missing;
}

function getGitHubSchedule() {
  if (!EVENT_PATH) return '';

  try {
    const event = JSON.parse(fs.readFileSync(EVENT_PATH, 'utf8'));
    return String(event.schedule || '').trim();
  } catch {
    return '';
  }
}

function tasksForSchedule(tasks, schedule) {
  return tasks.filter((task) => cronForTask(task) === schedule);
}

function tasksDueNow(tasks, now) {
  const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowLocalMinutes = normalizeMinutes(nowUtcMinutes + UTC_OFFSET_MINUTES);

  return tasks.filter((task) => {
    const reminderMinutes = normalizeMinutes(parseClock(task.start) - LEAD_MINUTES);
    const diff = normalizeMinutes(nowLocalMinutes - reminderMinutes);
    return diff >= 0 && diff < 5;
  });
}

function cronForTask(task) {
  const reminderLocalMinutes = parseClock(task.start) - LEAD_MINUTES;
  const reminderUtcMinutes = normalizeMinutes(reminderLocalMinutes - UTC_OFFSET_MINUTES);
  const minute = reminderUtcMinutes % 60;
  const hour = Math.floor(reminderUtcMinutes / 60);
  return `${minute} ${hour} * * *`;
}

function parseClock(clock) {
  const [hours, minutes] = String(clock).split(':').map(Number);
  return hours * 60 + minutes;
}

function normalizeMinutes(minutes) {
  return ((minutes % 1440) + 1440) % 1440;
}

function minutesToLabel(minutes) {
  const normalized = normalizeMinutes(minutes);
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function createEmailBody(value, task) {
  const checklist = Array.isArray(task.checklist)
    ? task.checklist.map((item) => `- ${item}`).join('\n')
    : '';

  return [
    `${task.title} starts in ${value.leadMinutes} minutes.`,
    '',
    `Time: ${minutesToLabel(parseClock(task.start))} - ${minutesToLabel(parseClock(task.end))}`,
    `Category: ${task.category}`,
    '',
    task.focus,
    '',
    checklist ? 'Checklist:' : '',
    checklist,
    '',
    'This reminder was sent by your GitHub Actions DSA schedule.'
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRawEmail({ from, to, subject, body }) {
  const headers = [
    `From: DSA Reminder <${from}>`,
    `To: ${to}`,
    `Subject: ${subject.replace(/\r?\n/g, ' ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@dsa-reminder.github-actions>`,
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

async function sendReminderEmail(value, task) {
  await sendGmailSmtp({
    username: value.gmailUser,
    password: value.appPassword,
    to: value.recipient,
    subject: `Reminder: ${task.title} at ${minutesToLabel(parseClock(task.start))}`,
    body: createEmailBody(value, task)
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
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(error);
  });

  socket.on('end', () => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(new Error('SMTP connection closed'));
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

    current.resolve({
      code: Number(last.slice(0, 3)),
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
    await command('EHLO github-actions', [250], 'EHLO');
    await command(`AUTH PLAIN ${Buffer.from(`\u0000${username}\u0000${password}`).toString('base64')}`, [235], 'AUTH');
    await command(`MAIL FROM:<${username}>`, [250], 'MAIL FROM');
    await command(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await command('DATA', [354], 'DATA');
    socket.write(`${buildRawEmail({ from: username, to, subject, body })}\r\n.\r\n`);
    expectSmtp(await reader.read(), [250], 'Send message');
    await command('QUIT', [221], 'QUIT');
  } finally {
    socket.end();
  }
}
