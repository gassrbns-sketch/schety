'use strict';
/* Счёты — запись силовых тренировок. PWA без сервера: данные в IndexedDB, обмен через GitHub Contents API. */

const DEFAULTS = {
  owner: 'gassrbns-sketch',
  repo: 'garmin-data',
  branch: 'main',
  token: '',
  timer: false,
  doneSide: 'left',      // куда сдвигаются сделанные подходы
  sound: true,           // деревянный щелчок костяшек
  pcBot: '',             // имя бота на ПК (хранится только в телефоне): /run и план на часы по ссылке t.me/<бот>?start=…
};
const PATHS = {
  plans: 'manual/plans',
  sessions: 'manual/sessions',
  workouts: 'manual/workouts.md',
  exercises: 'manual/exercises.json',
  morning: 'manual/morning.csv',
};
// Столбцы как у бота (garmin_manual.MORNING_FIELDS): одна строка на дату, новая замещает прежнюю.
const MORNING_FIELDS = ['date', 'weight_kg', 'readiness', 'discomfort', 'sleep_quality', 'recorded_at'];
const APP_VERSION = 20;   // совпадает с CACHE в sw.js
const PAST_SHOWN = 5;     // прошедших занятий в списке; остальные — под «Ещё прошедшие»
const SYNC_DELAY_MS = 60_000;
const TOKEN_WARN_DAYS = 14;
const DEFAULT_REST_S = 120;
const TYPES = {
  weight_reps: 'вес × повторы',
  added_weight_reps: 'доп. вес / ассист × повторы',
  reps: 'повторы',
  time: 'время',
};
const DEFAULT_STEP = { weight_reps: 2.5, added_weight_reps: 5 };
const BUILTIN_EXERCISES = [
  { id: 'bench', name: 'Жим лёжа', type: 'weight_reps', step: 2.5 },
  { id: 'pullup', name: 'Подтягивания', type: 'added_weight_reps', step: 2.5 },
  { id: 'pullup_assist', name: 'Подтягивания в гравитроне', type: 'added_weight_reps', step: 5 },
  { id: 'db_row_chest', name: 'Тяга гантелей с упором в грудь', type: 'weight_reps', step: 2.5 },
  { id: 'leg_press', name: 'Жим ногами горизонтальный', type: 'weight_reps', step: 5 },
  { id: 'rdl_db', name: 'Румынская тяга гантели', type: 'weight_reps', step: 2.5 },
  { id: 'db_press_seated', name: 'Жим гантелей сидя', type: 'weight_reps', step: 2.5 },
  { id: 'hammer_curl', name: 'Молоточки по очереди', type: 'weight_reps', step: 2.5 },
  { id: 'triceps_rope', name: 'Трицепс верёвкой', type: 'weight_reps', step: 2.5 },
  { id: 'ext_rotation', name: 'Наружная ротация лёжа', type: 'weight_reps', step: 1, per_side: true },
  { id: 'bulgarian_split', name: 'Болгарские сплит-приседы', type: 'reps', per_side: true, side_label: 'на ногу' },
  { id: 'bird_dog', name: 'Bird dog', type: 'reps', per_side: true },
  { id: 'dead_bug', name: 'Мёртвый жук', type: 'reps', per_side: true },
  { id: 'side_plank', name: 'Боковая планка', type: 'time' },
];

/* ---------- хранилище ---------- */

