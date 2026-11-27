from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import sqlite3

from app import create_app, now
from backend.bookings.payments import PaymentError
from tests.test_app import client, post
from tests.test_service_moderation import NEW_SERVICE


def setup(tmp_path, **options):
    return create_app({
        'TESTING': True, 'SECRET_KEY': 'isolated-test-key',
        'DATABASE': str(tmp_path / 'ordinary.sqlite'), 'DEMO_DATABASE': str(tmp_path / 'demo.sqlite'),
        **options,
    })


def submit(browser, path, data, key):
    csrf = browser.get('/api/session').json['csrf']
    return browser.post('/api' + path, json=data, headers={'X-CSRF-Token': csrf, 'Idempotency-Key': key})


def test_modes_keep_data_and_reject_demo_login_and_cookies(tmp_path):
    ordinary = setup(tmp_path, DEMO_MODE=False)
    browser = ordinary.test_client()
    assert browser.get('/api/catalog').json['specialists'] == []
    assert post(browser, '/register', {'name': 'Мой клиент', 'username': 'own-client', 'email': 'own@example.test',
                                       'password': 'MyPassword123'}).status_code == 200
    own_session = browser.get_cookie('svobodno_session')
    demo = setup(tmp_path, DEMO_MODE=True)
    master_cookie = client(demo, 'admin').get_cookie('svobodno_demo')
    assert demo.test_client().get('/api/session').json['demo_mode'] is True
    assert len(demo.test_client().get('/api/catalog').json['specialists']) == 6
    restarted = setup(tmp_path, DEMO_MODE=False, APP_BASE_URL='https://example.test')
    browser = restarted.test_client()
    browser.set_cookie(own_session.key, own_session.value)
    assert browser.get('/api/dashboard').status_code == 200
    browser.set_cookie(own_session.key, master_cookie.value)
    assert browser.get('/api/admin').status_code == 401
    headers = restarted.test_client().get('/api/session').headers['Set-Cookie']
    assert all(value in headers for value in ('Secure', 'HttpOnly', 'SameSite=Lax'))
    with sqlite3.connect(ordinary.config['DATABASE']) as target, sqlite3.connect(demo.config['DATABASE']) as source:
        target.execute('''INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)''',
                       source.execute("SELECT name,email,password,role FROM users WHERE role='admin'").fetchone())
    assert post(browser, '/login', {'email': 'admin@svobodno.demo', 'password': 'Demo2026!'}).status_code == 401
    assert browser.get('/api/session').json['demo_mode'] is False
    assert restarted.test_cli_runner().invoke(args=['create-admin', '--email', 'admin@example.test'],
                                               input='IndependentPass123\nIndependentPass123\n').exit_code == 0


def test_repeated_service_slot_and_concurrent_booking(tmp_path):
    app = setup(tmp_path, DEMO_MODE=True)
    master, admin, customer, second_tab = (client(app, role) for role in ('master', 'admin', 'client', 'client'))
    service_path, slot_path = '/master/services', '/master/slots'
    first = submit(master, service_path, NEW_SERVICE, 'service-first')
    assert first.status_code == 201
    assert submit(master, service_path, NEW_SERVICE, 'service-first').json == first.json
    assert submit(master, service_path, {**NEW_SERVICE, 'price': 900}, 'service-first').status_code == 409
    assert submit(master, service_path, NEW_SERVICE, 'service-new').json['id'] != first.json['id']
    pending = admin.get('/api/admin/service-applications').json['applications']
    assert len(pending) == 2

    ident = first.json['id']
    assert post(admin, f'/admin/service-applications/{ident}/decision', {'status': 'approved'}).status_code == 200
    when = (now() + timedelta(days=20)).replace(hour=11, minute=0).isoformat(timespec='minutes')
    payload = {'service_id': ident, 'starts_at': when, 'capacity': 1}
    slot = submit(master, slot_path, payload, 'slot-first')
    assert slot.status_code == 201
    assert submit(master, slot_path, payload, 'slot-first').json == slot.json
    assert submit(master, slot_path, payload, 'slot-new').status_code == 409

    booking = {'slot_id': slot.json['id']}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda tab: submit(tab, '/bookings', booking, 'booking-first'),
                                  (customer, second_tab)))
    assert all(r.status_code == 201 for r in responses)
    assert responses[0].json == responses[1].json
    booking_id = responses[0].json['id']
    assert submit(customer, '/bookings', {**booking, 'note': 'changed'}, 'booking-first').status_code == 409
    assert submit(customer, '/bookings', booking, 'booking-new').status_code == 409
    for tab in (customer, master):
        notices = tab.get('/api/notifications').json['notifications']
        assert sum(n['booking_id'] == booking_id and n['event'] == 'confirmed' for n in notices) == 1
    assert next(item for item in customer.get('/api/slots/1').json['slots'] if item['id'] == booking['slot_id'])['remaining'] == 0


