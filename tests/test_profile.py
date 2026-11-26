from io import BytesIO
from pathlib import Path
import sqlite3

from PIL import Image
import pytest
from werkzeug.security import check_password_hash

from app import create_app
from tests.test_app import client, post
from tests.test_specialist_registration import APPLICATION, APPLY, ADMIN


@pytest.fixture
def app(tmp_path):
    return create_app({'TESTING': True, 'DEMO_MODE': True, 'DEMO_DATABASE': str(tmp_path / 'test.sqlite'),
                       'UPLOAD_FOLDER': str(tmp_path / 'avatars'), 'SECRET_KEY': 'profile-tests'})


def mutate(browser, method, path, **kwargs):
    csrf = browser.get('/api/session').json['csrf']
    return browser.open('/api' + path, method=method, headers={'X-CSRF-Token': csrf}, **kwargs)


def upload(browser, data, name):
    return mutate(browser, 'POST', '/profile/avatar', data={'avatar': (data, name)})


def image_file(format_name):
    data = BytesIO()
    Image.new('RGB', (12, 12), 'green').save(data, format=format_name)
    data.seek(0)
    return data


def catalog_profile(browser, ident=1):
    return next(s for s in browser.get('/api/catalog').json['specialists'] if s['id'] == ident)


def test_details_and_password_are_shared_across_modes(app):
    master = client(app, 'master')
    details = {'name': 'Новое Имя', 'current_password': 'Demo2026!', 'new_password': 'NewPassword123',
               'confirmation': 'NewPassword123'}
    assert mutate(master, 'PATCH', '/profile', json={**details, 'current_password': 'wrong'}).status_code == 403
    assert mutate(master, 'PATCH', '/profile', json={**details, 'confirmation': 'mismatch'}).status_code == 400
    assert catalog_profile(master)['name'] == 'Алексей Морозов'
    assert mutate(master, 'PATCH', '/profile', json=details).status_code == 200
    assert catalog_profile(master)['name'] == details['name']
    for mode in ('client', 'master'):
        assert master.get('/api/dashboard?mode=' + mode).json['user']['name'] == details['name']
    assert post(master, '/logout', {}).status_code == 200
    credentials = {'username': 'master'}
    assert post(master, '/login', {**credentials, 'password': details['current_password']}).status_code == 401
    assert post(master, '/login', {**credentials, 'password': details['new_password']}).status_code == 200
    with sqlite3.connect(app.config['DATABASE']) as connection:
        stored = connection.execute('SELECT password FROM users WHERE username=?', (credentials['username'],)).fetchone()[0]
        assert stored != details['new_password'] and check_password_hash(stored, details['new_password'])


@pytest.mark.parametrize(('file_name', 'format_name'), [('avatar.jpg', 'JPEG'), ('avatar.jpeg', 'JPEG'),
                                                        ('avatar.png', 'PNG'), ('avatar.webp', 'WEBP')])
def test_avatar_validation_replacement_and_persistence(app, tmp_path, file_name, format_name):
    master = client(app, 'master')
    first = upload(master, image_file('PNG'), 'first.png')
    assert first.status_code == 200
    first_url = first.json['user']['avatar']
    assert catalog_profile(master)['photo'] == first_url
    assert master.get(first_url).mimetype == 'image/png'

    damaged = BytesIO(image_file('PNG').getvalue()[:-15])
    assert upload(master, damaged, 'damaged.png').status_code == 415
    assert upload(master, image_file('PNG'), 'renamed.jpg').status_code == 415
    assert upload(master, BytesIO(b'x' * (1024 * 1024)), 'large.jpg').status_code == 413
    assert master.get('/api/session').json['user']['avatar'] == first_url
    assert catalog_profile(master)['photo'] == first_url

    replacement = upload(master, image_file(format_name), file_name)
    assert replacement.status_code == 200
    second_url = replacement.json['user']['avatar']
    assert second_url != first_url
    assert master.get(first_url).status_code == 404
    assert not (tmp_path / 'avatars' / Path(first_url).name).exists()
    assert master.get(second_url).status_code == 200
    assert master.get('/static/photos/1.jpg').status_code == 200
    assert client(app, 'master').get('/api/session').json['user']['avatar'] == second_url
    assert catalog_profile(master)['photo'] == second_url


def test_replacement_retains_avatar_referenced_elsewhere(app):
    master = client(app, 'master')
    old = upload(master, image_file('PNG'), 'first.png').json['user']['avatar']
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('UPDATE specialists SET photo=? WHERE id=2', (old,))
    assert upload(master, image_file('PNG'), 'next.png').status_code == 200
    assert master.get(old).status_code == 200


def make_booking(browser, specialist_id, index=0):
    slot = browser.get(f'/api/slots/{specialist_id}').json['slots'][index]
    booking = post(browser, '/bookings', {'slot_id': slot['id'], 'address': 'Киров, Ленина 10'})
    assert booking.status_code == 201
    return booking.json['id']


