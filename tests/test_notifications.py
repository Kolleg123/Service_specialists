from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import sqlite3

import pytest

from app import create_app
from tests.test_app import app, client, post
from tests.test_lifecycle import scenario


def inbox(browser):
    response = browser.get('/api/notifications')
    assert response.status_code == 200
    return response.json['notifications']


def payload_for(browser):
    slot = browser.get('/api/slots/1').json['slots'][0]
    return {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'}


def test_confirmation_recipients_privacy_and_read_persistence(app):
    customer, master = client(app), client(app, 'master')
    other, teacher, admin = (client(app, role) for role in ('ivan', 'teacher', 'admin'))
    assert app.test_client().get('/api/notifications').status_code == 401
    assert inbox(customer) == inbox(master) == []
    payload = payload_for(customer)
    assert post(customer, '/bookings', {**payload, 'address': ''}).status_code == 400
    assert inbox(customer) == inbox(master) == []

    booking = post(customer, '/bookings', payload)
    assert booking.status_code == 201
    assert post(customer, '/bookings', payload).status_code == 409
    notification, = inbox(customer)
    master_notification, = inbox(master)
    assert notification['booking_id'] == master_notification['booking_id'] == booking.json['id']
    assert notification['event'] == master_notification['event'] == 'confirmed'
    assert notification['message'].startswith('Запись подтверждена')
    assert master_notification['message'].startswith('Новая запись клиента')
    assert datetime.fromisoformat(notification['created_at'])
    assert notification['is_read'] is master_notification['is_read'] is False
    url = f"/notifications/{notification['id']}/read"
    for stranger in (other, teacher, admin):
        assert inbox(stranger) == []
        assert post(stranger, url, {}).status_code == 404
    assert post(master, url, {}).status_code == 404
    assert post(customer, '/notifications/9223372036854775808/read', {}).status_code == 400
    assert customer.post('/api' + url, json={}).status_code == 403
    assert post(customer, url, {}).status_code == 200
    assert post(customer, url, {}).status_code == 200

    restarted = create_app(app.config)
    assert inbox(client(restarted)) == [{**notification, 'is_read': True}]
    assert inbox(client(restarted, 'master')) == [master_notification]


def test_admin_cancellation_and_concurrent_retry(app):
    customer, master = client(app), client(app, 'master')
    first_admin, second_admin = client(app, 'admin'), client(app, 'admin')
    booking = post(customer, '/bookings', payload_for(customer))
    assert booking.status_code == 201
    ident = booking.json['id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = pool.map(lambda admin: post(admin, f'/bookings/{ident}/cancel', {}).status_code,
                           (first_admin, second_admin))
        assert sorted(results) == [200, 409]
    for browser in (customer, master):
        notifications = inbox(browser)
        assert [n['event'] for n in notifications] == ['cancelled', 'confirmed']
        assert all(n['booking_id'] == ident for n in notifications)
    assert inbox(first_admin) == []


def test_completion_notifies_only_customer(scenario):
    _, clock, customer, master, ident, _ = scenario
    url = f'/bookings/{ident}/complete'
    assert post(master, url, {}).status_code == 409
    assert [n['event'] for n in inbox(customer)] == ['confirmed']
    booking = next(b for b in customer.get('/api/dashboard').json['bookings'] if b['id'] == ident)
    clock[0] = datetime.fromisoformat(booking['ends_at'])
    assert post(master, url, {}).status_code == 200
    assert post(master, url, {}).status_code == 409
    assert [n['event'] for n in inbox(customer)] == ['completed', 'confirmed']
    assert [n['event'] for n in inbox(master)] == ['confirmed']


def test_notification_failure_rolls_back_booking_and_inbox(app):
    customer, master = client(app), client(app, 'master')
    payload = payload_for(customer)
    database = app.config['DATABASE']
    with sqlite3.connect(database) as con:
        con.execute('''CREATE TRIGGER test_fail_notification BEFORE INSERT ON notifications
            WHEN (SELECT role FROM users WHERE id=NEW.user_id)='master'
            BEGIN SELECT RAISE(ABORT,'test notification failure'); END''')
    with pytest.raises(sqlite3.IntegrityError, match='test notification failure'):
        post(customer, '/bookings', payload)
    assert inbox(customer) == inbox(master) == []
    with sqlite3.connect(database) as con:
        assert con.execute('SELECT COUNT(*) FROM bookings WHERE slot_id=?', (payload['slot_id'],)).fetchone() == (0,)


def test_existing_database_gets_empty_inbox_without_backfill(app):
    database = app.config['DATABASE']
    with sqlite3.connect(database) as con:
        con.execute('DROP TABLE notifications')
        bookings = con.execute('SELECT * FROM bookings ORDER BY id').fetchall()
    restarted = create_app(app.config)
    assert inbox(client(restarted)) == []
    with sqlite3.connect(database) as con:
        assert con.execute('SELECT * FROM bookings ORDER BY id').fetchall() == bookings