const db = (() => {
  let opening;
  const open = () => opening || (opening = new Promise((res, rej) => {
    const r = indexedDB.open('schety', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    get: k => run('readonly', s => s.get(k)),
    set: (k, v) => run('readwrite', s => s.put(v, k)),
    del: k => run('readwrite', s => s.delete(k)),
    all: async prefix => {
      const keys = await run('readonly', s => s.getAllKeys());
      const out = [];
      for (const k of keys) if (String(k).startsWith(prefix)) out.push(await db.get(k));
      return out;
    },
  };
})();

const S = {
  settings: { ...DEFAULTS },
  meta: {},                 // tokenExp, lastSync, lastError
  plans: new Map(),         // date -> {date, sha, data}
  sessions: new Map(),      // id -> session
  catalog: { list: [], sha: null, dirty: false },
  checkins: new Map(),      // date -> {date, weight_kg, readiness, discomfort, sleep_quality, recorded_at, dirty}
};

const clone = o => JSON.parse(JSON.stringify(o));
const saveSettings = () => db.set('settings', S.settings);
const saveMeta = () => db.set('meta', S.meta);
const saveCatalog = () => db.set('catalog', S.catalog);
const saveSession = s => db.set('session:' + s.id, s);
const savePlan = p => db.set('plan:' + p.date, p);
const saveCheckin = c => db.set('checkin:' + c.date, c);

/* ---------- даты и форматирование ---------- */

const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dmy = iso => iso.slice(0, 10).split('-').reverse().join('.');
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const fmtNum = v => String(+(+v).toFixed(2));              // 82.5 — как в workouts.md
const fmtUi = v => fmtNum(v).replace('.', ',');            // 82,5 — на экране
const MINUS = '−';
const signed = v => (v > 0 ? '+' : v < 0 ? MINUS : '') + fmtUi(Math.abs(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

/* ---------- модель занятия ---------- */

function normSet(t, s = {}) {
  const o = {};
  if (t === 'weight_reps' || t === 'added_weight_reps') o.weight = num(s.weight) ?? 0;
  if (t !== 'time') o.reps = num(s.reps) ?? 0;
  if (t === 'weight_reps' || t === 'added_weight_reps') o.rir = num(s.rir);
  if (t === 'time') o.sec = num(s.sec ?? s.seconds) ?? 0;
  return o;
}

function exFromPlan(e) {
  const type = TYPES[e.type] ? e.type : 'weight_reps';
  let sets = Array.isArray(e.sets) && e.sets.length ? e.sets : [{}];
  if (e.circuit && e.rounds > 1 && sets.length === 1) sets = Array.from({ length: e.rounds }, () => sets[0]);
  const { sets: _drop, ...rest } = e;
  return {
    ...rest,
    type,
    origin: 'plan',
    user_note: '',
    sets: sets.map(s => {
      const p = normSet(type, s);
      return { plan: p, fact: { ...p }, done: false, note: '' };
    }),
  };
}

function sessionFromPlan(p) {
  const d = p.data;
  return {
    id: p.date,
    date: d.date || p.date,
    title: d.title || '',
    note: d.note || '',
    plan_date: p.date,
    plan_sha: p.sha,
    status: 'planned',
    started_at: null,
    finished_at: null,
    md_header: null,
    session_note: '',
    exercises: (d.exercises || []).map(exFromPlan),
    sync: { dirty: false, mdDirty: false, ver: 0, sha: null, sentAt: null, error: null },
  };
}

function newBlankSession() {
  const base = localDate();
  let id = base, n = 2;
  while (S.sessions.has(id) || S.plans.has(id)) id = `${base}-${n++}`;
  return {
    id, date: base, title: 'без плана', note: '', plan_date: null, plan_sha: null,
    status: 'in_progress', started_at: localIso(), finished_at: null, md_header: null,
    session_note: '', exercises: [],
    sync: { dirty: true, mdDirty: false, ver: 1, sha: null, sentAt: null, error: null },
  };
}

function sessionForFile(s) {
  const { sync, plan_update, ...rest } = s;
  return rest;
}

function catalogItem(id) {
  return S.catalog.list.find(x => x.id === id) || BUILTIN_EXERCISES.find(x => x.id === id);
}
function catalogAll() {
  const map = new Map(BUILTIN_EXERCISES.map(x => [x.id, x]));
  for (const x of S.catalog.list) map.set(x.id, x);
  return [...map.values()];
}
const stepOf = e => e.step || catalogItem(e.id)?.step || DEFAULT_STEP[e.type] || 1;

function lastFactFor(exId) {
  const list = [...S.sessions.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const s of list) {
    const e = s.exercises.find(x => x.id === exId && x.origin !== 'removed');
    const set = e && [...e.sets].reverse().find(x => x.done);
    if (set) return clone(set.fact);
  }
  return null;
}
function defaultFact(type) {
  return normSet(type, { weight: type === 'weight_reps' ? 20 : 0, reps: 10, rir: 2, sec: 30 });
}

function setLabel(type, v, perSide) {
  if (!v) return '';
  const side = perSide ? '/с' : '';
  switch (type) {
    case 'weight_reps': return `${fmtUi(v.weight)}×${v.reps}${side}`;
    case 'added_weight_reps': return v.weight ? `${signed(v.weight)}×${v.reps}` : `${v.reps}`;
    case 'reps': return `${v.reps}${side}`;
    case 'time': return `${v.sec}с`;
  }
  return '';
}
const sameFact = (a, b) => !!a && !!b && ['weight', 'reps', 'rir', 'sec'].every(k => (a[k] ?? null) === (b[k] ?? null));

function sessionState(s) {
  if (s.sync.dirty || s.sync.mdDirty) return { cls: 'unsent', text: 'не отправлено' };
  if (s.status === 'done') return { cls: 'done', text: 'сделано' };
  if (s.status === 'in_progress') return { cls: 'in_progress', text: 'идёт' };
  return { cls: 'plan', text: 'план' };
}

/* ---------- текст для workouts.md ---------- */

function exLine(e) {
  const done = e.sets.filter(x => x.done);
  if (!done.length) return null;
  const f = done.map(x => x.fact);
  const reps = f.map(x => x.reps).join(' ');
  const sameW = f.every(x => x.weight === f[0].weight);
  let line = e.name;
  if (e.type === 'weight_reps') {
    line += sameW ? ` ${fmtNum(f[0].weight)} кг ${reps}` : ' ' + f.map(x => `${fmtNum(x.weight)}×${x.reps}`).join(', ');
  } else if (e.type === 'added_weight_reps') {
    const w = f[0].weight;
    const label = w > 0 ? `с весом +${fmtNum(w)} кг` : w < 0 ? `ассист ${MINUS}${fmtNum(-w)} кг` : 'свой вес';
    line += sameW ? ` ${label} ${reps}` : ' ' + f.map(x => `${x.weight ? (x.weight > 0 ? '+' : MINUS) + fmtNum(Math.abs(x.weight)) : '0'}×${x.reps}`).join(', ');
  } else if (e.type === 'reps') {
    line += ` ${reps}`;
  } else if (e.type === 'time') {
    line += ' ' + f.map(x => `${x.sec}с`).join(' ');
  }
  if (e.type === 'weight_reps' || e.type === 'added_weight_reps') {
    const rirs = f.map(x => x.rir).filter(v => v != null);
    if (rirs.length) line += rirs.every(v => v === rirs[0]) ? ` RIR ${rirs[0]}` : ` RIR ${rirs.join('/')}`;
  }
  const notes = [];
  if (e.per_side) notes.push(e.side_label || 'на сторону');
  if (e.origin === 'replaced' && e.replaces?.name) notes.push(`вместо: ${e.replaces.name}`);
  if (e.origin === 'added') notes.push('добавлено в зале');
  done.forEach((x, i) => { if (x.note.trim()) notes.push(`${done.length > 1 ? (i + 1) + '-й: ' : ''}${x.note.trim()}`); });
  if (e.user_note?.trim()) notes.push(e.user_note.trim());
  if (notes.length) line += ` (${notes.join('; ')})`;
  return line;
}

function circuitPart(e) {
  const x = e.sets.find(s => s.done);
  if (!x) return null;
  const f = x.fact;
  const side = e.per_side ? '/стор' : '';
  if (e.type === 'time') return `${e.name.toLowerCase()} ${f.sec}с`;
  if (e.type === 'reps') return `${e.name.toLowerCase()} ${f.reps}${side}`;
  return `${e.name.toLowerCase()} ${fmtNum(f.weight)} кг ${f.reps}${side}`;
}

function buildText(s) {
  const lines = [`${dmy(s.date)} (${s.title || 'силовая'})`];
  const exs = s.exercises.filter(e => e.origin !== 'removed');
  for (let i = 0; i < exs.length;) {
    const e = exs[i];
    if (e.circuit) {
      const grp = [];
      while (i < exs.length && exs[i].circuit === e.circuit) grp.push(exs[i++]);
      const parts = grp.map(circuitPart).filter(Boolean);
      if (parts.length) {
        const rounds = Math.max(...grp.map(g => g.sets.filter(x => x.done).length));
        const name = e.circuit_name || (e.circuit === 'core' ? 'Кор' : e.circuit);
        lines.push(`${name}: ${parts.join(', ')} — ${rounds} ${plural(rounds, 'круг', 'круга', 'кругов')}`);
      }
      continue;
    }
    const l = exLine(e);
    if (l) lines.push(l);
    i++;
  }
  if (s.session_note.trim()) lines.push(s.session_note.trim());
  return lines.join('\n');
}

const ENTRY_HEADER = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** Дописать запись в конец workouts.md или заменить блок с тем же заголовком. */
function upsertWorkout(md, header, body) {
  body = body.replace(/^## /gm, '\\## ');   // текст не должен разбивать файл на лишние записи
  const block = `${header}\n\n${body}\n`;
  const lines = md.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) {
    const base = md.trim() ? md.replace(/\s+$/, '') : '# Описания тренировок';
    return `${base}\n\n${block}`;
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (ENTRY_HEADER.test(lines[i])) { end = i; break; }
  const before = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${block}${after ? '\n' + after : ''}`;
}

/** Убрать из workouts.md блок с этим заголовком (если его нет — текст не меняется). */
function removeWorkout(md, header) {
  const lines = md.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) return md;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (ENTRY_HEADER.test(lines[i])) { end = i; break; }
  const before = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n${after ? '\n' + after : ''}`;
}

/* ---------- GitHub ---------- */

const b64encode = str => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

class GhError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function ghFetch(method, url, body) {
  const { token } = S.settings;
  if (!token) throw new GhError(0, 'нет токена');
  const r = await fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const exp = r.headers.get('github-authentication-token-expiration');
  if (exp && exp !== S.meta.tokenExp) { S.meta.tokenExp = exp; saveMeta(); }
  return r;
}

const repoUrl = () => `https://api.github.com/repos/${encodeURIComponent(S.settings.owner)}/${encodeURIComponent(S.settings.repo)}`;
const contentsUrl = path => `${repoUrl()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

async function ghGet(path, ref = S.settings.branch) {
  const r = await ghFetch('GET', `${contentsUrl(path)}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new GhError(r.status, `GitHub ${r.status} при чтении ${path}`);
  return r.json();
}
async function ghGetText(path, ref) {
  const j = await ghGet(path, ref);
  if (!j) return { text: null, sha: null };
  return { text: b64decode(j.content || ''), sha: j.sha };
}
async function ghPut(path, text, sha, message) {
  const r = await ghFetch('PUT', contentsUrl(path), {
    message, content: b64encode(text), branch: S.settings.branch, ...(sha ? { sha } : {}),
  });
  if (r.ok) return (await r.json()).content.sha;
  throw new GhError(r.status, `GitHub ${r.status} при записи ${path}`);
}
/** Запись с одной повторной попыткой при устаревшем sha (409/422). makeText получает свежий текст файла. */
async function ghWrite(path, makeText, message, knownSha) {
  let sha = knownSha, text = null;
  if (sha === undefined) ({ sha, text } = await ghGetText(path));
  for (let attempt = 0; ; attempt++) {
    try {
      return await ghPut(path, makeText(text), sha, message);
    } catch (e) {
      if (attempt > 0 || !(e.status === 409 || e.status === 422)) throw e;
      ({ sha, text } = await ghGetText(path));
    }
  }
}

async function ghDelete(path, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const j = await ghGet(path);
    if (!j) return;                                   // уже нет
    const r = await ghFetch('DELETE', contentsUrl(path), { message, sha: j.sha, branch: S.settings.branch });
    if (r.ok || r.status === 404) return;
    if (attempt > 0 || !(r.status === 409 || r.status === 422)) throw new GhError(r.status, `GitHub ${r.status} при удалении ${path}`);
  }
}

/* ---------- синхронизация ---------- */

const pendingDeletes = () => S.meta.deletes || [];

/** Сброс занятия: локально — к плану (или удалить, если плана нет), в GitHub — убрать файл сессии и блок в workouts.md. */
async function resetSession(s) {
  const plan = s.plan_date && S.plans.get(s.plan_date);
  if (s.status !== 'planned') {
    S.meta.deletes = pendingDeletes().filter(d => d.id !== s.id).concat([{ id: s.id, date: s.date, md_header: s.md_header || null }]);
    await saveMeta();
  }
  if (plan) {
    const fresh = sessionFromPlan(plan);
    fresh.id = s.id;
    S.sessions.set(s.id, fresh);
    await saveSession(fresh);
  } else {
    S.sessions.delete(s.id);
    await db.del('session:' + s.id);
  }
  stopTimer();
  syncAll();
  return !!plan;
}

// План удаляется сразу в GitHub (без очереди): иначе следующее «Обновить» вернуло бы его.
async function deletePlan(date) {
  if (!S.settings.token) throw new Error('Укажите токен в настройках');
  const plan = S.plans.get(date);
  await ghDelete(`${PATHS.plans}/${date}.json`, `План ${date} удалён`);
  // Тот же файл может лежать в ветке claude/… или ccr-… — не импортировать его снова.
  if (plan?.sha) { S.meta.importedBlobs = { ...(S.meta.importedBlobs || {}), [plan.sha]: Date.now() }; await saveMeta(); }
  S.plans.delete(date);
  await db.del('plan:' + date);
  const s = S.sessions.get(date);
  if (s && s.status === 'planned') { S.sessions.delete(date); await db.del('session:' + date); }
}

async function pushDeletes() {
  for (const d of [...pendingDeletes()]) {
    await ghDelete(`${PATHS.sessions}/${d.id}.json`, `Тренировка ${d.date} сброшена`);
    if (d.md_header) await ghWrite(PATHS.workouts, old => removeWorkout(old || '', d.md_header), `Тренировка ${d.date} убрана из workouts.md`);
    S.meta.deletes = pendingDeletes().filter(x => x !== d);
    await saveMeta();
  }
}

let syncTimer = null, syncing = false;

function touch(s) {
  s.sync.dirty = true;
  if (s.status === 'done') s.sync.mdDirty = true;
  s.sync.ver = (s.sync.ver || 0) + 1;
  s.sync.error = null;
  saveSession(s);
  scheduleSync(SYNC_DELAY_MS);
  renderSync();
}
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncAll, ms);
}

async function pushSession(s) {
  const ver = s.sync.ver;
  const text = JSON.stringify(sessionForFile(s), null, 2) + '\n';
  const msg = `Тренировка ${s.date} (${s.status === 'done' ? 'завершена' : 'идёт'})`;
  // Телефон — единственный автор файла сессии: его версия побеждает, чужой текст не нужен.
  s.sync.sha = await ghWrite(`${PATHS.sessions}/${s.id}.json`, () => text, msg, s.sync.sha ?? undefined);
  if (s.sync.ver === ver) s.sync.dirty = false;
}

async function pushWorkout(s) {
  const ver = s.sync.ver;
  const body = buildText(s);
  await ghWrite(PATHS.workouts, old => upsertWorkout(old || '', s.md_header, body), `Тренировка ${s.date} → workouts.md`);
  if (s.sync.ver === ver) s.sync.mdDirty = false;
}

async function pushCatalog() {
  const mine = S.catalog.list;
  const sha = await ghWrite(PATHS.exercises, old => {
    let theirs = [];
    try { theirs = old ? JSON.parse(old) : []; } catch { theirs = []; }
    const list = Array.isArray(theirs) ? theirs : (theirs.exercises || []);
    const ids = new Set(list.map(x => x.id));
    for (const x of mine) if (!ids.has(x.id)) list.push(x);
    S.catalog.list = list;
    return JSON.stringify(list, null, 2) + '\n';
  }, 'Справочник упражнений: новые упражнения из зала');
  S.catalog.sha = sha;
  S.catalog.dirty = false;
  await saveCatalog();
}

/* ---------- утренний чек-ин: manual/morning.csv ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
const csvCell = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

function readMorning(text) {
  const rows = parseCsv(text || '');
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
function writeMorning(entries) {
  const byDate = new Map(entries.map(e => [e.date, e]));
  const lines = [MORNING_FIELDS.join(',')];
  for (const d of [...byDate.keys()].sort()) lines.push(MORNING_FIELDS.map(f => csvCell(byDate.get(d)[f])).join(','));
  return lines.join('\n') + '\n';
}

function lastWeight() {
  const withW = [...S.checkins.values()].filter(c => c.weight_kg !== '' && c.weight_kg != null).sort((a, b) => b.date.localeCompare(a.date));
  return withW.length ? num(withW[0].weight_kg) : null;
}

async function pushCheckins() {
  const mine = [...S.checkins.values()].filter(c => c.dirty);
  if (!mine.length) return;
  const vers = new Map(mine.map(c => [c.date, c.ver]));
  await ghWrite(PATHS.morning, old => {
    const rows = readMorning(old);
    for (const c of mine) rows.push(Object.fromEntries(MORNING_FIELDS.map(f => [f, c[f] ?? ''])));
    return writeMorning(rows);   // свои строки идут последними и замещают строки с той же датой
  }, `Чек-ин ${mine.map(c => c.date).join(', ')}`);
  for (const c of mine) {
    if (c.ver === vers.get(c.date)) c.dirty = false;
    await saveCheckin(c);
  }
}

async function pullCheckins() {
  const { text } = await ghGetText(PATHS.morning);
  if (text == null) return;
  for (const r of readMorning(text)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const local = S.checkins.get(r.date);
    if (local && local.dirty) continue;
    const c = { ...Object.fromEntries(MORNING_FIELDS.map(f => [f, r[f] ?? ''])), dirty: false, ver: local?.ver || 0 };
    S.checkins.set(c.date, c);
    await saveCheckin(c);
  }
}

/** Ссылка на бота на ПК: Telegram откроет чат, кнопка «Запустить» отправит /start <cmd>, бот выполнит сразу. */
const pcLink = cmd => `https://t.me/${encodeURIComponent(S.settings.pcBot)}?start=${encodeURIComponent(cmd)}`;

async function syncAll() {
  clearTimeout(syncTimer);
  if (syncing) { scheduleSync(3000); return; }
  if (!S.settings.token || !navigator.onLine) { renderSync(); return; }
  syncing = true;
  renderSync();
  let failed = null;
  // Сначала сбросы: новое занятие с тем же id должно лечь уже после удаления старого.
  try { await pushDeletes(); } catch (e) { failed = e; }
  for (const s of S.sessions.values()) {
    if (s.status === 'planned') continue;
    if (failed && pendingDeletes().some(d => d.id === s.id)) continue;
    try {
      if (s.sync.dirty) await pushSession(s);
      if (s.sync.mdDirty && s.status === 'done') await pushWorkout(s);
      s.sync.sentAt = s.sync.dirty || s.sync.mdDirty ? s.sync.sentAt : Date.now();
      s.sync.error = null;
    } catch (e) {
      s.sync.error = e.message;
      failed = e;
    }
    await saveSession(s);
  }
  if (S.catalog.dirty) {
    try { await pushCatalog(); } catch (e) { failed = e; }
  }
  try { await pushCheckins(); } catch (e) { failed = e; }
  S.meta.lastError = failed ? failed.message : null;
  if (!failed) S.meta.lastSync = Date.now();
  await saveMeta();
  syncing = false;
  if (failed) scheduleSync(5 * 60_000);
  else if (pendingDeletes().length || [...S.sessions.values()].some(s => s.sync.dirty || s.sync.mdDirty) || [...S.checkins.values()].some(c => c.dirty)) scheduleSync(SYNC_DELAY_MS);
  renderSync();
  if (route().name === 'list') render();
}

/**
 * Claude Code в облаке пушит не в main, а в ветки claude/…. Планы оттуда переносим в main,
 * каждую версию файла — один раз (по sha блоба), чтобы не затереть более поздние правки в main.
 * Если одна дата есть в нескольких ветках, берётся ветка с самым свежим коммитом.
 */
async function importBranchPlans() {
  const r = await ghFetch('GET', `${repoUrl()}/branches?per_page=100`);
  if (!r.ok) return 0;
  // Claude Code называет ветки по-разному: claude/… или ccr-… (облачная сессия из приложения Claude).
  const branches = (await r.json()).filter(b => /^(claude\/|ccr-)/.test(b.name));
  const seen = S.meta.importedBlobs || {};
  const byDate = new Map();
  for (const b of branches) {
    const list = await ghGet(PATHS.plans, b.name);
    for (const f of Array.isArray(list) ? list : []) {
      if (f.type !== 'file' || !/^\d{4}-\d{2}-\d{2}\.json$/.test(f.name) || seen[f.sha]) continue;
      if (S.plans.get(f.name.slice(0, -5))?.sha === f.sha) { seen[f.sha] = Date.now(); continue; }
      const date = f.name.slice(0, -5);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ branch: b, file: f });
    }
  }
  const commitDate = new Map();
  const dateOf = async b => {
    if (!commitDate.has(b.name)) {
      const c = await ghFetch('GET', `${repoUrl()}/commits/${b.commit.sha}`);
      commitDate.set(b.name, c.ok ? (await c.json()).commit.committer.date : '');
    }
    return commitDate.get(b.name);
  };
  let imported = 0;
  for (const [date, cands] of byDate) {
    for (const c of cands) c.when = await dateOf(c.branch);
    cands.sort((a, b) => b.when.localeCompare(a.when));
    const best = cands[0];
    const { text } = await ghGetText(best.file.path, best.branch.name);
    try { JSON.parse(text); } catch { cands.forEach(c => { seen[c.file.sha] = Date.now(); }); continue; }
    await ghWrite(`${PATHS.plans}/${date}.json`, () => text, `План тренировки ${date} из ветки ${best.branch.name}`);
    cands.forEach(c => { seen[c.file.sha] = Date.now(); });
    imported++;
  }
  S.meta.importedBlobs = seen;
  await saveMeta();
  return imported;
}

