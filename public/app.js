'use strict';

// ---------- tiny helpers ----------

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = true) {
  $toast.textContent = msg;
  $toast.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = ''), 3500);
}

// ---------- dates ----------

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const todayIso = () => iso(new Date());
const mondayOf = (s) => {
  const d = parse(s);
  return addDays(s, -((d.getDay() + 6) % 7));
};
const fmt = (s, opts) => parse(s).toLocaleDateString('en-GB', opts);
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const NUMBER_WORDS = ['No one', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function fmtTime(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  const suffix = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 || 12;
  return mm ? `${h12}:${pad(mm)}${suffix}` : `${h12}${suffix}`;
}

function dayLabel(date) {
  const t = todayIso();
  if (date === t) return 'tonight';
  if (date === addDays(t, 1)) return 'tomorrow night';
  if (date === addDays(t, -1)) return 'last night';
  return fmt(date, { weekday: 'long', day: 'numeric', month: 'long' });
}

function monthGrid(date) {
  const d = parse(date);
  const first = iso(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const start = mondayOf(first);
  const end = addDays(mondayOf(last), 6);
  return { start, end, month: d.getMonth() };
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

// ---------- state ----------

const state = {
  householdName: 'The Rieger House',
  me: null,
  settings: {},
  suggestions: [],
  view: 'home',
  selected: todayIso(),
  monthOpen: localStorageGet('rh_month') === '1',
  editingId: null,
  people: [],
  responses: new Map(),
  range: null,
  pending: new Set(),
  saveStatus: '',
};

function localStorageGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

const key = (uid, date) => `${uid}|${date}`;
const getResp = (uid, date) => state.responses.get(key(uid, date)) || null;

function canEdit(uid) {
  return state.me && (state.me.id === uid || state.me.role === 'admin' || state.settings.everyoneCanEdit);
}

// ---------- boot ----------

async function boot() {
  try {
    const b = await api('GET', '/api/bootstrap');
    state.householdName = b.householdName;
    document.title = b.householdName;
    if (b.needsSetup) return renderSetup();
    try {
      await loadMe();
    } catch (e) {
      if (e.status === 401) return renderLogin(b.people);
      throw e;
    }
    showHome();
  } catch (e) {
    fill($app,      h('div', { class: 'screen center' },
        h('h1', { class: 'brand' }, state.householdName),
        h('p', {}, "Can't reach the house right now. Check your connection."),
        h('button', { class: 'btn primary', onclick: boot }, 'Try again'))
    );
  }
}

async function loadMe() {
  const me = await api('GET', '/api/me');
  state.me = me.user;
  state.settings = me.settings;
  state.suggestions = me.suggestions;
  state.householdName = me.settings.householdName;
  document.title = state.householdName;
}

// ---------- setup ----------

function renderSetup() {
  const family = ['Grant', 'Emma', 'Elijah'];
  const famList = h('div', { class: 'stack-sm' });
  const drawFamily = () => {
    fill(famList,       ...family.map((n, i) =>
        h('div', { class: 'row-input' },
          h('input', { type: 'text', value: n, maxLength: 30, 'aria-label': `Family member ${i + 1}`, oninput: (e) => (family[i] = e.target.value) }),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => { family.splice(i, 1); drawFamily(); } }, 'Remove'))
      ),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { family.push(''); drawFamily(); famList.querySelector('div:nth-last-of-type(1) input')?.focus(); } }, 'Add another person')
    );
  };
  drawFamily();

  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    err.textContent = '';
    if (f.get('pin') !== f.get('pin2')) return (err.textContent = "The two PINs don't match.");
    try {
      await api('POST', '/api/setup', {
        code: f.get('code'),
        name: f.get('name'),
        pin: f.get('pin'),
        adminOnDinnerList: f.get('includeMe') === 'on',
        family: family.map((n) => n.trim()).filter(Boolean),
      });
      await loadMe();
      state.view = 'admin';
      showAdmin();
      toast('All set. Now give everyone a PIN.', false);
    } catch (ex) {
      err.textContent = ex.message;
    }
  } },
    h('label', { class: 'field' }, h('span', {}, 'Setup code'),
      h('input', { name: 'code', inputMode: 'numeric', autocomplete: 'one-time-code', required: true }),
      h('small', {}, 'This is the SETUP_CODE secret you set in Cloudflare.')),
    h('label', { class: 'field' }, h('span', {}, 'Your name (admin)'),
      h('input', { name: 'name', value: 'Lincoln', maxLength: 30, required: true })),
    h('label', { class: 'field' }, h('span', {}, 'Your PIN, 6 to 8 digits'),
      h('input', { name: 'pin', type: 'password', inputMode: 'numeric', pattern: '\\d{6,8}', autocomplete: 'new-password', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'Type the PIN again'),
      h('input', { name: 'pin2', type: 'password', inputMode: 'numeric', pattern: '\\d{6,8}', autocomplete: 'new-password', required: true })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'includeMe' }), h('span', {}, "I'll check in for dinner too")),
    h('fieldset', { class: 'field' }, h('legend', {}, 'Family'), famList),
    err,
    h('button', { class: 'btn primary big' }, 'Create the house')
  );

  fill($app,    h('main', { class: 'screen narrow' },
      h('h1', { class: 'brand' }, 'The Rieger House'),
      h('p', { class: 'lede' }, "Let's set up the dinner list. You'll be the admin."),
      form)
  );
}

