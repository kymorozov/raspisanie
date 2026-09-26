// Программа для MacBook: раз в полдня забирает домашние задания из МЭШ
// и отправляет их на сайт (в репозиторий kymorozov/raspisanie).
//
// Запускается службой macOS (LaunchAgent) в 7:40 и 19:10, а также при входе
// в систему. Если Mac в это время спал, запуск произойдёт при пробуждении.
//
// Настройки — в ~/Library/Application Support/raspisanie/config.json
//   meshToken  — токен МЭШ (программа сама продлевает его)
//   ghToken    — ключ GitHub с правом Contents: Read and write

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildHomework, refreshToken, jwtExp } from './mesh-sync.mjs';

const APP = process.env.RASPISANIE_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'raspisanie');
const CFG = path.join(APP, 'config.json');
const GH = {
  api: process.env.RASPISANIE_GH_API || 'https://api.github.com',
  owner: 'kymorozov', repo: 'raspisanie', branch: 'main',
  file: 'data/homework-mesh.json'
};

function log(msg) { console.log(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + '  ' + msg); }

function notify(text) {
  if (process.platform !== 'darwin') return;
  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('/usr/bin/osascript', ['-e', `display notification "${safe}" with title "Расписание: МЭШ"`], () => {});
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return {}; }
}
function writeCfg(cfg) {
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CFG, 0o600);
}

function hoursLeft(token) {
  const exp = jwtExp(token || '');
  return exp ? (new Date(exp) - Date.now()) / 3600e3 : null;
}

async function gh(method, p, token, body) {
  const url = `${GH.api}/repos/${GH.owner}/${GH.repo}${p}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'raspisanie-mac',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'ключ GitHub не подходит или истёк'
      : (r.status === 403 || r.status === 404) ? 'у ключа GitHub нет права записи в raspisanie'
      : 'GitHub ответил ' + r.status);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? null : r.json();
}

// Сравниваем без отметки времени: коммитим, только если что-то поменялось
// или прошлое обновление старше 11 часов (чтобы сайт видел, что всё живо).
function worthPushing(prev, next) {
  if (!prev) return true;
  const strip = o => JSON.stringify({ s: { ...o.status, lastGood: undefined }, i: o.items });
  if (strip(prev) !== strip(next)) return true;
  const age = Date.now() - new Date(prev.updatedAt || 0).getTime();
  return age > 11 * 3600e3;
}

async function main() {
  const cfg = readCfg();
  if (!cfg.meshToken || !cfg.ghToken) {
    log('Не заданы токены — запустите установку ещё раз');
    notify('Не заданы токены. Запустите установку ещё раз.');
    process.exitCode = 1;
    return;
  }

  // 1. Продлеваем токен, пока он ещё действует
  const left = hoursLeft(cfg.meshToken);
  if (left !== null && left > 0) {
    const r = await refreshToken(cfg.meshToken);
    const newLeft = r.ok ? hoursLeft(r.token) : null;
    if (r.ok && (newLeft === null || newLeft > left)) {
      cfg.previousToken = cfg.meshToken;
      cfg.meshToken = r.token;
      cfg.refreshedAt = new Date().toISOString();
      writeCfg(cfg);
      log(`Токен продлён: действует ещё ${newLeft ? newLeft.toFixed(1) : '?'} ч`);
    } else {
      log(`Продлить токен не удалось (${r.ok ? 'новый токен не дольше старого' : r.why}); осталось ${left.toFixed(1)} ч`);
    }
  } else if (left !== null) {
    log('Токен МЭШ уже истёк');
  }

  // 2. Забираем прошлые данные с сайта
  const cur = await gh('GET', `/contents/${GH.file}?ref=${GH.branch}`, cfg.ghToken);
  let prev = { items: [] };
  if (cur && cur.content) { try { prev = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8')); } catch {} }

  // 3. Выгрузка из МЭШ; если продлённый токен вдруг не принят — пробуем прежний
  const opts = { profileId: cfg.profileId, sasha: cfg.sasha, vanya: cfg.vanya, prev };
  let out = await buildHomework({ token: cfg.meshToken, ...opts });
  if (!out.status.ok && out.status.error === 'token_expired' && cfg.previousToken && hoursLeft(cfg.previousToken) > 0) {
    log('Продлённый токен не принят, возвращаюсь к прежнему');
    out = await buildHomework({ token: cfg.previousToken, ...opts });
    if (out.status.ok) { cfg.meshToken = cfg.previousToken; delete cfg.previousToken; writeCfg(cfg); }
  }
  out.status.source = 'mac';

  // 4. Отправляем на сайт
  if (worthPushing(prev, out)) {
    const body = {
      message: out.status.ok ? `МЭШ: домашние задания (${out.items.length})` : `МЭШ: ошибка — ${out.status.error}`,
      content: Buffer.from(JSON.stringify(out, null, 2) + '\n').toString('base64'),
      branch: GH.branch
    };
    if (cur && cur.sha) body.sha = cur.sha;
    await gh('PUT', `/contents/${GH.file}`, cfg.ghToken, body);
    log(`Отправлено на сайт: ${out.status.ok ? 'заданий ' + out.items.length : 'статус ' + out.status.error}`);
  } else {
    log('Изменений нет — на сайт не отправляю');
  }

  // 5. Предупреждения
  const finalLeft = hoursLeft(cfg.meshToken);
  if (!out.status.ok && out.status.error === 'token_expired') {
    notify('Токен МЭШ истёк. Возьмите новый на school.mos.ru и запустите установку ещё раз.');
  } else if (!out.status.ok && out.status.error === 'network') {
    notify('Нет связи с МЭШ — попробую в следующий раз.');
  } else if (finalLeft !== null && finalLeft < 14) {
    notify(`Токен МЭШ истекает через ${Math.max(0, finalLeft).toFixed(0)} ч, а продлить его не удаётся.`);
  }
}

main().catch(e => {
  log('Сбой: ' + e.message);
  notify('Не получилось обновить задания: ' + e.message);
  process.exitCode = 1;
});