async function pullAll() {
  if (!S.settings.token) throw new Error('Укажите токен в настройках');
  try { await importBranchPlans(); } catch (e) { console.warn('Планы из веток claude/:', e); }
  const list = await ghGet(PATHS.plans);
  // Планы, которых больше нет в GitHub (удалены или перенесены на другой день), убираем из телефона.
  // Начатое занятие по такому плану остаётся — факт важнее.
  if (Array.isArray(list) || list === null) {
    const remote = new Set((list || []).filter(f => f.type === 'file').map(f => f.name.replace(/\.json$/, '')));
    for (const date of [...S.plans.keys()]) {
      if (remote.has(date)) continue;
      S.plans.delete(date);
      await db.del('plan:' + date);
      const s = S.sessions.get(date);
      if (s && s.status === 'planned') { S.sessions.delete(date); await db.del('session:' + date); }
    }
  }
  for (const f of Array.isArray(list) ? list : []) {
    if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
    const date = f.name.slice(0, -5);
    const cached = S.plans.get(date);
    if (cached && cached.sha === f.sha) continue;
    const { text } = await ghGetText(f.path);
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    const p = { date, sha: f.sha, data };
    S.plans.set(date, p);
    await savePlan(p);
    const s = S.sessions.get(date);
    if (s && s.plan_sha !== f.sha) {
      if (s.status === 'planned') {
        const fresh = sessionFromPlan(p);
        S.sessions.set(date, fresh);
        await saveSession(fresh);
      } else {
        s.plan_update = f.sha;
        await saveSession(s);
      }
    }
  }
  if (!S.catalog.dirty) {
    const { text, sha } = await ghGetText(PATHS.exercises);
    if (text && sha !== S.catalog.sha) {
      try {
        const j = JSON.parse(text);
        S.catalog = { list: Array.isArray(j) ? j : (j.exercises || []), sha, dirty: false };
        await saveCatalog();
      } catch { /* битый справочник не мешает работе */ }
    }
  }
  try { await pullCheckins(); } catch (e) { console.warn('morning.csv:', e); }
  // Занятия, которых нет в телефоне (например, после переустановки).
  const sess = await ghGet(PATHS.sessions);
  for (const f of Array.isArray(sess) ? sess : []) {
    if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
    const id = f.name.slice(0, -5);
    const local = S.sessions.get(id);
    if (local && local.status !== 'planned') continue;
    if (pendingDeletes().some(d => d.id === id)) continue;   // сброшено, удаление ещё не дошло
    const { text } = await ghGetText(f.path);
    try {
      const data = JSON.parse(text);
      const s = { ...data, id, sync: { dirty: false, mdDirty: false, ver: 0, sha: f.sha, sentAt: null, error: null } };
      S.sessions.set(id, s);
      await saveSession(s);
    } catch { /* пропускаем */ }
  }
  S.meta.lastPull = Date.now();
  await saveMeta();
}

