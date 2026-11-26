import hashlib
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from contextlib import contextmanager
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from flask import Flask, jsonify, request, session, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from backend.bookings.schedule import save_schedule, schedule_for
from backend.bookings.service import BookingError, available_slots, create_booking
from backend.bookings.lifecycle import (CUSTOMER_ROLES, booking_interval, booking_policy, cancellation_reason,
                               store_transition, transition_booking, upcoming_master_bookings)
from backend.auth.password_recovery import send_recovery_email
from backend.auth.profile import (AVATAR_NAME, IMAGE_TYPES, ProfileError, account, remove_unused_avatars,
                                  retire_account, retire_specialist, set_avatar, update_details, validate_avatar)
from backend.database.category_management import admin_directory, remove_category, save_category
from backend.database.service_categories import active_category_id, category_groups
from backend.support import STATUSES, create_support, support_items, update_support
from backend.moderation.services import (ModerationError, PUBLIC_SERVICE, decide_service, manage_service,
                                service_details, service_fields)
from backend.moderation.specialists import decide_application, latest_application, submit_application

load_dotenv()

TZ = ZoneInfo('Europe/Kirov')


def now():
    return datetime.now(TZ).replace(tzinfo=None)


def create_app(test_config=None):
    app = Flask(__name__, static_folder='static')
    app.config.update(DATABASE=os.path.join(app.instance_path, 'svobodno.sqlite'),
                      UPLOAD_FOLDER=os.path.join(app.instance_path, 'uploads'), SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '').lower() in ('1', 'true', 'yes'), MAX_CONTENT_LENGTH=1024 * 1024,
                      SMTP_HOST=os.environ.get('SMTP_HOST', ''), SMTP_PORT=int(os.environ.get('SMTP_PORT', '587')),
                      SMTP_USERNAME=os.environ.get('SMTP_USERNAME', ''), SMTP_PASSWORD=os.environ.get('SMTP_PASSWORD', ''),
                      SMTP_FROM_EMAIL=os.environ.get('SMTP_FROM_EMAIL', ''), SMTP_FROM_NAME=os.environ.get('SMTP_FROM_NAME', 'Свободно.'),
                      APP_BASE_URL=os.environ.get('APP_BASE_URL', 'http://127.0.0.1:5000'),
                      PASSWORD_RESET_TTL_MINUTES=30, PASSWORD_RESET_LIMIT=30, PASSWORD_RESET_WINDOW_MINUTES=60)
    if test_config:
        app.config.update(test_config)
    uploads = Path(app.config['UPLOAD_FOLDER'])
    Path(app.instance_path).mkdir(exist_ok=True)
    key = Path(app.instance_path) / 'session.key'
    if not key.exists():
        try:
            with key.open('x') as f:
                f.write(secrets.token_hex(32))
            key.chmod(0o600)
        except FileExistsError:
            pass
    app.secret_key = app.config.get('SECRET_KEY') or os.environ.get('APP_SECRET') or key.read_text()

    @contextmanager
    def db():
        con = sqlite3.connect(app.config['DATABASE'], timeout=15)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys=ON')
        try:
            with con:
                yield con
        finally:
            con.close()

    def valid_sqlite_id(value):
        """Accept only positive SQLite INTEGER identifiers (never bool or coercible strings)."""
        return type(value) is int and 1 <= value < 2**63

    def fail(message, status=400):
        return jsonify(error=message), status

    def auth(*roles):
        def deco(fn):
            @wraps(fn)
            def wrapped(*args, **kwargs):
                with db() as c:
                    user = account(c, session.get('uid'))
                if not user:
                    return fail('Войдите в личный кабинет', 401)
                if roles and user['role'] not in roles:
                    return fail('Недостаточно прав', 403)
                return fn(user, *args, **kwargs)
            return wrapped
        return deco

    @app.before_request
    def csrf():
        for value in (request.view_args or {}).values():
            if type(value) is int and not valid_sqlite_id(value):
                return fail('Некорректный идентификатор', 400)
        for field in ('id', 'ident', 'specialist_id', 'service_id', 'slot_id', 'booking_id',
                      'notification_id', 'application_id', 'review_id'):
            if field in request.args:
                raw = request.args.get(field, '')
                if not raw.isdecimal() or not valid_sqlite_id(int(raw)):
                    return fail('Некорректный идентификатор', 400)
        if request.method in ('POST', 'PATCH', 'DELETE'):
            if not session.get('csrf') or request.headers.get('X-CSRF-Token') != session['csrf']:
                return fail('Обновите страницу и повторите действие', 403)
            if request.method == 'POST' and request.path == '/api/profile/avatar':
                if request.mimetype != 'multipart/form-data':
                    return fail('Ожидается файл изображения', 415)
                return None
            if request.method == 'DELETE':
                return None
            if not request.is_json:
                return fail('Ожидается JSON', 415)
            if not isinstance(request.get_json(), dict):
                return fail('Ожидается JSON-объект')
            data = request.get_json()
            for field in ('slot_id', 'service_id', 'booking_id', 'specialist_id', 'user_id',
                          'review_id', 'application_id', 'notification_id'):
                value = data.get(field)
                if value is not None and not valid_sqlite_id(value):
                    return fail('Некорректный идентификатор', 400)
            if 'ids' in data and (not isinstance(data['ids'], list) or
                                  any(not valid_sqlite_id(value) for value in data['ids'])):
                return fail('Список содержит некорректный идентификатор', 400)

    @app.after_request
    def password_recovery_headers(response):
        if request.path == '/reset-password':
            response.headers['Cache-Control'] = 'no-store'
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['X-Robots-Tag'] = 'noindex, nofollow'
        return response

    @app.errorhandler(400)
    def bad_request(_):
        return fail('Некорректный запрос')

    @app.errorhandler(413)
    def request_too_large(_):
        return fail('Размер запроса не должен превышать 1 МБ', 413)

    @app.errorhandler(ProfileError)
    def profile_error(error):
        return fail(str(error), error.status)

    @app.route('/')
    @app.route('/reset-password')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    @app.get('/api/session')
    def current():
        session.setdefault('csrf', secrets.token_hex(24))
        with db() as c:
            user = c.execute('SELECT id,name,username,email,role,specialist_id,avatar FROM users WHERE id=? AND role!="deleted"', (session.get('uid'),)).fetchone()
        return jsonify(user=dict(user) if user else None, csrf=session['csrf'])

    @app.post('/api/login')
    def login():
        data = request.get_json()
        with db() as c:
            user = c.execute('SELECT * FROM users WHERE username=?', (str(data.get('username', '')).strip().lower(),)).fetchone()
        if not user or not check_password_hash(user['password'], str(data.get('password', ''))):
            return fail('Неверный логин или пароль', 401)
        session.clear()
        session.update(uid=user['id'], csrf=secrets.token_hex(24))
        return current()

    @app.post('/api/register')
    def register():
        d = request.get_json()
        name = str(d.get('name', '')).strip()
        username = str(d.get('username', '')).strip().lower()
        email = str(d.get('email', '')).strip().lower()
        password = str(d.get('password', ''))
        if not 2 <= len(name) <= 80 or not re.fullmatch(r'[a-z0-9_.-]{3,30}', username):
            return fail('Укажите имя и логин длиной 3–30 символов (латинские буквы, цифры, точка, дефис или подчёркивание)')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 120 or not 8 <= len(password) <= 128:
            return fail('Укажите корректную почту и пароль от 8 до 128 символов')
        try:
            with db() as c:
                if c.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
                    return fail('Этот логин уже занят', 409)
                if c.execute('SELECT 1 FROM users WHERE email=? COLLATE NOCASE', (email,)).fetchone():
                    return fail('Эта почта уже зарегистрирована', 409)
                uid = c.execute('INSERT INTO users(name,username,email,password,role) VALUES(?,?,?,?,?)',
                                (name, username, email, generate_password_hash(password), 'client')).lastrowid
        except sqlite3.IntegrityError:
            return fail('Логин или почта уже используются', 409)
        session.clear()
        session.update(uid=uid, csrf=secrets.token_hex(24))
        return current()

    @app.post('/api/password-reset/request')
    def request_password_reset():
        data = request.get_json()
        email = str(data.get('email', '')).strip().lower()
        if len(email) > 120 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            return fail('Укажите корректный адрес электронной почты')
        ip = request.remote_addr or 'unknown'
        email_hash = hashlib.sha256(email.encode('utf-8')).hexdigest()
        current_time = now()
        cutoff = (current_time - timedelta(minutes=app.config['PASSWORD_RESET_WINDOW_MINUTES'])).isoformat()
        with db() as c:
            c.execute('DELETE FROM password_reset_requests WHERE created_at < ?', (cutoff,))
            count = c.execute('SELECT COUNT(*) FROM password_reset_requests WHERE ip_address=? OR email_hash=?', (ip, email_hash)).fetchone()[0]
            if count >= app.config['PASSWORD_RESET_LIMIT']:
                return jsonify(message='Если адрес зарегистрирован, инструкция будет отправлена на почту'), 200
            c.execute('INSERT INTO password_reset_requests(ip_address,email_hash,created_at) VALUES(?,?,?)', (ip, email_hash, current_time.isoformat()))
            user = c.execute('SELECT id,email,name FROM users WHERE email=? COLLATE NOCASE', (email,)).fetchone()
            if user:
                raw_token = secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(raw_token.encode('utf-8')).hexdigest()
                expires = (current_time + timedelta(minutes=app.config['PASSWORD_RESET_TTL_MINUTES'])).isoformat()
                c.execute('DELETE FROM password_reset_tokens WHERE user_id=?', (user['id'],))
                c.execute('INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)', (user['id'], token_hash, expires, current_time.isoformat()))
        if user:
            link = app.config['APP_BASE_URL'].rstrip('/') + '/reset-password#token=' + raw_token
            try:
                sender = app.config.get('MAIL_SENDER') or send_recovery_email
                sender(app.config, user['email'], user['name'], link)
            except Exception as exc:
                # Keep the response generic (avoid account enumeration), but make
                # the cause visible in server logs without exposing addresses,
                # reset tokens, SMTP responses or credentials.
                app.logger.error('Password recovery email delivery failed (%s)', type(exc).__name__)
                with db() as c:
                    c.execute('DELETE FROM password_reset_tokens WHERE token_hash=?', (token_hash,))
        return jsonify(message='Если адрес зарегистрирован, инструкция будет отправлена на почту'), 200

    @app.post('/api/password-reset/confirm')
    def confirm_password_reset():
        data = request.get_json()
        token, password = str(data.get('token', '')), str(data.get('password', ''))
        confirmation = str(data.get('confirmation', ''))
        if not token or len(token) > 256:
            return fail('Ссылка восстановления недействительна или устарела', 400)
        if not 8 <= len(password) <= 128 or password != confirmation:
            return fail('Пароль должен содержать от 8 до 128 символов, а подтверждение должно совпадать')
        token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash=? AND expires_at>?', (token_hash, now().isoformat())).fetchone()
            if not row:
                return fail('Ссылка восстановления недействительна или устарела', 400)
            c.execute('UPDATE users SET password=? WHERE id=?', (generate_password_hash(password), row['user_id']))
            c.execute('DELETE FROM password_reset_tokens WHERE user_id=?', (row['user_id'],))
        session.clear()
        session['csrf'] = secrets.token_hex(24)
        return jsonify(ok=True, csrf=session['csrf'], message='Пароль успешно изменён. Теперь войдите с новым паролем')

    @app.post('/api/logout')
    def logout():
        session.clear()
        return current()

    def cleanup_avatars(candidates):
        try:
            with db() as c:
                remove_unused_avatars(c, uploads, candidates)
        except OSError:
            app.logger.warning('Could not remove an unused profile image', exc_info=True)

    @app.patch('/api/profile')
    @auth(*CUSTOMER_ROLES)
    def update_profile(user):
        with db() as c:
            update_details(c, user['id'], request.get_json())
        return current()

    @app.post('/api/profile/avatar')
    @auth(*CUSTOMER_ROLES)
    def update_avatar(user):
        image = request.files.get('avatar')
        extension = validate_avatar(image)
        filename = f"user-{user['id']}-{secrets.token_hex(12)}{extension}"
        path = uploads / filename
        uploads.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            with path.open('xb') as target:
                created = True
                image.save(target)
            with db() as c:
                previous = set_avatar(c, user['id'], f'/uploads/{filename}')
        except Exception:
            if created:
                path.unlink(missing_ok=True)
            raise
        cleanup_avatars(previous)
        return current()

    @app.get('/uploads/<name>')
    def uploaded_file(name):
        if not AVATAR_NAME.fullmatch(name):
            return fail('Файл не найден', 404)
        with db() as c:
            url = f'/uploads/{name}'
            if not c.execute('SELECT 1 FROM users WHERE avatar=? UNION ALL SELECT 1 FROM specialists WHERE photo=?',
                             (url, url)).fetchone():
                return fail('Файл не найден', 404)
        response = send_from_directory(uploads, name, mimetype=IMAGE_TYPES[Path(name).suffix][1])
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-cache'
        return response

    @app.delete('/api/account')
    @auth(*CUSTOMER_ROLES)
    def delete_account(user):
        with db() as c:
            previous = retire_account(c, user['id'], now())
        cleanup_avatars(previous)
        session.clear()
        return current()

    @app.delete('/api/admin/specialists/<int:ident>')
    @auth('admin')
    def delete_specialist(user, ident):
        if not 1 <= ident < 2**63:
            return fail('Специалист не найден', 404)
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            photo = retire_specialist(c, ident)
        cleanup_avatars((photo,))
        return jsonify(ok=True)

    @app.get('/api/catalog')
    def catalog():
        current_time = now()
        category_id = request.args.get('category_id')
        with db() as c:
            c.execute('BEGIN')
            services = {}
            available = set()
            for row in c.execute(f'''SELECT v.id,v.specialist_id,v.title,v.price,v.duration,v.mode,v.active,
                    v.category_id,k.parent_id AS category_group_id
                FROM services v JOIN specialists p ON p.id=v.specialist_id
                LEFT JOIN service_categories k ON k.id=v.category_id AND k.archived=0
                WHERE {PUBLIC_SERVICE} ORDER BY v.id'''):
                services.setdefault(row['specialist_id'], []).append(dict(row))
                if row['category_id'] is not None:
                    available.add(row['category_id'])
            categories = category_groups(c, available)

            category_labels = {item['id']: item['name'] for group in categories for item in group['categories']}
            for entries in services.values():
                for service in entries:
                    service['category_name'] = category_labels.get(service['category_id'])

            group_labels = {row['id']: row['name'] for row in c.execute(
                'SELECT id,name FROM service_categories WHERE parent_id IS NULL AND archived=0')}
            specialists = []
            for row in c.execute('SELECT * FROM specialists WHERE active=1 ORDER BY id'):
                s = dict(row)
                s['category_label'] = group_labels.get(s['category_group_id'], s['category'])
                s['services'] = services.get(s['id'], [])
                if category_id and not any(category_id in (v['category_id'], v['category_group_id'])
                                           for v in s['services']):
                    continue
                schedule = schedule_for(c, s['id'])
                s['booking_mode'] = schedule['mode'] if schedule else 'manual'
                s['reviews'] = [dict(r) for r in c.execute('SELECT r.*,u.name FROM reviews r JOIN users u ON r.user_id=u.id WHERE r.specialist_id=? AND r.status="approved" ORDER BY r.id DESC', (s['id'],))]
                s['rating'] = round(sum(r['rating'] for r in s['reviews']) / len(s['reviews']), 1) if s['reviews'] else None
                try:
                    next_slot = next((slot for slot in available_slots(c, s['id'], current_time) if slot['remaining'] > 0), None)
                except BookingError:
                    next_slot = None
                s['next_slot'] = next_slot['starts_at'] if next_slot else None
                s['next_slot_mode'] = next_slot['booking_mode'] if next_slot else None
                specialists.append(s)
        return jsonify(specialists=specialists, categories=categories, timezone='Europe/Kirov')

    @app.get('/api/services/<int:ident>')
    def public_service(ident):
        if not 1 <= ident < 2**63:
            return fail('Услуга не найдена', 404)
        with db() as c:
            service = c.execute(f'''SELECT v.id,v.specialist_id,v.title,v.price,v.duration,v.mode,v.active,v.category_id
                FROM services v JOIN specialists p ON p.id=v.specialist_id
                WHERE v.id=? AND {PUBLIC_SERVICE}''', (ident,)).fetchone()
        return jsonify(service=dict(service)) if service else fail('Услуга не найдена', 404)

    @app.get('/api/slots/<int:specialist_id>')
    def slots(specialist_id):
        service_id = request.args.get('service_id')
        if service_id is not None:
            try:
                service_id = int(service_id)
                if not 1 <= service_id < 2**63:
                    raise ValueError
            except ValueError:
                return fail('Укажите корректную услугу')
        if specialist_id >= 2**63:
            return jsonify(slots=[])
        try:
            with db() as c:
                c.execute('BEGIN')
                rows = list(available_slots(c, specialist_id, now(), service_id))
        except BookingError as error:
            return fail(str(error), error.status)
        return jsonify(slots=rows)

    @app.post('/api/bookings')
    @auth(*CUSTOMER_ROLES)
    def book(user):
        try:
            with db() as c:
                ident = create_booking(c, user['id'], request.get_json(), now)
        except BookingError as error:
            return fail(str(error), error.status)
        return jsonify(id=ident), 201

    @app.get('/api/notifications')
    @auth()
    def notifications(user):
        with db() as c:
            rows = c.execute(
                'SELECT id,booking_id,service_id,specialist_application_id,support_request_id,event,message,created_at,is_read FROM notifications WHERE user_id=? ORDER BY id DESC',
                (user['id'],)).fetchall()
        return jsonify(notifications=[{**dict(row), 'is_read': bool(row['is_read'])} for row in rows])

    @app.post('/api/notifications/<int:ident>/read')
    @auth()
    def read_notification(user, ident):
        if ident > 2**63 - 1:
            return fail('Уведомление не найдено', 404)
        with db() as c:
            changed = c.execute('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
                                (ident, user['id'])).rowcount
        if not changed:
            return fail('Уведомление не найдено', 404)
        return jsonify(ok=True)

    @app.post('/api/notifications/<int:ident>/open')
    @auth()
    def open_notification(user, ident):
        if not 1 <= ident < 2**63:
            return fail('Уведомление не найдено', 404)
        with db() as c:
            notice = c.execute('SELECT * FROM notifications WHERE id=? AND user_id=?',
                               (ident, user['id'])).fetchone()
            if not notice:
                return fail('Уведомление не найдено', 404)
            c.execute('UPDATE notifications SET is_read=1 WHERE id=?', (ident,))
            target = notification_target(c, notice, user)
        return jsonify(message=notice['message'], target=target)

    def notification_target(c, notice, user):
        if notice['support_request_id'] is not None:
            items = support_items(c, user, notice['support_request_id'])
            if items:
                return dict(kind='support', mode='master' if user['role'] == 'master' else 'client',
                            tab='support', item=items[0])
        elif notice['booking_id'] is not None:
            row = c.execute("""SELECT b.id,b.user_id,b.status,b.cancel_reason,s.starts_at,s.booking_mode,
                v.title,p.name specialist FROM bookings b JOIN slots s ON s.id=b.slot_id
                JOIN services v ON v.id=s.service_id JOIN specialists p ON p.id=s.specialist_id
                WHERE b.id=? AND (b.user_id=? OR s.specialist_id=?)""",
                            (notice['booking_id'], user['id'],
                             user['specialist_id'] if user['role'] == 'master' else None)).fetchone()
            if row:
                return dict(kind='booking', mode='client' if row['user_id'] == user['id'] else 'master',
                            tab='bookings', item=dict(row))
        elif notice['service_id'] is not None and user['role'] == 'master':
            row = c.execute('SELECT * FROM services WHERE id=? AND specialist_id=? AND deleted=0',
                            (notice['service_id'], user['specialist_id'])).fetchone()
            if row:
                return dict(kind='service', mode='master', tab='services', item=service_details(row))
        elif notice['specialist_application_id'] is not None:
            row = c.execute('SELECT * FROM specialist_applications WHERE id=? AND user_id=?',
                            (notice['specialist_application_id'], user['id'])).fetchone()
            if row:
                return dict(kind='application', mode='client', tab='specialist-application', item=dict(row))
        return None

    @app.get('/api/dashboard')
    @auth()
    def dashboard(user):
        role = user['role']
        client_view = role == 'client' or (role == 'master' and request.args.get('mode') == 'client')
        if client_view:
            where, params = 'b.user_id=?', (user['id'],)
        elif role == 'master':
            where, params = 's.specialist_id=?', (user['specialist_id'],)
        elif role == 'admin':
            where, params = '1=1', ()
        else:
            return fail('Недостаточно прав', 403)
        with db() as c:
            application = latest_application(c, user['id']) if client_view else None
            bookings = c.execute(f'''SELECT b.*,s.starts_at,s.ends_at slot_ends_at,s.booking_mode,s.specialist_id,s.capacity,v.title service,v.mode,
                CASE WHEN s.ends_at IS NOT NULL AND s.booking_mode!='day' THEN ROUND((julianday(s.ends_at)-julianday(s.starts_at))*1440) ELSE v.duration END duration,p.name specialist,p.photo,u.name client
                FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id
                JOIN specialists p ON p.id=s.specialist_id JOIN users u ON u.id=b.user_id WHERE {where} ORDER BY s.starts_at DESC''', params).fetchall()
            searches = c.execute('SELECT * FROM searches WHERE user_id=? ORDER BY id DESC LIMIT 30', (user['id'],)).fetchall()
            reviews = c.execute('SELECT r.*,p.name specialist,u.name author FROM reviews r JOIN specialists p ON p.id=r.specialist_id JOIN users u ON u.id=r.user_id ' + ('' if user['role'] == 'admin' else 'WHERE r.user_id=? ') + 'ORDER BY r.id DESC', () if user['role'] == 'admin' else (user['id'],)).fetchall()
            profile_groups = ([dict(row) for row in c.execute('''SELECT id,name FROM service_categories
                WHERE parent_id IS NULL AND archived=0 ORDER BY name,id''')] if client_view else [])
            pending = {}
            if role == 'admin':
                pending = {
                    'support': c.execute("SELECT count(*) FROM support_requests WHERE status='pending'").fetchone()[0],
                    'service-applications': c.execute("""SELECT count(*) FROM services
                        WHERE deleted=0 AND COALESCE(draft_status,moderation_status)='pending'""").fetchone()[0],
                    'specialist-applications': c.execute("""SELECT count(*) FROM specialist_applications
                        WHERE status='pending'""").fetchone()[0],
                }
        current_time = now()
        reviewed_ids = {r['booking_id'] for r in reviews}
        rows = [{**dict(b), **booking_policy(b, user, current_time, b['id'] in reviewed_ids)} for b in bookings]
        return jsonify(bookings=rows, pending=pending, searches=[dict(r) for r in searches], reviews=[dict(r) for r in reviews],
                       specialist_application=application, specialist_categories=profile_groups,
                       user={key: user[key] for key in ('id', 'name', 'username', 'email', 'role', 'specialist_id', 'avatar')},
                       server_now=current_time.isoformat(timespec='seconds'))

    def apply_booking_transition(user, ident, action):
        try:
            with db() as c:
                reason = cancellation_reason(request.get_json()) if action == 'cancel' and user['role'] == 'master' else None
                transition_booking(c, user, ident, action, now, reason)
        except BookingError as error:
            return fail(str(error), error.status)
        return jsonify(ok=True)

    @app.post('/api/bookings/<int:ident>/cancel')
    @auth()
    def cancel(user, ident):
        return apply_booking_transition(user, ident, 'cancel')

    @app.post('/api/bookings/<int:ident>/complete')
    @auth('master')
    def complete(user, ident):
        return apply_booking_transition(user, ident, 'complete')

    @app.get('/api/master/bookings/upcoming')
    @auth('master')
    def upcoming_bookings(user):
        try:
            with db() as c:
                return jsonify(ids=upcoming_master_bookings(c, user, now()))
        except BookingError as error:
            return fail(str(error), error.status)

    @app.post('/api/master/bookings/cancel-all')
    @auth('master')
    def cancel_all_bookings(user):
        data = request.get_json()
        if data.get('confirm') is not True:
            return fail('Подтвердите отмену записей')
        expected_ids = data.get('ids')
        if not isinstance(expected_ids, list) or any(type(ident) is not int for ident in expected_ids):
            return fail('Укажите список записей для подтверждения')
        try:
            reason = cancellation_reason(data)
            with db() as c:
                c.execute('BEGIN IMMEDIATE')
                current_time = now()
                ids = upcoming_master_bookings(c, user, current_time)
                if expected_ids != ids:
                    return fail('Список предстоящих записей изменился. Откройте подтверждение заново.', 409)
                for ident in ids:
                    store_transition(c, ident, 'cancelled', current_time, reason)
        except BookingError as error:
            return fail(str(error), error.status)
        return jsonify(cancelled=len(ids))

    @app.post('/api/reviews')
    @auth(*CUSTOMER_ROLES)
    def review(user):
        d = request.get_json()
        rating, content = d.get('rating'), str(d.get('content', '')).strip()
        if type(rating) is not int or not 1 <= rating <= 5 or not 5 <= len(content) <= 1500:
            return fail('Оцените от 1 до 5 и напишите отзыв от 5 до 1500 символов')
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            if not account(c, user['id']):
                return fail('Войдите в личный кабинет', 401)
            b = c.execute('SELECT b.*,s.specialist_id,s.starts_at,s.ends_at slot_ends_at,v.duration FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id WHERE b.id=? AND b.user_id=? AND b.status="completed"', (d.get('booking_id'), user['id'])).fetchone()
            if not b:
                return fail('Отзыв доступен после завершённой встречи', 403)
            if now() < booking_interval(b)[1]:
                return fail('Отзыв недоступен до окончания услуги', 403)
            try:
                c.execute('INSERT INTO reviews(user_id,specialist_id,booking_id,rating,content,status,created_at) VALUES(?,?,?,?,?,"pending",?)', (user['id'], b['specialist_id'], b['id'], rating, content, now().date().isoformat()))
            except sqlite3.IntegrityError:
                return fail('Вы уже оставили отзыв об этой встрече', 409)
        return jsonify(ok=True), 201

    @app.post('/api/searches')
    @auth(*CUSTOMER_ROLES)
    def search_history(user):
        query = str(request.get_json().get('query', '')).strip()[:150]
        if query:
            with db() as c:
                c.execute("INSERT INTO searches(user_id,query,created_at) SELECT id,?,? FROM users WHERE id=? AND role!='deleted'",
                          (query, now().isoformat(timespec='minutes'), user['id']))
        return jsonify(ok=True)

    @app.post('/api/consult')
    def consult():
        message = str(request.get_json().get('message', '')).strip().lower()
        if not 1 <= len(message) <= 1000:
            return fail('Опишите задачу в пределах 1000 символов')
        rules = [(['кран', 'теч', 'труба', 'сантех', 'унитаз', 'засор'], 1, ('plumbing',), 'Похоже, вам нужен сантехник. Если вода течёт, по возможности перекройте её подачу. Специалист поможет найти причину и устранить протечку.'),
                 (['розет', 'электр', 'провод', 'свет'], 2, ('electrical',), 'Рекомендую электрика. Не касайтесь оголённых проводов. При запахе гари отключите питание, если это безопасно, и обратитесь в аварийную службу.'),
                 (['стриж', 'волос', 'уклад', 'красот'], 3, ('hair',), 'С новой стрижкой и уходом за волосами поможет стилист.'),
                 (['англий', 'язык', 'экзамен', 'репетитор'], 4, ('english',), 'Для занятий английским рекомендую преподавателя. Можно выбрать индивидуальный урок или разговорный клуб.'),
                 (['массаж', 'спин', 'мышц'], 5, ('massage',), 'По расслабляющему массажу можно обратиться к массажисту. При боли или травме сначала обратитесь к врачу: этот помощник не ставит диагнозов.'),
                 (['семинар', 'фото', 'съём', 'мастер-класс'], 6, ('portrait', 'photo-lessons'), 'Специалист проводит фотосессии и групповые мастер-классы. При записи на мастер-класс выберите количество мест.')]
        if any(x in message for x in ['газ', 'пожар', 'задыха', 'груд', 'искрит']):
            return jsonify(reply='Это может быть экстренная ситуация. При непосредственной опасности звоните 112. Обычная запись к специалисту не заменяет экстренную помощь.', specialist_id=None)
        for words, seed_id, category_ids, reply in rules:
            if any(w in message for w in words):
                with db() as c:
                    resolved_ids = tuple(active_category_id(c, ident) for ident in category_ids)
                    placeholders = ','.join('?' for _ in resolved_ids)
                    match = c.execute(f'''SELECT p.id AS specialist_id,v.id AS service_id,e.seed_key
                        FROM services v JOIN specialists p ON p.id=v.specialist_id
                        LEFT JOIN seed_entities e ON e.entity_id=p.id AND e.seed_key=?
                        WHERE v.category_id IN ({placeholders}) AND {PUBLIC_SERVICE}
                        ORDER BY e.seed_key IS NULL, v.id LIMIT 1''',
                                      (f'specialist:{seed_id}', *resolved_ids)).fetchone()
                if match:
                    if match['seed_key'] is None:
                        reply = 'В каталоге есть специалист с подходящей услугой.'
                    return jsonify(reply=reply, specialist_id=match['specialist_id'], service_id=match['service_id'])
                return jsonify(reply='Специалист этой категории сейчас недоступен. Попробуйте поискать в каталоге позже.', specialist_id=None)
        return jsonify(reply='Расскажите чуть подробнее: нужна помощь с ремонтом дома, стрижкой, английским, массажем или фотографией? Я подберу категорию и предложу специалиста.', specialist_id=None)

    @app.get('/api/master')
    @auth('master')
    def master(user):
        with db() as c:
            c.execute('BEGIN')
            services = c.execute('''SELECT v.*, (SELECT count(*) FROM bookings b JOIN slots s ON s.id=b.slot_id
                WHERE s.service_id=v.id AND b.status='confirmed' AND s.starts_at>?) upcoming_count
                FROM services v WHERE v.specialist_id=? AND v.deleted=0''',
                                 (now().isoformat(timespec='minutes'), user['specialist_id'])).fetchall()
            slots = c.execute('''SELECT s.*,v.title service,COALESCE((SELECT SUM(quantity) FROM bookings WHERE slot_id=s.id AND status='confirmed'),0) booked
                FROM slots s JOIN services v ON v.id=s.service_id WHERE s.specialist_id=? AND v.deleted=0 AND s.booking_mode='manual' AND s.starts_at>? ORDER BY s.starts_at''', (user['specialist_id'], now().isoformat(timespec='minutes'))).fetchall()
            schedule = schedule_for(c, user['specialist_id'])
            categories = category_groups(c)
        result = dict(services=[service_details(r) for r in services], slots=[dict(r) for r in slots],
                      categories=categories)
        if schedule:
            result['schedule'] = schedule
        return jsonify(result)

    @app.post('/api/master/schedule')
    @auth('master')
    def update_schedule(user):
        try:
            with db() as c:
                c.execute('BEGIN IMMEDIATE')
                if not c.execute('SELECT 1 FROM specialists WHERE id=? AND deleted=0', (user['specialist_id'],)).fetchone():
                    return fail('Профиль специалиста не найден', 404)
                save_schedule(c, user['specialist_id'], request.get_json())
                schedule = schedule_for(c, user['specialist_id'])
        except ValueError as error:
            return fail(str(error))
        return jsonify(schedule=schedule)

    @app.post('/api/master/services')
    @auth('master')
    def add_service(user):
        try:
            with db() as c:
                c.execute('BEGIN IMMEDIATE')
                fields = service_fields(c, request.get_json())
                if not c.execute('SELECT 1 FROM specialists WHERE id=? AND deleted=0', (user['specialist_id'],)).fetchone():
                    return fail('Профиль специалиста не найден', 404)
                ident = c.execute('''INSERT INTO services(specialist_id,title,price,duration,mode,category_id,moderation_status)
                    VALUES(?,?,?,?,?,?,'pending')''', (user['specialist_id'], *fields.values())).lastrowid
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(ok=True, id=ident, moderation_status='pending'), 201

    @app.post('/api/master/services/<int:ident>/<action>')
    @auth('master')
    def update_service(user, ident, action):
        if not 1 <= ident < 2**63 or action not in ('edit', 'delete'):
            return fail('Услуга не найдена', 404)
        try:
            with db() as c:
                manage_service(c, user['specialist_id'], ident, request.get_json(), action, now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(ok=True)

    @app.post('/api/master/slots')
    @auth('master')
    def add_slot(user):
        d = request.get_json()
        try:
            starts = datetime.fromisoformat(d.get('starts_at', ''))
            if starts.tzinfo is not None:
                raise ValueError()
        except (ValueError, TypeError):
            return fail('Укажите корректные дату и время')
        cap = d.get('capacity', 1)
        if type(cap) is not int or not 1 <= cap <= 50 or starts <= now() or starts > now() + timedelta(days=365):
            return fail('Дата должна быть в ближайшем году, количество мест — от 1 до 50')
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            if schedule_for(c, user['specialist_id']) is not None:
                return fail('Для ручных слотов переключите режим расписания', 409)
            service = c.execute('SELECT * FROM services WHERE id=? AND specialist_id=? AND active=1 AND deleted=0', (d.get('service_id'), user['specialist_id'])).fetchone()
            if not service:
                return fail('Услуга не найдена', 404)
            if service['mode'] != 'Группа' and cap != 1:
                return fail('Несколько мест доступны только для групповой услуги')
            end = starts + timedelta(minutes=service['duration'])
            existing = c.execute('SELECT s.starts_at,v.duration FROM slots s JOIN services v ON v.id=s.service_id WHERE s.specialist_id=? AND s.active=1 AND s.booking_mode="manual"', (user['specialist_id'],)).fetchall()
            try:
                occupied = [(datetime.fromisoformat(r['starts_at']), r['duration']) for r in existing]
                if any(start.tzinfo is not None for start, _ in occupied):
                    raise ValueError
            except (ValueError, TypeError):
                return fail('В расписании специалиста обнаружена некорректная дата', 409)
            if any(starts < start + timedelta(minutes=duration) and end > start for start, duration in occupied):
                return fail('Этот интервал пересекается с другим слотом', 409)
            c.execute('INSERT INTO slots(specialist_id,service_id,starts_at,capacity) VALUES(?,?,?,?)', (user['specialist_id'], service['id'], starts.isoformat(timespec='minutes'), cap))
        return jsonify(ok=True), 201

    @app.post('/api/master/slots/<int:ident>/close')
    @auth('master')
    def close_slot(user, ident):
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            slot = c.execute('SELECT * FROM slots WHERE id=? AND specialist_id=? AND booking_mode="manual"', (ident, user['specialist_id'])).fetchone()
            if not slot:
                return fail('Слот не найден', 404)
            if c.execute('SELECT id FROM bookings WHERE slot_id=? AND status="confirmed"', (ident,)).fetchone():
                return fail('Сначала отмените активные записи на этот слот', 409)
            c.execute('UPDATE slots SET active=0 WHERE id=?', (ident,))
        return jsonify(ok=True)

    @app.get('/api/support')
    @app.get('/api/support/<int:ident>')
    @auth('client', 'master', 'admin')
    def support(user, ident=None):
        status = request.args.get('status', 'all')
        order = request.args.get('order', 'newest')
        if status not in (*STATUSES, 'all') or order not in ('newest', 'oldest'):
            return fail('Некорректный фильтр или порядок сортировки')
        if ident is not None and not 1 <= ident < 2**63:
            return fail('Обращение не найдено', 404)
        with db() as c:
            items = support_items(c, user, ident, status, order)
        if ident is not None:
            return jsonify(item=items[0]) if items else fail('Обращение не найдено', 404)
        return jsonify(items=items)

    @app.post('/api/support')
    @auth('client', 'master')
    def send_support(user):
        try:
            with db() as c:
                ident, created = create_support(c, user, request.get_json(), now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(id=ident), 201 if created else 200

    @app.post('/api/support/<int:ident>/<action>')
    @auth('client', 'master', 'admin')
    def change_support(user, ident, action):
        if not 1 <= ident < 2**63 or action not in ('cancel', 'resolve'):
            return fail('Обращение не найдено', 404)
        if (user['role'] == 'admin') != (action == 'resolve'):
            return fail('Недостаточно прав', 403)
        try:
            with db() as c:
                update_support(c, user, ident, action, request.get_json(), now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(ok=True)

    @app.get('/api/admin/categories')
    @auth('admin')
    def list_categories(user):
        with db() as c:
            c.execute('BEGIN')
            return jsonify(groups=admin_directory(c))

    @app.post('/api/admin/categories')
    @app.post('/api/admin/categories/<ident>/<action>')
    @auth('admin')
    def change_category(user, ident=None, action='create'):
        if action not in ('create', 'edit', 'delete') or (action == 'create') != (ident is None):
            return fail('Действие не найдено', 404)
        try:
            with db() as c:
                if action == 'delete':
                    remove_category(c, ident, request.get_json())
                else:
                    ident = save_category(c, request.get_json(), ident)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(id=ident), 201 if action == 'create' else 200

    @app.get('/api/admin')
    @auth('admin')
    def admin(user):
        with db() as c:
            return jsonify(specialists=[dict(r) for r in c.execute('SELECT * FROM specialists WHERE deleted=0')],
                           services=[dict(r) for r in c.execute('SELECT v.*,p.name specialist FROM services v JOIN specialists p ON p.id=v.specialist_id WHERE v.deleted=0')])

    @app.post('/api/specialist-applications')
    @auth('client')
    def apply_for_specialist(user):
        try:
            with db() as c:
                application = submit_application(c, user['id'], request.get_json(), now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(application=application), 201

    @app.get('/api/admin/specialist-applications')
    @auth('admin')
    def specialist_applications(user):
        with db() as c:
            rows = c.execute("""SELECT a.*,u.name account_name,u.email FROM specialist_applications a
                JOIN users u ON u.id=a.user_id ORDER BY a.id DESC""").fetchall()
        return jsonify(applications=[dict(row) for row in rows])

    @app.post('/api/admin/specialist-applications/<int:ident>/decision')
    @auth('admin')
    def specialist_decision(user, ident):
        if not 1 <= ident < 2**63:
            return fail('Заявка не найдена', 404)
        try:
            with db() as c:
                decide_application(c, ident, request.get_json(), now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(ok=True)

    @app.get('/api/admin/service-applications')
    @auth('admin')
    def service_applications(user):
        status = request.args.get('status', 'pending')
        if status not in ('pending', 'approved', 'rejected', 'all'):
            return fail('Некорректный статус заявки')
        with db() as c:
            applications = c.execute("""SELECT v.*,p.name specialist,
                    COALESCE(v.draft_status,v.moderation_status) application_status
                FROM services v JOIN specialists p ON p.id=v.specialist_id
                WHERE v.deleted=0 AND (?='all' OR COALESCE(v.draft_status,v.moderation_status)=?)
                ORDER BY v.id DESC""", (status, status)).fetchall()
            labels = {category['id']: (group['name'], category['name'])
                      for group in category_groups(c) for category in group['categories']}
        result = []
        for row in applications:
            service = {**dict(row), **(service_details(row)['draft'] or {})}
            service['category_direction'], service['category_name'] = labels.get(service['category_id'], (None, None))
            result.append(service)
        return jsonify(applications=result)

    @app.post('/api/admin/service-applications/<int:ident>/decision')
    @auth('admin')
    def service_decision(user, ident):
        if not 1 <= ident < 2**63:
            return fail('Услуга не найдена', 404)
        try:
            with db() as c:
                service = decide_service(c, ident, request.get_json(), now)
        except ModerationError as error:
            return fail(str(error), error.status)
        return jsonify(service=service)

    @app.post('/api/admin/moderate')
    @auth('admin')
    def moderate(user):
        d = request.get_json()
        kind, ident = d.get('kind'), d.get('id')
        with db() as c:
            if kind == 'review' and d.get('status') in ['approved', 'rejected']:
                cur = c.execute('UPDATE reviews SET status=? WHERE id=?', (d['status'], ident))
            elif kind in ['specialist', 'service'] and type(d.get('active')) is bool:
                table = 'specialists' if kind == 'specialist' else 'services'
                scope = ' AND deleted=0'
                cur = c.execute(f'UPDATE {table} SET active=? WHERE id=?{scope}', (int(d['active']), ident))
            else:
                return fail('Некорректное действие модерации')
            if not cur.rowcount:
                return fail('Объект не найден', 404)
        return jsonify(ok=True)

    init_db(app, db)
    return app


def init_db(app, db):
    from backend.database.seed_data import initialize_database
    with db() as connection:
        initialize_database(connection, now())


if __name__ == '__main__':
    create_app().run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
