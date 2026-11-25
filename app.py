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
from booking_service import BookingError, available_slots, create_booking
from booking_lifecycle import booking_interval, booking_policy, transition_booking
from password_recovery import send_recovery_email

load_dotenv()

TZ = ZoneInfo('Europe/Kirov')
CATEGORIES = ['Все специалисты', 'Дом и ремонт', 'Красота', 'Обучение', 'Здоровье', 'Мероприятия']


def now():
    return datetime.now(TZ).replace(tzinfo=None)


def create_app(test_config=None):
    app = Flask(__name__, static_folder='static')
    app.config.update(DATABASE=os.path.join(app.instance_path, 'svobodno.sqlite'), SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '').lower() in ('1', 'true', 'yes'), MAX_CONTENT_LENGTH=1024 * 1024,
                      SMTP_HOST=os.environ.get('SMTP_HOST', ''), SMTP_PORT=int(os.environ.get('SMTP_PORT', '587')),
                      SMTP_USERNAME=os.environ.get('SMTP_USERNAME', ''), SMTP_PASSWORD=os.environ.get('SMTP_PASSWORD', ''),
                      SMTP_FROM_EMAIL=os.environ.get('SMTP_FROM_EMAIL', ''), SMTP_FROM_NAME=os.environ.get('SMTP_FROM_NAME', 'Свободно.'),
                      APP_BASE_URL=os.environ.get('APP_BASE_URL', 'http://127.0.0.1:5000'),
                      PASSWORD_RESET_TTL_MINUTES=30, PASSWORD_RESET_LIMIT=3, PASSWORD_RESET_WINDOW_MINUTES=60)
    if test_config:
        app.config.update(test_config)
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

    def fail(message, status=400):
        return jsonify(error=message), status

    def auth(role=None):
        def deco(fn):
            @wraps(fn)
            def wrapped(*args, **kwargs):
                with db() as c:
                    user = c.execute('SELECT * FROM users WHERE id=?', (session.get('uid'),)).fetchone()
                if not user:
                    return fail('Войдите в личный кабинет', 401)
                if role and user['role'] != role:
                    return fail('Недостаточно прав', 403)
                return fn(user, *args, **kwargs)
            return wrapped
        return deco

    @app.before_request
    def csrf():
        if request.method in ('POST', 'PATCH', 'DELETE'):
            if not session.get('csrf') or request.headers.get('X-CSRF-Token') != session['csrf']:
                return fail('Обновите страницу и повторите действие', 403)
            if not request.is_json:
                return fail('Ожидается JSON', 415)
            if not isinstance(request.get_json(), dict):
                return fail('Ожидается JSON-объект')

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

    @app.route('/')
    @app.route('/reset-password')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    @app.get('/api/session')
    def current():
        session.setdefault('csrf', secrets.token_hex(24))
        with db() as c:
            user = c.execute('SELECT id,name,email,role,specialist_id FROM users WHERE id=?', (session.get('uid'),)).fetchone()
        return jsonify(user=dict(user) if user else None, csrf=session['csrf'])

    @app.post('/api/login')
    def login():
        data = request.get_json()
        with db() as c:
            user = c.execute('SELECT * FROM users WHERE email=?', (str(data.get('email', '')).strip().lower(),)).fetchone()
        if not user or not check_password_hash(user['password'], str(data.get('password', ''))):
            return fail('Неверная почта или пароль', 401)
        session.clear()
        session.update(uid=user['id'], csrf=secrets.token_hex(24))
        return current()

    @app.post('/api/register')
    def register():
        d = request.get_json()
        name, email, password = (str(d.get(k, '')).strip() for k in ('name', 'email', 'password'))
        if not 2 <= len(name) <= 80 or '@' not in email or len(email) > 120 or not 8 <= len(password) <= 128:
            return fail('Укажите имя, корректную почту и пароль от 8 до 128 символов')
        try:
            with db() as c:
                uid = c.execute('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',
                                (name, email.lower(), generate_password_hash(password), 'client')).lastrowid
        except sqlite3.IntegrityError:
            return fail('Эта почта уже зарегистрирована', 409)
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
            user = c.execute('SELECT id,email,name FROM users WHERE email=?', (email,)).fetchone()
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

    @app.get('/api/catalog')
    def catalog():
        with db() as c:
            specialists = []
            for row in c.execute('SELECT * FROM specialists WHERE active=1 ORDER BY id'):
                s = dict(row)
                s['services'] = [dict(r) for r in c.execute('SELECT * FROM services WHERE specialist_id=? AND active=1', (s['id'],))]
                s['reviews'] = [dict(r) for r in c.execute('SELECT r.*,u.name FROM reviews r JOIN users u ON r.user_id=u.id WHERE r.specialist_id=? AND r.status="approved" ORDER BY r.id DESC', (s['id'],))]
                s['rating'] = round(sum(r['rating'] for r in s['reviews']) / len(s['reviews']), 1) if s['reviews'] else None
                s['next_slot'] = c.execute('SELECT MIN(starts_at) FROM slots WHERE specialist_id=? AND starts_at>? AND active=1', (s['id'], now().isoformat(timespec='minutes'))).fetchone()[0]
                specialists.append(s)
        return jsonify(specialists=specialists, categories=CATEGORIES, timezone='Europe/Kirov')

    @app.get('/api/slots/<int:specialist_id>')
    def slots(specialist_id):
        service_id = request.args.get('service_id')
        if service_id is not None:
            try:
                service_id = int(service_id)
                if service_id < 1:
                    raise ValueError
            except ValueError:
                return fail('Укажите корректную услугу')
        with db() as c:
            rows = available_slots(c, specialist_id, now(), service_id)
        return jsonify(slots=rows)

    @app.post('/api/bookings')
    @auth('client')
    def book(user):
        try:
            with db() as c:
                ident = create_booking(c, user['id'], request.get_json(), now())
        except BookingError as error:
            return fail(str(error), error.status)
        return jsonify(id=ident), 201

    @app.get('/api/notifications')
    @auth()
    def notifications(user):
        with db() as c:
            rows = c.execute(
                'SELECT id,booking_id,event,message,created_at,is_read FROM notifications WHERE user_id=? ORDER BY id DESC',
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

    @app.get('/api/dashboard')
    @auth()
    def dashboard(user):
        where, params = ('b.user_id=?', (user['id'],)) if user['role'] == 'client' else ('s.specialist_id=?', (user['specialist_id'],)) if user['role'] == 'master' else ('1=1', ())
        with db() as c:
            bookings = c.execute(f'''SELECT b.*,s.starts_at,s.specialist_id,s.capacity,v.title service,v.mode,v.duration,p.name specialist,p.photo,u.name client
                FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id
                JOIN specialists p ON p.id=s.specialist_id JOIN users u ON u.id=b.user_id WHERE {where} ORDER BY s.starts_at DESC''', params).fetchall()
            searches = c.execute('SELECT * FROM searches WHERE user_id=? ORDER BY id DESC LIMIT 30', (user['id'],)).fetchall()
            reviews = c.execute('SELECT r.*,p.name specialist,u.name author FROM reviews r JOIN specialists p ON p.id=r.specialist_id JOIN users u ON u.id=r.user_id ' + ('' if user['role'] == 'admin' else 'WHERE r.user_id=? ') + 'ORDER BY r.id DESC', () if user['role'] == 'admin' else (user['id'],)).fetchall()
        current_time = now()
        reviewed_ids = {r['booking_id'] for r in reviews}
        rows = [{**dict(b), **booking_policy(b, user, current_time, b['id'] in reviewed_ids)} for b in bookings]
        return jsonify(bookings=rows, searches=[dict(r) for r in searches], reviews=[dict(r) for r in reviews],
                       server_now=current_time.isoformat(timespec='seconds'))

    def apply_booking_transition(user, ident, action):
        try:
            with db() as c:
                transition_booking(c, user, ident, action, now)
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

    @app.post('/api/reviews')
    @auth('client')
    def review(user):
        d = request.get_json()
        rating, content = d.get('rating'), str(d.get('content', '')).strip()
        if type(rating) is not int or not 1 <= rating <= 5 or not 5 <= len(content) <= 1500:
            return fail('Оцените от 1 до 5 и напишите отзыв от 5 до 1500 символов')
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            b = c.execute('SELECT b.*,s.specialist_id,s.starts_at,v.duration FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id WHERE b.id=? AND b.user_id=? AND b.status="completed"', (d.get('booking_id'), user['id'])).fetchone()
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
    @auth('client')
    def search_history(user):
        query = str(request.get_json().get('query', '')).strip()[:150]
        if query:
            with db() as c:
                c.execute('INSERT INTO searches(user_id,query,created_at) VALUES(?,?,?)', (user['id'], query, now().isoformat(timespec='minutes')))
        return jsonify(ok=True)

    @app.post('/api/consult')
    def consult():
        message = str(request.get_json().get('message', '')).strip().lower()
        if not 1 <= len(message) <= 1000:
            return fail('Опишите задачу в пределах 1000 символов')
        rules = [(['кран', 'теч', 'труба', 'сантех', 'унитаз', 'засор'], 1, 'Похоже, вам нужен сантехник. Если вода течёт, по возможности перекройте её подачу. Алексей поможет найти причину и устранить протечку.'),
                 (['розет', 'электр', 'провод', 'свет'], 2, 'Рекомендую электрика. Не касайтесь оголённых проводов. При запахе гари отключите питание, если это безопасно, и обратитесь в аварийную службу.'),
                 (['стриж', 'волос', 'уклад', 'красот'], 3, 'С новой стрижкой и уходом за волосами поможет стилист Мария.'),
                 (['англий', 'язык', 'экзамен', 'репетитор'], 4, 'Для занятий английским рекомендую Анну. Можно выбрать индивидуальный урок или разговорный клуб.'),
                 (['массаж', 'спин', 'мышц'], 5, 'По расслабляющему массажу можно обратиться к Дмитрию. При боли или травме сначала обратитесь к врачу: этот помощник не ставит диагнозов.'),
                 (['семинар', 'фото', 'съём', 'мастер-класс'], 6, 'Елена проводит фотосессии и групповые мастер-классы. При записи на мастер-класс выберите количество мест.')]
        if any(x in message for x in ['газ', 'пожар', 'задыха', 'груд', 'искрит']):
            return jsonify(reply='Это может быть экстренная ситуация. При непосредственной опасности звоните 112. Обычная запись к специалисту не заменяет экстренную помощь.', specialist_id=None)
        for words, ident, reply in rules:
            if any(w in message for w in words):
                with db() as c:
                    active = c.execute('SELECT p.id,p.active FROM seed_entities e JOIN specialists p ON p.id=e.entity_id WHERE e.seed_key=?', (f'specialist:{ident}',)).fetchone()
                if active and active['active']:
                    return jsonify(reply=reply, specialist_id=active['id'])
                return jsonify(reply='Специалист этой категории сейчас недоступен. Попробуйте поискать в каталоге позже.', specialist_id=None)
        return jsonify(reply='Расскажите чуть подробнее: нужна помощь с ремонтом дома, стрижкой, английским, массажем или фотографией? Я подберу категорию и предложу специалиста.', specialist_id=None)

    @app.get('/api/master')
    @auth('master')
    def master(user):
        with db() as c:
            services = c.execute('SELECT * FROM services WHERE specialist_id=?', (user['specialist_id'],)).fetchall()
            slots = c.execute('''SELECT s.*,v.title service,COALESCE((SELECT SUM(quantity) FROM bookings WHERE slot_id=s.id AND status='confirmed'),0) booked
                FROM slots s JOIN services v ON v.id=s.service_id WHERE s.specialist_id=? AND s.starts_at>? ORDER BY s.starts_at''', (user['specialist_id'], now().isoformat(timespec='minutes'))).fetchall()
        return jsonify(services=[dict(r) for r in services], slots=[dict(r) for r in slots])

    @app.post('/api/master/services')
    @auth('master')
    def add_service(user):
        d = request.get_json()
        title, mode = str(d.get('title', '')).strip(), d.get('mode')
        price, duration = d.get('price'), d.get('duration')
        if not 3 <= len(title) <= 100 or mode not in ['Выезд', 'У специалиста', 'Онлайн', 'Группа'] or type(price) is not int or not 0 <= price <= 1000000 or type(duration) is not int or not 15 <= duration <= 480:
            return fail('Проверьте название, формат, стоимость и длительность (15–480 минут)')
        with db() as c:
            c.execute('INSERT INTO services(specialist_id,title,price,duration,mode) VALUES(?,?,?,?,?)', (user['specialist_id'], title, price, duration, mode))
        return jsonify(ok=True), 201

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
            service = c.execute('SELECT * FROM services WHERE id=? AND specialist_id=? AND active=1', (d.get('service_id'), user['specialist_id'])).fetchone()
            if not service:
                return fail('Услуга не найдена', 404)
            if service['mode'] != 'Группа' and cap != 1:
                return fail('Несколько мест доступны только для групповой услуги')
            end = starts + timedelta(minutes=service['duration'])
            existing = c.execute('SELECT s.starts_at,v.duration FROM slots s JOIN services v ON v.id=s.service_id WHERE s.specialist_id=? AND s.active=1', (user['specialist_id'],)).fetchall()
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
            slot = c.execute('SELECT * FROM slots WHERE id=? AND specialist_id=?', (ident, user['specialist_id'])).fetchone()
            if not slot:
                return fail('Слот не найден', 404)
            if c.execute('SELECT id FROM bookings WHERE slot_id=? AND status="confirmed"', (ident,)).fetchone():
                return fail('Сначала отмените активные записи на этот слот', 409)
            c.execute('UPDATE slots SET active=0 WHERE id=?', (ident,))
        return jsonify(ok=True)

    @app.get('/api/admin')
    @auth('admin')
    def admin(user):
        with db() as c:
            return jsonify(specialists=[dict(r) for r in c.execute('SELECT * FROM specialists')],
                           services=[dict(r) for r in c.execute('SELECT v.*,p.name specialist FROM services v JOIN specialists p ON p.id=v.specialist_id')])

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
                cur = c.execute(f'UPDATE {table} SET active=? WHERE id=?', (int(d['active']), ident))
            else:
                return fail('Некорректное действие модерации')
            if not cur.rowcount:
                return fail('Объект не найден', 404)
        return jsonify(ok=True)

    init_db(app, db)
    return app


def init_db(app, db):
    from seed_data import initialize_database
    with db() as connection:
        initialize_database(connection, now())


if __name__ == '__main__':
    create_app().run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
