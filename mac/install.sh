#!/bin/bash
# Установка программы, которая забирает домашние задания из МЭШ
# и отправляет их на сайт kymorozov.github.io/raspisanie.
#
# Запуск в Терминале:
#   curl -fsSL https://raw.githubusercontent.com/kymorozov/raspisanie/main/mac/install.sh -o /tmp/rs.sh && bash /tmp/rs.sh
#
# Повторный запуск — чтобы заменить токен МЭШ.
# Удаление:  bash /tmp/rs.sh --uninstall

set -euo pipefail

RAW="${RASPISANIE_RAW:-https://raw.githubusercontent.com/kymorozov/raspisanie/main}"
GH_API="${RASPISANIE_GH_API:-https://api.github.com}"
TTY="${RASPISANIE_TTY:-/dev/tty}"
APP="${RASPISANIE_HOME:-$HOME/Library/Application Support/raspisanie}"
LABEL="ru.raspisanie.mesh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/raspisanie-mesh.log"
UID_N="$(id -u)"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP"
  say "Программа удалена. Журнал остался в $LOG"
  exit 0
fi

mkdir -p "$APP" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# --- 1. Node.js ---------------------------------------------------------
NODE=""
if command -v node >/dev/null 2>&1; then
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$v" -ge 18 ] 2>/dev/null; then NODE="$(command -v node)"; fi
fi
if [ -z "$NODE" ] && [ -x "$APP/node/bin/node" ]; then NODE="$APP/node/bin/node"; fi
if [ -z "$NODE" ]; then
  say "Скачиваю Node.js — он нужен программе и ставится только в её папку…"
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  FILE="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o "node-v22[0-9.]*-darwin-$ARCH\.tar\.gz" | head -1)"
  [ -n "$FILE" ] || fail "Не удалось найти Node.js на nodejs.org — проверьте интернет и запустите ещё раз"
  curl -fL --progress-bar "https://nodejs.org/dist/latest-v22.x/$FILE" -o "$APP/node.tgz"
  rm -rf "$APP/node" && mkdir -p "$APP/node"
  tar -xzf "$APP/node.tgz" -C "$APP/node" --strip-components 1
  rm -f "$APP/node.tgz"
  NODE="$APP/node/bin/node"
fi
echo "Node.js: $("$NODE" -v)"

# --- 2. Программа -------------------------------------------------------
say "Скачиваю программу…"
curl -fsSL "$RAW/scripts/mesh-sync.mjs" -o "$APP/mesh-sync.mjs"
curl -fsSL "$RAW/mac/mesh-mac.mjs"      -o "$APP/mesh-mac.mjs"
echo "Готово: $APP"

# --- 3. Токены ----------------------------------------------------------
CFG="$APP/config.json"
OLD_GH=""
if [ -f "$CFG" ]; then
  OLD_GH="$("$NODE" -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ghToken||"")}catch(e){}' "$CFG")"
fi

exec 3< "$TTY"

say "Токен МЭШ"
echo "Откройте school.mos.ru в Chrome, войдите, нажмите ⌘⌥I → Application → Cookies → school.mos.ru"
echo "и скопируйте значение aupd_token. Вставьте его сюда и нажмите Enter (символы не видны — так и должно быть):"
IFS= read -rs MESH <&3 || true; echo
MESH="$(printf '%s' "$MESH" | tr -d '[:space:]"')"
[ -n "$MESH" ] || fail "Токен МЭШ не введён"

if [ -n "$OLD_GH" ]; then
  say "Ключ GitHub уже сохранён — нажмите Enter, чтобы оставить его, или вставьте новый:"
else
  say "Ключ GitHub (начинается с github_pat_, право Contents: Read and write на репозиторий raspisanie):"
fi
IFS= read -rs GHT <&3 || true; echo
exec 3<&-
GHT="$(printf '%s' "$GHT" | tr -d '[:space:]')"
[ -z "$GHT" ] && GHT="$OLD_GH"
[ -n "$GHT" ] || fail "Ключ GitHub не введён"

# Проверяем оба ключа, ничего не печатая из них
MESH="$MESH" GHT="$GHT" GH_API="$GH_API" "$NODE" --input-type=module -e '
  const t = process.env.MESH;
  let hours = null;
  try { const p = JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"), "base64")); hours = (p.exp*1000 - Date.now())/3600e3; } catch {}
  if (hours === null) { console.log("⚠︎ Токен МЭШ выглядит необычно — проверьте, что скопировали значение целиком"); }
  else if (hours <= 0) { console.error("✗ Этот токен МЭШ уже истёк — возьмите свежий"); process.exit(2); }
  else console.log("✓ Токен МЭШ действует ещё " + hours.toFixed(1) + " ч — программа будет продлевать его сама");
  try {
    const r = await fetch(process.env.GH_API + "/repos/kymorozov/raspisanie", { headers: { Authorization: "Bearer " + process.env.GHT, "User-Agent": "raspisanie-install" } });
    if (r.status === 401) { console.error("✗ Ключ GitHub не подходит или истёк"); process.exit(3); }
    if (!r.ok) { console.error("✗ Ключ GitHub не видит репозиторий raspisanie (ответ " + r.status + ")"); process.exit(3); }
    const j = await r.json();
    if (j.permissions && j.permissions.push === false) { console.error("✗ У ключа GitHub нет права записи — нужно Contents: Read and write"); process.exit(3); }
    console.log("✓ Ключ GitHub подходит");
  } catch (e) { console.log("⚠︎ Не удалось проверить ключ GitHub: " + e.message); }
' || fail "Исправьте и запустите установку ещё раз"

umask 077
MESH="$MESH" GHT="$GHT" "$NODE" -e '
  const fs = require("fs"), p = process.argv[1];
  let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
  c.meshToken = process.env.MESH; c.ghToken = process.env.GHT; delete c.previousToken;
  fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.chmodSync(p, 0o600);
' "$CFG"
unset MESH GHT OLD_GH

# --- 4. Автозапуск: 7:40 и 19:10, при входе в систему и после сна --------
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP/mesh-mac.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>40</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>10</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

[ -f "$LOG" ] && mv -f "$LOG" "$LOG.old"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"

say "Первый запуск…"
for _ in $(seq 1 40); do
  sleep 2
  if grep -qE 'Отправлено на сайт|Изменений нет|Сбой|Не заданы' "$LOG" 2>/dev/null; then break; fi
done
echo "────────────────────────────────"
tail -n 12 "$LOG" 2>/dev/null || echo "(журнал пока пуст)"
echo "────────────────────────────────"
if grep -q 'Отправлено на сайт: заданий\|Изменений нет' "$LOG" 2>/dev/null; then
  say "✓ Всё работает. Задания обновляются в 7:40 и 19:10, пока Mac включён; после сна — при пробуждении."
else
  say "Что-то пошло не так — пришлите в чат строки выше (в них нет ни токенов, ни имён)."
fi
echo "Журнал: $LOG"
