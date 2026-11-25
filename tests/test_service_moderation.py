from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import sqlite3
from threading import Barrier

import pytest

from app import create_app, now
from tests.test_app import app, client, post
from tests.test_notifications import inbox

APPLICATIONS = '/admin/service-applications'
NEW_SERVICE = {'title': 'Проверка водоснабжения', 'price': 1100, 'duration': 60, 'mode': 'Онлайн'}


def submit(master, **changes):
    response = post(master, '/master/services', {**NEW_SERVICE, **changes})
    assert response.status_code == 201
    assert response.json['moderation_status'] == 'pending'
    return response.json['id']


def decision(service_id):
    return f'{APPLICATIONS}/{service_id}/decision'


def catalog_ids(browser):
    return {v['id'] for s in browser.get('/api/catalog').json['specialists'] for v in s['services']}


def test_pending_service_is_private_and_approval_publishes_it(app):
    master, admin, customer, teacher = (client(app, role) for role in ('master', 'admin', 'client', 'teacher'))
    ident = submit(master, moderation_status='approved')
    assert all(v['id'] != ident for v in teacher.get('/api/master').json['services'])
    owned = next(v for v in master.get('/api/master').json['services'] if v['id'] == ident)
    assert owned['moderation_status'] == 'pending'
    assert admin.get('/api'+APPLICATIONS).json['applications'][0]['title'] == NEW_SERVICE['title']
    assert app.test_client().get('/api'+APPLICATIONS).status_code == 401
    for browser in (customer, master):
        assert browser.get('/api'+APPLICATIONS).status_code == 403
        assert post(browser, decision(ident), {'status': 'approved'}).status_code == 403
        assert browser.get('/api/admin').status_code == 403
        assert post(browser, '/admin/moderate', {'kind': 'service', 'id': ident, 'active': True}).status_code == 403

    starts_at = (now() + timedelta(days=20)).replace(hour=10, minute=0).isoformat(timespec='minutes')
    assert post(master, '/master/slots', {'service_id': ident, 'starts_at': starts_at}).status_code == 201
    slot_id = next(s['id'] for s in master.get('/api/master').json['slots'] if s['service_id'] == ident)
    assert post(admin, '/admin/moderate', {'kind': 'service', 'id': ident, 'active': True}).status_code == 200
    assert ident not in catalog_ids(customer)
    assert customer.get(f'/api/services/{ident}').status_code == 404
    assert customer.get(f'/api/slots/1?service_id={ident}').json['slots'] == []
    assert post(customer, '/bookings', {'slot_id': slot_id, 'service_id': ident}).status_code == 409

    assert post(admin, decision(ident), {'status': 'approved'}).status_code == 200
    assert post(admin, decision(ident), {'status': 'approved'}).status_code == 200
    assert post(admin, decision(ident), {'status': 'rejected', 'reason': 'Другое решение'}).status_code == 409
    assert admin.get('/api'+APPLICATIONS).json['applications'] == []
    assert ident in catalog_ids(customer)
    assert customer.get(f'/api/services/{ident}').json['service']['title'] == NEW_SERVICE['title']
    assert post(customer, '/bookings', {'slot_id': slot_id, 'service_id': ident}).status_code == 201
    notice, = [n for n in inbox(master) if n['service_id'] == ident]
    assert notice['event'] == 'service_approved' and notice['booking_id'] is None
    assert post(teacher, f"/notifications/{notice['id']}/read", {}).status_code == 404
    assert post(master, f"/notifications/{notice['id']}/read", {}).status_code == 200


def test_rejection_reason_and_concurrent_decisions(app):
    master, admin, other = (client(app, role) for role in ('master', 'admin', 'admin'))
    ident = submit(master)
    for reason in ('   ', None, 123, 'а' * 501):
        assert post(admin, decision(ident), {'status': 'rejected', 'reason': reason}).status_code == 400
    assert post(admin, decision(99999), {'status': 'approved'}).status_code == 404
    assert inbox(master) == []
    barrier = Barrier(2)

    def decide(browser, reason):
        barrier.wait(timeout=5)
        return post(browser, decision(ident), {'status': 'rejected', 'reason': reason})

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(decide, admin, '  Уточните описание  ')
        second = pool.submit(decide, other, 'Исправьте название')
        results = [first.result(timeout=10), second.result(timeout=10)]
    assert sorted(result.status_code for result in results) == [200, 409]
    service = next(response.json['service'] for response in results if response.status_code == 200)
    reason = service['moderation_reason']
    assert reason in ('Уточните описание', 'Исправьте название')
    assert post(admin, decision(ident), {'status': 'rejected', 'reason': reason}).status_code == 200
    master_service = next(v for v in master.get('/api/master').json['services'] if v['id'] == ident)
    assert master_service['moderation_status'] == 'rejected'
    assert master_service['moderation_reason'] == reason
    notice, = inbox(master)
    assert notice['event'] == 'service_rejected' and reason in notice['message']
    assert ident not in catalog_ids(master)


