const $ = (selector) => document.querySelector(selector);

let config = null;
let user = null;
let settings = null;
let tasks = [];

function api(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
    return payload;
  });
}

async function init() {
  config = await api('/api/app-config');
  setupAuth();

  try {
    const payload = await api('/api/me');
    if (payload.authenticated === false) {
      setSignedOut();
    } else {
      setSignedIn(payload);
    }
  } catch {
    setSignedOut();
  }
}

function setupAuth() {
  if (config.googleClientId) {
    loadGoogleScript().then(() => {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (response) => {
          try {
            const payload = await api('/api/auth/google', {
              method: 'POST',
              body: JSON.stringify({ credential: response.credential })
            });
            setSignedIn(payload);
          } catch (error) {
            setAuthMessage(error.message, 'bad');
          }
        }
      });
      google.accounts.id.renderButton($('#googleButton'), {
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        width: 280
      });
    });
  } else {
    $('#googleButton').textContent = 'Server needs GOOGLE_CLIENT_ID before Google sign-in works.';
    setAuthMessage('Configure Google OAuth on the server, then reload this page.', 'bad');
  }

  if (config.devLoginEnabled) {
    $('#devLoginForm').classList.remove('hidden');
  }
}

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(script);
  });
}

function setSignedOut() {
  user = null;
  $('#signedOut').classList.remove('hidden');
  $('#signedIn').classList.add('hidden');
  $('#accountArea').innerHTML = '';
}

function setSignedIn(payload) {
  user = payload.user;
  settings = payload.settings;
  tasks = payload.tasks.map(withLabels);
  $('#signedOut').classList.add('hidden');
  $('#signedIn').classList.remove('hidden');
  renderAccount();
  renderSettings();
  renderTasks();
  renderStatus();
}

function renderAccount() {
  $('#accountArea').innerHTML = `
    ${user.picture ? `<img src="${escapeHtml(user.picture)}" alt="">` : ''}
    <span>${escapeHtml(user.email)}</span>
    <button id="logout" class="secondary-button" type="button">Sign out</button>
  `;
  $('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setSignedOut();
  });
}

function renderSettings() {
  $('#enabled').checked = Boolean(settings.enabled);
  $('#leadMinutes').value = settings.leadMinutes || 15;
  $('#timeZone').value =
    settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  renderCompanyEmailStatus();
}

function renderCompanyEmailStatus() {
  const line = $('#companyEmailStatus');
  line.classList.remove('bad', 'good');

  if (config.companySenderConfigured) {
    line.textContent = 'Company sender is configured. Test emails and reminders can be sent.';
    line.classList.add('good');
  } else {
    line.textContent =
      'Company sender is not configured yet, so no emails will be sent from this preview server.';
    line.classList.add('bad');
  }
}

function renderTasks() {
  tasks.sort((a, b) => parseClock(a.start) - parseClock(b.start));
  $('#taskEditor').innerHTML = tasks
    .map(
      (task, index) => `
        <article class="task-row" data-index="${index}">
          <label>
            Start
            <input class="task-start" type="time" value="${escapeHtml(normalTime(task.start))}">
          </label>
          <label>
            End
            <input class="task-end" type="time" value="${escapeHtml(normalTime(task.end))}">
          </label>
          <label>
            Task
            <input class="task-title" type="text" value="${escapeHtml(task.title)}">
          </label>
          <label>
            Category
            <input class="task-category" type="text" value="${escapeHtml(task.category)}">
          </label>
          <button class="delete-task" type="button">Delete</button>
          <label class="wide">
            Reminder note
            <textarea class="task-focus">${escapeHtml(task.focus || '')}</textarea>
          </label>
        </article>
      `
    )
    .join('');

  document.querySelectorAll('.task-row').forEach((row) => {
    row.querySelectorAll('input, textarea').forEach((input) => {
      input.addEventListener('input', () => {
        readTasksFromDom();
        renderStatus();
        markDirty();
      });
    });
    row.querySelector('.delete-task').addEventListener('click', () => {
      tasks.splice(Number(row.dataset.index), 1);
      renderTasks();
      renderStatus();
      markDirty();
    });
  });
}

function readTasksFromDom() {
  tasks = Array.from(document.querySelectorAll('.task-row')).map((row) => {
    const index = Number(row.dataset.index);
    const existing = tasks[index] || {};
    return withLabels({
      id: existing.id || randomId(),
      start: row.querySelector('.task-start').value || '09:00',
      end: row.querySelector('.task-end').value || '10:00',
      title: row.querySelector('.task-title').value || 'Untitled task',
      category: row.querySelector('.task-category').value || 'Task',
      focus: row.querySelector('.task-focus').value || '',
      checklist: existing.checklist || []
    });
  });
}

