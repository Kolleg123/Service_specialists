"""Optional test payments for existing bookings, with durable provider operation keys."""
import base64
import hmac
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

import click
from flask import jsonify, request

from backend.auth.runtime import env_flag
from backend.bookings.service import parse_start
from backend.database.idempotency import Operation


PAYMENT_SCHEMA = '''CREATE TABLE IF NOT EXISTS booking_payments(
    id TEXT PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    shop_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount>0),
    currency TEXT NOT NULL DEFAULT 'RUB',
    return_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('creating','failed','pending','waiting_for_capture','succeeded','canceled')),
    provider_id TEXT UNIQUE,
    confirmation_url TEXT,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    refund_started_at INTEGER,
    refund_id TEXT UNIQUE,
    refund_status TEXT CHECK(refund_status IN ('pending','succeeded','canceled'))
)'''
PROVIDER_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')
PAYMENT_STATUSES = ('pending', 'waiting_for_capture', 'succeeded', 'canceled')
REFUND_STATUSES = ('pending', 'succeeded', 'canceled')
POLL_SECONDS = 30
# YooKassa retains idempotency keys for 24 hours. Leave a margin for network delay.
RETRY_WINDOW = 23 * 60 * 60
MESSAGES = {
    'payment_pending': 'Тестовый платёж ожидает подтверждения.',
    'payment_succeeded': 'Тестовый платёж подтверждён.',
    'payment_canceled': 'Тестовый платёж отменён. Если встреча ещё предстоит, оплату можно повторить.',
    'payment_failed': 'ЮKassa отклонила создание тестового платежа.',
    'refund_pending': 'Для отменённой записи оформляется тестовый возврат.',
    'refund_succeeded': 'Тестовый возврат выполнен.',
    'refund_canceled': 'Тестовый возврат отменён. Нужна проверка администратором.',
}


class PaymentError(ValueError):
    def __init__(self, message, status=503, upstream_status=None):
        super().__init__(message)
        self.status = status
        self.upstream_status = upstream_status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def identifier(value):
    return isinstance(value, str) and PROVIDER_ID.fullmatch(value) is not None


def trusted_url(value, public=False):
    if not isinstance(value, str) or any(c.isspace() or c == '\\' for c in value):
        return False
    try:
        parts = urlsplit(value)
        return bool(parts.hostname and parts.username is None and parts.password is None and (
            parts.scheme == 'https' or (not public and parts.scheme == 'http'
                                        and parts.hostname in ('localhost', '127.0.0.1', '::1'))))
    except ValueError:
        return False