function applyPlanUpdate(s) {
  const p = S.plans.get(s.plan_date);
  if (!p) return;
  const fresh = sessionFromPlan(p);
  for (const fe of fresh.exercises) {
    const cur = s.exercises.find(x => x.id === fe.id && x.origin === 'plan');
    if (!cur) { s.exercises.push(fe); continue; }
    const doneCount = cur.sets.filter(x => x.done).length;
    cur.sets = cur.sets.filter(x => x.done).concat(fe.sets.slice(doneCount));
    cur.note = fe.note;
    cur.rest_s = fe.rest_s;
  }
  s.title = fresh.title;
  s.note = fresh.note;
  s.plan_sha = p.sha;
  delete s.plan_update;
  touch(s);
}

/* ---------- маршруты и общая разметка ---------- */

const $ = sel => document.querySelector(sel);
const view = $('#view');

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('s/')) return { name: 'session', id: decodeURIComponent(h.slice(2)) };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'checkin') return { name: 'checkin' };
  return { name: 'list' };
}
const go = hash => { location.hash = hash; };

function renderSync() {
  const el = $('#sync');
  const pending = [...S.sessions.values()].filter(s => s.status !== 'planned' && (s.sync.dirty || s.sync.mdDirty));
  const hasPending = pending.length > 0 || pendingDeletes().length > 0 || [...S.checkins.values()].some(c => c.dirty);
  el.className = 'sync';
  el.onclick = null;
  if (syncing) { el.textContent = 'отправка…'; return; }
  if (S.meta.lastError && hasPending) {
    el.textContent = 'ошибка — повторить';
    el.classList.add('err');
    el.onclick = () => syncAll();
    return;
  }
  if (hasPending) { el.textContent = 'сохранено в телефоне'; el.onclick = () => syncAll(); return; }
  if (S.meta.lastSync) { el.textContent = `отправлено в ${hhmm(new Date(S.meta.lastSync))}`; el.classList.add('ok'); return; }
  el.textContent = '';
}

