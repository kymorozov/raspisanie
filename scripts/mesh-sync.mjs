// Ежедневная выгрузка домашних заданий из МЭШ (school.mos.ru).
// Запускается GitHub Actions, результат — data/homework-mesh.json.
//
// Секреты репозитория:
//   MESH_TOKEN          — токен из входа на school.mos.ru (cookie aupd_token)
//   MESH_STUDENT_SASHA  — необязательно: id ученика, если автоопределение не сработало
//   MESH_STUDENT_VANYA  — необязательно: то же для Вани
//   MESH_PROFILE_ID     — необязательно: id родительского профиля
//
// Логи Actions в публичном репозитории видны всем, поэтому
// скрипт не печатает ни токен, ни имена, ни идентификаторы детей.

import fs from 'node:fs';

const OUT = 'data/homework-mesh.json';
const API = 'https://school.mos.ru/api/family/mobile/v1';
const DAYS_BACK = 14;
const DAYS_AHEAD = 21;
const token = (process.env.MESH_TOKEN || '').trim();

function readPrev() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
  catch { return { items: [] }; }
}

function save(obj) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2) + '\n');
}

// Дата по Москве со сдвигом в днях, формат YYYY-MM-DD
function mskIso(shiftDays = 0) {
  const d = new Date(Date.now() + 3 * 3600 * 1000 + shiftDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function jwtExp(t) {
  try {
    const part = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
}

function normDate(s) {
  if (!s) return null;
  s = String(s);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function materialUrl(m) {
  const u = Array.isArray(m.urls) && m.urls.length ? m.urls[0] : null;
  if (!u) return null;
  const s = typeof u === 'string' ? u : (u.url || u.link || null);
  return s && /^https?:\/\//.test(s) ? s : null;
}

async function api(path) {
  const headers = {
    'auth-token': token,
    'x-mes-subsystem': 'familymp',
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0 (raspisanie homework sync)'
  };
  if (process.env.MESH_PROFILE_ID) headers['profile-id'] = process.env.MESH_PROFILE_ID.trim();
  let r;
  try {
    r = await fetch(API + path, { headers, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    const c = err.cause || {};
    const e = new Error('Нет соединения с school.mos.ru: ' + (c.code || err.name || 'неизвестно') + (c.message ? ' — ' + c.message : ''));
    e.code = 'network';
    throw e;
  }
  if (r.status === 401 || r.status === 403) {
    const e = new Error('МЭШ отклонил токен (HTTP ' + r.status + ')');
    e.code = 'token_expired';
    throw e;
  }
  if (!r.ok) {
    const e = new Error('МЭШ ответил HTTP ' + r.status);
    e.code = 'http_error';
    throw e;
  }
  return r.json();
}

async function resolveKids() {
  const manual = [
    ['s', process.env.MESH_STUDENT_SASHA],
    ['v', process.env.MESH_STUDENT_VANYA]
  ].filter(([, id]) => id && id.trim());
  if (manual.length) return manual.map(([kid, id]) => ({ kid, id: id.trim() }));

  // Автоопределение по классу: 7-й — Саша, 10-й — Ваня
  const prof = await api('/profile');
  const children = prof.children || [];
  const kids = [];
  for (const c of children) {
    const level = c.class_level_id || parseInt(String(c.class_name || ''), 10);
    if (level === 7) kids.push({ kid: 's', id: String(c.id) });
    else if (level === 10) kids.push({ kid: 'v', id: String(c.id) });
  }
  console.log('Детей в аккаунте: ' + children.length + '; классы: ' +
    children.map(c => c.class_name || '?').join(', '));
  return kids;
}

async function main() {
  const prev = readPrev();
  const base = { updatedAt: new Date().toISOString(), range: { from: mskIso(-DAYS_BACK), to: mskIso(DAYS_AHEAD) } };

  if (!token) {
    save({ ...base, status: { ok: false, error: 'not_configured', message: 'Секрет MESH_TOKEN не задан' }, items: prev.items || [] });
    console.log('MESH_TOKEN не задан — пропускаю');
    return;
  }

  const tokenExp = jwtExp(token);
  try {
    const kids = await resolveKids();
    if (!kids.length) {
      const e = new Error('Не нашёл детей 7-го и 10-го класса. Задайте MESH_STUDENT_SASHA и MESH_STUDENT_VANYA');
      e.code = 'no_kids';
      throw e;
    }
    const items = [];
    for (const { kid, id } of kids) {
      const q = `/homeworks?student_id=${encodeURIComponent(id)}&from=${base.range.from}&to=${base.range.to}&sort_column=date&sort_direction=asc`;
      const j = await api(q);
      const list = j.payload || j.data || (Array.isArray(j) ? j : []);
      for (const h of list) {
        const due = normDate(h.date_prepared_for) || normDate(h.date) || normDate(h.lesson_date_time);
        const text = String(h.description || h.homework || '').trim();
        const materials = (h.materials || [])
          .map(m => ({ title: String(m.title || m.type_name || 'Материал').trim(), url: materialUrl(m) }))
          .filter(m => m.title);
        if (!due || (!text && !materials.length)) continue;
        const hid = h.homework_entry_student_id || h.homework_entry_id || h.homework_id || (due + ':' + text.slice(0, 20));
        items.push({
          id: 'm-' + kid + '-' + hid,
          src: 'mesh',
          kid,
          subject: String(h.subject_name || '').trim(),
          due,
          assigned: normDate(h.date_assigned_on),
          text,
          materials,
          done: !!h.is_done
        });
      }
      console.log(`Ученик ${kid}: заданий ${list.length}`);
    }
    items.sort((a, b) => a.due.localeCompare(b.due) || a.kid.localeCompare(b.kid) || a.subject.localeCompare(b.subject));
    save({ ...base, status: { ok: true, tokenExp }, items });
    console.log('Сохранено заданий: ' + items.length);
  } catch (e) {
    // Старые задания оставляем, чтобы приложение не опустело
    save({
      ...base,
      status: { ok: false, error: e.code || 'error', message: e.message, tokenExp, lastGood: prev.status && prev.status.ok ? prev.updatedAt : (prev.status && prev.status.lastGood) || null },
      items: prev.items || []
    });
    console.error('Ошибка: ' + e.message);
  }
}

main();
