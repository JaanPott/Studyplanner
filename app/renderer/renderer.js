/* ---------- State & helpers ---------- */
// drafts: half-typed new tasks per test id, so re-renders don't wipe them
// editing: { kind, id, fields } for the test/task open in an edit form (fields = current form values)
// dismissed: calendar keys of imported tests the user deleted, so a sync doesn't bring them back
// events: calendar occurrences from the last sync; month: first day of the month on screen
const state = {
  tests: [], plan: [], dismissed: [], selectedId: null, drafts: {}, editing: null, savedAt: 0,
  events: [], month: null,
};
let settings = { icalUrl: '', keyword: 'test' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysUntil = s => Math.round((parse(s) - today0()) / 864e5);
// Undated items (tasks can have no date) sort last
const dateKey = s => s ? parse(s).getTime() : Infinity;
const byDate = (a, b) => { const x = dateKey(a.date), y = dateKey(b.date); return x === y ? 0 : x - y; };
const bool = v => v === true || String(v).toUpperCase() === 'TRUE';
const fmt = s => s ? parse(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
const clock = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const rel = s => {
  const n = daysUntil(s);
  if (isNaN(n)) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
};
state.month = (d => new Date(d.getFullYear(), d.getMonth(), 1))(new Date());

function setStatus(text, error = false) {
  const el = $('#status'); el.textContent = text; el.classList.toggle('error', error);
}
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* ---------- Data ----------
   Kept in planner.json in the app-data folder (see main.js); every change is saved straight away. */
const normTest = t => ({ ...t, id: String(t.id), done: bool(t.done) });
const normPlan = p => ({ ...p, id: String(p.id), testId: String(p.testId), done: bool(p.done) });
const snapshot = () => ({ savedAt: state.savedAt, tests: state.tests, plan: state.plan, dismissed: state.dismissed });

function load(data) {
  data = data || {};
  state.tests = (data.tests || []).map(normTest);
  state.plan = (data.plan || []).map(normPlan);
  state.dismissed = data.dismissed || [];
  state.savedAt = data.savedAt || 0;
  selectNext();
  render();
}

function selectNext() {
  if (state.tests.some(t => t.id === state.selectedId)) return;
  const next = state.tests.filter(t => !t.done).sort(byDate)[0] || state.tests[0];
  state.selectedId = next ? next.id : null;
}

function persist() {
  state.savedAt = Date.now();
  window.api.saveData(snapshot()).catch(e => {
    setStatus('Could not save', true);
    toast('Could not save your changes: ' + e.message);
  });
}

const findItem = (kind, id) => (kind === 'test' ? state.tests : state.plan).find(x => x.id === id);
const EDIT_FIELDS = { test: ['name', 'subject', 'date', 'description'], plan: ['date', 'task'] };

function valid(kind, fields) {
  if (kind === 'test' ? fields.name && fields.date : fields.task) return true;
  toast(kind === 'test' ? 'A test needs a name and a date' : 'A task needs a description');
  return false;
}

function toggle(kind, id, done) {
  const item = findItem(kind, id);
  if (!item) return;
  item.done = done;
  persist();
  render();
}

function nextId(list, prefix) {
  const nums = list.map(x => Number((x.id.match(/^\D*(\d+)$/) || [])[1]) || 0);
  return prefix + (Math.max(0, ...nums) + 1);
}

function add(kind, fields, form) {
  if (!valid(kind, fields)) return false;
  if (kind === 'test') {
    const t = { ...fields, id: nextId(state.tests, 'T'), done: false };
    state.tests.push(t);
    state.selectedId = t.id;
    form.reset();
  } else {
    state.plan.push({ ...fields, id: nextId(state.plan, 'P'), done: false });
    delete state.drafts[fields.testId];
  }
  persist();
  render();
  toast(kind === 'test' ? 'Test added' : 'Task added');
  return true;
}

function removeItem(kind, id) {
  if (kind === 'test') {
    const t = state.tests.find(x => x.id === id);
    if (!t || !confirm(`Delete "${t.name}" and its study plan?`)) return;
    state.tests = state.tests.filter(x => x.id !== id);
    state.plan = state.plan.filter(p => p.testId !== id);
    if (t.cal) state.dismissed.push(t.cal.key);
    if (state.selectedId === id) state.selectedId = null;
  } else {
    state.plan = state.plan.filter(p => p.id !== id);
  }
  if (state.editing && !findItem(state.editing.kind, state.editing.id)) state.editing = null;
  persist();
  render();
}

function startEdit(kind, id) {
  const item = findItem(kind, id);
  if (!item) return;
  state.editing = { kind, id, fields: Object.fromEntries(EDIT_FIELDS[kind].map(k => [k, item[k] ?? ''])) };
  if (kind === 'test') state.selectedId = id;
  render();
  const form = $(`.edit-form[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  if (form) form.querySelector('input:not([type=date])').focus();
}

function saveEdit(kind, id, fields) {
  const item = findItem(kind, id);
  if (!item || !valid(kind, fields)) return;
  Object.assign(item, fields);
  state.editing = null;
  persist();
  render();
  toast(kind === 'test' ? 'Test updated' : 'Task updated');
}

function cancelEdit() {
  state.editing = null;
  render();
}

/* ---------- Calendar sync ----------
   Downloads the user's iCal feed (via main.js), keeps its events for the month view and turns
   events whose description contains a test keyword into tests. */
const SYNC_EVERY = 30 * 60e3;
const IMPORT_DAYS_BACK = 7; // older tests aren't imported, so a first sync doesn't fill the list with past ones

// Keywords match anywhere inside a word, because Estonian inflects and compounds them:
// "test" has to find "testiks" as well as "lõputest"
function keywordMatcher(text) {
  const words = String(text || '').split(',').map(w => w.trim()).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'iu');
  return s => re.test(s || '');
}

// t.cal holds the calendar's values as of the last sync. A field is only overwritten when the
// calendar changed it since then, so edits made in the planner survive later syncs.
function importTests() {
  const isTest = keywordMatcher(settings.keyword);
  let added = 0, updated = 0;
  if (!isTest) return { added, updated };
  const since = addDays(today0(), -IMPORT_DAYS_BACK);
  for (const ev of state.events) {
    if (ev.start < since || !isTest(ev.description) || state.dismissed.includes(ev.key)) continue;
    const fromCal = { name: ev.title || 'Untitled test', date: iso(ev.start), description: ev.description };
    const t = state.tests.find(x => x.cal && x.cal.key === ev.key);
    if (!t) {
      state.tests.push({ id: nextId(state.tests, 'T'), subject: '', done: false, ...fromCal, cal: { key: ev.key, ...fromCal } });
      added++;
      continue;
    }
    const changed = Object.keys(fromCal).filter(k => t.cal[k] !== fromCal[k]);
    changed.forEach(k => { t[k] = t.cal[k] = fromCal[k]; });
    if (changed.length) updated++;
  }
  return { added, updated };
}

let syncing = false;
async function sync() {
  if (syncing || !settings.icalUrl) return;
  syncing = true;
  $('#sync').disabled = true;
  setStatus('Syncing…');
  try {
    const res = await window.api.fetchCalendar(settings.icalUrl);
    if (!res.text) {
      setStatus('Calendar sync failed', true);
      toast(res.error);
      return;
    }
    const t0 = today0();
    state.events = ICal.expand(ICal.parse(res.text), addDays(t0, -90), addDays(t0, 400));
    const { added, updated } = importTests();
    if (added || updated) {
      persist();
      selectNext();
      const n = added || updated, s = n === 1 ? '' : 's';
      toast(added ? `Added ${n} test${s} from your calendar` : `Updated ${n} test${s} from your calendar`);
    }
    const at = new Date(res.fetchedAt);
    if (res.error) {
      setStatus(`Offline · calendar from ${iso(at) === iso(new Date()) ? clock(at) : fmt(iso(at))}`, true);
      toast(res.error);
    } else {
      setStatus(`Synced ${clock(at)}`);
    }
    render();
  } catch (e) {
    setStatus('Calendar sync failed', true);
    toast(e.message);
  } finally {
    syncing = false;
    $('#sync').disabled = false;
  }
}

/* ---------- Settings ---------- */
function applySettings() {
  const connected = !!settings.icalUrl;
  $('#sync').hidden = !connected;
  $('#calBanner').hidden = connected;
  if (!connected) {
    state.events = [];
    setStatus('No calendar connected');
  }
}

function openSettings() {
  const f = $('#settingsForm');
  f.icalUrl.value = settings.icalUrl;
  f.keyword.value = settings.keyword;
  $('#settings').showModal();
}

$('#settingsForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value === 'cancel') return; // the dialog closes itself
  settings = { icalUrl: e.target.icalUrl.value.trim(), keyword: e.target.keyword.value.trim() };
  try {
    await window.api.saveSettings(settings);
  } catch (err) {
    toast('Could not save settings: ' + err.message);
  }
  applySettings();
  render();
  sync();
});

/* ---------- Rendering ---------- */
const testOrder = (a, b) => (a.done - b.done) || byDate(a, b);

function renderCalendar() {
  const first = state.month;
  $('#calTitle').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const start = addDays(first, -((first.getDay() + 6) % 7)); // back to Monday
  const todayKey = iso(new Date());

  // Imported tests show as test chips, so leave out the calendar event they came from
  const imported = new Set(state.tests.filter(t => t.cal).map(t => t.cal.key));
  const items = {};
  const put = (d, item) => (items[iso(d)] ||= []).push(item);
  [...state.tests].sort(testOrder).forEach(t => put(parse(t.date), { test: t }));
  for (const ev of state.events) {
    if (imported.has(ev.key)) continue;
    if (!ev.allDay) { put(ev.start, { ev }); continue; }
    let d = new Date(ev.start);
    do { put(d, { ev }); d = addDays(d, 1); } while (d < ev.end);
  }

  const label = it => it.test ? `Test: ${it.test.name}`
    : it.ev.allDay ? it.ev.title : `${clock(it.ev.start)} ${it.ev.title}`;
  const chip = it => it.test
    ? `<button class="chip test${it.test.done ? ' done' : ''}" data-id="${esc(it.test.id)}" title="${esc(label(it))}">${esc(it.test.name)}</button>`
    : `<span class="chip${it.ev.allDay ? ' allday' : ''}" title="${esc(label(it))}">${esc(label(it))}</span>`;
  const cap = $('.dash').classList.contains('big-cal') ? 5 : 2;

  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<div class="wd">${w}</div>`);
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i), key = iso(d);
    const list = items[key] || [];
    const shown = list.length > cap ? list.slice(0, cap - 1) : list;
    const rest = list.slice(shown.length);
    const cls = ['day', d.getMonth() !== first.getMonth() && 'other', key === todayKey && 'today'].filter(Boolean).join(' ');
    return `<div class="${cls}"><span class="dnum">${d.getDate()}</span>${shown.map(chip).join('')}${rest.length
      ? `<span class="chip more" title="${esc(rest.map(label).join('\n'))}">+${rest.length} more</span>` : ''}</div>`;
  });
  $('#calGrid').innerHTML = weekdays.join('') + days.join('');
}