// ---------- login ----------

function renderLogin(people) {
  const withPin = people || [];
  fill($app,    h('main', { class: 'screen narrow' },
      h('h1', { class: 'brand' }, state.householdName),
      h('p', { class: 'lede' }, 'Who are you?'),
      h('div', { class: 'people-grid' },
        withPin.map((p) =>
          h('button', { class: 'person-btn', onclick: () => (p.hasPin ? renderPin(p, people) : toast(`${p.name} doesn't have a PIN yet. Ask Lincoln to set one.`)) },
            h('span', { class: 'avatar', style: `--c:${p.color}` }, initial(p.name)),
            h('span', {}, p.name))
        )))
  );
}

function renderPin(person, people) {
  let pin = '';
  const dots = h('div', { class: 'pin-dots', 'aria-label': 'PIN' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  let busy = false;

  const draw = () => {
    const n = Math.max(4, pin.length);
    fill(dots, ...Array.from({ length: n }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
    submitBtn.disabled = pin.length < 4 || busy;
  };
  const press = (d) => {
    if (busy) return;
    err.textContent = '';
    if (d === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += d;
    draw();
  };
  const submit = async () => {
    if (pin.length < 4 || busy) return;
    busy = true;
    draw();
    try {
      await api('POST', '/api/login', { userId: person.id, pin });
      document.removeEventListener('keydown', onKey);
      await loadMe();
      state.selected = todayIso();
      showHome();
    } catch (e) {
      err.textContent = e.message;
      pin = '';
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
    } finally {
      busy = false;
      draw();
    }
  };
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Enter') submit();
  };
  document.addEventListener('keydown', onKey);

  const submitBtn = h('button', { class: 'btn primary big', onclick: submit }, 'Sign in');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];

  fill($app,    h('main', { class: 'screen narrow center' },
      h('button', { class: 'btn ghost small back', onclick: () => { document.removeEventListener('keydown', onKey); renderLogin(people); } }, 'Not ' + person.name + '?'),
      h('span', { class: 'avatar large', style: `--c:${person.color}` }, initial(person.name)),
      h('h1', { class: 'pin-title' }, `Hi ${person.name}`),
      h('p', { class: 'muted' }, 'Enter your PIN'),
      dots,
      err,
      h('div', { class: 'keypad' },
        keys.map((k) =>
          k === ''
            ? h('span')
            : h('button', { class: 'key', 'aria-label': k === 'back' ? 'Delete' : k, onclick: () => press(k) }, k === 'back' ? '⌫' : k))),
      submitBtn)
  );
  draw();
}

// ---------- home ----------

let pollTimer;

function showHome() {
  state.view = 'home';
  state.editingId = null;
  fill($app,    h('div', { class: 'shell' },
      renderHeader(),
      h('main', { class: 'home' },
        h('section', { id: 'cal', class: 'cal', 'aria-label': 'Calendar' }),
        h('section', { id: 'day', class: 'day', 'aria-live': 'polite' }),
        h('section', { id: 'editor', class: 'editor' })))
  );
  renderAll();
  loadRange(true);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => document.visibilityState === 'visible' && loadRange(true), 30_000);
}

function renderHeader() {
  return h('header', { class: 'topbar' },
    h('h1', { class: 'brand small' }, state.householdName),
    h('button', { class: 'avatar-btn', 'aria-label': 'Your account', onclick: openAccount },
      h('span', { class: 'avatar', style: `--c:${state.me.color}` }, initial(state.me.name))));
}

function renderAll() {
  renderCal();
  renderDay();
  renderEditor();
}

async function loadRange(force) {
  const { start, end } = monthGrid(state.selected);
  const rangeKey = `${start}|${end}`;
  if (!force && state.range === rangeKey) return;
  state.range = rangeKey;
  try {
    const data = await api('GET', `/api/days?from=${start}&to=${end}`);
    if (state.range !== rangeKey) return;
    state.people = data.people;
    for (const k of [...state.responses.keys()]) {
      const [, d] = k.split('|');
      if (d >= start && d <= end && !state.pending.has(k)) state.responses.delete(k);
    }
    for (const r of data.responses) {
      const k = key(r.userId, r.date);
      if (!state.pending.has(k)) state.responses.set(k, r);
    }
    renderCal();
    renderDay();
    // Don't rebuild the editor while someone is typing in it.
    const editor = document.getElementById('editor');
    if (!editor || !editor.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') renderEditor();
  } catch (e) {
    if (e.status === 401) return signedOut();
    if (force) toast("Couldn't load the latest plans. Check your connection.");
  }
}

function select(date) {
  state.selected = date;
  state.editingId = null;
  renderAll();
  loadRange(false);
}

function statusOf(r) {
  if (!r || r.home === null) return 'none';
  return r.home ? 'home' : 'away';
}

function renderCal() {
  const el = document.getElementById('cal');
  if (!el) return;
  const today = todayIso();
  const sel = state.selected;
  const month = state.monthOpen;
  const { start, end, month: m } = monthGrid(sel);
  const from = month ? start : mondayOf(sel);
  const to = month ? end : addDays(from, 6);

  const step = (dir) => {
    if (month) {
      const d = parse(sel);
      const target = new Date(d.getFullYear(), d.getMonth() + dir, 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(d.getDate(), lastDay));
      select(iso(target));
    } else select(addDays(sel, 7 * dir));
  };

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const outside = month && parse(d).getMonth() !== m;
    const dots = state.people.map((p) => h('i', { class: `dot ${statusOf(getResp(p.id, d))}` }));
    const answered = state.people.filter((p) => statusOf(getResp(p.id, d)) !== 'none').length;
    const label = `${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}, ${answered} of ${state.people.length} answered`;
    days.push(
      h('button', {
        class: ['day-cell', d === sel && 'selected', d === today && 'today', outside && 'outside', d < today && 'past'].filter(Boolean).join(' '),
        'aria-label': label,
        'aria-pressed': d === sel ? 'true' : 'false',
        onclick: () => select(d),
      },
        !month && h('span', { class: 'wd' }, fmt(d, { weekday: 'short' })),
        h('span', { class: 'num' }, parse(d).getDate()),
        h('span', { class: 'dots' }, dots))
    );
  }

  const title = month
    ? fmt(sel, { month: 'long', year: 'numeric' })
    : (() => {
        const a = parse(from), b = parse(to);
        return a.getMonth() === b.getMonth()
          ? fmt(from, { month: 'long' })
          : `${fmt(from, { month: 'short' })} – ${fmt(to, { month: 'short' })}`;
      })();

  fill(el,     h('div', { class: 'cal-head' },
      h('button', { class: 'icon-btn', 'aria-label': month ? 'Previous month' : 'Previous week', onclick: () => step(-1) }, '‹'),
      h('span', { class: 'cal-title' }, title),
      h('button', { class: 'icon-btn', 'aria-label': month ? 'Next month' : 'Next week', onclick: () => step(1) }, '›')),
    month && h('div', { class: 'grid weekdays', 'aria-hidden': 'true' }, WEEKDAYS.map((w) => h('span', {}, w))),
    h('div', { class: `grid ${month ? 'month' : 'week'}` }, days),
    h('div', { class: 'cal-foot' },
      h('span', { class: 'legend' },
        h('span', {}, h('i', { class: 'dot home' }), 'Home'),
        h('span', {}, h('i', { class: 'dot away' }), 'Not home'),
        h('span', {}, h('i', { class: 'dot none' }), 'No answer')),
      h('span', { class: 'cal-actions' },
        sel !== today && h('button', { class: 'link', onclick: () => select(today) }, 'Today'),
        h('button', { class: 'link', onclick: () => { state.monthOpen = !month; localStorageSet('rh_month', state.monthOpen ? '1' : '0'); renderCal(); } },
          month ? 'Show week' : 'Show month')))
  );
}

function outLine(r) {
  if (!r || !r.home || !r.goingOut) return null;
  const time = fmtTime(r.outTime);
  if (time && r.outWhat) return `Heading out at ${time} for ${r.outWhat}`;
  if (time) return `Heading out at ${time}`;
  if (r.outWhat) return `Heading out after dinner for ${r.outWhat}`;
  return 'Heading out after dinner';
}

function renderDay() {
  const el = document.getElementById('day');
  if (!el) return;
  const date = state.selected;
  const people = state.people;
  const statuses = people.map((p) => statusOf(getResp(p.id, date)));
  const home = statuses.filter((s) => s === 'home').length;
  const missing = people.filter((_, i) => statuses[i] === 'none');

  let headline;
  if (!people.length) headline = 'No one is on the dinner list yet';
  else if (missing.length === people.length) headline = 'No answers yet';
  else if (home === people.length) headline = 'Everyone is home for dinner';
  else headline = `${NUMBER_WORDS[home] || home} home for dinner`;

  let sub = '';
  if (people.length && missing.length && missing.length < people.length) {
    sub = missing.length === 1 ? `Waiting on ${missing[0].name}` : `Waiting on ${missing.length} people`;
  } else if (people.length && !missing.length) sub = 'Everyone has answered';

  const label = dayLabel(date);
  const dateLine = label.includes('night') ? `${label.charAt(0).toUpperCase() + label.slice(1)}, ${fmt(date, { weekday: 'long', day: 'numeric', month: 'long' })}` : label;

  const order = [...people].sort((a, b) => (a.id === state.me.id ? -1 : b.id === state.me.id ? 1 : 0));

  fill(el,     h('p', { class: 'date-line' }, dateLine),
    h('h2', { class: 'headline' }, headline),
    sub && h('p', { class: 'muted sub' }, sub),
    h('ul', { class: 'family' },
      order.map((p) => {
        const r = getResp(p.id, date);
        const s = statusOf(r);
        const editable = canEdit(p.id) && p.id !== state.me.id;
        const line = outLine(r);
        const content = [
          h('span', { class: `plate ${s}`, style: `--c:${p.color}`, 'aria-hidden': 'true' }, initial(p.name)),
          h('span', { class: 'who' },
            h('span', { class: 'name' }, p.name, p.id === state.me.id && h('span', { class: 'you' }, ' (you)')),
            line && h('span', { class: 'out' }, line)),
          h('span', { class: `status ${s}` }, s === 'home' ? 'Home' : s === 'away' ? 'Not home' : 'No answer'),
        ];
        return h('li', {},
          editable
            ? h('button', { class: 'member', 'aria-label': `Change ${p.name}'s plans`, onclick: () => editFor(p.id) }, content)
            : h('div', { class: 'member' }, content));
      }))
  );
}

function editFor(uid) {
  state.editingId = uid;
  renderEditor();
  document.getElementById('editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderEditor() {
  const el = document.getElementById('editor');
  if (!el) return;
  const date = state.selected;
  const me = state.me;
  const targetId = state.editingId ?? (state.people.some((p) => p.id === me.id) ? me.id : null);
  const target = state.people.find((p) => p.id === targetId);

  if (!target) {
    fill(el,       me.role === 'admin'
        ? h('p', { class: 'muted note' }, "You're not on the dinner list. Tap someone above to update their plans, or add yourself in Admin.")
        : h('p', { class: 'muted note' }, "You're not on the dinner list. Ask Lincoln to add you.")
    );
    return;
  }

  const r = getResp(target.id, date) || { home: null, goingOut: false, outWhat: '', outTime: '' };
  const isMe = target.id === me.id;
  const label = dayLabel(date);
  const title = isMe ? `Your plans for ${label}` : `${target.name}'s plans for ${label}`;

  const choice = (opts, current, onPick, group) =>
    h('div', { class: 'choice', role: 'radiogroup', 'aria-label': group },
      opts.map(([value, text, cls]) =>
        h('button', {
          class: `choice-btn ${cls || ''} ${current === value ? 'on' : ''}`,
          role: 'radio',
          'aria-checked': current === value ? 'true' : 'false',
          onclick: () => onPick(value),
        }, text)));

  const parts = [
    h('div', { class: 'editor-head' },
      h('h3', {}, title),
      !isMe && h('button', { class: 'link', onclick: () => { state.editingId = null; renderEditor(); } }, 'Done')),
    h('p', { class: 'q' }, 'Home for dinner?'),
    choice([[true, 'Yes, home', 'yes'], [false, 'No, not home', 'no']], r.home, (v) => save(target.id, date, { home: v }), 'Home for dinner?'),
  ];

  if (r.home === true) {
    parts.push(
      h('p', { class: 'q' }, 'Going out after dinner?'),
      choice([[false, 'No'], [true, 'Yes']], !!r.goingOut, (v) => save(target.id, date, { goingOut: v }), 'Going out after dinner?')
    );
    if (r.goingOut) {
      const what = h('input', {
        type: 'text', id: 'out-what', maxLength: 80, value: r.outWhat, placeholder: 'e.g. Football training', autocomplete: 'off', enterKeyHint: 'done',
        oninput: (e) => saveDebounced(target.id, date, { outWhat: e.target.value }),
        onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
      });
      const sugg = isMe ? state.suggestions.filter((s) => s.toLowerCase() !== (r.outWhat || '').toLowerCase()) : [];
      parts.push(
        h('div', { class: 'out-fields' },
          h('label', { class: 'field', for: 'out-what' }, h('span', {}, 'What is it?')),
          what,
          sugg.length > 0 && h('div', { class: 'chips' },
            sugg.map((s) => h('button', { class: 'chip', onclick: () => { what.value = s; save(target.id, date, { outWhat: s }); } }, s))),
          h('label', { class: 'field' }, h('span', {}, 'What time do you need to leave?'),
            h('input', { type: 'time', value: r.outTime, step: 300, onchange: (e) => save(target.id, date, { outTime: e.target.value }) })))
      );
    }
  }

  parts.push(h('p', { class: `save-status ${state.saveStatus === 'error' ? 'error' : ''}`, id: 'save-status' }, saveStatusText()));
  fill(el, h('div', { class: 'card' }, parts));
}

function saveStatusText() {
  if (state.saveStatus === 'saving') return 'Saving…';
  if (state.saveStatus === 'saved') return 'Saved';
  if (state.saveStatus === 'error') return 'Not saved. Check your connection and tap again.';
  return '';
}

function setSaveStatus(s) {
  state.saveStatus = s;
  const el = document.getElementById('save-status');
  if (el) {
    el.textContent = saveStatusText();
    el.classList.toggle('error', s === 'error');
  }
}

const queues = new Map();
const debounceTimers = new Map();
let savedTimer;

function saveDebounced(uid, date, patch) {
  const k = key(uid, date);
  const local = getResp(uid, date) || { userId: uid, date, home: null, goingOut: false, outWhat: '', outTime: '' };
  state.responses.set(k, { ...local, ...patch });
  state.pending.add(k);
  setSaveStatus('saving');
  clearTimeout(debounceTimers.get(k));
  debounceTimers.set(k, setTimeout(() => save(uid, date, patch, { rerender: false }), 600));
}

function save(uid, date, patch, { rerender = true } = {}) {
  const k = key(uid, date);
  clearTimeout(debounceTimers.get(k));
  const before = getResp(uid, date);
  const local = before || { userId: uid, date, home: null, goingOut: false, outWhat: '', outTime: '' };
  state.responses.set(k, { ...local, ...patch });
  state.pending.add(k);
  setSaveStatus('saving');
  if (rerender) {
    renderCal();
    renderDay();
    renderEditor();
  }

  const run = async () => {
    try {
      const { response } = await api('PUT', `/api/responses/${uid}/${date}`, patch);
      if (queues.get(k) === p) {
        state.pending.delete(k);
        state.responses.set(k, response);
      }
      setSaveStatus('saved');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => state.saveStatus === 'saved' && setSaveStatus(''), 2500);
      if (patch.outWhat && uid === state.me.id && !state.suggestions.includes(patch.outWhat)) {
        state.suggestions = [patch.outWhat, ...state.suggestions].slice(0, 5);
      }
    } catch (e) {
      if (e.status === 401) return signedOut();
      state.pending.delete(k);
      setSaveStatus('error');
      toast(e.message);
      loadRange(true);
    }
  };
  const p = (queues.get(k) || Promise.resolve()).then(run);
  queues.set(k, p);
  return p;
}

// ---------- account ----------

function openSheet(content, onClose) {
  const close = () => {
    sheet.remove();
    document.removeEventListener('keydown', onEsc);
    onClose?.();
  };
  const onEsc = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onEsc);
  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === sheet && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content(close)));
  document.body.append(sheet);
  sheet.querySelector('button, input')?.focus();
  return close;
}

