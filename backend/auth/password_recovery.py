"""SMTP delivery for password recovery messages."""
import smtplib
import ssl
from concurrent.futures import ThreadPoolExecutor
from email.headerregistry import Address
from email.message import EmailMessage
from threading import BoundedSemaphore
from time import monotonic


def send_recovery_email(config, recipient, display_name, reset_url):
    host = config.get('SMTP_HOST')
    sender = config.get('SMTP_FROM_EMAIL')
    if not host or not sender:
        raise RuntimeError('SMTP is not configured')
    message = EmailMessage()
    message['Subject'] = 'Восстановление пароля — Свободно.'
    message['From'] = Address(
        display_name=config.get('SMTP_FROM_NAME', 'Свободно.'),
        addr_spec=sender
    )
    message['To'] = recipient
    message.set_content(
        f"Здравствуйте, {display_name}!\n\n"
        f"Для создания нового пароля перейдите по ссылке (действует 30 минут):\n{reset_url}\n\n"
        "Если вы не запрашивали восстановление, просто проигнорируйте это письмо."
    )
    port = int(config.get('SMTP_PORT', 587))
    tls_context = ssl.create_default_context()
    client = (smtplib.SMTP_SSL(host, port, timeout=10, context=tls_context) if port == 465
              else smtplib.SMTP(host, port, timeout=10))
    with client as smtp:
        smtp.ehlo()
        if port != 465:
            smtp.starttls(context=tls_context)
            smtp.ehlo()
        username, password = config.get('SMTP_USERNAME'), config.get('SMTP_PASSWORD')
        if username:
            smtp.login(username, password or '')
        smtp.send_message(message)


class RecoveryDelivery:
    """Bounded in-process delivery with an SMTP failure cooldown."""
    def __init__(self, app, db):
        self.app = app
        self.db = db
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='password-mail')
        self.capacity = BoundedSemaphore(4)
        self.retry_after = 0

    def send(self, recipient, display_name, link, token_hash):
        # An injected delivery stub can run inline in unit tests.
        if self.app.testing and self.app.config.get('MAIL_SENDER'):
            self.deliver(recipient, display_name, link, token_hash)
        elif self.capacity.acquire(blocking=False):
            self.executor.submit(self.run, recipient, display_name, link, token_hash)
        else:
            self.app.logger.warning('Password recovery mail queue is full')
            self.discard(token_hash)

    def run(self, *args):
        try:
            self.deliver(*args)
        finally:
            self.capacity.release()

    def discard(self, token_hash):
        with self.db() as connection:
            connection.execute('DELETE FROM password_reset_tokens WHERE token_hash=?', (token_hash,))

    def deliver(self, recipient, display_name, link, token_hash):
        if monotonic() < self.retry_after:
            self.discard(token_hash)
            return
        try:
            sender = self.app.config.get('MAIL_SENDER') or send_recovery_email
            sender(self.app.config, recipient, display_name, link)
        except Exception as error:
            self.app.logger.error('Password recovery email delivery failed (%s)', type(error).__name__)
            self.retry_after = monotonic() + 300
            self.discard(token_hash)
