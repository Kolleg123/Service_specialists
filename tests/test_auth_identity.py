import sqlite3

import pytest
from app import create_app


@pytest.fixture
def app(tmp_path):
    sent = []
    application = create_app({
        'TESTING': True,
        'DEMO_MODE': True,
        'DEMO_DATABASE': str(tmp_path / 'identity.sqlite'),
        'SECRET_KEY': 'identity-tests',
        'MAIL_SENDER': lambda config, email, name, url: sent.append((email, name, url)),
        'APP_BASE_URL': 'https://example.test',
    })
    application.config['TEST_SENT'] = sent
    return application


def post(client, path, data):
    csrf = client.get('/api/session').json['csrf']
    return client.post('/api' + path, json=data, headers={'X-CSRF-Token': csrf})


def login(client, username='client', password='Demo2026!'):
    return post(client, '/login', {'username': username, 'password': password})


def test_login_accepts_username_and_email(app):
    client = app.test_client()
    assert login(client).status_code == 200
    user = client.get('/api/session').json['user']
    assert user['username'] == 'client'
    assert user['email'] == 'client@svobodno.demo'
    assert post(client, '/logout', {}).status_code == 200
    assert post(client, '/login', {'identifier': 'client@svobodno.demo', 'password': 'Demo2026!'}).status_code == 200


def test_registration_requires_unique_immutable_username_and_unique_email(app):
    client = app.test_client()
    payload = {'name': 'Новый пользователь', 'username': 'newuser', 'email': 'new@example.test',
               'password': 'NewPassword123'}
    created = post(client, '/register', payload)
    assert created.status_code == 200
    assert created.json['user']['username'] == 'newuser'
    assert post(client, '/logout', {}).status_code == 200
    assert post(client, '/register', {**payload, 'email': 'other@example.test'}).status_code == 409
    assert post(client, '/register', {**payload, 'username': 'another'}).status_code == 409
    assert login(client, 'newuser', 'NewPassword123').status_code == 200


def test_profile_can_change_email_but_cannot_change_username_and_recovery_uses_new_email(app):
    client = app.test_client()
    assert login(client).status_code == 200
    csrf = client.get('/api/session').json['csrf']
    headers = {'X-CSRF-Token': csrf}
    changed = client.patch('/api/profile', json={'name': 'Клиент', 'email': 'New.Mail@example.test'},
                           headers=headers)
    assert changed.status_code == 200
    assert changed.json['user']['username'] == 'client'
    assert changed.json['user']['email'] == 'new.mail@example.test'

    duplicate = client.patch('/api/profile', json={'name': 'Клиент', 'email': 'master@svobodno.demo'},
                             headers=headers)
    assert duplicate.status_code == 409
    invalid = client.patch('/api/profile', json={'name': 'Клиент', 'email': 'not-an-email'},
                           headers=headers)
    assert invalid.status_code == 400
    immutable = client.patch('/api/profile', json={'name': 'Клиент', 'email': 'new.mail@example.test',
                                                    'username': 'changed-login'}, headers=headers)
    assert immutable.status_code == 400
    assert post(client, '/logout', {}).status_code == 200
    assert login(client, 'client').status_code == 200

    sent = app.config['TEST_SENT']
    response = post(client, '/password-reset/request', {'email': 'new.mail@example.test'})
    assert response.status_code == 200
    assert len(sent) == 1 and sent[0][0] == 'new.mail@example.test'
    with sqlite3.connect(app.config['DATABASE']) as connection:
        row = connection.execute('SELECT username,email FROM users WHERE id=1').fetchone()
    assert row == ('client', 'new.mail@example.test')


def test_profile_rejects_email_already_owned_by_another_user(app):
    client = app.test_client()
    assert login(client).status_code == 200
    csrf = client.get('/api/session').json['csrf']
    response = client.patch('/api/profile', json={'name': 'Клиент', 'email': 'master@svobodno.demo'},
                            headers={'X-CSRF-Token': csrf})
    assert response.status_code == 409
    assert client.get('/api/session').json['user']['email'] == 'client@svobodno.demo'


def test_legacy_email_and_username_collisions_preserve_both_accounts(tmp_path):
    from werkzeug.security import generate_password_hash

    config = {'TESTING': True, 'DATABASE': str(tmp_path / 'ordinary.sqlite'),
              'DEMO_DATABASE': str(tmp_path / 'demo.sqlite'), 'SECRET_KEY': 'identity-tests'}
    application = create_app(config)
    with sqlite3.connect(config['DATABASE']) as connection:
        connection.executemany('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)', [
            ('First', 'Legacy@example.test', generate_password_hash('LegacyFirst123'), 'client'),
            ('Second', 'legacy@example.test', generate_password_hash('LegacySecond123'), 'client'),
        ])
    application = create_app(config)
    first, second = application.test_client(), application.test_client()
    assert post(first, '/login', {'email': 'Legacy@example.test', 'password': 'LegacyFirst123'}).json['user']['username'] == 'legacy'
    assert post(second, '/login', {'email': 'legacy@example.test', 'password': 'LegacySecond123'}).json['user']['username'] == 'legacy_1'
    assert login(first, 'LEGACY', 'LegacyFirst123').status_code == 200
    assert login(second, 'legacy_1', 'LegacySecond123').status_code == 200
    assert post(first, '/register', {'name': 'Third', 'email': 'LEGACY@example.test', 'username': 'third',
                                     'password': 'LegacyThird123'}).status_code == 409
    create_app(config)
    with sqlite3.connect(config['DATABASE']) as connection:
        assert connection.execute('PRAGMA foreign_key_check').fetchall() == []
        assert connection.execute('SELECT username FROM users ORDER BY id').fetchall() == [('legacy',), ('legacy_1',)]
