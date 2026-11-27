import hashlib
from datetime import timedelta
from email import policy
from email.parser import BytesParser
from unittest.mock import MagicMock

import pytest

from app import create_app, now
from backend.auth.password_recovery import send_recovery_email


sent = []


@pytest.fixture
def app(tmp_path):
    sent.clear()
    return create_app({
        'TESTING': True,
        'DEMO_MODE': True, 'DEMO_DATABASE': str(tmp_path / 'recovery.sqlite'),
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


def test_smtp_from_header_round_trip(monkeypatch):
    smtp = MagicMock()
    monkeypatch.setattr('backend.auth.password_recovery.smtplib.SMTP', smtp)
    send_recovery_email(
        {'SMTP_HOST': 'smtp.example.test', 'SMTP_FROM_EMAIL': 'sender@example.test'},
        'recipient@example.test', 'Тест', 'https://example.test/reset-password',
    )

    send_message = smtp.return_value.__enter__.return_value.send_message
    send_message.assert_called_once()
    message = send_message.call_args.args[0]
    parsed = BytesParser(policy=policy.default).parsebytes(message.as_bytes(policy=policy.SMTP))
    assert not parsed.defects
    assert not parsed['From'].defects
    address, = parsed['From'].addresses
    assert address.display_name == 'Свободно.'
    assert address.addr_spec == 'sender@example.test'


def test_rate_limit(app):
    assert app.config['PASSWORD_RESET_LIMIT'] == 30
    assert app.config['PASSWORD_RESET_IP_LIMIT'] == 30
    assert app.config['PASSWORD_RESET_WINDOW_MINUTES'] == 60
    assert app.config['PASSWORD_RESET_TTL_MINUTES'] == 30
    client = app.test_client()
    payload = {'email': 'client@svobodno.demo'}
    for _ in range(30):
        allowed = post(client, '/password-reset/request', payload)
        assert allowed.status_code == 200
    assert len(sent) == 30

    blocked = post(client, '/password-reset/request', payload)
    assert blocked.status_code == 200
    assert blocked.json == allowed.json
    assert len(sent) == 30