def test_parallel_reset_revokes_tokens_and_previous_sessions(tmp_path):
    links = []
    app = setup(tmp_path, DEMO_MODE=True, MAIL_SENDER=lambda cfg, email, name, url: links.append(url))
    user, second = client(app), client(app)
    request_tab = app.test_client()
    for _ in range(2):
        post(request_tab, '/password-reset/request', {'email': 'client@svobodno.demo'})
    token, other = (url.split('#token=')[1] for url in links)
    payload = {'token': token, 'password': 'ChangedPass123', 'confirmation': 'ChangedPass123'}
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: post(app.test_client(), '/password-reset/confirm', payload).status_code,
                                 range(2)))
    assert sorted(statuses) == [200, 400]
    assert post(request_tab, '/password-reset/confirm', {**payload, 'token': other}).status_code == 400
    assert [tab.get('/api/dashboard').status_code for tab in (user, second)] == [401, 401]
    assert post(user, '/login', {'email': 'client@svobodno.demo', 'password': 'Demo2026!'}).status_code == 401
    assert post(user, '/login', {'email': 'client@svobodno.demo', 'password': payload['password']}).status_code == 200
    signed = user.get_cookie('svobodno_demo')
    assert post(user, '/logout', {}).status_code == 200
    second.set_cookie(signed.key, signed.value)
    assert second.get('/api/dashboard').status_code == 401


class TestProvider:
    __test__ = False

    def __init__(self):
        self.payments = {}
        self.refunds = {}
        self.post_keys = []
        self.timeout = True

    def call(self, endpoint, payload=None, key=None):
        if endpoint == 'payments':
            self.post_keys.append(key)
            ident = f'pay-{key}'
            remote = self.payments.setdefault(ident, {
                'id': ident, 'status': 'pending', 'test': True, 'amount': payload['amount'],
                'metadata': payload['metadata'], 'recipient': {'account_id': '100500'},
                'confirmation': {'confirmation_url': 'https://yookassa.ru/test-checkout'},
            })
            if self.timeout:
                self.timeout = False
                raise PaymentError('Simulated lost provider response')
            return remote
        if endpoint == 'refunds':
            ident = f'r-{payload["payment_id"]}'
            return self.refunds.setdefault(ident, {'id': ident, 'status': 'succeeded', **payload})
        collection, ident = endpoint.split('/')
        return getattr(self, collection)[ident]