def test_delete_dual_role_account_preserves_shared_history_after_restart(app, tmp_path):
    master = client(app, 'master')
    second_session = client(app, 'master')
    customer = client(app)
    admin = client(app, 'admin')
    own = make_booking(master, 2)
    incoming = make_booking(customer, 1)
    support = post(master, '/support', {'title': 'Личный вопрос', 'description': 'Описание обращения'})
    assert support.status_code == 201
    avatar = upload(master, image_file('PNG'), 'photo.png').json['user']['avatar']

    assert mutate(master, 'DELETE', '/account').status_code == 409
    assert mutate(admin, 'DELETE', '/admin/specialists/1').status_code == 409
    assert post(master, f'/bookings/{own}/cancel', {}).status_code == 200
    assert mutate(master, 'DELETE', '/account').status_code == 409
    assert post(customer, f'/bookings/{incoming}/cancel', {}).status_code == 200

    assert master.delete('/api/account').status_code == 403
    deleted = mutate(master, 'DELETE', '/account')
    assert deleted.status_code == 200 and deleted.json['user'] is None
    assert mutate(master, 'DELETE', '/account').status_code == 401
    assert second_session.get('/api/session').json['user'] is None
    assert second_session.get('/api/dashboard').status_code == 401
    assert master.get(avatar).status_code == 404
    assert not (tmp_path / 'avatars' / Path(avatar).name).exists()
    assert any(b['id'] == incoming and b['status'] == 'cancelled'
               for b in customer.get('/api/dashboard').json['bookings'])
    assert any(b['id'] == own and b['client'] == 'Удалённый пользователь'
               for b in admin.get('/api/dashboard').json['bookings'])
    item = next(i for i in admin.get('/api/support?status=all').json['items'] if i['title'] == 'Личный вопрос')
    assert (item['status'], item['sender_email']) == ('cancelled', '')

    restarted = create_app(dict(app.config))
    public = restarted.test_client()
    assert post(public, '/login', {'username': 'master', 'password': 'Demo2026!'}).status_code == 401
    assert 1 not in [s['id'] for s in public.get('/api/catalog').json['specialists']]
    assert public.get('/api/services/1').status_code == 404
    with sqlite3.connect(app.config['DATABASE']) as connection:
        assert connection.execute('PRAGMA foreign_key_check').fetchall() == []


def test_client_deletion_blocks_booking_and_releases_email_without_reviving_old_session(app):
    customer, stale_session = app.test_client(), app.test_client()
    email, password = 'deletion@example.test', 'OldPassword123'
    assert post(customer, '/register', {'email': email, 'username': 'retired-client', 'name': 'Клиент',
                                        'password': password}).status_code == 200
    assert post(stale_session, '/login', {'email': email, 'password': password}).status_code == 200
    booking = make_booking(customer, 1)
    assert mutate(customer, 'DELETE', '/account').status_code == 409
    assert post(customer, f'/bookings/{booking}/cancel', {}).status_code == 200
    assert mutate(customer, 'DELETE', '/account').status_code == 200
    restarted = create_app(dict(app.config))
    public = restarted.test_client()
    assert post(public, '/login', {'email': email, 'password': password}).status_code == 401
    assert post(public, '/register', {'email': email, 'username': 'retired-client', 'name': 'Новый клиент',
                                      'password': 'NewPassword123'}).status_code == 200
    assert stale_session.get('/api/session').json['user'] is None


def test_admin_retires_professional_profile_and_preserves_client_account(app):
    master = client(app, 'master')
    admin = client(app, 'admin')
    own = make_booking(master, 2)
    avatar = upload(master, image_file('PNG'), 'photo.png').json['user']['avatar']
    assert mutate(master, 'DELETE', '/admin/specialists/1').status_code == 403
    assert mutate(admin, 'DELETE', '/admin/specialists/1').status_code == 200
    assert mutate(admin, 'DELETE', '/admin/specialists/1').status_code == 404
    assert post(admin, '/admin/moderate', {'kind':'specialist', 'id':1, 'active':True}).status_code == 404
    assert 1 not in [s['id'] for s in admin.get('/api/admin').json['specialists']]
    assert master.get(avatar).status_code == 200
    assert master.get('/api/session').json['user']['role'] == 'client'
    assert master.get('/api/master').status_code == 403
    assert own in [b['id'] for b in master.get('/api/dashboard').json['bookings']]

    restarted = create_app(dict(app.config))
    assert 1 not in [s['id'] for s in restarted.test_client().get('/api/catalog').json['specialists']]
    new_client = client(restarted, 'master')
    application = post(new_client, APPLY, APPLICATION).json['application']
    assert post(client(restarted, 'admin'), f"{ADMIN}/{application['id']}/decision", {'status': 'approved'}).status_code == 200
    ident = new_client.get('/api/session').json['user']['specialist_id']
    assert ident != 1
    assert catalog_profile(new_client, ident)['photo'] == avatar


def test_startup_adds_profile_columns_to_existing_database(app):
    with sqlite3.connect(app.config['DATABASE']) as connection:
        connection.execute('ALTER TABLE users DROP COLUMN avatar')
        connection.execute('ALTER TABLE specialists DROP COLUMN deleted')
        connection.execute("UPDATE users SET name='Имя из старой базы' WHERE email='client@svobodno.demo'")
    existing = create_app(dict(app.config))
    session = client(existing).get('/api/session').json
    assert session['user']['name'] == 'Имя из старой базы'
    assert session['user']['avatar'] is None


def test_review_range_ownership_and_public_rating(app):
    customer = client(app)
    other = client(app, 'ivan')
    admin = client(app, 'admin')
    completed = next(row for row in customer.get('/api/dashboard').json['bookings'] if row['status'] == 'completed')
    review = {'booking_id': completed['id'], 'rating': 4, 'content': 'Результатом доволен'}
    assert post(other, '/reviews', review).status_code == 403
    for rating in (0, 6):
        assert post(customer, '/reviews', {**review, 'rating': rating}).status_code == 400
    assert post(customer, '/reviews', review).status_code == 201
    assert catalog_profile(customer)['rating'] is None
    ident = customer.get('/api/dashboard').json['reviews'][0]['id']
    moderation = {'kind': 'review', 'id': ident}
    assert post(admin, '/admin/moderate', {**moderation, 'status': 'approved'}).status_code == 200
    assert catalog_profile(customer)['rating'] == 4
    assert post(admin, '/admin/moderate', {**moderation, 'status': 'rejected'}).status_code == 200
    public = catalog_profile(customer)
    assert public['rating'] is None and not public['reviews']