def test_failed_inbox_write_rolls_back_decision(app):
    master, admin = client(app, 'master'), client(app, 'admin')
    ident = submit(master)
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('''CREATE TRIGGER reject_notice BEFORE INSERT ON notifications
            WHEN NEW.event='service_approved'
            BEGIN SELECT RAISE(ABORT,'cannot write service notification'); END''')
    with pytest.raises(sqlite3.IntegrityError, match='cannot write service notification'):
        post(admin, decision(ident), {'status': 'approved'})
    assert inbox(master) == []
    assert ident not in catalog_ids(admin)
    assert admin.get('/api'+APPLICATIONS).json['applications'][0]['moderation_status'] == 'pending'
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('DROP TRIGGER reject_notice')
    assert post(admin, decision(ident), {'status': 'approved'}).status_code == 200
    assert len(inbox(master)) == 1


def test_generated_booking_cannot_use_unpublished_service(app):
    master, admin, customer = client(app, 'master'), client(app, 'admin'), client(app)
    ident = submit(master)
    assert post(master, '/master/schedule', {'mode': 'day', 'weekdays': list(range(1, 8)),
                     'opens_at': '09:00', 'closes_at': '18:00', 'daily_limit': 2}).status_code == 200
    day = (now() + timedelta(days=2)).date().isoformat()
    payload = {'booking_mode': 'day', 'date': day, 'service_id': ident}
    assert customer.get(f'/api/slots/1?service_id={ident}').json['slots'] == []
    assert post(customer, '/bookings', payload).status_code == 409
    assert post(admin, decision(ident), {'status': 'approved'}).status_code == 200
    assert post(customer, '/bookings', payload).status_code == 201


def test_upgrade_preserves_published_services_manual_slots_and_read_notifications(tmp_path):
    from seed_data import SCHEMA

    database = tmp_path / 'old.sqlite'
    starts_at = (now() + timedelta(days=2)).replace(hour=10, minute=0).isoformat(timespec='minutes')
    with sqlite3.connect(database) as connection:
        connection.executescript(SCHEMA)
        connection.executescript("""
            CREATE TABLE notifications(id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                booking_id INTEGER NOT NULL REFERENCES bookings(id),
                event TEXT NOT NULL CHECK(event IN ('confirmed','cancelled','completed')),
                message TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
                UNIQUE(user_id,booking_id,event));
            CREATE INDEX notification_inbox ON notifications(user_id,id DESC);
            INSERT INTO specialists(id,name,active) VALUES(99,'Существующий специалист',1);
            INSERT INTO users(id,name,email,role) VALUES(99,'Существующий клиент','old@example.test','client');
            INSERT INTO services(id,specialist_id,title,price,duration,mode)
                VALUES(99,99,'Старая опубликованная услуга',500,60,'Онлайн');
        """)
        connection.execute('INSERT INTO slots(id,specialist_id,service_id,starts_at,capacity) VALUES(99,99,99,?,1)',
                           (starts_at,))
        connection.execute("""INSERT INTO bookings(id,user_id,slot_id,quantity,status,created_at,total)
            VALUES(99,99,99,1,'confirmed',?,500)""", (starts_at,))
        connection.execute("""INSERT INTO notifications VALUES(99,99,99,'confirmed','Уже прочитано',?,1)""",
                           (starts_at,))
    config = {'TESTING': True, 'DATABASE': str(database), 'SECRET_KEY': 'test-only'}
    for _ in range(2):
        browser = create_app(config).test_client()
        assert browser.get('/api/services/99').json['service']['title'] == 'Старая опубликованная услуга'
        slot, = browser.get('/api/slots/99').json['slots']
        assert slot['booking_mode'] == 'manual' and slot['remaining'] == 0
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT is_read,booking_id,service_id FROM notifications WHERE id=99').fetchone() == (1, 99, None)
            assert connection.execute('PRAGMA foreign_key_check').fetchall() == []