class YooKassa:
    def __init__(self, shop, key):
        self.authorization = 'Basic ' + base64.b64encode(f'{shop}:{key}'.encode()).decode()
        self.opener = build_opener(NoRedirect())

    def call(self, endpoint, payload=None, key=None):
        headers = {'Authorization': self.authorization, 'Accept': 'application/json'}
        if key:
            headers.update({'Content-Type': 'application/json', 'Idempotence-Key': key})
        req = Request('https://api.yookassa.ru/v3/' + endpoint,
                      data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        try:
            with self.opener.open(req, timeout=5) as response:
                result = json.load(response)
            if isinstance(result, dict):
                return result
        except HTTPError as error:
            status = error.code
            error.close()
            raise PaymentError('ЮKassa временно недоступна или отклонила запрос.', upstream_status=status) from None
        except (URLError, OSError, ValueError):
            pass
        raise PaymentError('ЮKassa не подтвердила результат. Проверьте статус позже.')


class Payments:
    def __init__(self, app, db, clock):
        self.app, self.db, self.clock = app, db, clock
        self.shop = app.config['YOOKASSA_SHOP_ID']
        self.return_url = app.config['YOOKASSA_RETURN_URL']
        self.webhook_token = app.config['YOOKASSA_WEBHOOK_TOKEN']
        key = app.config['YOOKASSA_SECRET_KEY']
        self.enabled = bool(app.config['PAYMENTS_ENABLED'] and re.fullmatch(r'[0-9]+', self.shop)
                            and key.startswith('test_') and len(key) > 5 and trusted_url(self.return_url))
        self.api = app.config.get('YOOKASSA_API') if app.testing else None
        if self.enabled and not self.api:
            self.api = YooKassa(self.shop, key)
        if app.config['PAYMENTS_ENABLED'] and not self.enabled:
            app.logger.warning('Test payments disabled: check the YooKassa test shop configuration')

    @staticmethod
    def configure(app):
        app.config.update(PAYMENTS_ENABLED=env_flag('PAYMENTS_ENABLED'))
        for key in ('SHOP_ID', 'SECRET_KEY', 'RETURN_URL', 'WEBHOOK_TOKEN'):
            name = 'YOOKASSA_' + key
            app.config[name] = os.environ.get(name, '')

    @staticmethod
    def amount(row):
        return {'value': f"{row['amount']}.00", 'currency': row['currency']}

    def start(self, user_id, booking_id, operation_key):
        if not self.enabled:
            raise PaymentError('Тестовая оплата отключена', 404)
        if not 1 <= booking_id < 2**63:
            raise PaymentError('Запись не найдена', 404)
        with self.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            booking = connection.execute('''SELECT b.*,s.starts_at FROM bookings b
                JOIN slots s ON s.id=b.slot_id WHERE b.id=? AND b.user_id=?''', (booking_id, user_id)).fetchone()
            if not booking:
                raise PaymentError('Запись не найдена', 404)
            operation = Operation(connection, user_id, 'payment', operation_key, {'booking_id': booking_id})
            previous = operation.previous()
            if previous:
                payment_id = previous['payment_id']
            else:
                if (booking['status'] != 'confirmed' or parse_start(booking['starts_at']) <= self.clock()
                        or not booking['total'] or booking['total'] < 1):
                    raise PaymentError('Оплата доступна для предстоящих подтверждённых записей с ненулевой ценой', 409)
                row = self.latest(connection, booking_id)
                if row and row['shop_id'] != self.shop:
                    raise PaymentError('Для этой записи нужен исходный тестовый магазин', 409)
                if not row or row['status'] in ('canceled', 'failed'):
                    payment_id = uuid4().hex
                    connection.execute("""INSERT INTO booking_payments
                        (id,booking_id,shop_id,amount,return_url,created_at,status)
                        VALUES(?,?,?,?,?,?,'creating')""",
                        (payment_id, booking_id, self.shop, booking['total'], self.return_url, int(time.time())))
                else:
                    payment_id = row['id']
                operation.save({'payment_id': payment_id})
        return self.sync(payment_id, interactive=True)

    @staticmethod
    def latest(connection, booking_id):
        return connection.execute('SELECT * FROM booking_payments WHERE booking_id=? ORDER BY rowid DESC LIMIT 1',
                                  (booking_id,)).fetchone()

    @staticmethod
    def read(connection, payment_id):
        return connection.execute('''SELECT p.*,b.status booking_status FROM booking_payments p
            JOIN bookings b ON b.id=p.booking_id WHERE p.id=?''', (payment_id,)).fetchone()

    def notify(self, connection, row, event):
        connection.execute("""INSERT OR IGNORE INTO notifications
            (user_id,booking_id,payment_id,event,message,created_at)
            SELECT u.id,b.id,?,?,?,? FROM bookings b JOIN users u ON u.id=b.user_id
            WHERE b.id=? AND u.role!='deleted'""",
            (row['id'], event, MESSAGES[event], self.clock().isoformat(), row['booking_id']))

    def store_payment(self, remote, expected_id):
        metadata = remote.get('metadata')
        if not isinstance(metadata, dict) or not identifier(metadata.get('attempt')):
            raise PaymentError('ЮKassa вернула неожиданный идентификатор операции')
        payment_id = metadata['attempt']
        if expected_id and expected_id != payment_id:
            raise PaymentError('ЮKassa вернула другую операцию')
        with self.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = self.read(connection, payment_id)
            if not row and not expected_id:
                return None
            provider_id = remote.get('id')
            status = remote.get('status')
            recipient = remote.get('recipient')
            if (not row or row['shop_id'] != self.shop or not identifier(provider_id)
                    or not isinstance(recipient, dict) or str(recipient.get('account_id')) != self.shop
                    or remote.get('test') is not True or remote.get('amount') != self.amount(row)
                    or metadata.get('booking') != str(row['booking_id']) or status not in PAYMENT_STATUSES
                    or (row['provider_id'] and provider_id != row['provider_id'])):
                raise PaymentError('Данные платежа ЮKassa не совпадают с записью')
            if row['status'] in ('succeeded', 'canceled'):
                return row
            if row['status'] == 'waiting_for_capture' and status == 'pending':
                return row
            confirmation = remote.get('confirmation') or {}
            url = confirmation.get('confirmation_url') if isinstance(confirmation, dict) else None
            if not trusted_url(url, public=True):
                url = row['confirmation_url']
            connection.execute('UPDATE booking_payments SET provider_id=?,status=?,confirmation_url=? WHERE id=?',
                               (provider_id, status, url if status == 'pending' else None, payment_id))
            if status != row['status'] and (status != 'waiting_for_capture' or row['status'] != 'pending'):
                self.notify(connection, row, 'payment_' + ('pending' if status == 'waiting_for_capture' else status))
            return self.read(connection, payment_id)

    def sync(self, payment_id, interactive=False):
        with self.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = self.read(connection, payment_id)
            if not row or row['shop_id'] != self.shop:
                raise PaymentError('Платёж не найден в этом тестовом магазине', 404)
            timestamp = int(time.time())
            if row['next_check_at'] > timestamp:
                return row
            connection.execute('UPDATE booking_payments SET next_check_at=? WHERE id=?',
                               (timestamp + POLL_SECONDS, payment_id))

        if row['status'] == 'creating' and timestamp - row['created_at'] < RETRY_WINDOW:
            try:
                remote = self.api.call('payments', {
                    'amount': self.amount(row), 'capture': True, 'payment_method_data': {'type': 'bank_card'},
                    'confirmation': {'type': 'redirect', 'return_url': row['return_url']},
                    'description': f"Свободно. Тестовая оплата записи №{row['booking_id']}",
                    'metadata': {'attempt': row['id'], 'booking': str(row['booking_id'])}
                }, row['id'])
            except PaymentError as error:
                if error.upstream_status != 400:
                    raise
                with self.db() as connection:
                    changed = connection.execute("""UPDATE booking_payments SET status='failed'
                        WHERE id=? AND status='creating' AND provider_id IS NULL""", (payment_id,)).rowcount
                    if changed:
                        self.notify(connection, row, 'payment_failed')
                if interactive and changed:
                    raise PaymentError('ЮKassa отклонила создание платежа. Проверьте настройки тестового магазина.', 502)
            else:
                row = self.store_payment(remote, payment_id)
        elif row['status'] in ('pending', 'waiting_for_capture'):
            remote = self.api.call('payments/' + row['provider_id'])
            if remote.get('id') != row['provider_id']:
                raise PaymentError('ЮKassa вернула другой платёж')
            row = self.store_payment(remote, payment_id)
        if row['status'] == 'succeeded' and row['booking_status'] == 'cancelled':
            self.refund(payment_id)
        with self.db() as connection:
            return self.read(connection, payment_id)

    def refund(self, payment_id):
        with self.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = self.read(connection, payment_id)
            if (not row or row['shop_id'] != self.shop or row['status'] != 'succeeded'
                    or row['booking_status'] != 'cancelled' or row['refund_status'] in ('succeeded', 'canceled')):
                return
            timestamp = int(time.time())
            if row['refund_started_at'] is None:
                connection.execute('''UPDATE booking_payments SET refund_started_at=?,refund_status='pending'
                    WHERE id=?''', (timestamp, payment_id))
                self.notify(connection, row, 'refund_pending')
                row = self.read(connection, payment_id)
        if row['refund_id']:
            remote = self.api.call('refunds/' + row['refund_id'])
        elif timestamp - row['refund_started_at'] < RETRY_WINDOW:
            remote = self.api.call('refunds', {'amount': self.amount(row), 'payment_id': row['provider_id']},
                                   'refund-' + payment_id)
        else:
            return
        self.store_refund(row, remote, row['refund_id'])

    def store_refund(self, row, remote, expected_id=None):
        refund_id, status = remote.get('id'), remote.get('status')
        if (not identifier(refund_id) or (expected_id and refund_id != expected_id)
                or status not in REFUND_STATUSES or remote.get('test', True) is not True
                or remote.get('payment_id') != row['provider_id'] or remote.get('amount') != self.amount(row)):
            raise PaymentError('Данные возврата ЮKassa не совпадают с записью')
        with self.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = self.read(connection, row['id'])
            if row['refund_status'] in ('succeeded', 'canceled'):
                return
            if row['refund_id'] and row['refund_id'] != refund_id:
                raise PaymentError('ЮKassa вернула другой возврат')
            connection.execute('UPDATE booking_payments SET refund_id=?,refund_status=? WHERE id=?',
                               (refund_id, status, row['id']))
            if status != row['refund_status']:
                self.notify(connection, row, 'refund_' + status)

    def due(self, where='1=1', params=(), limit=10):
        if not self.enabled:
            return 0
        timestamp = int(time.time())
        with self.db() as connection:
            ids = [row['id'] for row in connection.execute(f'''SELECT p.id FROM booking_payments p
                JOIN bookings b ON b.id=p.booking_id JOIN slots s ON s.id=b.slot_id
                WHERE ({where}) AND p.shop_id=? AND p.next_check_at<=? AND (
                    p.status IN ('pending','waiting_for_capture')
                    OR (p.status='creating' AND p.created_at>?)
                    OR (p.status='succeeded' AND b.status='cancelled'
                        AND COALESCE(p.refund_status,'') NOT IN ('succeeded','canceled')
                        AND (p.refund_id IS NOT NULL OR p.refund_started_at IS NULL OR p.refund_started_at>?)))
                ORDER BY p.next_check_at,p.rowid LIMIT ?''',
                (*params, self.shop, timestamp, timestamp-RETRY_WINDOW, timestamp-RETRY_WINDOW, limit))]
        for payment_id in ids:
            try:
                self.sync(payment_id)
            except PaymentError as error:
                self.app.logger.warning('YooKassa reconciliation: %s (%s)', error, payment_id)
        return len(ids)

    def summary(self, booking, user, timestamp):
        state = booking['refund_status'] or booking['payment_status']
        if booking['refund_status']:
            state = 'refund_' + state
        if booking['payment_status'] == 'succeeded' and booking['status'] == 'cancelled' and not booking['refund_status']:
            state = 'refund_pending'
        if ((state == 'creating' and timestamp - booking['payment_created'] >= RETRY_WINDOW)
                or (state == 'refund_pending' and booking['refund_started'] and not booking['provider_refund_id']
                    and timestamp - booking['refund_started'] >= RETRY_WINDOW)):
            state = 'needs_review'
        can_pay = (self.enabled and booking['user_id'] == user['id'] and booking['phase'] == 'upcoming'
                   and booking['total'] and booking['total'] >= 1 and booking['payment_shop'] in (None, self.shop)
                   and state in (None, 'canceled', 'failed', 'creating', 'pending'))
        return {'status': state or 'unpaid', 'can_pay': bool(can_pay)} if self.enabled or state else None

    def webhook(self, token):
        if (not self.enabled or len(self.webhook_token) < 32
                or not hmac.compare_digest(token.encode(), self.webhook_token.encode())):
            return '', 404
        notice = request.get_json(silent=True)
        if not isinstance(notice, dict) or notice.get('type') != 'notification':
            return '', 400
        obj = notice.get('object')
        event = notice.get('event')
        if not isinstance(obj, dict) or not identifier(obj.get('id')):
            return '', 400
        object_id = obj['id']
        try:
            if event in ('payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture'):
                remote = self.api.call('payments/' + object_id)
                if remote.get('id') != object_id:
                    raise PaymentError('YooKassa webhook object mismatch')
                if remote.get('status') != event.split('.')[1]:
                    # Outdated events must not overwrite the actual provider status.
                    if remote.get('status') not in ('succeeded', 'canceled'):
                        raise PaymentError('YooKassa webhook status not yet visible')
                if isinstance(remote.get('metadata'), dict) and 'attempt' in remote['metadata']:
                    row = self.store_payment(remote, None)
                    if row and row['status'] == 'succeeded' and row['booking_status'] == 'cancelled':
                        self.refund(row['id'])
            elif event == 'refund.succeeded':
                remote = self.api.call('refunds/' + object_id)
                with self.db() as connection:
                    row = connection.execute('''SELECT * FROM booking_payments WHERE provider_id=?
                        AND shop_id=? AND refund_started_at IS NOT NULL''',
                        (str(remote.get('payment_id')), self.shop)).fetchone()
                if row:
                    if remote.get('status') != 'succeeded':
                        raise PaymentError('YooKassa refund status not yet visible')
                    self.store_refund(row, remote, object_id)
        except PaymentError as error:
            if error.upstream_status == 404:
                return '', 200
            self.app.logger.warning('YooKassa webhook reconciliation failed: %s', error)
            return '', 503
        return '', 200

    def register(self, auth):
        @self.app.errorhandler(PaymentError)
        def payment_error(error):
            return jsonify(error=str(error)), error.status

        @self.app.post('/api/bookings/<int:ident>/payment')
        @auth('client', 'master')
        def pay(user, ident):
            row = self.start(user['id'], ident, request.headers.get('Idempotency-Key'))
            url = row['confirmation_url'] if row['booking_status'] == 'confirmed' else None
            return jsonify(status=row['status'], confirmation_url=url)

        self.app.add_url_rule('/api/payments/yookassa/<token>', view_func=self.webhook, methods=['POST'])

        @self.app.cli.command('sync-payments')
        def sync_payments():
            """Check a bounded batch of due test payment and refund operations."""
            click.echo(f'Передано на сверку: {self.due(limit=20)}')