function renderTests() {
  const list = [...state.tests].sort(testOrder);
  $('#testCount').textContent = `${list.filter(t => !t.done).length} remaining`;
  $('#tests').innerHTML = list.map(t => {
    const n = daysUntil(t.date);
    const cls = [t.done && 'done', t.id === state.selectedId && 'active', n < 0 && 'past'].filter(Boolean).join(' ');
    return `<li class="${cls}">
      <input type="checkbox" data-kind="test" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''} aria-label="Mark ${esc(t.name)} done">
      <button class="test-link" data-id="${esc(t.id)}">
        <span><span class="name">${esc(t.name)}</span><span class="sub">${esc(t.subject)}</span></span>
        <span class="due ${!t.done && n >= 0 && n <= 3 ? 'soon' : ''}">${fmt(t.date)}<br><small>${rel(t.date)}</small></span>
      </button>
    </li>`;
  }).join('') || '<li class="muted">No tests yet — add one below.</li>';
}

function renderPie() {
  const total = state.tests.length;
  const done = state.tests.filter(t => t.done).length;
  const pct = total ? done / total : 0;
  $('#pie').style.setProperty('--deg', `${pct * 360}deg`);
  $('#pieLabel').textContent = `${Math.round(pct * 100)}%`;
  $('#pieLegend').innerHTML =
    `<li><i class="sw done"></i>Done <b>${done}</b></li>
     <li><i class="sw todo"></i>Remaining <b>${total - done}</b></li>`;
  const list = [...state.tests].sort((a, b) => byDate(b, a));
  $('#pieTests').hidden = !list.length;
  $('#pieTests').innerHTML = list.map(t => `
    <li class="${t.done ? 'done' : ''}">
      <i class="sw ${t.done ? 'done' : 'todo'}"></i>
      <span class="name">${esc(t.name)}</span>
      <span class="muted">${fmt(t.date)}</span>
    </li>`).join('');
}

