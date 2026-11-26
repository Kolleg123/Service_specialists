from datetime import datetime, timedelta
import sqlite3

import pytest

import app as app_module
from tests.test_app import client, post


APPLICATION = {
    'name': 'Мария Иванова',
    'profession': 'Преподаватель английского',
    'category': 'Обучение',
    'experience': 3,
    'education': 'Педагогическое образование',
    'skills': 'Английский язык, разговорная практика',
    'bio': 'Помогаю подготовиться к экзаменам',
    'location': 'Киров и онлайн',
}
APPLY = '/specialist-applications'
ADMIN = '/admin/specialist-applications'


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, 'now', lambda: datetime(2030, 5, 6, 8))
    return app_module.create_app({'TESTING': True, 'DATABASE': str(tmp_path / 'test.sqlite'),
                                  'SECRET_KEY': 'test-only'})


def register(app):
    browser = app.test_client()
    response = post(browser, '/register', {'name': 'Мария', 'username': 'maria', 'email': 'new@example.test',
                                         'password': 'LocalTest2026!', 'role': 'master'})
    assert response.status_code == 200
    assert response.json['user']['role'] == 'client'
    return browser, response.json['user']['id']


def test_application_permissions_rejection_and_approval(app):
    applicant, user_id = register(app)
    admin, other = client(app, 'admin'), client(app, 'ivan')
    assert applicant.post('/api' + APPLY, json=APPLICATION).status_code == 403
    assert post(applicant, APPLY, {**APPLICATION, 'category': 'Все специалисты'}).status_code == 400
    assert post(applicant, APPLY, {**APPLICATION, 'experience': True}).status_code == 400
    first = post(applicant, APPLY, {**APPLICATION, 'status': 'approved', 'specialist_id': 1})
    assert first.status_code == 201
    assert first.json['application']['status'] == 'pending'
    assert post(applicant, APPLY, APPLICATION).status_code == 409
    assert applicant.get('/api/master').status_code == 403
    assert other.get('/api/dashboard?mode=master').json['specialist_application'] is None
    assert applicant.get('/api' + ADMIN).status_code == 403

    first_id = first.json['application']['id']
    decision = f'{ADMIN}/{first_id}/decision'
    assert post(applicant, decision, {'status': 'approved'}).status_code == 403
    assert post(admin, decision, {'status': 'rejected', 'reason': '  '}).status_code == 400
    assert post(admin, decision, {'status': 'rejected', 'reason': 'Уточните место работы'}).status_code == 200
    rejected = applicant.get('/api/dashboard').json['specialist_application']
    assert (rejected['status'], rejected['reason']) == ('rejected', 'Уточните место работы')
    notices = applicant.get('/api/notifications').json['notifications']
    assert notices[0]['event'] == 'specialist_rejected'
    assert rejected['reason'] in notices[0]['message']

    second = post(applicant, APPLY, APPLICATION)
    assert second.status_code == 201
    application_id = second.json['application']['id']
    pending, rejected = admin.get('/api' + ADMIN).json['applications']
    assert pending['email'] == 'new@example.test' and pending['id'] == application_id
    assert rejected['id'] == first_id
    assert admin.get('/api/admin/service-applications').json['applications'] == []
    decision = f'{ADMIN}/{application_id}/decision'
    assert post(admin, decision, {'status': 'approved'}).status_code == 200
    assert post(admin, decision, {'status': 'approved'}).status_code == 409
    dashboard = applicant.get('/api/dashboard?mode=client').json
    user = dashboard['user']
    assert (user['id'], user['role'], dashboard['specialist_application']['status']) == (user_id, 'master', 'approved')
    assert applicant.get('/api/master').status_code == 200
    assert post(applicant, APPLY, APPLICATION).status_code == 403
    profile = next(row for row in applicant.get('/api/catalog').json['specialists'] if row['id'] == user['specialist_id'])
    assert {key: profile[key] for key in APPLICATION} == APPLICATION
    notifications = applicant.get('/api/notifications').json['notifications']
    assert [(n['event'], n['specialist_application_id']) for n in notifications] == [
        ('specialist_approved', application_id), ('specialist_rejected', first_id)
    ]
    with sqlite3.connect(app.config['DATABASE']) as connection:
        assert connection.execute('SELECT count(*) FROM users WHERE email=?', (user['email'],)).fetchone() == (1,)
        assert connection.execute('SELECT count(*) FROM specialists WHERE name=?', (APPLICATION['name'],)).fetchone() == (1,)


def test_specialist_keeps_client_actions_and_cannot_book_own_service(app, monkeypatch):
    specialist, owner, customer = client(app), client(app, 'master'), client(app, 'ivan')
    slot, second_slot, *_ = specialist.get('/api/slots/1?service_id=1').json['slots']
    booking = post(specialist, '/bookings', {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'})
    assert booking.status_code == 201
    ident = booking.json['id']

    application_id = post(specialist, APPLY, APPLICATION).json['application']['id']
    admin = client(app, 'admin')
    assert post(admin, f'{ADMIN}/{application_id}/decision', {'status': 'approved'}).status_code == 200
    specialist_id = specialist.get('/api/session').json['user']['specialist_id']
    service_id = post(specialist, '/master/services', {'title': 'Урок английского', 'price': 500,
                                                     'duration': 60, 'mode': 'Онлайн',
                                                     'category_id': 'english'}).json['id']
    assert post(admin, f'/admin/service-applications/{service_id}/decision', {'status': 'approved'}).status_code == 200
    starts_at = (app_module.now() + timedelta(days=2)).replace(hour=10).isoformat(timespec='minutes')
    assert post(specialist, '/master/slots', {'service_id': service_id, 'starts_at': starts_at}).status_code == 201
    own_slot, = specialist.get(f'/api/slots/{specialist_id}').json['slots']
    assert post(specialist, '/bookings', {'slot_id': own_slot['id']}).status_code == 403
    incoming = post(customer, '/bookings', {'slot_id': own_slot['id']})
    assert incoming.status_code == 201
    assert [b['id'] for b in specialist.get('/api/dashboard').json['bookings']] == [incoming.json['id']]

    assert post(specialist, '/bookings', {'slot_id': second_slot['id'], 'address': 'Киров, Ленина 10'}).status_code == 201
    own_bookings = specialist.get('/api/dashboard?mode=client').json['bookings']
    first = next(b for b in own_bookings if b['id'] == ident)
    second = next(b for b in own_bookings if b['slot_id'] == second_slot['id'])
    assert first['actions']['cancel'] and second['actions']['cancel']
    assert post(specialist, f"/bookings/{second['id']}/cancel", {}).status_code == 200
    assert incoming.json['id'] not in {b['id'] for b in own_bookings}
    assert post(specialist, '/searches', {'query': 'Мастер'}).status_code == 200
    monkeypatch.setattr(app_module, 'now', lambda: datetime.fromisoformat(first['ends_at']))
    assert post(specialist, f'/bookings/{ident}/complete', {}).status_code == 404
    assert post(owner, f'/bookings/{ident}/complete', {}).status_code == 200
    completed = next(b for b in specialist.get('/api/dashboard?mode=client').json['bookings'] if b['id'] == ident)
    assert completed['actions']['review']
    assert post(specialist, '/reviews', {'booking_id': ident, 'rating': 5, 'content': 'Хорошая работа'}).status_code == 201
    messages = specialist.get('/api/notifications').json['notifications']
    assert {'confirmed', 'completed', 'cancelled', 'specialist_approved', 'service_approved'} <= {n['event'] for n in messages}