function renderStatus() {
  if (!tasks.length) {
    $('#currentTitle').textContent = 'No tasks yet';
    $('#currentTime').textContent = '--';
    $('#currentFocus').textContent = 'Add your first task to start receiving reminders.';
    $('#progressBar').style.width = '0%';
    $('#nextTitle').textContent = '--';
    $('#nextTime').textContent = '--';
    $('#countdownValue').textContent = '--';
    return;
  }

  const now = new Date();
  const occurrences = getOccurrencesAround(now);
  const current = occurrences.find((item) => now >= item.start && now < item.end);
  const next = occurrences.find((item) => item.start > now);

  if (current) {
    $('#currentTitle').textContent = current.task.title;
    $('#currentTime').textContent = `${current.task.startLabel} - ${current.task.endLabel}`;
    $('#currentFocus').textContent = current.task.focus || '';
    $('#progressBar').style.width = `${Math.round(((now - current.start) / (current.end - current.start)) * 100)}%`;
  } else {
    $('#currentTitle').textContent = 'No active task';
    $('#currentTime').textContent = '--';
    $('#currentFocus').textContent = 'Your next task is coming up below.';
    $('#progressBar').style.width = '0%';
  }

  if (next) {
    const lead = Number($('#leadMinutes').value || 15);
    const reminderAt = new Date(next.start.getTime() - lead * 60 * 1000);
    $('#nextTitle').textContent = next.task.title;
    $('#nextTime').textContent = `Email at ${formatClock(reminderAt)} for ${formatClock(next.start)} task`;
    $('#countdownValue').textContent = formatCountdown(reminderAt - now);
  }
}

function getOccurrencesAround(now) {
  const occurrences = [];

  for (const offset of [-1, 0, 1, 2]) {
    const base = new Date(now);
    base.setDate(now.getDate() + offset);
    for (const task of tasks) {
      const start = dateAtMinutes(base, parseClock(task.start));
      const end = dateAtMinutes(base, parseClock(task.end));
      if (end <= start) end.setDate(end.getDate() + 1);
      occurrences.push({ task, start, end });
    }
  }

  return occurrences.sort((a, b) => a.start - b.start);
}

function dateAtMinutes(base, minutes) {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
}

function withLabels(task) {
  return {
    ...task,
    startLabel: minutesToLabel(parseClock(task.start)),
    endLabel: minutesToLabel(parseClock(task.end))
  };
}

function parseClock(clock) {
  const [hours, minutes] = String(clock || '0:00').split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToLabel(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function normalTime(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return `${String(Math.min(hour, 23)).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`;
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

function collectSchedule() {
  readTasksFromDom();
  return {
    settings: {
      enabled: $('#enabled').checked,
      leadMinutes: Number($('#leadMinutes').value || 15),
      timeZone: $('#timeZone').value || Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    tasks
  };
}

function markDirty() {
  $('#syncState').textContent = 'Unsaved';
}

function setSyncState(text, type) {
  const line = $('#syncState');
  line.textContent = text;
  line.classList.remove('bad', 'good');
  if (type) line.classList.add(type);
}

function setAuthMessage(text, type) {
  const line = $('#authMessage');
  line.textContent = text;
  line.classList.remove('bad', 'good');
  if (type) line.classList.add(type);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

$('#devLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await api('/api/auth/dev', {
      method: 'POST',
      body: JSON.stringify({ email: $('#devEmail').value })
    });
    setSignedIn(payload);
  } catch (error) {
    setAuthMessage(error.message, 'bad');
  }
});

$('#addTask').addEventListener('click', () => {
  readTasksFromDom();
  tasks.push(
    withLabels({
      id: randomId(),
      start: '09:00',
      end: '10:00',
      title: 'New task',
      category: 'Task',
      focus: 'What should this reminder say?',
      checklist: []
    })
  );
  renderTasks();
  renderStatus();
  markDirty();
});

$('#saveSchedule').addEventListener('click', async () => {
  try {
    setSyncState('Saving...');
    const payload = await api('/api/schedule', {
      method: 'PUT',
      body: JSON.stringify(collectSchedule())
    });
    setSignedIn(payload);
    setSyncState('Synced', 'good');
  } catch (error) {
    setSyncState(error.message, 'bad');
  }
});

$('#sendTestEmail').addEventListener('click', async () => {
  try {
    setSyncState('Sending test...');
    await api('/api/send-test-email', { method: 'POST' });
    setSyncState('Test email sent', 'good');
  } catch (error) {
    setSyncState(error.message, 'bad');
  }
});

['#enabled', '#leadMinutes', '#timeZone'].forEach((selector) => {
  $(selector).addEventListener('input', () => {
    renderStatus();
    markDirty();
  });
});

init().catch((error) => setAuthMessage(error.message, 'bad'));
setInterval(() => {
  if (user) renderStatus();
}, 1000);
