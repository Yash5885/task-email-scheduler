const $ = (selector) => document.querySelector(selector);

const roadmap = {
  week1: [
    'Largest element',
    'Second largest',
    'Check if sorted',
    'Remove duplicates',
    'Left rotate by one',
    'Rotate by K',
    'Move zeroes'
  ],
  week2: [
    'Linear search',
    'Missing number',
    'Max consecutive ones',
    'Single number',
    'Two Sum',
    'Union of arrays',
    'Intersection of arrays'
  ],
  week3: [
    'Longest subarray with given sum',
    'Maximum subarray sum',
    "Kadane's algorithm",
    'Best time to buy and sell stock',
    'Sliding window maximum sum of size K',
    'Prefix sum range queries'
  ]
};

let tasks = [];
let status = null;
let apiAvailable = true;

function storageKey(name) {
  return `dsa-reminder:${localDateKey(new Date())}:${name}`;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatClock(isoDate) {
  if (!isoDate) return '--';
  return new Date(isoDate).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDateLine() {
  return new Date().toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Now';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loadInitialData() {
  if (shouldUseHostedMode()) {
    await loadStaticData();
  } else {
    try {
      const [taskPayload, statusPayload] = await Promise.all([
        fetchJson('api/tasks'),
        fetchJson('api/status')
      ]);

      apiAvailable = true;
      tasks = taskPayload.tasks;
      status = statusPayload;
    } catch (error) {
      await loadStaticData();
    }
  }

  renderAll();
  if (!apiAvailable) {
    applyHostedMode();
  }
}

function shouldUseHostedMode() {
  return location.hostname.endsWith('.github.io') || location.protocol === 'file:';
}

async function loadStaticData() {
  apiAvailable = false;
  const taskPayload = await fetchJson('data/tasks.json');
  tasks = (Array.isArray(taskPayload) ? taskPayload : taskPayload.tasks).map(taskWithLabels);
  status = computeStaticStatus();
}

async function refreshStatus() {
  if (apiAvailable) {
    status = await fetchJson('api/status');
  } else {
    status = computeStaticStatus();
  }

  renderCurrent();
  renderTasks();
  renderReminderPill();
}

function parseClock(clock) {
  const [hours, minutes] = String(clock).split(':').map(Number);
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

function taskWithLabels(task) {
  return {
    ...task,
    startLabel: minutesToLabel(parseClock(task.start)),
    endLabel: minutesToLabel(parseClock(task.end)),
    minutesStart: parseClock(task.start),
    minutesEnd: parseClock(task.end)
  };
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

function getOccurrencesAround(now, leadMinutes) {
  const occurrences = [];

  for (const dayOffset of [-1, 0, 1, 2]) {
    const baseDate = new Date(now);
    baseDate.setDate(now.getDate() + dayOffset);

    for (const task of tasks) {
      const start = addMinutesToDateMidnight(baseDate, parseClock(task.start));
      const end = addMinutesToDateMidnight(baseDate, parseClock(task.end));
      if (end <= start) end.setDate(end.getDate() + 1);

      occurrences.push({
        task,
        start,
        end,
        reminderAt: new Date(start.getTime() - leadMinutes * 60 * 1000)
      });
    }
  }

  return occurrences.sort((a, b) => a.start - b.start);
}

function occurrenceToStatus(occurrence, leadMinutes) {
  if (!occurrence) return null;

  return {
    ...occurrence.task,
    startAt: occurrence.start.toISOString(),
    endAt: occurrence.end.toISOString(),
    reminderAt: occurrence.reminderAt.toISOString(),
    occurrenceKey: `${localDateKey(occurrence.start)}:${occurrence.task.id}`,
    startLabel: minutesToLabel(parseClock(occurrence.task.start)),
    endLabel: minutesToLabel(parseClock(occurrence.task.end)),
    minutesStart: parseClock(occurrence.task.start),
    minutesEnd: parseClock(occurrence.task.end),
    leadMinutes
  };
}

function computeStaticStatus() {
  const now = new Date();
  const leadMinutes = 15;
  const occurrences = getOccurrencesAround(now, leadMinutes);
  const current = occurrences.find((item) => now >= item.start && now < item.end) || null;
  const next = occurrences.find((item) => item.start > now) || null;
  const afterNext = occurrences.find((item) => next && item.start > next.start) || null;

  return {
    now: now.toISOString(),
    localDate: localDateKey(now),
    current: occurrenceToStatus(current, leadMinutes),
    next: occurrenceToStatus(next, leadMinutes),
    afterNext: occurrenceToStatus(afterNext, leadMinutes),
    currentProgress: current
      ? Math.max(0, Math.min(100, Math.round(((now - current.start) / (current.end - current.start)) * 100)))
      : 0,
    settings: {
      enabled: false,
      gmailUser: '',
      recipient: '',
      leadMinutes,
      hasAppPassword: false,
      hostedMode: true
    },
    lastCheck: {
      at: now.toISOString(),
      status: 'github-pages',
      sent: 0,
      error: null
    }
  };
}

function renderAll() {
  $('#dateLine').textContent = formatDateLine();
  loadGoals();
  renderCurrent();
  renderTasks();
  renderReminderSettings();
  renderReminderPill();
  renderRoadmap('week1');
}

function renderCurrent() {
  const current = status && status.current;
  const next = status && status.next;

  if (current) {
    $('#currentTime').textContent = `${current.startLabel} - ${current.endLabel}`;
    $('#currentTitle').textContent = current.title;
    $('#currentFocus').textContent = current.focus;
    $('#progressBar').style.width = `${status.currentProgress || 0}%`;
  } else {
    $('#currentTime').textContent = '--';
    $('#currentTitle').textContent = 'No active block';
    $('#currentFocus').textContent = 'The next block will appear here when it starts.';
    $('#progressBar').style.width = '0%';
  }

  if (next) {
    $('#nextTitle').textContent = next.title;
    $('#nextTime').textContent = `${formatClock(next.startAt)} start`;
    $('#countdownValue').textContent = formatCountdown(new Date(next.startAt) - new Date());
  } else {
    $('#nextTitle').textContent = '--';
    $('#nextTime').textContent = '--';
    $('#countdownValue').textContent = '--';
  }
}

function renderTasks() {
  const doneMap = loadDoneMap();
  const list = $('#taskList');
  const currentId = status && status.current && status.current.id;
  const nextId = status && status.next && status.next.id;

  list.innerHTML = tasks
    .map((task) => {
      const done = Boolean(doneMap[task.id]);
      const classes = [
        'task-card',
        currentId === task.id ? 'current' : '',
        nextId === task.id ? 'next' : '',
        done ? 'done' : ''
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <article class="${classes}">
          <div class="task-time">${task.startLabel}<br>${task.endLabel}</div>
          <div>
            <div class="task-title-row">
              <h3>${escapeHtml(task.title)}</h3>
              <span class="chip" data-category="${escapeHtml(task.category)}">${escapeHtml(task.category)}</span>
            </div>
            <p>${escapeHtml(task.focus)}</p>
          </div>
          <label class="task-check">
            <input type="checkbox" data-task-id="${escapeHtml(task.id)}" ${done ? 'checked' : ''}>
            Done
          </label>
        </article>
      `;
    })
    .join('');

  list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const nextDoneMap = loadDoneMap();
      nextDoneMap[checkbox.dataset.taskId] = checkbox.checked;
      saveDoneMap(nextDoneMap);
      renderTasks();
    });
  });

  const doneCount = Object.values(doneMap).filter(Boolean).length;
  $('#completionLine').textContent = `${doneCount} of ${tasks.length} done`;
}

function renderReminderSettings() {
  if (!status) return;
  const settings = status.settings;

  if (settings.hostedMode) {
    $('#enabled').checked = true;
    $('#gmailUser').value = 'Set as GitHub secret: GMAIL_USER';
    $('#recipient').value = 'Set as GitHub secret: REMINDER_TO';
    $('#leadMinutes').value = 15;
    $('#appPassword').placeholder = 'Set as GitHub secret: GMAIL_APP_PASSWORD';
    return;
  }

  $('#enabled').checked = Boolean(settings.enabled);
  $('#gmailUser').value = settings.gmailUser || '';
  $('#recipient').value = settings.recipient || settings.gmailUser || '';
  $('#leadMinutes').value = settings.leadMinutes || 15;
  $('#appPassword').placeholder = settings.hasAppPassword
    ? 'Saved locally; leave blank to keep it'
    : 'Gmail app password';
}

function renderReminderPill() {
  if (!status || !status.settings) return;
  const pill = $('#reminderPill');
  const settings = status.settings;
  pill.classList.remove('ready', 'off');

  if (settings.hostedMode) {
    pill.textContent = 'GitHub Actions reminders';
    pill.classList.add('ready');
    return;
  }

  if (settings.enabled && settings.gmailUser && settings.recipient && settings.hasAppPassword) {
    pill.textContent = `${settings.leadMinutes} min Gmail reminders on`;
    pill.classList.add('ready');
  } else if (settings.enabled) {
    pill.textContent = 'Reminders need Gmail setup';
    pill.classList.add('off');
  } else {
    pill.textContent = 'Gmail reminders off';
    pill.classList.add('off');
  }
}

function applyHostedMode() {
  $('#settingsSaved').textContent = 'GitHub cloud';
  $('#enabled').disabled = true;
  $('#gmailUser').disabled = true;
  $('#recipient').disabled = true;
  $('#appPassword').disabled = true;
  $('#leadMinutes').disabled = true;
  $('#settingsForm button[type="submit"]').disabled = true;
  $('#testEmail').disabled = true;
  $('#checkNow').disabled = true;
  setMessage(
    'Hosted mode: the website is static. Email reminders are sent by GitHub Actions after you add repository secrets.',
    'good'
  );
}

function loadGoals() {
  const saved = JSON.parse(localStorage.getItem(storageKey('goals')) || '{}');
  $('#goalRevise').value = saved.revise || '';
  $('#goalNewOne').value = saved.newOne || '';
  $('#goalNewTwo').value = saved.newTwo || '';
}

function saveGoals() {
  localStorage.setItem(
    storageKey('goals'),
    JSON.stringify({
      revise: $('#goalRevise').value,
      newOne: $('#goalNewOne').value,
      newTwo: $('#goalNewTwo').value
    })
  );
}

function loadDoneMap() {
  return JSON.parse(localStorage.getItem(storageKey('done')) || '{}');
}

function saveDoneMap(doneMap) {
  localStorage.setItem(storageKey('done'), JSON.stringify(doneMap));
}

function renderRoadmap(week) {
  $('#roadmapList').innerHTML = roadmap[week].map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  document.querySelectorAll('.roadmap-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.week === week);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setMessage(message, type) {
  const line = $('#settingsMessage');
  line.textContent = message;
  line.classList.remove('good', 'bad');
  if (type) line.classList.add(type);
}

function bindEvents() {
  ['#goalRevise', '#goalNewOne', '#goalNewTwo'].forEach((selector) => {
    $(selector).addEventListener('input', saveGoals);
  });

  $('#clearGoals').addEventListener('click', () => {
    localStorage.removeItem(storageKey('goals'));
    loadGoals();
  });

  document.querySelectorAll('.roadmap-tab').forEach((button) => {
    button.addEventListener('click', () => renderRoadmap(button.dataset.week));
  });

  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!apiAvailable) {
      setMessage(
        'Hosted mode cannot save Gmail credentials in the browser. Add GMAIL_USER, GMAIL_APP_PASSWORD, and REMINDER_TO as GitHub repository secrets.',
        'bad'
      );
      return;
    }

    setMessage('Saving...', null);

    try {
      await fetchJson('api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          enabled: $('#enabled').checked,
          gmailUser: $('#gmailUser').value,
          recipient: $('#recipient').value,
          appPassword: $('#appPassword').value,
          leadMinutes: $('#leadMinutes').value
        })
      });

      $('#appPassword').value = '';
      await refreshStatus();
      renderReminderSettings();
      setMessage('Saved. The server will check reminders every 30 seconds.', 'good');
    } catch (error) {
      setMessage(friendlyError(error), 'bad');
    }
  });

  $('#testEmail').addEventListener('click', async () => {
    setMessage('Sending test email...', null);
    try {
      await fetchJson('api/test-email', { method: 'POST' });
      setMessage('Test email sent.', 'good');
    } catch (error) {
      setMessage(friendlyError(error), 'bad');
    }
  });

  $('#checkNow').addEventListener('click', async () => {
    setMessage('Checking reminders...', null);
    try {
      const payload = await fetchJson('api/check-now', { method: 'POST' });
      await refreshStatus();
      setMessage(`Reminder check: ${payload.result.status}. Sent ${payload.result.sent}.`, 'good');
    } catch (error) {
      setMessage(friendlyError(error), 'bad');
    }
  });
}

function friendlyError(error) {
  const message = String(error && error.message ? error.message : error);

  if (message.includes('SMTP 535') || message.includes('BadCredentials')) {
    const sender = $('#gmailUser').value || 'the sender Gmail account';
    return `Gmail rejected the login. Generate a fresh 16-character app password from ${sender}, paste it into the password box, click Save, then Send test. Do not use your normal Gmail password.`;
  }

  if (message.includes('smtp.gmail.com') || message.includes('SMTP')) {
    return `Gmail could not send the email: ${message}`;
  }

  return message;
}

bindEvents();
loadInitialData().catch((error) => {
  $('#currentTitle').textContent = 'Could not load site';
  $('#currentFocus').textContent = error.message;
  setMessage(friendlyError(error), 'bad');
});

setInterval(() => {
  if (status) renderCurrent();
}, 1000);

setInterval(() => {
  refreshStatus().catch((error) => setMessage(friendlyError(error), 'bad'));
}, 15000);
