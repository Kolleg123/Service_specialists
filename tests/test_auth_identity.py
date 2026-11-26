import sqlite3

import pytest
from app import create_app


@pytest.fixture
def app(tmp_path):
    sent = []
    application = create_app({
        'TESTING': True,
        'DATABASE': str(tmp_path / 'identity.sqlite'),
        'SECRET_KEY': 'identity-tests',
        'MAIL_SENDER': lambda config, email, name, url: sent.append((email, name, url)),
        'APP_BASE_URL': 'https://example.test',
    })
    application.config['TEST_SENT'] = sent
    return application


def post(client, path, data):
    csrf = client.get('/api/session').json['csrf']
    return client.post('/api' + path, json=data, headers={'X-CSRF-Token': csrf})


def login(client, username='client'):
    return post(client, '/login', {'username': username, 'password': 'Demo2026!'})


def test_login_uses_username_not_email_and_legacy_accounts_are_migrated(app):
    client = app.test_client()
    assert login(client).status_code == 200
    user = client.get('/api/session').json['user']
    assert user['username'] == 'client'
    assert user['email'] == 'client@svobodno.demo'
    assert post(client, '/logout', {}).status_code == 200
    assert post(client, '/login', {'username': 'client@svobodno.demo', 'password': 'Demo2026!'}).status_code == 401


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
    assert login(client, 'newuser').status_code == 200


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