let toastTimer;
function toast(text, actionLabel, action, ms = 5000) {
  const t = $('#toast');
  t.innerHTML = `<span class="grow">${esc(text)}</span>` + (actionLabel ? `<button class="primary">${esc(actionLabel)}</button>` : '');
  t.hidden = false;
  if (actionLabel) t.querySelector('button').onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function openSheet(html, bind) {
  const sh = $('#sheet'), bg = $('#sheet-bg');
  sh.innerHTML = html;
  sh.hidden = bg.hidden = false;
  bg.onclick = closeSheet;
  bind && bind(sh);
}
function closeSheet() { $('#sheet').hidden = $('#sheet-bg').hidden = true; $('#sheet').innerHTML = ''; }

function render() {
  const r = route();
  $('#back').hidden = r.name === 'list';
  $('#gear').hidden = r.name === 'settings';
  closeSheet();
  if (r.name === 'settings') renderSettings();
  else if (r.name === 'session') renderSession(r.id);
  else if (r.name === 'checkin') renderCheckin();
  else renderList();
  renderSync();
  updateWakeLock();
}

/* ---------- экран 1: список занятий ---------- */

function renderList() {
  $('#title').textContent = 'Счёты';
  const today = localDate();
  const items = new Map();
  for (const p of S.plans.values()) items.set(p.date, { id: p.date, date: p.data.date || p.date, title: p.data.title, state: { cls: 'plan', text: 'план' } });
  for (const s of S.sessions.values()) items.set(s.id, { id: s.id, date: s.date, title: s.title, state: sessionState(s), s });
  const all = [...items.values()];
  const ahead = all.filter(x => x.date >= today && (!x.s || x.s.status !== 'done')).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const past = all.filter(x => !ahead.includes(x)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  const banners = [];
  if (!S.settings.token) banners.push(`<div class="banner">Нет токена GitHub — планы не придут, занятия не уйдут. <a href="#/settings">Настройки</a></div>`);
  const exp = tokenExpiry();
  if (exp != null && exp < TOKEN_WARN_DAYS) banners.push(`<div class="banner ${exp < 3 ? 'err' : ''}">Токен GitHub истекает через ${Math.max(0, Math.ceil(exp))} ${plural(Math.max(0, Math.ceil(exp)), 'день', 'дня', 'дней')}. Выпустите новый и вставьте в настройках.</div>`);
  if (S.meta.lastError) banners.push(`<div class="banner err">Последняя отправка: ${esc(S.meta.lastError)}</div>`);

  const li = x => `<button class="list-item" data-id="${esc(x.id)}">
      <span class="grow"><span class="t">${dmy(x.date)}</span> <span class="muted">${esc(x.title || '')}</span></span>
      <span class="badge ${x.state.cls}">${x.state.text}</span></button>`;

  const ci = S.checkins.get(today);
  const ciText = ci
    ? [ci.weight_kg !== '' ? `${fmtUi(ci.weight_kg)} кг` : '', ci.readiness !== '' ? `готовность ${esc(ci.readiness)}` : '', ci.sleep_quality !== '' ? `сон ${esc(ci.sleep_quality)}` : ''].filter(Boolean).join(' · ')
    : 'вес, готовность, боли, сон';
  view.innerHTML = `${banners.join('')}
    <button id="checkin" class="list-item">
      <span class="grow"><span class="t">☀️ Чек-ин</span> <span class="muted">${ciText}</span></span>
      <span class="badge ${ci ? (ci.dirty ? 'unsent' : 'done') : 'plan'}">${ci ? (ci.dirty ? 'не отправлено' : 'сделано') : 'сегодня'}</span></button>
    <div class="row">
      <button id="refresh" class="grow">Обновить</button>
      <button id="blank" class="grow">Новое занятие без плана</button>
    </div>
    ${S.settings.pcBot ? `<a class="btn" href="${pcLink('run')}" style="margin-top:8px">⌚ Обновить данные Garmin (бот на ПК)</a>` : ''}
    ${ahead.length ? `<h2>Впереди</h2>${ahead.map(li).join('')}` : `<p class="muted">Планов пока нет. Claude кладёт их в <code>${PATHS.plans}/</code>.</p>`}
    ${past.length ? `<h2>Прошедшие</h2>${past.slice(0, PAST_SHOWN).map(li).join('')}` : ''}
    ${past.length > PAST_SHOWN ? `<details class="more"><summary>Ещё прошедшие: ${past.length - PAST_SHOWN}</summary>${past.slice(PAST_SHOWN).map(li).join('')}</details>` : ''}`;

  view.querySelectorAll('.list-item[data-id]').forEach(b => b.onclick = () => go('#/s/' + encodeURIComponent(b.dataset.id)));
  $('#checkin').onclick = () => go('#/checkin');
  $('#refresh').onclick = async e => {
    e.target.disabled = true;
    e.target.textContent = 'Загрузка…';
    try { await pullAll(); await syncAll(); toast('Обновлено'); }
    catch (err) { toast(err.message || String(err)); }
    render();
  };
  $('#blank').onclick = () => {
    const s = newBlankSession();
    S.sessions.set(s.id, s);
    saveSession(s);
    scheduleSync(SYNC_DELAY_MS);
    go('#/s/' + encodeURIComponent(s.id));
    setTimeout(() => openPicker(s, null), 50);
  };
}

/* ---------- экран чек-ина ---------- */

function scale(id, label, value) {
  const btns = Array.from({ length: 10 }, (_, i) => i + 1)
    .map(n => `<button data-v="${n}" class="${String(value) === String(n) ? 'primary' : ''}">${n}</button>`).join('');
  return `<label>${label}</label><div class="scale" id="${id}" data-v="${esc(value ?? '')}">${btns}</div>`;
}

function renderCheckin() {
  const date = localDate();
  $('#title').textContent = 'Чек-ин ' + dmy(date);
  const c = S.checkins.get(date) || {};
  const w = c.weight_kg !== undefined && c.weight_kg !== '' ? num(c.weight_kg) : lastWeight();
  view.innerHTML = `
    ${stepper('c-weight', 'Вес, кг', w, 0.1, true)}
    ${scale('c-ready', 'Готовность', c.readiness)}
    <label for="c-pain">Травмы, боли, дискомфорт</label>
    <div class="row"><input id="c-pain" class="grow" value="${esc(c.discomfort ?? '')}" placeholder="нет"><button id="c-nopain">0</button></div>
    ${scale('c-sleep', 'Качество сна', c.sleep_quality)}
    <button id="c-save" class="primary" style="width:100%;margin-top:20px">Сохранить</button>
    ${c.recorded_at ? `<p class="muted small">Записано ${esc(c.recorded_at.replace('T', ' '))}${c.dirty ? ', ещё не отправлено' : ''}.</p>` : ''}`;
  view.querySelectorAll('.stepper button').forEach(b => b.onclick = () => {
    const inp = $('#' + b.dataset.for);
    const cur = num(inp.value.replace(',', '.')) ?? lastWeight() ?? 80;
    inp.value = fmtUi(Math.max(0, +(cur + +b.dataset.d).toFixed(1)));
  });
  view.querySelectorAll('.scale').forEach(sc => sc.querySelectorAll('button').forEach(b => b.onclick = () => {
    const same = sc.dataset.v === b.dataset.v;
    sc.dataset.v = same ? '' : b.dataset.v;
    sc.querySelectorAll('button').forEach(x => x.classList.toggle('primary', x.dataset.v === sc.dataset.v));
  }));
  $('#c-nopain').onclick = () => { $('#c-pain').value = '0'; };
  $('#c-save').onclick = () => {
    const raw = $('#c-weight').value.trim().replace(',', '.');
    const wv = raw === '' ? '' : num(raw);
    if (wv === null || (wv !== '' && wv <= 0)) { toast('Не понял вес. Число, например 82,5, или пусто.'); return; }
    const now = new Date();
    const entry = {
      date,
      weight_kg: wv === '' ? '' : fmtNum(wv),
      readiness: $('#c-ready').dataset.v,
      discomfort: $('#c-pain').value.trim(),
      sleep_quality: $('#c-sleep').dataset.v,
      recorded_at: `${date}T${hhmm(now)}`,
      dirty: true,
      ver: (c.ver || 0) + 1,
    };
    S.checkins.set(date, entry);
    saveCheckin(entry);
    sound.click(1, 0.8);
    syncAll();
    go('#/');
    toast('Чек-ин сохранён');
  };
}

function tokenExpiry() {
  if (!S.meta.tokenExp) return null;
  const t = Date.parse(S.meta.tokenExp.replace(' UTC', 'Z').replace(' ', 'T'));
  return isNaN(t) ? null : (t - Date.now()) / 86_400_000;
}

/* ---------- экран 2: занятие ---------- */

let current = null;

function getSession(id) {
  let s = S.sessions.get(id);
  if (!s) {
    const p = S.plans.get(id);
    if (!p) return null;
    s = sessionFromPlan(p);
    S.sessions.set(id, s);
    saveSession(s);
  }
  return s;
}

function startIfNeeded(s) {
  if (s.status === 'planned') {
    s.status = 'in_progress';
    s.started_at = localIso();
  }
}

function renderSession(id) {
  const s = getSession(id);
  if (!s) { view.innerHTML = '<p class="muted">Занятие не найдено.</p>'; return; }
  current = s;
  $('#title').textContent = `${dmy(s.date)} ${s.title || ''}`;
  const parts = [];
  parts.push(progressBar(s));
  if (s.plan_update) parts.push(`<div class="banner">План обновлён Claude. <button id="apply-plan" class="primary">Применить к невыполненным подходам</button></div>`);
  if (s.note) parts.push(`<div class="banner">${esc(s.note)}</div>`);
  if (s.status === 'planned') parts.push(`<button id="start" class="primary" style="width:100%;margin-bottom:12px">Начать занятие</button>`);
  let prevCircuit = null;
  s.exercises.forEach((e, i) => {
    if (e.circuit && e.circuit !== prevCircuit) {
      parts.push(`<div class="circuit-label">${esc(e.circuit_name || (e.circuit === 'core' ? 'Кор' : e.circuit))} · круговой${e.rounds ? `, ${e.rounds} ${plural(e.rounds, 'круг', 'круга', 'кругов')}` : ''}</div>`);
    }
    prevCircuit = e.circuit || null;
    parts.push(exCard(e, i));
  });
  parts.push(`<button id="add-ex" style="width:100%">+ упражнение</button>`);
  parts.push(`<label for="snote">Заметка к занятию</label><textarea id="snote" placeholder="самочувствие, что мешало…">${esc(s.session_note)}</textarea>`);
  if (s.status === 'done') {
    parts.push(`<h2>Текст занятия</h2><pre class="text">${esc(buildText(s))}</pre>
      <div class="row"><button id="copy" class="grow">Скопировать</button><button id="resend" class="grow">Отправить сейчас</button></div>`);
  } else {
    parts.push(`<button id="finish" class="primary" style="width:100%;margin-top:16px">Завершить занятие</button>`);
  }
  if (S.settings.pcBot && s.status !== 'done' && s.plan_date && S.plans.has(s.plan_date)) {
    parts.push(`<a class="btn" href="${pcLink('push_' + s.plan_date)}" style="margin-top:8px">⌚ Тренировка на часы Garmin (бот на ПК)</a>`);
  }
  if (s.status === 'planned' && s.plan_date && S.plans.has(s.plan_date)) {
    parts.push(`<button id="delplan" class="danger" style="width:100%;margin-top:32px">Удалить план</button>`);
  }
  if (s.status !== 'planned') {
    parts.push(`<button id="reset" class="danger" style="width:100%;margin-top:32px">${s.plan_date && S.plans.has(s.plan_date) ? 'Сбросить к плану' : 'Удалить занятие'}</button>`);
  }
  view.innerHTML = parts.join('');
  view.querySelectorAll('.rod').forEach(layoutRod);
  bindSession(s);
}

/** Время с начала занятия (до завершения — идёт) и доля сделанных подходов по всем упражнениям. */
function elapsedText(s) {
  if (!s.started_at) return '0:00';
  const end = s.finished_at ? Date.parse(s.finished_at) : Date.now();
  const sec = Math.max(0, Math.round((end - Date.parse(s.started_at)) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}
function progressBar(s) {
  const sets = s.exercises.filter(e => e.origin !== 'removed').flatMap(e => e.sets);
  const done = sets.filter(x => x.done).length;
  const pct = sets.length ? Math.round(done / sets.length * 100) : 0;
  return `<div class="progress">
    <div class="row small"><span class="grow">⏱ <b id="elapsed">${elapsedText(s)}</b></span><span>${done} из ${sets.length} ${plural(sets.length, 'подхода', 'подходов', 'подходов')} · ${pct}%</span></div>
    <div class="bar"><div style="width:${pct}%"></div></div></div>`;
}
// Блок времени и прогресса прилипает под шапкой; её высота зависит от выреза экрана и шрифта.
new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', $('#top').offsetHeight + 'px')).observe($('#top'));
// Тикаем только числом на экране, без перерисовки занятия.
setInterval(() => {
  const el = document.getElementById('elapsed');
  if (el && current && current.status === 'in_progress') el.textContent = elapsedText(current);
}, 1000);

function exCard(e, i) {
  const removed = e.origin === 'removed';
  const tag = e.origin === 'added' ? 'добавлено' : e.origin === 'replaced' ? `вместо: ${esc(e.replaces?.name || '')}` : removed ? 'пропущено' : '';
  return `<div class="ex ${removed ? 'removed' : ''}" data-i="${i}">
    <div class="ex-head">
      <div class="name">${esc(e.name)}${tag ? `<span class="tag">${tag}</span>` : ''}</div>
      <button class="icon ex-menu" aria-label="Меню упражнения">⋮</button>
    </div>
    ${e.note ? `<div class="ex-note">${esc(e.note)}</div>` : ''}
    ${e.user_note ? `<div class="ex-unote">${esc(e.user_note)}</div>` : ''}
    ${removed ? '' : `<div class="rod" data-i="${i}">${e.sets.map((x, k) => `<div class="bead" data-k="${k}"></div>`).join('')}</div>
    <div class="ex-foot"><span class="muted small">${e.sets.filter(x => x.done).length} из ${e.sets.length}${e.rest_s ? ` · отдых ${e.rest_s} с` : ''}</span>
      <button class="ghost add-set">+ подход</button></div>`}
  </div>`;
}

const doneLeft = () => S.settings.doneSide !== 'right';

/** Расставить костяшки: сделанные прижаты к своей стороне, остальные — к противоположной. */
function layoutRod(rod) {
  const e = current.exercises[+rod.dataset.i];
  const W = rod.clientWidth;
  const n = e.sets.length;
  const gap = 6;
  const w = Math.max(30, Math.min(88, (W * 0.85 - gap * (n - 1)) / n));
  const doneIdx = e.sets.map((x, k) => x.done ? k : -1).filter(k => k >= 0);
  const openIdx = e.sets.map((x, k) => x.done ? -1 : k).filter(k => k >= 0);
  const pos = new Array(n);
  doneIdx.forEach((k, j) => { pos[k] = j * (w + gap); });
  openIdx.forEach((k, j) => { pos[k] = W - w - (openIdx.length - 1 - j) * (w + gap); });
  rod._geo = { W, w, gap, pos: doneLeft() ? pos : pos.map(x => W - w - x) };
  rod.querySelectorAll('.bead').forEach(b => {
    const k = +b.dataset.k, set = e.sets[k];
    const label = setLabel(e.type, set.fact, e.per_side);
    b.textContent = label;
    b.style.width = w + 'px';
    b.style.left = rod._geo.pos[k] + 'px';
    b.style.transform = '';
    b.style.fontSize = w < 58 ? '11px' : '';
    b.classList.toggle('done', set.done);
    b.classList.toggle('dev', !sameFact(set.fact, set.plan) && !!set.plan);
  });
}

function bindSession(s) {
  const rerender = () => { const y = scrollY; renderSession(s.id); scrollTo(0, y); };
  $('#start') && ($('#start').onclick = () => { startIfNeeded(s); touch(s); rerender(); });
  $('#apply-plan') && ($('#apply-plan').onclick = () => { applyPlanUpdate(s); rerender(); });
  $('#add-ex').onclick = () => openPicker(s, null);
  $('#snote').onchange = e => { s.session_note = e.target.value; touch(s); };
  if ($('#finish')) $('#finish').onclick = () => finishSession(s);
  if ($('#copy')) $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(buildText(s)); toast('Текст скопирован'); }
    catch { toast('Не удалось скопировать — выделите текст вручную'); }
  };
  if ($('#resend')) $('#resend').onclick = () => { s.sync.dirty = s.sync.mdDirty = true; saveSession(s); syncAll(); };
  if ($('#delplan')) $('#delplan').onclick = async () => {
    if (!confirm(`Удалить план на ${s.plan_date.slice(8, 10)}.${s.plan_date.slice(5, 7)}? Файл плана в GitHub будет удалён.`)) return;
    try {
      await deletePlan(s.plan_date);
      toast('План удалён');
      go('#/');
    } catch (e) { toast('Не удалось: ' + e.message); }
  };
  if ($('#reset')) $('#reset').onclick = async () => {
    const toPlan = s.plan_date && S.plans.has(s.plan_date);
    const what = toPlan
      ? 'Сбросить занятие к плану? Все отметки и правки пропадут'
      : 'Удалить занятие? Все отметки пропадут';
    if (!confirm(`${what}, файл занятия в GitHub${s.md_header ? ' и запись в workouts.md' : ''} будут удалены.`)) return;
    const kept = await resetSession(s);
    toast(kept ? 'Занятие сброшено к плану' : 'Занятие удалено');
    if (kept) renderSession(s.id); else go('#/');
  };
  view.querySelectorAll('.ex-menu').forEach(b => b.onclick = () => openExMenu(s, +b.closest('.ex').dataset.i, rerender));
  view.querySelectorAll('.add-set').forEach(b => b.onclick = () => {
    const e = s.exercises[+b.closest('.ex').dataset.i];
    const last = e.sets[e.sets.length - 1];
    const fact = last ? clone(last.fact) : (lastFactFor(e.id) || defaultFact(e.type));
    e.sets.push({ plan: null, fact, done: false, note: '' });
    touch(s);
    rerender();
  });
  view.querySelectorAll('.rod').forEach(rod => bindRod(s, rod, rerender));
}

function finishSession(s) {
  const now = new Date();
  startIfNeeded(s);
  s.status = 'done';
  s.finished_at = localIso(now);
  s.md_header = s.md_header || `## ${s.date} ${hhmm(now)}`;
  stopTimer();
  touch(s);
  syncAll();
  renderSession(s.id);
  scrollTo(0, document.body.scrollHeight);
}

/* ---------- жесты на спице ---------- */

function bindRod(s, rod, rerender) {
  const e = s.exercises[+rod.dataset.i];
  let g = null;

  const beadsOf = ks => ks.map(k => rod.querySelector(`.bead[data-k="${k}"]`));

  rod.addEventListener('pointerdown', ev => {
    const b = ev.target.closest('.bead');
    if (!b) return;
    const k = +b.dataset.k;
    sound.unlock();   // браузер разрешает звук только после жеста пользователя
    g = { k, x0: ev.clientX, y0: ev.clientY, t0: Date.now(), id: ev.pointerId, drag: false, cancel: false, long: false, crossed: 0 };
    g.lp = setTimeout(() => { if (g && !g.drag) { g.long = true; openSetEditor(s, e, k, rerender); } }, 550);
  });

  rod.addEventListener('pointermove', ev => {
    if (!g || g.id !== ev.pointerId || g.cancel) return;
    const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
    if (!g.drag) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g.cancel = true; clearTimeout(g.lp); return; }
      if (Math.abs(dx) < 10) return;
      clearTimeout(g.lp);
      const towardDone = (dx < 0) === doneLeft();
      const set = e.sets[g.k];
      if (set.done === towardDone) { g.cancel = true; return; }  // некуда двигать
      g.drag = true;
      g.toDone = towardDone;
      // Толкаем соседей, как на настоящих счётах.
      g.group = set.done
        ? e.sets.map((x, k) => (x.done && k >= g.k) ? k : -1).filter(k => k >= 0)
        : e.sets.map((x, k) => (!x.done && k <= g.k) ? k : -1).filter(k => k >= 0);
      g.els = beadsOf(g.group);
      g.els.forEach(el => el.classList.add('dragging'));
      const geo = rod._geo;
      // Максимальный ход — до упора в противоположную группу.
      const target = groupTargets(e, g.group, g.toDone, geo);
      g.travel = Math.min(...g.group.map((k, j) => Math.abs(target[j] - geo.pos[k])));
      try { rod.setPointerCapture(ev.pointerId); } catch { /* синтетический указатель */ }
    }
    const dir = dx < 0 ? -1 : 1;
    const shift = dir * Math.min(Math.abs(dx), g.travel);
    const geo = rod._geo;
    let crossed = 0;
    g.els.forEach((el, j) => {
      el.style.transform = `translateX(${shift}px)`;
      const c0 = geo.pos[g.group[j]] + geo.w / 2, c1 = c0 + shift;
      if ((c0 - geo.W / 2) * (c1 - geo.W / 2) < 0) crossed++;
    });
    if (crossed > g.crossed) {
      if (navigator.vibrate) navigator.vibrate(15);
      sound.click(0.5, 1.15);
    }
    g.crossed = crossed;
    g.shift = shift;
  });

  const end = ev => {
    if (!g || g.id !== ev.pointerId) return;
    clearTimeout(g.lp);
    const st = g;
    g = null;
    if (st.drag) {
      st.els.forEach(el => el.classList.remove('dragging'));
      if (ev.type !== 'pointercancel' && Math.abs(st.shift || 0) >= Math.min(40, st.travel * 0.35)) {
        for (const k of st.group) e.sets[k].done = st.toDone;
        // Стук костяшек о ряд: по щелчку на каждую, сделанные — ниже и громче.
        sound.clack(st.group.length, st.toDone);
        if (st.toDone) {
          startIfNeeded(s);
          afterSetDone(s, e);
          if (navigator.vibrate) navigator.vibrate(30);
        }
        touch(s);
        rerender();
      } else {
        layoutRod(rod);
      }
      return;
    }
    if (!st.cancel && !st.long && ev.type === 'pointerup' && Date.now() - st.t0 < 500) openSetEditor(s, e, st.k, rerender);
  };
  rod.addEventListener('pointerup', end);
  rod.addEventListener('pointercancel', end);
  rod.addEventListener('contextmenu', ev => ev.preventDefault());
}

