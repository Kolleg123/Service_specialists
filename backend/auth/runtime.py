"""Deployment settings, legacy account isolation and signed session separation."""
import hashlib
import hmac
import ipaddress
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

import click
from backend.auth.identity import available_username
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash

DEMO_DOMAIN = '@svobodno.demo'


def env_flag(name, default=False):
    return os.environ.get(name, str(default)).lower() in ('true', '1', 'yes')


def configure(app, overrides):
    instance = Path(app.instance_path)
    app.config.update(
        DEMO_MODE=env_flag('DEMO_MODE'),
        DATABASE=os.environ.get('DATABASE_PATH') or str(instance / 'svobodno.sqlite'),
        DEMO_DATABASE=os.environ.get('DEMO_DATABASE_PATH') or str(instance / 'svobodno-demo.sqlite'),
        TRUSTED_PROXY_IPS=os.environ.get('TRUSTED_PROXY_IPS', ''),
    )
    app.config.update(overrides or {})
    demo = app.config['DEMO_MODE']
    main = Path(app.config.get('ORDINARY_DATABASE', app.config['DATABASE'])).resolve()
    sample = Path(app.config['DEMO_DATABASE']).resolve()
    app.config['ORDINARY_DATABASE'] = str(main)
    if main == sample or (main.exists() and sample.exists() and main.samefile(sample)):
        raise ValueError('Обычная и демонстрационная базы должны быть разными файлами')
    app.config['DATABASE'] = str(sample if demo else main)
    app.config.setdefault('UPLOAD_FOLDER', str(instance / ('uploads-demo' if demo else 'uploads')))
    app.config['SESSION_COOKIE_NAME'] = 'svobodno_demo' if demo else 'svobodno_session'
    if urlsplit(app.config['APP_BASE_URL']).scheme == 'https':
        app.config['SESSION_COOKIE_SECURE'] = True

    secret = app.config.get('SECRET_KEY') or os.environ.get('APP_SECRET')
    if not secret:
        instance.mkdir(parents=True, exist_ok=True)
        path = instance / 'session.key'
        # Publish only a complete key, including when several workers start together.
        temporary = instance / ('.session-' + secrets.token_hex(12))
        if not path.exists():
            try:
                with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
                    stream.write(secrets.token_hex(32))
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                temporary.unlink(missing_ok=True)
        secret = path.read_text().strip()
    if not app.testing and (len(secret) < 32 or secret == 'replace-with-a-long-random-secret'):
        raise ValueError('APP_SECRET должен содержать случайный секрет длиной не менее 32 символов. Проверьте окружение службы и .env проекта.')
    namespace = b'svobodno-demo-v1' if demo else b'svobodno-main-v1'
    namespace += b'\0' + os.fsencode(app.config['DATABASE'])
    app.secret_key = hmac.new(secret.encode(), namespace, hashlib.sha256).hexdigest()

    trusted = {ipaddress.ip_address(value.strip()) for value in app.config['TRUSTED_PROXY_IPS'].split(',') if value.strip()}
    if trusted:
        direct = app.wsgi_app
        forwarded = ProxyFix(direct, x_for=1, x_proto=1, x_host=0)

        def from_proxy(environ, start_response):
            try:
                peer = ipaddress.ip_address(environ.get('REMOTE_ADDR') or '')
            except ValueError:
                peer = None
            return (forwarded if peer in trusted else direct)(environ, start_response)

        app.wsgi_app = from_proxy


def demo_email(email):
    return (email or '').strip().lower().endswith(DEMO_DOMAIN)


def allowed_account(connection, user, demo_mode):
    if not user or user['role'] == 'deleted':
        return False
    if demo_mode:
        return True
    return not demo_email(user['email']) and not connection.execute(
        """SELECT 1 FROM seed_entities WHERE table_name='users' AND entity_id=?""", (user['id'],)
    ).fetchone()


def register_admin_command(app, db):
    @app.cli.command('create-admin')
    @click.option('--email', prompt='Почта администратора')
    @click.password_option()
    def create_admin(email, password):
        """Create an independent administrator account in the ordinary database."""
        email = email.strip().lower()
        if app.config['DEMO_MODE']:
            raise click.ClickException('Запустите команду в обычном режиме')
        if demo_email(email) or not 3 <= len(email) <= 120 or email.count('@') != 1 or not all(email.split('@')):
            raise click.ClickException('Укажите обычный адрес электронной почты')
        if not 12 <= len(password) <= 128:
            raise click.ClickException('Пароль должен содержать от 12 до 128 символов')
        with db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            if connection.execute('SELECT 1 FROM users WHERE lower(email)=?', (email,)).fetchone():
                raise click.ClickException('Эта почта уже используется')
            username = available_username(connection, email, "admin")
            connection.execute("INSERT INTO users(name,username,email,password,role) VALUES(?,?,?,?,'admin')",
                               ('Администратор', username, email, generate_password_hash(password)))
        click.echo(f'Администратор создан. Логин: {username}')
