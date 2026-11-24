from datetime import datetime, timedelta
import sqlite3

import pytest
import app as app_module
from tests.test_app import client, post


@pytest.fixture
def schedule(tmp_path, monkeypatch):
    clock = [datetime(2030, 5, 10, 9, 0)]
    monkeypatch.setattr(app_module, 'now', lambda: clock[0])
    app = app_module.create_app({
        'TESTING': True,
        'DATABASE': str(tmp_path / 'schedule.sqlite'),
        'SECRET_KEY': 'test-only',
    })
    master = client(app, 'master')
    return app, clock, master


def add_service(master, duration):
    response = post(master, '/master/services', {
        'title': f'Проверка длительности {duration}',
        'price': 500,
        'duration': duration,
        'mode': 'Онлайн',
    })
    return response


def add_slot(master, service_id, starts_at):
    return post(master, '/master/slots', {
        'service_id': service_id,
        'starts_at': starts_at,
        'capacity': 1,
    })


@pytest.mark.parametrize('duration', [15, 480])
def test_minimum_and_maximum_service_duration_are_bookable(schedule, duration):
    _, clock, master = schedule
    service = add_service(master, duration)
    assert service.status_code == 201
    service_id = master.get('/api/master').json['services'][-1]['id']
    starts = (clock[0] + timedelta(days=40)).replace(hour=8)
    assert add_slot(master, service_id, starts.isoformat(timespec='minutes')).status_code == 201


@pytest.mark.parametrize('duration', [14, 481, True, 15.0, '60'])
def test_duration_outside_integer_bounds_is_rejected(schedule, duration):
    _, _, master = schedule
    response = post(master, '/master/services', {
        'title': 'Проверка неверной длительности',
        'price': 500,
        'duration': duration,
        'mode': 'Онлайн',
    })
    assert response.status_code == 400


def test_adjacent_slots_are_allowed_but_overlapping_slots_are_rejected(schedule):
    _, clock, master = schedule
    assert add_service(master, 60).status_code == 201
    service_id = master.get('/api/master').json['services'][-1]['id']
    start = (clock[0] + timedelta(days=40)).replace(hour=8)
    assert add_slot(master, service_id, start.isoformat(timespec='minutes')).status_code == 201
    adjacent = start + timedelta(hours=1)
    assert add_slot(master, service_id, adjacent.isoformat(timespec='minutes')).status_code == 201
    overlap = start + timedelta(minutes=59)
    response = add_slot(master, service_id, overlap.isoformat(timespec='minutes'))
    assert response.status_code == 409
    assert 'пересекается' in response.json['error']


@pytest.mark.parametrize('value', [
    'not-a-date',
    '2030-05-10T10:00+03:00',
    '',
    None,
])
def test_invalid_and_timezone_aware_slot_dates_are_rejected(schedule, value):
    _, _, master = schedule
    service_id = master.get('/api/master').json['services'][0]['id']
    response = add_slot(master, service_id, value)
    assert response.status_code == 400


def test_slot_in_the_past_is_rejected_and_now_is_not_bookable(schedule):
    _, clock, master = schedule
    service_id = master.get('/api/master').json['services'][0]['id']
    past = (clock[0] - timedelta(minutes=1)).isoformat(timespec='minutes')
    exact_now = clock[0].isoformat(timespec='minutes')
    assert add_slot(master, service_id, past).status_code == 400
    assert add_slot(master, service_id, exact_now).status_code == 400


def test_corrupt_legacy_slot_does_not_crash_schedule_creation(schedule):
    app, clock, master = schedule
    service_id = master.get('/api/master').json['services'][0]['id']
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute(
            "UPDATE slots SET starts_at='broken-date' WHERE specialist_id=1 AND id=(SELECT MIN(id) FROM slots WHERE specialist_id=1)"
        )
    starts = (clock[0] + timedelta(days=40)).replace(hour=8)
    response = add_slot(master, service_id, starts.isoformat(timespec='minutes'))
    assert response.status_code == 409
    assert 'некорректная дата' in response.json['error']


def test_empty_database_returns_empty_catalog_and_availability(tmp_path):
    app = app_module.create_app({
        'TESTING': True,
        'DATABASE': str(tmp_path / 'empty.sqlite'),
        'SECRET_KEY': 'test-only',
    })
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('PRAGMA foreign_keys=ON')
        for table in ('reviews', 'bookings', 'searches', 'slots', 'services', 'users', 'specialists'):
            connection.execute(f'DELETE FROM {table}')
    public = app.test_client()
    assert public.get('/api/catalog').status_code == 200
    assert public.get('/api/catalog').json['specialists'] == []
    assert public.get('/api/slots/1').status_code == 200
    assert public.get('/api/slots/1').json == {'slots': []}


def test_partial_database_with_no_services_or_slots_is_safe(tmp_path):
    app = app_module.create_app({
        'TESTING': True,
        'DATABASE': str(tmp_path / 'partial-empty.sqlite'),
        'SECRET_KEY': 'test-only',
    })
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('DELETE FROM reviews')
        connection.execute('DELETE FROM bookings')
        connection.execute('DELETE FROM slots')
        connection.execute('DELETE FROM services')
    public = app.test_client()
    catalog = public.get('/api/catalog')
    assert catalog.status_code == 200
    assert len(catalog.json['specialists']) == 6
    assert all(person['services'] == [] for person in catalog.json['specialists'])
    assert public.get('/api/slots/1').json == {'slots': []}
    master = client(app, 'master')
    dashboard = master.get('/api/master')
    assert dashboard.status_code == 200
    assert dashboard.json == {'services': [], 'slots': []}
