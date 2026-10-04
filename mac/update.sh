#!/bin/bash
# Обновить программу МЭШ на Mac без повторного ввода ключей:
# свежие файлы, расписание 7:40 / 13:10 / 17:10 / 19:10 и запуск прямо сейчас.
#   curl -fsSL https://raw.githubusercontent.com/kymorozov/raspisanie/main/mac/update.sh | bash
set -euo pipefail
RAW="https://raw.githubusercontent.com/kymorozov/raspisanie/main"
APP="$HOME/Library/Application Support/raspisanie"
LABEL="ru.raspisanie.mesh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$APP/config.json" ] && [ -f "$PLIST" ] || { echo "Программа не установлена — запустите install.sh"; exit 1; }
NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST")"
curl -fsSL "$RAW/scripts/mesh-sync.mjs" -o "$APP/mesh-sync.mjs"
curl -fsSL "$RAW/mac/mesh-mac.mjs"      -o "$APP/mesh-mac.mjs"
/usr/libexec/PlistBuddy -c 'Delete :StartCalendarInterval' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :StartCalendarInterval array' "$PLIST"
i=0
for t in 7:40 13:10 17:10 19:10; do
  /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$i dict" \
    -c "Add :StartCalendarInterval:$i:Hour integer ${t%%:*}" \
    -c "Add :StartCalendarInterval:$i:Minute integer ${t##*:}" "$PLIST"
  i=$((i+1))
done
echo "Node: $("$NODE" -v); расписание: 7:40, 13:10, 17:10, 19:10"
LOG="$HOME/Library/Logs/raspisanie-mesh.log"
BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"   # RunAtLoad — запуск сразу
echo "Обновляю задания (до 2 минут, если МЭШ сбоит)…"
for _ in $(seq 1 50); do
  sleep 3
  tail -n +"$((BEFORE+1))" "$LOG" 2>/dev/null | grep -qE 'Отправлено на сайт|Изменений нет|Сбой' && break
done
echo "────────────"
tail -n +"$((BEFORE+1))" "$LOG"
