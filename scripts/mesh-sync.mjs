// Выгрузка домашних заданий из МЭШ (school.mos.ru).
//
// Используется программой на MacBook (mac/mesh-mac.mjs): school.mos.ru
// не принимает соединения с зарубежных серверов, поэтому запускать
// выгрузку нужно с российского адреса.
//
// Можно запустить и вручную:  MESH_TOKEN=… node scripts/mesh-sync.mjs
// — результат запишется в data/homework-mesh.json.
//
// Скрипт не печатает ни токен, ни имена, ни идентификаторы детей.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://school.mos.ru/api/family/mobile/v1';
const DAYS_BACK = 14;
const DAYS_AHEAD = 21;
const UA = 'Mozilla/5.0 (raspisanie homework sync)';

// Дата по Москве со сдвигом в днях, формат YYYY-MM-DD
export function mskIso(shiftDays = 0) {
  const d = new Date(Date.now() + 3 * 3600 * 1000 + shiftDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

export function jwtExp(t) {
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

function netError(err) {
  const c = err.cause || {};
  const e = new Error('Нет соединения с school.mos.ru: ' + (c.code || err.name || 'неизвестно'));
  e.code = 'network';
  return e;
}

async function api(token, path, profileId) {
  const headers = { 'auth-token': token, 'x-mes-subsystem': 'familymp', 'accept': 'application/json', 'user-agent': UA };
  if (profileId) headers['profile-id'] = String(profileId).trim();
  let r;
  try {
    r = await fetch(API + path, { headers, signal: AbortSignal.timeout(30000) });
  } catch (err) { throw netError(err); }
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

// Продление токена: по ещё действующему токену МЭШ выдаёт новый.
// Возвращает {ok, token} или {ok:false, why}.
export async function refreshToken(token) {
  let r;
  try {
    r = await fetch('https://school.mos.ru/v2/token/refresh', {
      headers: { 'Authorization': 'Bearer ' + token, 'accept': '*/*', 'user-agent': UA },
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) { return { ok: false, why: netError(err).message }; }
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
  const body = (await r.text()).trim().replace(/^"|"$/g, '');
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(body)) return { ok: false, why: 'неожиданный ответ' };
  return { ok: true, token: body };
}

async function resolveKids(token, opts) {
  const manual = [['s', opts.sasha], ['v', opts.vanya]].filter(([, id]) => id && String(id).trim());
  if (manual.length) return manual.map(([kid, id]) => ({ kid, id: String(id).trim() }));
  // Автоопределение по классу: 7-й — Саша, 10-й — Ваня
  const prof = await api(token, '/profile', opts.profileId);
  const children = prof.children || [];
  const kids = [];
  for (const c of children) {
    const level = c.class_level_id || parseInt(String(c.class_name || ''), 10);
    if (level === 7) kids.push({ kid: 's', id: String(c.id) });
    else if (level === 10) kids.push({ kid: 'v', id: String(c.id) });
  }
  console.log('Детей в аккаунте: ' + children.length + '; классы: ' + children.map(c => c.class_name || '?').join(', '));
  return kids;
}

// Главная функция: никогда не бросает исключение, возвращает готовый JSON.
// prev — предыдущий JSON: при ошибке старые задания сохраняются.
export async function buildHomework({ token, profileId, sasha, vanya, prev = { items: [] } }) {
  const base = { updatedAt: new Date().toISOString(), range: { from: mskIso(-DAYS_BACK), to: mskIso(DAYS_AHEAD) } };
  if (!token) {
    return { ...base, status: { ok: false, error: 'not_configured', message: 'Токен МЭШ не задан' }, items: prev.items || [] };
  }
  const tokenExp = jwtExp(token);
  try {
    const kids = await resolveKids(token, { profileId, sasha, vanya });
    if (!kids.length) {
      const e = new Error('Не нашёл детей 7-го и 10-го класса в аккаунте');
      e.code = 'no_kids';
      throw e;
    }
    const items = [];
    for (const { kid, id } of kids) {
      const q = `/homeworks?student_id=${encodeURIComponent(id)}&from=${base.range.from}&to=${base.range.to}&sort_column=date&sort_direction=asc`;
      const j = await api(token, q, profileId);
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
    return { ...base, status: { ok: true, tokenExp }, items };
  } catch (e) {
    const lastGood = prev.status && prev.status.ok ? prev.updatedAt : (prev.status && prev.status.lastGood) || null;
    console.error('Ошибка: ' + e.message);
    return { ...base, status: { ok: false, error: e.code || 'error', message: e.message, tokenExp, lastGood }, items: prev.items || [] };
  }
}

// Ручной запуск из командной строки
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const OUT = 'data/homework-mesh.json';
  let prev = { items: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const out = await buildHomework({
    token: (process.env.MESH_TOKEN || '').trim(),
    profileId: process.env.MESH_PROFILE_ID,
    sasha: process.env.MESH_STUDENT_SASHA,
    vanya: process.env.MESH_STUDENT_VANYA,
    prev
  });
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(out.status.ok ? 'Сохранено заданий: ' + out.items.length : 'Не обновлено: ' + out.status.message);
}
