# Обновление Linux-сервера

1. В SSH перейдите в проект: `cd ~/Service_specialists`. Выполните `git status --short`, `git stash list` и `git rev-parse HEAD`. Сохраните хеш текущего коммита. Если есть изменения в отслеживаемых файлах, сохраните их отдельным `git stash push -m "before-fedor-upgrade"`. Проверьте уже существующие записи stash через `git stash show --stat stash@{0}`. Не применяйте их автоматически после обновления. Сверьте локальные исправления на сервере с новой веткой. Не добавляйте конфигурацию и резервные копии в Git.

2. Уточните файл действующей БД. Обычно это `instance/svobodno.sqlite`, но `DATABASE_PATH` или демо-режим могут указывать на другой файл. Остановите `systemctl --user stop svobodno.service` и фоновые задачи проекта, если они настроены. Сделайте закрытый каталог резервных копий командой `umask 077; BK=$(mktemp -d "$HOME/svobodno-backup.XXXXXXXX")`. Сохраните предыдущий коммит и локальную конфигурацию:
   `git rev-parse HEAD > "$BK/commit"`
   `test ! -f .env || cp -p .env "$BK/env"`
   `test ! -d instance || cp -a instance "$BK/instance"`
   Если БД или загрузки находятся вне `instance`, сохраните их отдельно. Для базы дополнительно сделайте проверенный снимок через Python. Укажите фактический путь к БД:

       DB="$PWD/instance/svobodno.sqlite"
       .venv/bin/python - "$DB" "$BK/database.sqlite" <<'PY'
       import sqlite3
       import sys
       from pathlib import Path
       source = Path(sys.argv[1]).resolve()
       with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as db, sqlite3.connect(sys.argv[2]) as copy:
           db.backup(copy)
           if copy.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
               raise SystemExit('Копия SQLite не прошла проверку')
       print('Резервная копия SQLite проверена')
       PY

3. Получите код: `git fetch origin main`, `git switch main`, `git merge --ff-only origin/main`. При ошибке остановитесь и выясните причину. Обновите зависимости в этом окружении: `"$HOME/.local/bin/uv" pip install --python .venv/bin/python -r requirements.txt`. Если в окружении есть pip, подойдёт `.venv/bin/python -m pip install -r requirements.txt`.

4. Проверьте в локальной `.env` публичный `APP_BASE_URL` с HTTPS, путь к БД, `DEMO_MODE` и существующие SMTP/платёжные настройки. Сохраните действующий корректный `APP_SECRET`. Если ключ в `.env` отсутствует или содержит заглушку, команда ниже сгенерирует новый и запишет его без вывода в консоль. Сначала сохраните резервную копию как в шаге 2. Смена секретного ключа завершает открытые сессии. Переменная из окружения systemd имеет приоритет над `.env`. Если там задан старый секрет, исправьте его источник и после правки файла службы выполните `systemctl --user daemon-reload`.

       umask 077
       .venv/bin/python - <<'PY'
       import os
       import secrets
       import tempfile
       from pathlib import Path
       from dotenv import dotenv_values
       path = Path('.env')
       existing = dotenv_values(path).get('APP_SECRET') or ''
       if len(existing) >= 32 and existing != 'replace-with-a-long-random-secret':
           path.chmod(0o600)
           print('Существующий APP_SECRET сохранён')
       else:
           text = path.read_text() if path.exists() else ''
           with tempfile.NamedTemporaryFile(mode='w', dir='.', prefix='.env.', delete=False) as file:
               file.write(text.rstrip() + '\nAPP_SECRET=' + secrets.token_urlsafe(48) + '\n')
               temporary = file.name
           os.replace(temporary, path)
           print('Новый APP_SECRET записан в .env')
       PY

5. Сначала проверьте миграцию на копии: скопируйте `"$BK/database.sqlite"` в `"$BK/smoke.sqlite"`. Запустите `DATABASE_PATH="$BK/smoke.sqlite" DEMO_MODE=false PAYMENTS_ENABLED=false .venv/bin/python -c 'from app import create_app; create_app()'`. Для демонстрационной БД используйте `DEMO_MODE=true` и `DEMO_DATABASE_PATH` вместо `DATABASE_PATH`. Убедитесь, что окружение ручного запуска соответствует службе. Если копия открывается, запустите службу: `systemctl --user start svobodno.service`. При старте Gunicorn Flask выполнит ту же транзакционную миграцию на настроенной базе. Проверьте `systemctl --user status svobodno.service --no-pager` и `journalctl --user -u svobodno.service -n 40 --no-pager`. Проверьте HTTP 200: `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/session`. Затем откройте публичный сайт, войдите старой учёткой по email и проверьте историю. Проверку почты и тестовой оплаты делайте отдельно.

6. При откате остановите службу и фоновые задания. Сохраните отдельный снимок текущей БД и загрузок, если после обновления успели появиться новые записи: их нужно учесть до восстановления. Переключитесь на прежний коммит командой `git switch --detach "$(cat "$BK/commit")"`, восстановите прежнюю конфигурацию и зависимости. Если откатываете данные, при остановленных процессах восстановите прежнюю БД из `"$BK/database.sqlite"` и согласованные загрузки. Используйте SQLite `.restore` или Python `backup()` из резервной копии в рабочий файл, чтобы не смешать снимок со старыми файлами WAL. Запустите службу и повторите проверку HTTP.

## Логины существующих пользователей

Миграция добавляет nullable-поле `users.username` и уникальный индекс с игнорированием регистра. Действующие записи без логина получают его из части адреса до @, с суффиксами `_1`, `_2` при совпадении. Если основа короче трёх символов или отсутствует, используется `user<ID>`. Идентификаторы, хеши, роли и связанные данные сохраняются. Повторный запуск оставляет присвоенные логины без изменений. Старый вход по email работает, а назначенный логин показывается в профиле. Давно сохранённые адреса, совпадающие без учёта регистра, сохраняются: войти можно с точным старым адресом либо по логину. Для такого адреса восстановление по email требует сначала уточнить адрес в профиле или у администратора.