function openAccount() {
  openSheet((close) => {
    const err = h('p', { class: 'form-error', role: 'alert' });
    const pinForm = h('form', { class: 'stack hidden', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(pinForm);
      err.textContent = '';
      try {
        await api('POST', '/api/me/pin', { currentPin: f.get('current'), newPin: f.get('next') });
        close();
        toast('PIN changed', false);
      } catch (ex) {
        err.textContent = ex.message;
      }
    } },
      h('label', { class: 'field' }, h('span', {}, 'Current PIN'), h('input', { name: 'current', type: 'password', inputMode: 'numeric', autocomplete: 'current-password', required: true })),
      h('label', { class: 'field' }, h('span', {}, state.me.role === 'admin' ? 'New PIN, 6 to 8 digits' : 'New PIN, 4 to 8 digits'),
        h('input', { name: 'next', type: 'password', inputMode: 'numeric', autocomplete: 'new-password', required: true })),
      err,
      h('button', { class: 'btn primary' }, 'Save new PIN'));

    return [
      h('div', { class: 'sheet-who' },
        h('span', { class: 'avatar', style: `--c:${state.me.color}` }, initial(state.me.name)),
        h('div', {}, h('strong', {}, state.me.name), h('p', { class: 'muted' }, state.me.role === 'admin' ? 'Admin' : 'Family member'))),
      state.me.role === 'admin' && h('button', { class: 'btn big', onclick: () => { close(); showAdmin(); } }, 'Admin'),
      h('button', { class: 'btn big', onclick: (e) => { pinForm.classList.toggle('hidden'); e.target.remove(); pinForm.querySelector('input').focus(); } }, 'Change my PIN'),
      pinForm,
      h('button', { class: 'btn big', onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); close(); signedOut(); } }, 'Sign out'),
      h('button', { class: 'btn ghost', onclick: close }, 'Close'),
    ];
  });
}