function groupTargets(e, group, toDone, geo) {
  // Позиции группы после переноса: прижата к краю своей новой стороны вплотную к уже лежащим там костяшкам.
  const n = e.sets.length, step = geo.w + geo.gap;
  const left = doneLeft();
  if (toDone) {
    const already = e.sets.filter(x => x.done).length;
    return group.map((_, j) => {
      const p = (already + j) * step;
      return left ? p : geo.W - geo.w - p;
    });
  }
  const stay = e.sets.filter(x => !x.done).length;
  return group.map((_, j) => {
    const p = geo.W - geo.w - (stay + group.length - 1 - j) * step;
    return left ? p : geo.W - geo.w - p;
  });
}

/* ---------- правка подхода ---------- */

function stepper(id, label, value, step, allowEmpty) {
  return `<label for="${id}">${label}</label>
    <div class="stepper"><button data-for="${id}" data-d="${-step}">−</button>
    <input id="${id}" inputmode="decimal" value="${value == null ? '' : fmtUi(value)}" ${allowEmpty ? 'placeholder="—"' : ''}>
    <button data-for="${id}" data-d="${step}">+</button></div>`;
}

function openSetEditor(s, e, k, rerender) {
  const set = e.sets[k];
  const t = e.type;
  const f = set.fact;
  const fields = [];
  if (t === 'weight_reps') fields.push(stepper('f-weight', 'Вес, кг', f.weight, stepOf(e)));
  if (t === 'added_weight_reps') fields.push(stepper('f-weight', 'Доп. вес, кг (минус — ассист)', f.weight, stepOf(e)));
  if (t !== 'time') fields.push(stepper('f-reps', e.per_side ? 'Повторы на сторону' : 'Повторы', f.reps, 1));
  if (t === 'weight_reps' || t === 'added_weight_reps') fields.push(stepper('f-rir', 'RIR', f.rir, 1, true));
  if (t === 'time') fields.push(stepper('f-sec', 'Секунды', f.sec, 5));
  const planText = set.plan ? `План: ${setLabel(t, set.plan, e.per_side)}${set.plan.rir != null ? ` RIR ${set.plan.rir}` : ''}` : 'Подход вне плана';
  openSheet(`<h3>${esc(e.name)} · подход ${k + 1}</h3>
    <div class="muted small">${planText}</div>
    ${fields.join('')}
    <label for="f-note">Заметка</label><input id="f-note" value="${esc(set.note)}">
    <div class="row" style="margin-top:14px">
      ${set.done ? `<button id="f-undo" class="grow">Не сделан</button>` : ''}
      <button id="f-save" class="grow ${set.done ? 'primary' : ''}">Сохранить</button>
      ${set.done ? '' : `<button id="f-done" class="grow primary">Сделан</button>`}
    </div>
    <div class="row" style="margin-top:8px">
      <button id="f-del" class="danger grow">Удалить подход</button>
    </div>`, sh => {
    sh.querySelectorAll('.stepper button').forEach(b => b.onclick = () => {
      const inp = sh.querySelector('#' + b.dataset.for);
      const cur = num(inp.value.replace(',', '.')) ?? 0;
      let v = +(cur + +b.dataset.d).toFixed(2);
      if (b.dataset.for !== 'f-weight' || t === 'weight_reps') v = Math.max(0, v);
      inp.value = fmtUi(v);
    });
    const read = () => {
      const g = id => { const el = sh.querySelector(id); return el ? num(el.value.replace(',', '.')) : undefined; };
      const nf = { ...f };
      if (g('#f-weight') !== undefined) nf.weight = g('#f-weight') ?? 0;
      if (g('#f-reps') !== undefined) nf.reps = g('#f-reps') ?? 0;
      if (g('#f-rir') !== undefined) nf.rir = g('#f-rir');
      if (g('#f-sec') !== undefined) nf.sec = g('#f-sec') ?? 0;
      return nf;
    };
    const apply = done => {
      const old = set.fact;
      set.fact = read();
      // Изменённые вес/повторы/секунды сразу переходят на все следующие несделанные подходы.
      const changed = ['weight', 'reps', 'sec'].filter(key => key in set.fact && set.fact[key] !== old[key]);
      set.note = sh.querySelector('#f-note').value.trim();
      if (done !== undefined) {
        // Отметка держит порядок счётов: сделанные — сплошной ряд с начала.
        if (done) e.sets.forEach((x, j) => { if (j <= k) x.done = true; });
        else e.sets.forEach((x, j) => { if (j >= k) x.done = false; });
        if (done) {
          startIfNeeded(s);
          afterSetDone(s, e);
          sound.click(1, 0.8);
        }
      }
      const later = changed.length ? e.sets.filter((x, j) => j > k && !x.done) : [];
      const backup = later.map(x => x.fact);
      later.forEach(x => {
        x.fact = { ...x.fact };
        for (const key of changed) x.fact[key] = set.fact[key];
      });
      touch(s);
      closeSheet();
      rerender();
      if (later.length) {
        toast(`Так же в следующих подходах: ${later.length}`, 'Отменить', () => {
          later.forEach((x, j) => { if (!x.done) x.fact = backup[j]; });
          touch(s);
          rerender();
        }, 6000);
      }
    };
    sh.querySelector('#f-save').onclick = () => apply();
    sh.querySelector('#f-done') && (sh.querySelector('#f-done').onclick = () => apply(true));
    sh.querySelector('#f-undo') && (sh.querySelector('#f-undo').onclick = () => apply(false));
    sh.querySelector('#f-del').onclick = () => {
      e.sets.splice(k, 1);
      touch(s);
      closeSheet();
      rerender();
    };
  });
}