def test_test_payment_retry_status_webhooks_and_refund(tmp_path):
    provider = TestProvider()
    secret = 'fixture-webhook-secret'.ljust(32, '0')
    app = setup(tmp_path, DEMO_MODE=True, YOOKASSA_API=provider, PAYMENTS_ENABLED=True,
                YOOKASSA_SHOP_ID='100500', YOOKASSA_SECRET_KEY='test_fixture',
                YOOKASSA_RETURN_URL='http://127.0.0.1:5000/?payment_return=1#dashboard', YOOKASSA_WEBHOOK_TOKEN=secret)
    customer, other, teacher, admin = (client(app, role) for role in ('client', 'ivan', 'teacher', 'admin'))
    slot = next(s for s in customer.get('/api/slots/4').json['slots'] if s['capacity'] == 6)
    ident = post(customer, '/bookings', {'slot_id': slot['id'], 'quantity': 2}).json['id']
    path = f'/bookings/{ident}/payment'
    assert submit(other, path, {'amount': 1}, 'pay-one').status_code == 404
    assert submit(customer, path, {'amount': 1}, 'pay-one').status_code == 503
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('UPDATE booking_payments SET next_check_at=0')
    assert submit(customer, path, {'amount': 1}, 'pay-one').json['status'] == 'pending'
    assert submit(customer, path, {}, 'another-tab').json['status'] == 'pending'
    first, = provider.payments.values()
    assert first['amount'] == {'value': f"{slot['price'] * 2}.00", 'currency': 'RUB'}
    assert len(provider.post_keys) == 2 and len(set(provider.post_keys)) == 1

    def webhook(remote, event, token=secret):
        return app.test_client().post('/api/payments/yookassa/' + token, json={
            'type': 'notification', 'event': event, 'object': {'id': remote['id']}
        })

    assert webhook(first, 'payment.canceled', 'wrong').status_code == 404
    assert webhook(first, 'payment.succeeded').status_code == 503  # The response from the provider still says pending.
    first['status'] = 'canceled'
    assert webhook(first, 'payment.canceled').status_code == 200
    assert submit(customer, path, {}, 'pay-one').json['status'] == 'canceled'
    assert submit(customer, path, {}, 'pay-again').json['status'] == 'pending'
    second = list(provider.payments.values())[-1]
    second.update(status='succeeded', test=False)
    assert webhook(second, 'payment.succeeded').status_code == 503
    second['test'] = True
    assert webhook(second, 'payment.succeeded').status_code == 200

    def booking_status(tab):
        return next(b for b in tab.get('/api/dashboard').json['bookings'] if b['id'] == ident)

    for tab in (customer, teacher, admin):
        assert booking_status(tab)['payment'] == {'status': 'succeeded', 'can_pay': False}
    assert post(teacher, '/master/bookings/cancel-all', {'confirm': True, 'ids': [ident]}).status_code == 200
    assert webhook(second, 'payment.succeeded').status_code == 200
    assert webhook(second, 'payment.succeeded').status_code == 200
    assert len(provider.refunds) == 1
    assert booking_status(customer)['status'] == 'cancelled'
    assert booking_status(customer)['payment']['status'] == 'refund_succeeded'
    notices = customer.get('/api/notifications').json['notifications']
    notice, = [n for n in notices if n['booking_id'] == ident and n['event'] == 'refund_succeeded']
    assert post(customer, f"/notifications/{notice['id']}/open", {}).json['target']['item']['id'] == ident


def test_recovery_trusts_only_configured_proxy_and_does_not_wait_for_smtp(tmp_path, monkeypatch):
    from threading import Event

    started, release = Event(), Event()

    def blocked_mail(*args):
        started.set()
        release.wait(5)

    monkeypatch.setattr('backend.auth.password_recovery.send_recovery_email', blocked_mail)
    app = setup(tmp_path, DEMO_MODE=True, TRUSTED_PROXY_IPS='127.0.0.1')
    browser = app.test_client()
    csrf = browser.get('/api/session').json['csrf']

    def recovery(email, forwarded, peer):
        return browser.post('/api/password-reset/request', json={'email': email},
                            headers={'X-CSRF-Token': csrf, 'X-Forwarded-For': forwarded},
                            environ_overrides={'REMOTE_ADDR': peer})

    try:
        known = recovery('client@svobodno.demo', '192.0.2.10', '127.0.0.1')
        assert known.status_code == 200 and started.wait(1)
        unknown = recovery('unknown@example.test', '192.0.2.99', '192.0.2.20')
        assert unknown.json == known.json
        with sqlite3.connect(app.config['DATABASE']) as connection:
            sources = [x[0] for x in connection.execute('SELECT ip_address FROM password_reset_requests ORDER BY id')]
        assert sources == ['192.0.2.10', '192.0.2.20']
    finally:
        release.set()
