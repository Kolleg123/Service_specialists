from datetime import timedelta
import sqlite3

import pytest

from app import now
from tests.test_app import app, client, post
from tests.test_service_moderation import decision


SERVICE = {'title': 'Тест условий визита', 'category_id': 'plumbing', 'mode': 'У специалиста',
           'price': 500, 'duration': 60, 'service_address': 'Киров, ул. Тестовая, 15',
           'contact_phone': '+1 (202) 555-0143', 'contact_instructions': 'Позвонить перед визитом'}


def publish(master, admin, **changes):
    response = post(master, '/master/services', {**SERVICE, **changes})
    assert response.status_code == 201
    ident = response.json['id']
    assert post(admin, decision(ident), {'status': 'approved'}).status_code == 200
    return ident


def bookings(browser):
    response = browser.get('/api/dashboard')
    assert response.status_code == 200
    return response.json['bookings']


def test_booking_order_and_private_snapshot(app):
    master, admin, customer, stranger, stranger_master = (
        client(app, role) for role in ('master', 'admin', 'client', 'ivan', 'teacher')
    )
    ident = publish(master, admin)
    for endpoint in ('/api/catalog', f'/api/services/{ident}'):
        response = app.test_client().get(endpoint)
        assert response.status_code == 200
        assert SERVICE['service_address'] in str(response.json)
        assert SERVICE['contact_phone'] not in str(response.json)
        assert SERVICE['contact_instructions'] not in str(response.json)

    starts_at = (now() + timedelta(days=20)).replace(hour=10, minute=0)
    for start in (starts_at, starts_at - timedelta(days=1)):
        assert post(master, '/master/slots', {'service_id': ident, 'starts_at': start.isoformat(timespec='minutes')}).status_code == 201
    earlier, later = customer.get(f'/api/slots/1?service_id={ident}').json['slots']
    assert earlier['service_address'] == SERVICE['service_address']
    assert 'contact_phone' not in earlier and 'contact_instructions' not in earlier

    response = post(customer, '/bookings', {'slot_id': later['id']})
    assert response.status_code == 201
    older_id = response.json['id']
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute("UPDATE bookings SET created_at='2001-01-01' WHERE id=?", (older_id,))
    response = post(customer, '/bookings', {'slot_id': earlier['id'], 'address': 'Чужой адрес'})
    assert response.status_code == 201
    new_id = response.json['id']
    for participant in (customer, master):
        row = bookings(participant)[0]
        assert row['id'] == new_id
        for field in ('service_address', 'mode', 'contact_phone', 'contact_instructions'):
            assert row[field] == SERVICE[field]
        assert not row['address']
    for outsider in (stranger, stranger_master):
        assert all(row['id'] not in (older_id, new_id) for row in bookings(outsider))
    admin_row = next(row for row in bookings(admin) if row['id'] == new_id)
    assert all(field not in admin_row for field in ('address', 'note', 'contact_phone',
                                                     'contact_instructions', 'service_details'))

    edit = {**SERVICE, 'mode': 'Онлайн', 'contact_instructions': 'Ссылка для подключения'}
    assert post(master, f'/master/services/{ident}/edit', edit).status_code == 200
    assert customer.get(f'/api/services/{ident}').json['service']['service_address'] == SERVICE['service_address']
    application = admin.get('/api/admin/service-applications').json['applications'][0]
    assert post(admin, decision(ident), {'status': 'approved', 'revision': application['revision']}).status_code == 200
    public = customer.get(f'/api/services/{ident}').json['service']
    assert public['mode'] == 'Онлайн' and public['service_address'] is None
    assert bookings(customer)[0]['service_address'] == SERVICE['service_address']
    assert bookings(customer)[0]['contact_instructions'] == SERVICE['contact_instructions']

    # Same visit times and IDs, reversed creation dates prove the list is ordered by created_at.
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute("UPDATE bookings SET created_at='2099-01-01' WHERE id=?", (older_id,))
    assert bookings(customer)[0]['id'] == older_id
    assert bookings(master)[0]['id'] == older_id


def test_travel_address_validation_and_visibility(app):
    master, admin, customer, stranger = (client(app, role) for role in ('master', 'admin', 'client', 'ivan'))
    ident = publish(master, admin, mode='Выезд')
    starts_at = (now() + timedelta(days=20)).replace(hour=10, minute=0).isoformat(timespec='minutes')
    assert post(master, '/master/slots', {'service_id': ident, 'starts_at': starts_at}).status_code == 201
    slot, = customer.get(f'/api/slots/1?service_id={ident}').json['slots']
    assert slot['service_address'] is None
    for invalid in (None, {}, 123456, '123', 'а' * 251):
        assert post(customer, '/bookings', {'slot_id': slot['id'], 'address': invalid}).status_code == 400
    address = 'Киров, ул. Тестовая, 42'
    assert post(customer, '/bookings', {'slot_id': slot['id'], 'address': address,
                                        'mode': 'У специалиста'}).status_code == 409
    response = post(customer, '/bookings', {'slot_id': slot['id'], 'address': address})
    assert response.status_code == 201
    ident = response.json['id']
    assert bookings(customer)[0]['address'] == address
    assert bookings(master)[0]['address'] == address
    assert address not in str(bookings(stranger))
    assert address not in str(bookings(admin))
    assert address not in str(stranger.get('/api/catalog').json)
    assert address not in str(stranger.get('/api/slots/1').json['slots'])


@pytest.mark.parametrize('changes', [
    {'service_address': ' '}, {'service_address': '<5'}, {'service_address': ['Киров']},
    {'contact_phone': 'Позвоните позже'}, {'contact_phone': '+123'}, {'contact_phone': 89000000000},
    {'contact_instructions': 'а' * 1001},
])
def test_service_fields_are_validated(app, changes):
    assert post(client(app, 'master'), '/master/services', {**SERVICE, **changes}).status_code == 400