/* ---------- меню упражнения ---------- */

function openExMenu(s, i, rerender) {
  const e = s.exercises[i];
  const removed = e.origin === 'removed';
  openSheet(`<h3>${esc(e.name)}</h3><div class="menu">
    ${removed ? '<button data-a="restore">Вернуть</button>' : '<button data-a="replace">Заменить</button><button data-a="skip">Пропустить</button>'}
    <button data-a="up" ${i === 0 ? 'disabled' : ''}>Выше</button>
    <button data-a="down" ${i === s.exercises.length - 1 ? 'disabled' : ''}>Ниже</button>
    <button data-a="note">Заметка</button>
    ${e.origin === 'added' ? '<button data-a="delete" class="danger">Удалить</button>' : ''}
    <button data-a="close" class="ghost">Закрыть</button></div>`, sh => {
    sh.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'close') return closeSheet();
      if (a === 'replace') return openPicker(s, i);
      if (a === 'note') return openExNote(s, e, rerender);
      if (a === 'skip') { e.removed_origin = e.origin; e.origin = 'removed'; }
      if (a === 'restore') { e.origin = e.removed_origin || 'plan'; delete e.removed_origin; }
      if (a === 'up' && i > 0) [s.exercises[i - 1], s.exercises[i]] = [s.exercises[i], s.exercises[i - 1]];
      if (a === 'down' && i < s.exercises.length - 1) [s.exercises[i + 1], s.exercises[i]] = [s.exercises[i], s.exercises[i + 1]];
      if (a === 'delete') s.exercises.splice(i, 1);
      startIfNeeded(s);
      touch(s);
      closeSheet();
      rerender();
    });
  });
}

function openExNote(s, e, rerender) {
  openSheet(`<h3>Заметка: ${esc(e.name)}</h3>
    <textarea id="ex-note">${esc(e.user_note || '')}</textarea>
    <button id="ex-note-save" class="primary" style="width:100%;margin-top:10px">Сохранить</button>`, sh => {
    sh.querySelector('#ex-note-save').onclick = () => {
      e.user_note = sh.querySelector('#ex-note').value.trim();
      touch(s);
      closeSheet();
      rerender();
    };
    sh.querySelector('#ex-note').focus();
  });
}

/* ---------- экран 3: выбор упражнения ---------- */

function recentIds() {
  const seen = new Map();
  const list = [...S.sessions.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const s of list) {
    if (s.status === 'planned') continue;
    for (const e of s.exercises) if (e.origin !== 'removed' && !seen.has(e.id)) seen.set(e.id, s.date);
  }
  return seen;
}

function uniqueExId(s, base) {
  let id = base, n = 2;
  while (s.exercises.some(x => x.id === id)) id = `${base}_${n++}`;
  return id;
}

function openPicker(s, replaceIdx) {
  const recent = recentIds();
  const all = catalogAll().sort((a, b) => {
    const ra = recent.get(a.id) || '', rb = recent.get(b.id) || '';
    return rb.localeCompare(ra) || a.name.localeCompare(b.name, 'ru');
  });
  const title = replaceIdx == null ? 'Добавить упражнение' : `Заменить: ${esc(s.exercises[replaceIdx].name)}`;
  openSheet(`<h3>${title}</h3>
    <input id="q" placeholder="Поиск" autocomplete="off">
    <div id="picks" style="margin-top:10px"></div>`, sh => {
    const q = sh.querySelector('#q');
    const draw = () => {
      const text = q.value.trim().toLowerCase();
      const hits = all.filter(x => !text || x.name.toLowerCase().includes(text)).slice(0, 40);
      sh.querySelector('#picks').innerHTML = hits.map(x => `<button class="pick" data-id="${esc(x.id)}">
          <span>${esc(x.name)}</span><span class="muted small">${recent.has(x.id) ? dmy(recent.get(x.id)) : TYPES[x.type]}</span></button>`).join('') +
        (text ? `<button class="pick" id="create"><span>Создать «${esc(q.value.trim())}»</span><span class="muted small">новое</span></button>` : '');
      sh.querySelectorAll('.pick[data-id]').forEach(b => b.onclick = () => choose(all.find(x => x.id === b.dataset.id)));
      const c = sh.querySelector('#create');
      if (c) c.onclick = () => openCreate(s, replaceIdx, q.value.trim());
    };
    q.oninput = draw;
    draw();
    q.focus();
  });

  function choose(item) {
    addOrReplace(s, replaceIdx, item);
  }
}

function addOrReplace(s, replaceIdx, item) {
  const fact = lastFactFor(item.id) || defaultFact(item.type);
  const base = {
    id: uniqueExId(s, item.id), name: item.name, type: item.type,
    ...(item.per_side ? { per_side: true } : {}), ...(item.side_label ? { side_label: item.side_label } : {}),
    ...(item.step ? { step: item.step } : {}), user_note: '',
  };
  startIfNeeded(s);
  if (replaceIdx == null) {
    s.exercises.push({ ...base, origin: 'added', sets: [{ plan: null, fact: normSet(item.type, fact), done: false, note: '' }] });
  } else {
    const old = s.exercises[replaceIdx];
    const open = old.sets.filter(x => !x.done);
    const sets = (open.length ? open : [{}]).map(x => ({
      plan: null,
      fact: old.type === item.type && x.fact ? clone(x.fact) : normSet(item.type, fact),
      done: false, note: '',
    }));
    const hasDone = old.sets.some(x => x.done);
    if (hasDone) old.sets = old.sets.filter(x => x.done);
    else { old.removed_origin = old.origin; old.origin = 'removed'; }
    old.replaced_by = base.id;
    const repl = { ...base, origin: 'replaced', replaces: { id: old.id, name: old.name }, sets };
    if (old.circuit) Object.assign(repl, { circuit: old.circuit, rounds: old.rounds });
    if (old.rest_s) repl.rest_s = old.rest_s;
    s.exercises.splice(replaceIdx + 1, 0, repl);
  }
  touch(s);
  closeSheet();
  renderSession(s.id);
  if (replaceIdx == null) scrollTo(0, document.body.scrollHeight);
}

function openCreate(s, replaceIdx, name) {
  openSheet(`<h3>Новое упражнение</h3>
    <label for="c-name">Название</label><input id="c-name" value="${esc(name)}">
    <label for="c-type">Тип</label><select id="c-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <label for="c-step">Шаг веса, кг</label><input id="c-step" inputmode="decimal" value="2,5">
    <label class="row" style="color:var(--text)"><input id="c-side" type="checkbox" style="width:24px;min-height:24px"> на сторону</label>
    <button id="c-ok" class="primary" style="width:100%;margin-top:12px">Создать</button>`, sh => {
    sh.querySelector('#c-ok').onclick = () => {
      const nm = sh.querySelector('#c-name').value.trim();
      if (!nm) return;
      const type = sh.querySelector('#c-type').value;
      const item = { id: 'x_' + Date.now().toString(36), name: nm, type };
      const step = num(sh.querySelector('#c-step').value.replace(',', '.'));
      if (step && (type === 'weight_reps' || type === 'added_weight_reps')) item.step = step;
      if (sh.querySelector('#c-side').checked) item.per_side = true;
      S.catalog.list.push(item);
      S.catalog.dirty = true;
      saveCatalog();
      addOrReplace(s, replaceIdx, item);
    };
  });
}

/* ---------- экран 4: настройки ---------- */

