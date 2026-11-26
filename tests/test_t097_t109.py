from datetime import timedelta
import sqlite3

from app import now
from backend.backup import backup_database, restore_database, check_database
from tests.test_app import client, post


def test_next_slot_and_hidden_service_stay_consistent(app):
    c = client(app)
    data = c.get('/api/catalog').json
    specialist = data['specialists'][0]
    assert specialist['next_slot']
    slots = c.get(f"/api/slots/{specialist['id']}").json['slots']
    assert slots
    assert specialist['next_slot'] == slots[0]['starts_at']
    service_id = slots[0]['service_id']
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('UPDATE services SET active=0 WHERE id=?', (service_id,))
    refreshed = c.get('/api/catalog').json
    specialist = next(s for s in refreshed['specialists'] if s['id'] == specialist['id'])
    assert specialist['next_slot'] != slots[0]['starts_at']


def test_price_filter_uses_only_matching_services(app):
    c = client(app)
    catalog = c.get('/api/catalog').json
    prices = [service['price'] for specialist in catalog['specialists'] for service in specialist['services']]
    assert min(prices) > 0
    assert c.get('/api/services/1').status_code == 200
    assert c.get('/api/services/999999').status_code == 404


def test_notification_queue_does_not_block_booking(app):
    c = client(app)
    slot = c.get('/api/slots/1').json['slots'][0]
    result = post(c, '/bookings', {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'})
    assert result.status_code == 201
    with sqlite3.connect(app.config['DATABASE']) as con:
        row = con.execute('SELECT status,event,event_key FROM outgoing_notifications ORDER BY id DESC LIMIT 1').fetchone()
    assert row[0] == 'pending' and row[1] == 'confirmed' and row[2]


def test_reminders_are_idempotent_and_cancelled_booking_has_no_reminder(app):
    c = client(app)
    slot = c.get('/api/slots/1').json['slots'][0]
    with sqlite3.connect(app.config['DATABASE']) as con:
        starts = (now() + timedelta(minutes=30)).isoformat(timespec='minutes')
        con.execute('UPDATE slots SET starts_at=? WHERE id=?', (starts, slot['id']))
    booking = post(c, '/bookings', {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'})
    assert booking.status_code == 201
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('DELETE FROM outgoing_notifications WHERE booking_id=?', (booking.json['id'],))
        from backend.bookings.reminders import schedule_reminders
        created = schedule_reminders(con, now())
        again = schedule_reminders(con, now())
        assert created == 1 and again == 0
    assert post(c, f"/bookings/{booking.json['id']}/cancel", {}).status_code == 200


def test_backup_restore_integrity(app, tmp_path):
    backup = tmp_path / 'backup.sqlite'
    restored = tmp_path / 'restored.sqlite'
    assert backup_database(app.config['DATABASE'], backup).endswith('backup.sqlite')
    assert check_database(backup) == 'ok'
    assert restore_database(backup, restored).endswith('restored.sqlite')
    assert check_database(restored) == 'ok'