function renderDetails() {
  $('#details').innerHTML = [...state.tests].sort(testOrder).map(testCard).join('')
    || '<section class="card"><p class="placeholder">No tests yet — add one above.</p></section>';
}

function testCard(t) {
  const items = state.plan.filter(p => p.testId === t.id).sort(byDate);
  const doneN = items.filter(p => p.done).length;
  const pct = items.length ? Math.round(doneN / items.length * 100) : 0;
  const draft = state.drafts[t.id] || {};
  const cls = ['card test-card', t.done && 'done', t.id === state.selectedId && 'active'].filter(Boolean).join(' ');
  return `<section class="${cls}" data-test-id="${esc(t.id)}">
    ${editFields('test', t.id) ? testEditForm(t) : `
    <div class="detail-head">
      <h2>${esc(t.name)}</h2>
      <div class="head-end">
        <span class="muted">${t.subject ? esc(t.subject) + ' · ' : ''}${fmt(t.date)} · ${t.done ? 'done' : rel(t.date)}</span>
        <button class="edit" data-start-edit="test" data-id="${esc(t.id)}" title="Edit test" aria-label="Edit ${esc(t.name)}">✎</button>
        <button class="del" data-del="test" data-id="${esc(t.id)}" title="Delete test" aria-label="Delete ${esc(t.name)}">×</button>
      </div>
    </div>
    <p class="desc">${esc(t.description) || '<span class="muted">No description.</span>'}</p>`}
    <h3>Study plan</h3>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <p class="muted">${doneN} / ${items.length} tasks done</p>
    <ul class="plan">${items.map(planItem).join('')
      || '<li class="muted">No tasks yet — add one below.</li>'}
    </ul>
    <form class="add-form plan-form" data-test-id="${esc(t.id)}">
      <input name="date" type="date" aria-label="Task date (optional)" title="Date (optional)" value="${esc(draft.date)}">
      <input name="task" placeholder="New study task" required aria-label="Task for ${esc(t.name)}" value="${esc(draft.task)}">
      <button type="submit" class="primary">Add task</button>
    </form>
  </section>`;
}