function renderSettings() {
  $('#title').textContent = 'Настройки';
  const st = S.settings;
  const exp = tokenExpiry();
  view.innerHTML = `
    <label for="s-token">Токен GitHub (fine-grained, Contents: Read and write)</label>
    <input id="s-token" type="password" value="${esc(st.token)}" autocomplete="off" placeholder="github_pat_…">
    <div class="row" style="margin-top:8px"><button id="s-check" class="grow">Проверить</button><button id="s-show" class="grow">Показать</button></div>
    <div id="s-result" class="muted small" style="margin-top:6px">${exp != null ? `Токен действует ещё ${Math.ceil(exp)} дн.` : ''}</div>
    <label for="s-repo">Репозиторий данных</label>
    <div class="row"><input id="s-owner" value="${esc(st.owner)}"><span>/</span><input id="s-repo" value="${esc(st.repo)}"></div>
    <label class="row" style="color:var(--text);margin-top:16px"><input id="s-timer" type="checkbox" style="width:24px;min-height:24px" ${st.timer ? 'checked' : ''}> Таймер отдыха</label>
    <label class="row" style="color:var(--text)"><input id="s-sound" type="checkbox" style="width:24px;min-height:24px" ${st.sound ? 'checked' : ''}> Звук костяшек</label>
    <label for="s-side">Сделанные подходы сдвигаются</label>
    <select id="s-side"><option value="left" ${st.doneSide !== 'right' ? 'selected' : ''}>влево (свайп справа налево)</option><option value="right" ${st.doneSide === 'right' ? 'selected' : ''}>вправо (свайп слева направо)</option></select>
    <h2>Бот на ПК</h2>
    <label for="s-pcbot">Имя бота (без @) — для кнопок «Обновить данные Garmin» и «Тренировка на часы»</label>
    <input id="s-pcbot" value="${esc(st.pcBot)}" autocomplete="off" placeholder="имя_бота">
    <h2>Неотправленное</h2>
    <div id="s-pending" class="muted small"></div>
    <button id="s-sync" style="width:100%;margin-top:8px">Отправить всё неотправленное</button>
    <p class="muted small" style="margin-top:24px">Данные: ${esc(st.owner)}/${esc(st.repo)}, ветка ${esc(st.branch)}. Версия приложения ${APP_VERSION}. Планы — <code>${PATHS.plans}/</code>, факт — <code>${PATHS.sessions}/</code>, текст — <code>${PATHS.workouts}</code>.</p>`;
  const pending = [...S.sessions.values()].filter(s => s.status !== 'planned' && (s.sync.dirty || s.sync.mdDirty));
  const pendingCi = [...S.checkins.values()].filter(c => c.dirty).map(c => `чек-ин ${dmy(c.date)}`);
  const pendingAll = pending.map(s => `${dmy(s.date)}${s.sync.error ? ' — ' + s.sync.error : ''}`).concat(pendingCi);
  $('#s-pending').textContent = pendingAll.length ? pendingAll.join(', ') : 'Всё отправлено.';
  const persistField = () => {
    st.token = $('#s-token').value.trim();
    st.owner = $('#s-owner').value.trim() || DEFAULTS.owner;
    st.repo = $('#s-repo').value.trim() || DEFAULTS.repo;
    st.timer = $('#s-timer').checked;
    st.sound = $('#s-sound').checked;
    st.doneSide = $('#s-side').value;
    st.pcBot = $('#s-pcbot').value.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
    saveSettings();
  };
  ['#s-token', '#s-owner', '#s-repo', '#s-timer', '#s-sound', '#s-side', '#s-pcbot'].forEach(id => $(id).onchange = persistField);
  $('#s-sound').addEventListener('change', () => { if (st.sound) sound.clack(3, true); });
  $('#s-show').onclick = () => { const t = $('#s-token'); t.type = t.type === 'password' ? 'text' : 'password'; };
  $('#s-sync').onclick = () => { persistField(); syncAll(); };
  $('#s-check').onclick = async () => {
    persistField();
    const out = $('#s-result');
    out.textContent = 'Проверяю…';
    try {
      const r = await ghFetch('GET', repoUrl());
      if (!r.ok) throw new Error(r.status === 401 ? 'токен не принят (401)' : r.status === 404 ? 'репозиторий не виден этому токену (404)' : `ответ ${r.status}`);
      const j = await r.json();
      const canWrite = j.permissions ? j.permissions.push : null;
      const e = tokenExpiry();
      out.textContent = `Доступ есть: ${j.full_name}${canWrite === false ? ', но только чтение' : ''}.` + (e != null ? ` Токен действует ещё ${Math.ceil(e)} дн.` : ' Срок токена не указан.');
    } catch (err) {
      out.textContent = 'Ошибка: ' + (err.message || err);
    }
  };
}

/* ---------- таймер отдыха и экран ---------- */

/* ---------- звук костяшек ---------- */

/** Синтез деревянного щелчка через Web Audio: короткий тон с падением высоты + шумовая атака. Файлы не нужны. */
const sound = (() => {
  let ctx = null, noise = null;
  function ensure() {
    if (!S.settings.sound) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const len = Math.floor(ctx.sampleRate * 0.025);
      noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function noiseBand(c, t, type, f, q, vol) {
    const n = c.createBufferSource();
    n.buffer = noise;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    fl.Q.value = q;
    const g = c.createGain();
    g.gain.value = vol;
    n.connect(fl).connect(g).connect(out(c));
    n.start(t);
  }
  /**
   * Деревянная костяшка: глухой короткий «ток». Основа — шум через широкие полосы (без звенящих тонов),
   * тело — очень короткий тон с падением высоты, всё затухает за 20–40 мс.
   */
  function click(strength = 1, pitch = 1, delay = 0) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const f0 = 720 * pitch;
    // Тело: короткий «ток» без звона.
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 1.25, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.012);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * strength, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(out(c));
    o.start(t);
    o.stop(t + 0.05);
    // Древесина: шум в двух широких полосах.
    noiseBand(c, t, 'bandpass', f0, 3, 1.6 * strength);
    noiseBand(c, t, 'bandpass', f0 * 2.4, 2.5, 0.9 * strength);
    // Звонкая атака: дерево о дерево.
    noiseBand(c, t, 'highpass', 3000, 0.7, 0.35 * strength);
  }
  let master = null;
  function out(c) {
    // Общий выход через компрессор: громко и без хрипа, когда звуки накладываются.
    if (!master) {
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = c.createGain();
      master.gain.value = 0.9;
      master.connect(comp).connect(c.destination);
    }
    return master;
  }
  function tone(c, { f, f2, type = 'sine', t, dur, vol = 0.3, a = 0.005, lp }) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (lp) { const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
    node.connect(g).connect(out(c));
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  /** Несколько костяшек разом — один плотный удар ряда, а не дробь. */
  function clack(count, toDone) {
    if (count <= 1) return click(toDone ? 1 : 0.7, toDone ? 0.8 : 1);
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;
    const k = Math.min(1.3, 0.95 + count * 0.07);
    const p = toDone ? 0.88 : 1.12;
    // Плотная связка из 2–3 ударов за 20 мс: слышно как один удар ряда с деревянным перестуком.
    click(k, p);
    click(k * 0.7, p * 1.08, 0.009);
    if (count >= 3) click(k * 0.5, p * 0.94, 0.019);
    tone(c, { f: toDone ? 420 : 520, f2: toDone ? 300 : 380, t, dur: 0.06, vol: 0.18 * k, a: 0.001 });
  }
  return { unlock: ensure, click, clack };
})();

let timerEnd = 0, timerTick = null;
function startTimer(sec) {
  timerEnd = Date.now() + sec * 1000;
  $('#timer').hidden = false;
  clearInterval(timerTick);
  timerTick = setInterval(drawTimer, 250);
  drawTimer();
}
function drawTimer() {
  const left = Math.ceil((timerEnd - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(timerTick);
    $('#timer-left').textContent = 'Отдых окончен';
    if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
    setTimeout(stopTimer, 3000);
    return;
  }
  $('#timer-left').textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
}
function stopTimer() { clearInterval(timerTick); $('#timer').hidden = true; }
$('#timer-add').onclick = () => { timerEnd += 30_000; drawTimer(); };
$('#timer-stop').onclick = stopTimer;

/** После отметки подхода — таймер отдыха. */
function afterSetDone(s, e) {
  if (S.settings.timer) startTimer(e.rest_s || DEFAULT_REST_S);
}

let wakeLock = null;
async function updateWakeLock() {
  const want = route().name === 'session' && current && current.status !== 'done' && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}

/* ---------- запуск ---------- */

async function boot() {
  Object.assign(S.settings, (await db.get('settings')) || {});
  // Сигналы на часы через Telegram убраны (v17): токен бота больше не храним.
  if ('tgToken' in S.settings || 'tgChat' in S.settings || 'watch' in S.settings) {
    delete S.settings.tgToken; delete S.settings.tgChat; delete S.settings.watch; delete S.meta.tgOffset;
    await saveSettings();
  }
  S.meta = (await db.get('meta')) || {};
  S.catalog = (await db.get('catalog')) || S.catalog;
  for (const p of await db.all('plan:')) S.plans.set(p.date, p);
  for (const s of await db.all('session:')) S.sessions.set(s.id, s);
  for (const c of await db.all('checkin:')) S.checkins.set(c.date, c);

  $('#back').onclick = () => go('#/');
  $('#gear').onclick = () => go('#/settings');
  addEventListener('hashchange', render);
  addEventListener('online', () => syncAll());
  addEventListener('resize', () => { if (route().name === 'session') view.querySelectorAll('.rod').forEach(layoutRod); });
  document.addEventListener('visibilitychange', () => {
    updateWakeLock();
    if (document.visibilityState === 'hidden') syncAll();   // попытка отправить, пока вкладку не усыпили
  });

  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    // Новая версия встала — перезагрузиться сразу, а не со следующего открытия.
    // Посреди занятия не дёргаем: подхватится при выходе в список.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      const reload = () => { if (!reloaded) { reloaded = true; location.reload(); } };
      if (route().name === 'session') addEventListener('hashchange', reload, { once: true });
      else reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); }))
      .catch(() => {});
  }

  render();
  if (S.settings.token && navigator.onLine) {
    try { await pullAll(); } catch (e) { S.meta.lastError = e.message; }
    await syncAll();
    if (route().name !== 'session') render();
  }
}

boot();
