"""Time boundaries and transitions are tested with a fixed clock, never sleeps."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import sqlite3

import pytest
import app as app_module
from tests.test_app import client, post


@pytest.fixture
def scenario(tmp_path, monkeypatch):
    clock = [datetime(2030, 5, 10, 9, 0)]
    monkeypatch.setattr(app_module, 'now', lambda: clock[0])
    app = app_module.create_app({'TESTING': True, 'DEMO_MODE': True, 'DEMO_DATABASE': str(tmp_path / 'lifecycle.sqlite'), 'SECRET_KEY': 'test'})
    customer, master = client(app), client(app, 'master')
    slot = customer.get('/api/slots/1').json['slots'][0]
    booking = post(customer, '/bookings', {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'})
    assert booking.status_code == 201
    start = datetime(2030, 5, 10, 10, 0)
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('UPDATE slots SET starts_at=? WHERE id=?', (start.isoformat(timespec='seconds'), slot['id']))
    return app, clock, customer, master, booking.json['id'], start


def row(c, ident):
    return next(b for b in c.get('/api/dashboard').json['bookings'] if b['id'] == ident)


@pytest.mark.parametrize('seconds,phase,allowed', [(-3600, 'upcoming', False), (0, 'in_progress', False),
                                                   (3599, 'in_progress', False), (3600, 'awaiting_completion', True),
                                                   (3601, 'awaiting_completion', True)])
def test_completion_boundary_and_consistent_roles(scenario, seconds, phase, allowed):
    app, clock, customer, master, ident, start = scenario
    clock[0] = start + timedelta(seconds=seconds)
    a, b = row(customer, ident), row(master, ident)
    assert a['phase'] == b['phase'] == phase
    assert a['status_label'] == b['status_label']
    assert a['ends_at'] == (start + timedelta(hours=1)).isoformat(timespec='seconds')
    assert not a['actions']['complete']
    assert not a['actions']['review']
    assert b['actions']['complete'] is allowed
    response = post(master, f'/bookings/{ident}/complete', {})
    assert response.status_code == (200 if allowed else 409)
    assert row(customer, ident)['status'] == ('completed' if allowed else 'confirmed')


def test_duration_is_not_assumed_to_be_one_hour(scenario):
    app, clock, customer, master, ident, start = scenario
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('UPDATE services SET duration=90 WHERE id=1')
    clock[0] = start + timedelta(minutes=89, seconds=59)
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 409
    clock[0] += timedelta(seconds=1)
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 200


def test_completed_is_terminal_and_review_requires_completion(scenario):
    app, clock, customer, master, ident, start = scenario
    payload = {'booking_id': ident, 'rating': 5, 'content': 'Отличная работа, спасибо!'}
    clock[0] = start + timedelta(minutes=59, seconds=59)
    assert post(customer, '/reviews', payload).status_code == 403
    clock[0] += timedelta(seconds=1)
    # Elapsed time alone never completes the appointment or unlocks reviews.
    assert post(customer, '/reviews', payload).status_code == 403
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 200
    assert row(customer, ident)['actions']['review']
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 409
    assert post(master, f'/bookings/{ident}/cancel', {}).status_code == 409
    assert post(customer, '/reviews', payload).status_code == 201
    assert not row(customer, ident)['actions']['review']
    assert post(customer, '/reviews', payload).status_code == 409


def test_legacy_early_completed_record_does_not_unlock_review(scenario):
    app, clock, customer, master, ident, start = scenario
    clock[0] = start + timedelta(minutes=1)
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute("UPDATE bookings SET status='completed' WHERE id=?", (ident,))
    assert not row(customer, ident)['actions']['review']
    assert post(customer, '/reviews', {'booking_id': ident, 'rating': 5, 'content': 'Ещё не закончено'}).status_code == 403


def test_only_assigned_master_can_complete(scenario):
    app, clock, customer, master, ident, start = scenario
    clock[0] = start + timedelta(hours=1)
    assert post(client(app, 'teacher'), f'/bookings/{ident}/complete', {}).status_code == 404
    assert post(customer, f'/bookings/{ident}/complete', {}).status_code == 403
    assert post(client(app, 'admin'), f'/bookings/{ident}/complete', {}).status_code == 403
    assert post(master, '/bookings/999999/complete', {}).status_code == 404
    assert row(customer, ident)['status'] == 'confirmed'


@pytest.mark.parametrize('offset,allowed', [(-1, True), (0, False), (1, False), (3600, False)])
def test_cancellation_boundary(scenario, offset, allowed):
    app, clock, customer, master, ident, start = scenario
    clock[0] = start + timedelta(seconds=offset)
    assert row(customer, ident)['actions']['cancel'] is allowed
    assert row(master, ident)['actions']['cancel'] is allowed
    assert post(customer, f'/bookings/{ident}/cancel', {}).status_code == (200 if allowed else 409)
    assert row(customer, ident)['status'] == ('cancelled' if allowed else 'confirmed')


def test_cancel_repeat_complete_and_review_do_not_reopen_booking(scenario):
    app, clock, customer, master, ident, start = scenario
    assert post(customer, f'/bookings/{ident}/cancel', {}).status_code == 200
    assert post(customer, f'/bookings/{ident}/cancel', {}).status_code == 409
    clock[0] = start + timedelta(hours=2)
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 409
    assert post(customer, '/reviews', {'booking_id': ident, 'rating': 4, 'content': 'Отменённая встреча'}).status_code == 403
    assert row(customer, ident)['status'] == 'cancelled'
    assert not any(row(customer, ident)['actions'].values())


def test_concurrent_completion_has_one_winner(scenario):
    app, clock, customer, master, ident, start = scenario
    clock[0] = start + timedelta(hours=1)
    another_session = client(app, 'master')
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda c: post(c, f'/bookings/{ident}/complete', {}).status_code, [master, another_session]))
    assert sorted(responses) == [200, 409]
    assert row(customer, ident)['status'] == 'completed'


def test_completion_uses_next_day_when_service_crosses_midnight(scenario):
    app, clock, customer, master, ident, start = scenario
    start = start.replace(hour=23, minute=30)
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('UPDATE slots SET starts_at=? WHERE id=(SELECT slot_id FROM bookings WHERE id=?)',
                    (start.isoformat(timespec='seconds'), ident))
    clock[0] = start + timedelta(minutes=59, seconds=59)
    assert row(master, ident)['ends_at'] == (start + timedelta(hours=1)).isoformat(timespec='seconds')
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 409
    clock[0] += timedelta(seconds=1)
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 200


def test_production_app_does_not_expose_test_clock(scenario):
    app, clock, customer, master, ident, start = scenario
    csrf = customer.get('/api/session').json['csrf']
    result = customer.post('/__test__/clock', json={'now': '2099-01-01T00:00:00'}, headers={'X-CSRF-Token': csrf})
    assert result.status_code == 404
    assert post(master, f'/bookings/{ident}/complete', {}).status_code == 409