async function signedOut() {
  clearInterval(pollTimer);
  $toast.className = '';
  state.me = null;
  state.responses.clear();
  state.range = null;
  boot();
}

// ---------- admin ----------

let adminData = null;
let openPerson = null;

async function showAdmin() {
  state.view = 'admin';
  clearInterval(pollTimer);
  try {
    adminData = await api('GET', '/api/admin/users');
  } catch (e) {
    if (e.status === 401) return signedOut();
    toast(e.message);
    return showHome();
  }
  renderAdmin();
}

function renderAdmin() {
  const { users, settings, palette } = adminData;
  const refresh = async () => {
    adminData = await api('GET', '/api/admin/users');
    renderAdmin();
  };
  const act = async (fn, okMsg) => {
    try {
      await fn();
      await refresh();
      if (okMsg) toast(okMsg, false);
    } catch (e) {
      toast(e.message);
    }
  };

  const personCard = (u) => {
    const isOpen = openPerson === u.id;
    const badges = [
      u.role === 'admin' && h('span', { class: 'badge' }, 'Admin'),
      !u.hasPin && h('span', { class: 'badge warn' }, 'No PIN yet'),
      u.locked && h('span', { class: 'badge warn' }, 'Locked out'),
      !u.onDinnerList && h('span', { class: 'badge quiet' }, 'Not on dinner list'),
    ];
    const pinInput = h('input', { type: 'password', inputMode: 'numeric', placeholder: u.role === 'admin' ? '6 to 8 digits' : '4 to 8 digits', autocomplete: 'new-password', 'aria-label': `New PIN for ${u.name}` });
    const nameInput = h('input', { type: 'text', value: u.name, maxLength: 30, 'aria-label': 'Name' });
    return h('li', { class: `admin-person ${isOpen ? 'open' : ''}` },
      h('button', { class: 'admin-person-head', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { openPerson = isOpen ? null : u.id; renderAdmin(); } },
        h('span', { class: 'avatar', style: `--c:${u.color}` }, initial(u.name)),
        h('span', { class: 'who' }, h('span', { class: 'name' }, u.name), h('span', { class: 'badges' }, badges)),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, isOpen ? '−' : '+')),
      isOpen && h('div', { class: 'admin-person-body stack' },
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: u.onDinnerList, onchange: (e) => act(() => api('PATCH', `/api/admin/users/${u.id}`, { onDinnerList: e.target.checked })) }),
          h('span', {}, 'On the dinner list')),
        h('div', { class: 'field' }, h('span', {}, u.hasPin ? 'Set a new PIN' : 'Set a PIN'),
          h('div', { class: 'row-input' }, pinInput,
            h('button', { class: 'btn small primary', onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/pin`, { pin: pinInput.value }), `${u.name}'s PIN is set`) }, 'Save PIN'))),
        h('div', { class: 'field' }, h('span', {}, 'Name'),
          h('div', { class: 'row-input' }, nameInput,
            h('button', { class: 'btn small', onclick: () => act(() => api('PATCH', `/api/admin/users/${u.id}`, { name: nameInput.value }), 'Name saved') }, 'Save name'))),
        h('div', { class: 'field' }, h('span', {}, 'Colour'),
          h('div', { class: 'swatches' },
            palette.map((c) => h('button', {
              class: `swatch ${c === u.color ? 'on' : ''}`, style: `--c:${c}`, 'aria-label': `Colour ${c}`, 'aria-pressed': c === u.color ? 'true' : 'false',
              onclick: () => act(() => api('PATCH', `/api/admin/users/${u.id}`, { color: c })),
            })))),
        u.id !== state.me.id && h('button', { class: 'btn ghost danger small', onclick: () => {
          if (confirm(`Remove ${u.name}? Their account is closed and they disappear from the dinner list.`)) {
            openPerson = null;
            act(() => api('DELETE', `/api/admin/users/${u.id}`), `${u.name} removed`);
          }
        } }, `Remove ${u.name}`))
    );
  };

  const addName = h('input', { type: 'text', maxLength: 30, placeholder: 'Name', 'aria-label': 'New person name', required: true });
  const addPin = h('input', { type: 'password', inputMode: 'numeric', placeholder: 'PIN (optional)', 'aria-label': 'New person PIN', autocomplete: 'new-password' });
  const houseName = h('input', { type: 'text', value: settings.householdName, maxLength: 40, 'aria-label': 'Household name' });

  fill($app,    h('div', { class: 'shell' },
      h('header', { class: 'topbar' },
        h('h1', { class: 'brand small' }, 'Admin'),
        h('button', { class: 'btn small primary', onclick: async () => { await loadMe(); showHome(); } }, 'Done')),
      h('main', { class: 'admin stack-lg' },
        h('section', {},
          h('h2', { class: 'section-title' }, 'Family'),
          h('ul', { class: 'admin-list' }, users.map(personCard))),
        h('section', {},
          h('h2', { class: 'section-title' }, 'Add someone'),
          h('form', { class: 'stack-sm', onsubmit: (e) => {
            e.preventDefault();
            act(() => api('POST', '/api/admin/users', { name: addName.value, pin: addPin.value || undefined }), `${addName.value.trim()} added`);
          } }, addName, addPin, h('button', { class: 'btn primary' }, 'Add person'))),
        h('section', {},
          h('h2', { class: 'section-title' }, 'Settings'),
          h('div', { class: 'stack' },
            h('div', { class: 'field' }, h('span', {}, 'Household name'),
              h('div', { class: 'row-input' }, houseName,
                h('button', { class: 'btn small', onclick: () => act(() => api('PUT', '/api/admin/settings', { householdName: houseName.value }), 'Saved') }, 'Save'))),
            h('label', { class: 'switch' },
              h('input', { type: 'checkbox', checked: settings.everyoneCanEdit, onchange: (e) => act(() => api('PUT', '/api/admin/settings', { everyoneCanEdit: e.target.checked })) }),
              h('span', {}, 'Let everyone update anyone\'s plans'),
            ),
            h('p', { class: 'muted small-print' }, 'Handy if Mum wants to fill in for the kids. When this is off, people can only change their own plans, and you can change anyone\'s.'))))
    )
  );
}

// ---------- lifecycle ----------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state.view !== 'home' || !state.me) return;
  // If the app was left open overnight, jump to the new day.
  if (state.lastSeenToday && state.lastSeenToday !== todayIso() && state.selected === state.lastSeenToday) state.selected = todayIso();
  state.lastSeenToday = todayIso();
  renderAll();
  loadRange(true);
});
state.lastSeenToday = todayIso();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();