// Form values for the item if it's the one being edited, else null
const editFields = (kind, id) =>
  state.editing && state.editing.kind === kind && state.editing.id === id ? state.editing.fields : null;

const editActions = `<div class="form-actions">
    <button type="button" class="ghost" data-cancel-edit>Cancel</button>
    <button type="submit" class="primary">Save</button>
  </div>`;

function testEditForm(t) {
  const f = editFields('test', t.id);
  return `<form class="add-form edit-form" data-kind="test" data-id="${esc(t.id)}">
    <input name="name" placeholder="Test name" required aria-label="Test name" value="${esc(f.name)}">
    <input name="subject" placeholder="Subject" aria-label="Subject" value="${esc(f.subject)}">
    <input name="date" type="date" required aria-label="Test date" value="${esc(f.date)}">
    <textarea name="description" rows="3" placeholder="Description (optional)" aria-label="Description">${esc(f.description)}</textarea>
    ${editActions}
  </form>`;
}

function planItem(p) {
  const f = editFields('plan', p.id);
  if (f) return `
      <li><form class="add-form plan-form edit-form" data-kind="plan" data-id="${esc(p.id)}">
        <input name="date" type="date" aria-label="Task date (optional)" title="Date (optional)" value="${esc(f.date)}">
        <input name="task" placeholder="Study task" required aria-label="Task" value="${esc(f.task)}">
        ${editActions}
      </form></li>`;
  return `
      <li class="${p.done ? 'done' : ''}"><label>
        <input type="checkbox" data-kind="plan" data-id="${esc(p.id)}" ${p.done ? 'checked' : ''}>
        <span class="pdate">${fmt(p.date)}</span><span class="name">${esc(p.task)}</span>
      </label><button class="edit" data-start-edit="plan" data-id="${esc(p.id)}" title="Edit task" aria-label="Edit task">✎</button><button class="del" data-del="plan" data-id="${esc(p.id)}" title="Delete task" aria-label="Delete task">×</button></li>`;
}

