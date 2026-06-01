'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('tls');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'task-scheduler.sqlite');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const PUBLIC_TASKS_PATH = path.join(PUBLIC_DIR, 'data', 'tasks.json');
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const REMINDER_INTERVAL_MS = 60 * 1000;
const DEFAULT_COMPANY_EMAIL = 'yashamantrial@gmail.com';

const smtpSettings = {
  host: process.env.COMPANY_SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.COMPANY_SMTP_PORT || 465),
  user: process.env.COMPANY_SMTP_USER || DEFAULT_COMPANY_EMAIL,
  password: (process.env.COMPANY_SMTP_PASSWORD || '').replace(/\s+/g, ''),
  from: process.env.COMPANY_EMAIL_FROM || process.env.COMPANY_SMTP_USER || DEFAULT_COMPANY_EMAIL
};

let jwksCache = {
  expiresAt: 0,
  keys: []
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
initDb();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(request, response, url);
      if (!handled) sendJson(response, 404, { error: 'Unknown API route' });
      return;
    }

    serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Task email scheduler running at http://localhost:${PORT}/platform.html`);
  checkAllReminders('startup');
  setInterval(() => checkAllReminders('timer'), REMINDER_INTERVAL_MS);
});

function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      picture TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      lead_minutes INTEGER NOT NULL DEFAULT 15,
      time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_tasks (
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      focus TEXT NOT NULL,
      checklist_json TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, task_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sent_reminders (
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      reminder_key TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, task_id, reminder_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/app-config') {
    sendJson(response, 200, {
      googleClientId: GOOGLE_CLIENT_ID,
      devLoginEnabled: process.env.ALLOW_DEV_LOGIN === '1',
      companySenderConfigured: Boolean(smtpSettings.user && smtpSettings.password && smtpSettings.from)
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/email-diagnostics') {
    sendJson(response, 200, {
      configured: isSmtpConfigured(),
      host: smtpSettings.host,
      port: smtpSettings.port,
      user: maskEmail(smtpSettings.user),
      from: maskEmail(smtpSettings.from),
      passwordPresent: Boolean(smtpSettings.password),
      passwordLength: smtpSettings.password.length,
      passwordLooksLikeGmailAppPassword: smtpSettings.password.length === 16
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/google') {
    const body = await readJsonBody(request);
    const profile = await verifyGoogleCredential(body.credential);
    const user = upsertUser(profile);
    seedDefaultScheduleIfNeeded(user.id);
    setSessionCookie(response, user.id);
    sendJson(response, 200, getUserPayload(user.id));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/dev') {
    if (process.env.ALLOW_DEV_LOGIN !== '1') {
      const error = new Error('Developer login is disabled');
      error.statusCode = 403;
      throw error;
    }

    const body = await readJsonBody(request);
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      const error = new Error('Enter a valid email');
      error.statusCode = 400;
      throw error;
    }

    const user = upsertUser({
      sub: `dev:${email}`,
      email,
      name: email.split('@')[0],
      picture: ''
    });
    seedDefaultScheduleIfNeeded(user.id);
    setSessionCookie(response, user.id);
    sendJson(response, 200, getUserPayload(user.id));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const userId = getSessionUserId(request);
    if (!userId) {
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    sendJson(response, 200, { authenticated: true, ...getUserPayload(userId) });
    return true;
  }

  if (request.method === 'PUT' && url.pathname === '/api/schedule') {
    const userId = requireSession(request);
    const body = await readJsonBody(request);
    saveSchedule(userId, body);
    sendJson(response, 200, getUserPayload(userId));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/check-reminders') {
    const result = await checkAllReminders('manual');
    sendJson(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/send-test-email') {
    const userId = requireSession(request);
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
    try {
      ensureSmtpConfigured();
      await sendSmtpMail({
        from: smtpSettings.from,
        to: user.email,
        username: smtpSettings.user,
        password: smtpSettings.password,
        subject: 'Task Email Scheduler test email',
        body: [
          `Hi ${user.name || user.email},`,
          '',
          'This is a test email from Task Email Scheduler.',
          '',
          'Your task reminders will arrive here when a task is about to start.'
        ].join('\n')
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: friendlyEmailError(error) });
    }
    return true;
  }

  return false;
}

function upsertUser(profile) {
  const existing = db.prepare('SELECT * FROM users WHERE google_sub = ? OR email = ?').get(profile.sub, profile.email);
  if (existing) {
    db.prepare(
      'UPDATE users SET google_sub = ?, email = ?, name = ?, picture = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(profile.sub, profile.email, profile.name || '', profile.picture || '', existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(
    'INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)'
  ).run(profile.sub, profile.email, profile.name || '', profile.picture || '');
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function seedDefaultScheduleIfNeeded(userId) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM user_tasks WHERE user_id = ?').get(userId).count;
  if (count > 0) return;

  const tasks = readDefaultTasks();
  const insert = db.prepare(`
    INSERT INTO user_tasks
      (user_id, task_id, title, category, start_time, end_time, focus, checklist_json, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    tasks.forEach((task, index) => {
      insert.run(
        userId,
        task.id,
        task.title,
        task.category,
        task.start,
        task.end,
        task.focus,
        JSON.stringify(task.checklist || []),
        index
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readDefaultTasks() {
  const taskPath = fs.existsSync(TASKS_PATH) ? TASKS_PATH : PUBLIC_TASKS_PATH;
  return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
}

function getUserPayload(userId) {
  const user = db.prepare('SELECT id, email, name, picture FROM users WHERE id = ?').get(userId);
  if (!user) {
    const error = new Error('Session user not found');
    error.statusCode = 401;
    throw error;
  }

  return {
    user,
    settings: getSettings(userId),
    tasks: getTasks(userId)
  };
}

function getSettings(userId) {
  return db.prepare(
    'SELECT enabled, lead_minutes AS leadMinutes, time_zone AS timeZone FROM user_settings WHERE user_id = ?'
  ).get(userId);
}

function getTasks(userId) {
  return db.prepare(
    `SELECT task_id AS id, title, category, start_time AS start, end_time AS end, focus,
            checklist_json AS checklistJson
       FROM user_tasks
      WHERE user_id = ?
      ORDER BY position ASC, start_time ASC`
  )
    .all(userId)
    .map((task) => ({
      ...task,
      checklist: safeJsonArray(task.checklistJson),
      checklistJson: undefined
    }));
}

function saveSchedule(userId, body) {
  const settings = sanitizeSettings(body.settings || {});
  const tasks = sanitizeTasks(body.tasks || []);

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE user_settings
          SET enabled = ?, lead_minutes = ?, time_zone = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?`
    ).run(settings.enabled ? 1 : 0, settings.leadMinutes, settings.timeZone, userId);

    db.prepare('DELETE FROM user_tasks WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO user_tasks
        (user_id, task_id, title, category, start_time, end_time, focus, checklist_json, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    tasks.forEach((task, index) => {
      insert.run(
        userId,
        task.id,
        task.title,
        task.category,
        task.start,
        task.end,
        task.focus,
        JSON.stringify(task.checklist),
        index
      );
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sanitizeSettings(value) {
  return {
    enabled: value.enabled !== false,
    leadMinutes: clamp(Number(value.leadMinutes), 1, 120, 15),
    timeZone: String(value.timeZone || 'Asia/Kolkata').slice(0, 80)
  };
}

function sanitizeTasks(value) {
  if (!Array.isArray(value)) {
    const error = new Error('Tasks must be an array');
    error.statusCode = 400;
    throw error;
  }

  return value.slice(0, 100).map((task) => {
    const id = String(task.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const title = String(task.title || '').trim().slice(0, 160);
    const start = String(task.start || '').trim();
    const end = String(task.end || '').trim();

    if (!title || !isClock(start) || !isClock(end)) {
      const error = new Error('Each task needs a title, start time, and end time');
      error.statusCode = 400;
      throw error;
    }

    return {
      id: id || crypto.randomUUID(),
      title,
      category: String(task.category || 'Task').trim().slice(0, 60),
      start,
      end,
      focus: String(task.focus || '').trim().slice(0, 600),
      checklist: Array.isArray(task.checklist)
        ? task.checklist.map((item) => String(item).trim().slice(0, 140)).filter(Boolean).slice(0, 20)
        : []
    };
  });
}

function isClock(value) {
  if (!/^\d{1,2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) {
    const error = new Error('GOOGLE_CLIENT_ID is not configured on the server');
    error.statusCode = 500;
    throw error;
  }

  const token = String(credential || '');
  const parts = token.split('.');
  if (parts.length !== 3) {
    const error = new Error('Invalid Google credential');
    error.statusCode = 401;
    throw error;
  }

  const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  const signature = base64UrlDecode(parts[2]);
  const key = await getGooglePublicKey(header.kid);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, signature);

  if (!valid || payload.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    const error = new Error('Google sign-in verification failed');
    error.statusCode = 401;
    throw error;
  }

  if (Number(payload.exp || 0) * 1000 < Date.now()) {
    const error = new Error('Google credential expired');
    error.statusCode = 401;
    throw error;
  }

  if (payload.email_verified !== true) {
    const error = new Error('Google email is not verified');
    error.statusCode = 401;
    throw error;
  }

  return {
    sub: String(payload.sub),
    email: String(payload.email || '').toLowerCase(),
    name: String(payload.name || ''),
    picture: String(payload.picture || '')
  };
}

async function getGooglePublicKey(kid) {
  const now = Date.now();
  if (jwksCache.expiresAt < now || !jwksCache.keys.length) {
    const { body, maxAgeSeconds } = await httpsJson('https://www.googleapis.com/oauth2/v3/certs');
    jwksCache = {
      expiresAt: now + Math.max(60, maxAgeSeconds || 3600) * 1000,
      keys: body.keys || []
    };
  }

  const jwk = jwksCache.keys.find((key) => key.kid === kid);
  if (!jwk) {
    const error = new Error('Google signing key not found');
    error.statusCode = 401;
    throw error;
  }

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const cacheControl = String(res.headers['cache-control'] || '');
            const maxAge = Number((cacheControl.match(/max-age=(\d+)/) || [])[1] || 3600);
            resolve({ body: JSON.parse(data), maxAgeSeconds: maxAge });
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function base64UrlDecode(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function requireSession(request) {
  const userId = getSessionUserId(request);
  if (userId) return userId;

  const error = new Error('Sign in required');
  error.statusCode = 401;
  throw error;
}

function getSessionUserId(request) {
  const cookies = parseCookies(request.headers.cookie || '');
  const session = verifySession(cookies.session || '');
  return session ? session.userId : null;
}

function setSessionCookie(response, userId) {
  const payload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  };
  const session = signSession(payload);
  response.setHeader(
    'Set-Cookie',
    `session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function signSession(payload) {
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
}

function verifySession(value) {
  const [encoded, signature] = String(value || '').split('.');
  if (!encoded || !signature || hmac(encoded) !== signature) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encoded).toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

async function checkAllReminders(reason) {
  const users = db
    .prepare(
      `SELECT users.id, users.email, users.name,
              user_settings.enabled, user_settings.lead_minutes AS leadMinutes,
              user_settings.time_zone AS timeZone
         FROM users
         JOIN user_settings ON user_settings.user_id = users.id
        WHERE user_settings.enabled = 1`
    )
    .all();
  let sent = 0;

  if (!isSmtpConfigured()) {
    return { reason, sent, skipped: 'Company SMTP settings are not configured' };
  }

  for (const user of users) {
    const due = remindersDueForUser(user, new Date());
    for (const item of due) {
      if (wasReminderSent(user.id, item.task.id, item.key)) continue;
      await sendTaskEmail(user, item.task, user.leadMinutes);
      markReminderSent(user.id, item.task.id, item.key);
      sent += 1;
    }
  }

  return { reason, sent };
}

function isSmtpConfigured() {
  return Boolean(smtpSettings.user && smtpSettings.password && smtpSettings.from);
}

function maskEmail(email) {
  const value = String(email || '');
  const [name, domain] = value.split('@');
  if (!name || !domain) return value ? 'configured' : '';
  return `${name.slice(0, 2)}***@${domain}`;
}

function ensureSmtpConfigured() {
  if (isSmtpConfigured()) return;
  const error = new Error(
    'Company sender is not configured. Set COMPANY_SMTP_USER, COMPANY_SMTP_PASSWORD, and COMPANY_EMAIL_FROM on the server.'
  );
  error.statusCode = 400;
  throw error;
}

function friendlyEmailError(error) {
  const message = String(error && error.message ? error.message : error);

  if (message.includes('SMTP 535') || message.includes('BadCredentials')) {
    return 'Company Gmail rejected the login. Create a fresh app password for yashamantrial@gmail.com, set it as COMPANY_SMTP_PASSWORD in Render, and redeploy.';
  }

  if (message.includes('Username and Password not accepted')) {
    return 'Company Gmail rejected the SMTP username/password. Make sure COMPANY_SMTP_USER is yashamantrial@gmail.com and COMPANY_SMTP_PASSWORD is a fresh Gmail app password.';
  }

  if (message.includes('Could not connect')) {
    return `${message}. Render may not be able to reach the SMTP host/port, or the SMTP host/port is wrong.`;
  }

  if (message.includes('Company sender is not configured')) {
    return message;
  }

  return `Email send failed: ${message}`;
}

function remindersDueForUser(user, now) {
  const tasks = getTasks(user.id);
  const local = localParts(now, user.timeZone || 'Asia/Kolkata');
  const nowMinutes = Number(local.hour) * 60 + Number(local.minute);

  return tasks
    .map((task) => {
      const reminderMinutes = normalizeMinutes(parseClock(task.start) - user.leadMinutes);
      const diff = normalizeMinutes(nowMinutes - reminderMinutes);
      return {
        task,
        key: `${local.year}-${local.month}-${local.day}:${task.id}:${user.leadMinutes}`,
        due: diff >= 0 && diff < 1
      };
    })
    .filter((item) => item.due);
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function wasReminderSent(userId, taskId, key) {
  return Boolean(
    db.prepare(
      'SELECT 1 FROM sent_reminders WHERE user_id = ? AND task_id = ? AND reminder_key = ?'
    ).get(userId, taskId, key)
  );
}

function markReminderSent(userId, taskId, key) {
  db.prepare(
    'INSERT OR IGNORE INTO sent_reminders (user_id, task_id, reminder_key) VALUES (?, ?, ?)'
  ).run(userId, taskId, key);
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

async function sendTaskEmail(user, task, leadMinutes) {
  const body = [
    `Hi ${user.name || user.email},`,
    '',
    `${task.title} starts in ${leadMinutes} minutes.`,
    '',
    `Time: ${minutesToLabel(parseClock(task.start))} - ${minutesToLabel(parseClock(task.end))}`,
    `Category: ${task.category}`,
    '',
    task.focus,
    '',
    'This reminder was sent by Task Email Scheduler.'
  ].join('\n');

  await sendSmtpMail({
    from: smtpSettings.from,
    to: user.email,
    username: smtpSettings.user,
    password: smtpSettings.password,
    subject: `Reminder: ${task.title} starts in ${leadMinutes} minutes`,
    body
  });
}

function buildRawEmail({ from, to, subject, body }) {
  const headers = [
    `From: Task Email Scheduler <${from}>`,
    `To: ${to}`,
    `Subject: ${subject.replace(/\r?\n/g, ' ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@task-email-scheduler>`,
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

async function sendSmtpMail({ from, to, username, password, subject, body }) {
  const useStartTls = smtpSettings.port === 587;

  // For port 587 (STARTTLS): open a plain TCP connection first, then upgrade.
  // For port 465 (implicit TLS): open a direct TLS connection.
  let socket;

  if (useStartTls) {
    const net = require('net');
    socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host: smtpSettings.host, port: smtpSettings.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Could not connect to ${smtpSettings.host}:${smtpSettings.port}`));
      }, 20000);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } else {
    socket = await new Promise((resolve, reject) => {
      const s = tls.connect({
        host: smtpSettings.host,
        port: smtpSettings.port,
        servername: smtpSettings.host,
        rejectUnauthorized: true
      });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Could not connect to ${smtpSettings.host}:${smtpSettings.port}`));
      }, 20000);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  let reader = createSmtpReader(socket);

  function makeCommand(sock, rdr) {
    return async function command(line, allowedCodes, label) {
      sock.write(`${line}\r\n`);
      const smtpResponse = await rdr.read();
      if (!allowedCodes.includes(smtpResponse.code)) {
        throw new Error(`${label} failed with SMTP ${smtpResponse.code}: ${smtpResponse.text}`);
      }
      return smtpResponse;
    };
  }

  let command = makeCommand(socket, reader);

  try {
    const greeting = await reader.read();
    if (greeting.code !== 220) {
      throw new Error(`Greeting failed with SMTP ${greeting.code}: ${greeting.text}`);
    }

    await command('EHLO task-email-scheduler', [250], 'EHLO');

    if (useStartTls) {
      // Issue STARTTLS to upgrade the plain connection to TLS
      await command('STARTTLS', [220], 'STARTTLS');

      // Upgrade socket to TLS in-place
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({
          socket,
          host: smtpSettings.host,
          servername: smtpSettings.host,
          rejectUnauthorized: true
        });
        upgraded.once('secureConnect', () => resolve(upgraded));
        upgraded.once('error', reject);
      });

      // Re-create reader and command helper on the upgraded TLS socket
      reader = createSmtpReader(socket);
      command = makeCommand(socket, reader);

      // Must re-issue EHLO after STARTTLS upgrade
      await command('EHLO task-email-scheduler', [250], 'EHLO after STARTTLS');
    }

    await command(
      `AUTH PLAIN ${Buffer.from(`\u0000${username}\u0000${password}`).toString('base64')}`,
      [235],
      'AUTH'
    );
    await command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
    await command(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await command('DATA', [354], 'DATA');
    socket.write(`${buildRawEmail({ from, to, subject, body })}\r\n.\r\n`);
    const result = await reader.read();
    if (result.code !== 250) {
      throw new Error(`Send message failed with SMTP ${result.code}: ${result.text}`);
    }
    await command('QUIT', [221], 'QUIT');
  } finally {
    socket.end();
  }
}

function createSmtpReader(socket) {
  let lines = [];
  let partial = '';
  let pending = null;

  socket.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() || '';
    for (const line of parts) if (line) lines.push(line);
    flush();
  });

  socket.on('error', rejectPending);
  socket.on('end', () => rejectPending(new Error('SMTP connection closed')));

  function rejectPending(error) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(error);
  }

  function flush() {
    if (!pending || !lines.length) return;
    const last = lines[lines.length - 1];
    if (!/^\d{3} /.test(last)) return;
    const responseLines = lines;
    lines = [];
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve({ code: Number(last.slice(0, 3)), text: responseLines.join('\n') });
  }

  return {
    read(timeoutMs = 20000) {
      if (pending) return Promise.reject(new Error('SMTP reader already waiting'));
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

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response, url) {
  const pathname = url.pathname === '/' ? '/platform.html' : url.pathname;
  const relativePath = decodeURIComponent(pathname.slice(1));
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
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    }[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  );
}
