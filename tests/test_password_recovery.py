import hashlib
from datetime import timedelta

import pytest

from app import create_app, now


sent = []


@pytest.fixture
def app(tmp_path):
    sent.clear()
    return create_app({
        'TESTING': True,
        'DATABASE': str(tmp_path / 'recovery.sqlite'),
        'SECRET_KEY': 'test-secret',
        'APP_BASE_URL': 'https://example.test',
        'MAIL_SENDER': lambda config, email, name, url: sent.append((email, name, url)),
    })


def post(client, path, payload):
    csrf = client.get('/api/session').json['csrf']
    return client.post('/api' + path, json=payload, headers={'X-CSRF-Token': csrf})


def test_request_existing_email_sends_link_and_stores_only_hash(app):
    client = app.test_client()
    response = post(client, '/password-reset/request', {'email': 'client@svobodno.demo'})
    assert response.status_code == 200
    assert len(sent) == 1
    assert sent[0][0] == 'client@svobodno.demo'
    assert sent[0][2].startswith('https://example.test/reset-password#token=')
    token = sent[0][2].split('token=')[1]
    import sqlite3
    with sqlite3.connect(app.config['DATABASE']) as con:
        stored = con.execute('SELECT token_hash FROM password_reset_tokens').fetchone()[0]
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert token not in stored


def test_unknown_email_has_same_response_and_sends_nothing(app):
    client = app.test_client()
    known = post(client, '/password-reset/request', {'email': 'client@svobodno.demo'})
    sent.clear()
    unknown = post(client, '/password-reset/request', {'email': 'nobody@example.test'})
    assert known.status_code == unknown.status_code == 200
    assert known.json == unknown.json
    assert sent == []


def test_invalid_email_rejected(app):
    client = app.test_client()
    assert post(client, '/password-reset/request', {'email': 'bad'}).status_code == 400


def test_successful_reset_and_single_use(app):
    client = app.test_client()
    post(client, '/password-reset/request', {'email': 'client@svobodno.demo'})
    token = sent[0][2].split('token=')[1]
    response = post(client, '/password-reset/confirm', {
        'token': token, 'password': 'NewPassword123', 'confirmation': 'NewPassword123'})
    assert response.status_code == 200
    old_login = post(client, '/login', {'username': 'client', 'password': 'Demo2026!'})
    assert old_login.status_code == 401
    login = post(client, '/login', {'username': 'client', 'password': 'NewPassword123'})
    assert login.status_code == 200
    assert post(client, '/password-reset/confirm', {
        'token': token, 'password': 'AnotherPass123', 'confirmation': 'AnotherPass123'}).status_code == 400


def test_invalid_and_expired_tokens(app):
    client = app.test_client()
    assert post(client, '/password-reset/confirm', {
        'token': 'wrong', 'password': 'NewPassword123', 'confirmation': 'NewPassword123'}).status_code == 400
    post(client, '/password-reset/request', {'email': 'client@svobodno.demo'})
    token = sent[0][2].split('token=')[1]
    import sqlite3
    with sqlite3.connect(app.config['DATABASE']) as con:
        con.execute('UPDATE password_reset_tokens SET expires_at=?',
                    ((now() - timedelta(minutes=1)).isoformat(),))
    assert post(client, '/password-reset/confirm', {
        'token': token, 'password': 'NewPassword123', 'confirmation': 'NewPassword123'}).status_code == 400


@pytest.mark.parametrize('password,confirmation', [
    ('short', 'short'), ('ValidPassword123', 'DifferentPassword123')
])
def test_invalid_password(app, password, confirmation):
    client = app.test_client()
    post(client, '/password-reset/request', {'email': 'client@svobodno.demo'})
    token = sent[0][2].split('token=')[1]
    assert post(client, '/password-reset/confirm', {
        'token': token, 'password': password, 'confirmation': confirmation}).status_code == 400


def test_smtp_error_is_not_exposed(app):
    def broken(*args):
        raise OSError('sensitive SMTP diagnostic')
    app.config['MAIL_SENDER'] = broken
    response = post(app.test_client(), '/password-reset/request', {'email': 'client@svobodno.demo'})
    assert response.status_code == 200
    assert 'sensitive' not in response.get_data(as_text=True)


def test_rate_limit(app):
    app.config['PASSWORD_RESET_LIMIT'] = 2
    client = app.test_client()
    for _ in range(2):
        assert post(client, '/password-reset/request', {'email': 'client@svobodno.demo'}).status_code == 200
    before = len(sent)
    assert post(client, '/password-reset/request', {'email': 'client@svobodno.demo'}).status_code == 200
    assert len(sent) == before
