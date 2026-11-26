"""SMTP delivery for password recovery messages."""
import smtplib
import ssl
from email.headerregistry import Address
from email.message import EmailMessage


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