function render() { renderCalendar(); renderTests(); renderPie(); renderDetails(); }

/* ---------- Events ---------- */
const formFields = form => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v.trim()]));

document.addEventListener('change', e => {
  const cb = e.target.closest('input[data-kind]');
  if (cb) toggle(cb.dataset.kind, cb.dataset.id, cb.checked);
});
document.addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) return removeItem(del.dataset.del, del.dataset.id);
  const edit = e.target.closest('[data-start-edit]');
  if (edit) return startEdit(edit.dataset.startEdit, edit.dataset.id);
  if (e.target.closest('[data-cancel-edit]')) return cancelEdit();
  if (e.target.closest('[data-open-settings]')) return openSettings();
  const nav = e.target.closest('[data-month]');
  if (nav) {
    const n = Number(nav.dataset.month), now = new Date();
    state.month = n ? new Date(state.month.getFullYear(), state.month.getMonth() + n, 1)
                    : new Date(now.getFullYear(), now.getMonth(), 1);
    return renderCalendar();
  }
  const btn = e.target.closest('.test-link, .chip.test');
  if (!btn) return;
  state.selectedId = btn.dataset.id;
  render();
  $(`.test-card[data-test-id="${CSS.escape(btn.dataset.id)}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.addEventListener('input', e => {
  if (e.target.closest('.edit-form')) {
    state.editing.fields[e.target.name] = e.target.value;
    return;
  }
  const form = e.target.closest('.plan-form');
  if (form) (state.drafts[form.dataset.testId] ||= {})[e.target.name] = e.target.value;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.closest('.edit-form')) cancelEdit();
});
document.addEventListener('submit', e => {
  const edit = e.target.closest('.edit-form');
  if (edit) {
    e.preventDefault();
    return saveEdit(edit.dataset.kind, edit.dataset.id, formFields(edit));
  }
  const form = e.target.closest('.plan-form');
  if (!form) return;
  e.preventDefault();
  add('plan', { ...formFields(form), testId: form.dataset.testId }, form);
});
$('#sync').addEventListener('click', sync);
$('#openSettings').addEventListener('click', openSettings);

/* ---------- Theme ---------- */
const svg = body => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const THEME_ICONS = {  // icon shows the mode a click switches to
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
};
function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  const next = theme === 'dark' ? 'light' : 'dark';
  $('#theme').innerHTML = THEME_ICONS[next];
  $('#theme').setAttribute('aria-label', `Switch to ${next} mode`);
  $('#theme').title = `Switch to ${next} mode`;
  if (save) try { localStorage.setItem('theme', theme); } catch (e) {}
}
setTheme(document.documentElement.dataset.theme);
$('#theme').addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

/* ---------- Calendar size ---------- */
function setBigCal(big, save) {
  $('.dash').classList.toggle('big-cal', big);
  $('#calSize').textContent = big ? 'Smaller calendar' : 'Bigger calendar';
  $('#calSize').setAttribute('aria-pressed', big);
  if (save) try { localStorage.setItem('bigCal', big ? '1' : ''); } catch (e) {}
  renderCalendar();
}
let bigCal = false; try { bigCal = localStorage.getItem('bigCal') === '1'; } catch (e) {}
setBigCal(bigCal);
$('#calSize').addEventListener('click', () => setBigCal(!$('.dash').classList.contains('big-cal'), true));

/* ---------- New test form ---------- */
const showTestForm = open => {
  $('#testForm').hidden = !open;
  $('#newTest').hidden = open;
  if (open) $('#testForm input').focus();
};
$('#newTest').addEventListener('click', () => showTestForm(true));
$('#cancelTest').addEventListener('click', () => { $('#testForm').reset(); showTestForm(false); });
$('#testForm').addEventListener('submit', e => {
  e.preventDefault();
  if (add('test', formFields(e.target), e.target)) showTestForm(false);
});

/* ---------- Start ---------- */
(async () => {
  const [savedSettings, data] = await Promise.all([window.api.loadSettings(), window.api.loadData()]);
  settings = savedSettings;
  applySettings();
  load(data);
  sync();
  setInterval(sync, SYNC_EVERY);
})();
