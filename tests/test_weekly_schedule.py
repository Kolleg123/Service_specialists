from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import sqlite3
from threading import Barrier

import pytest

import app as app_module
from tests.test_app import client, post


@pytest.fixture
def app(tmp_path, monkeypatch):
    monday = datetime(2030, 5, 6, 8)
    monkeypatch.setattr(app_module, 'now', lambda: monday)
    return app_module.create_app({'TESTING': True, 'DATABASE': str(tmp_path / 'schedule.sqlite'),
                                  'SECRET_KEY': 'test-only'})


def schedule(master, mode='time', **changes):
    return post(master, '/master/schedule', {
        'mode': mode, 'weekdays': [1, 2], 'opens_at': '09:00', 'closes_at': '15:00',
        'lunch_start': '11:00', 'lunch_end': '12:00', 'daily_limit': 1, **changes
    })


def slots(browser, service=1):
    return browser.get(f'/api/slots/1?service_id={service}').json['slots']


def book(browser, mode, when='2030-05-06', service=1, **changes):
    return post(browser, '/bookings', {
        'booking_mode': mode, 'date': when, 'service_id': service,
        'address': 'Киров, Ленина 10', **changes
    })


def test_timed_windows_are_based_on_duration_and_lunch(app, monkeypatch):
    master, customer = client(app, 'master'), client(app)
    assert schedule(customer).status_code == 403
    assert schedule(master, weekdays=[True]).status_code == 400
    assert schedule(master, lunch_end='10:00').status_code == 400
    assert schedule(master).json['schedule']['weekdays'] == [1, 2]
    monkeypatch.setattr(app_module, 'now', lambda: datetime(2030, 5, 6, 9, 15))
    monday = [s for s in slots(customer, 2) if s['date'] == '2030-05-06']
    assert [s['starts_at'][11:] for s in monday] == ['12:00', '13:30']
    assert monday[-1]['ends_at'] == '2030-05-06T15:00'
    assert all(s['id'] is None for s in monday)
    for start in ('09:00', '10:30', '11:00', '14:00'):
        assert book(customer, 'time', service=2, starts_at=f'2030-05-06T{start}').status_code == 409
    assert book(customer, 'time', '2030-05-08', starts_at='2030-05-08T09:00').status_code == 409
    assert book(customer, 'time', '2030-06-10', starts_at='2030-06-10T09:00').status_code == 409


@pytest.mark.parametrize('mode', ['time', 'day'])
def test_parallel_requests_across_services_share_specialist_capacity(app, mode):
    master, first, second = client(app, 'master'), client(app), client(app, 'ivan')
    assert schedule(master, mode).status_code == 200
    starts = {'starts_at': '2030-05-06T09:00'} if mode == 'time' else {}
    barrier = Barrier(2)

    def attempt(browser, service):
        barrier.wait(timeout=5)
        return browser, service, book(browser, mode, service=service, **starts)

    with ThreadPoolExecutor(2) as pool:
        results = [pool.submit(attempt, browser, service) for browser, service in ((first, 1), (second, 2))]
        results = [result.result(timeout=10) for result in results]
    assert sorted(result.status_code for _, _, result in results) == [201, 409]
    winner, winner_service, response = next(item for item in results if item[2].status_code == 201)
    loser, loser_service, _ = next(item for item in results if item[2].status_code == 409)
    assert all(s['starts_at'] != '2030-05-06T09:00' for s in slots(loser, loser_service))
    assert post(winner, f"/bookings/{response.json['id']}/cancel", {}).status_code == 200
    assert book(loser, mode, service=loser_service, **starts).status_code == 201


def test_daily_limit_includes_legacy_records_and_counts_bookings_not_people(app, monkeypatch):
    teacher, older, newer = client(app, 'teacher'), client(app), client(app, 'ivan')
    legacy_slot = older.get('/api/slots/4?service_id=8').json['slots'][0]
    assert legacy_slot['starts_at'].startswith('2030-05-07')
    legacy = post(older, '/bookings', {'slot_id': legacy_slot['id'], 'quantity': 4})
    assert legacy.status_code == 201
    assert schedule(teacher, 'day', daily_limit=2).status_code == 200
    remaining = newer.get('/api/slots/4?service_id=7').json['slots']
    assert next(item for item in remaining if item['date'] == '2030-05-07')['remaining'] == 1
    data = {'booking_mode': 'day', 'date': '2030-05-07', 'service_id': 7}
    added = post(newer, '/bookings', data)
    assert added.status_code == 201
    assert post(older, '/bookings', data).status_code == 409
    assert post(older, f"/bookings/{legacy.json['id']}/cancel", {}).status_code == 200
    assert post(newer, '/bookings', data).status_code == 409  # Still one per client/service/date.
    monkeypatch.setattr(app_module, 'now', lambda: datetime(2030, 5, 7, 9))
    ident = added.json['id']
    assert post(newer, f'/bookings/{ident}/cancel', {}).status_code == 409
    assert post(teacher, f'/bookings/{ident}/complete', {}).status_code == 409
    assert post(older, '/bookings', data).status_code == 409  # Today has started.
    monkeypatch.setattr(app_module, 'now', lambda: datetime(2030, 5, 7, 15))
    assert post(teacher, f'/bookings/{ident}/complete', {}).status_code == 200
    assert post(newer, '/reviews', {'booking_id': ident, 'rating': 5,
                                   'content': 'Встреча действительно состоялась'}).status_code == 201


def test_timed_booking_keeps_original_interval_after_duration_change(app):
    master, first, second = client(app, 'master'), client(app), client(app, 'ivan')
    assert schedule(master).status_code == 200
    booked = book(first, 'time', service=2, starts_at='2030-05-06T09:00')
    assert booked.status_code == 201
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('UPDATE services SET duration=15 WHERE id=2')
    assert book(second, 'time', starts_at='2030-05-06T10:00').status_code == 409
    row = next(b for b in first.get('/api/dashboard').json['bookings'] if b['id'] == booked.json['id'])
    assert row['duration'] == 90
    assert row['ends_at'] == '2030-05-06T10:30:00'


def test_switching_from_day_to_time_keeps_existing_booking(app):
    master, first, second = client(app, 'master'), client(app), client(app, 'ivan')
    assert schedule(master, 'day').status_code == 200
    booked = book(first, 'day')
    assert booked.status_code == 201
    assert schedule(master).status_code == 200
    assert all(s['date'] != '2030-05-06' for s in slots(second))
    assert post(first, f"/bookings/{booked.json['id']}/cancel", {}).status_code == 200
    assert book(second, 'time', starts_at='2030-05-06T09:00').status_code == 201
