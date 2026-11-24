"""SMTP delivery for password recovery messages."""
import smtplib
from email.message import EmailMessage


def send_recovery_email(config, recipient, display_name, reset_url):
    host = config.get('SMTP_HOST')
    sender = config.get('SMTP_FROM_EMAIL')
    if not host or not sender:
        raise RuntimeError('SMTP is not configured')
    message = EmailMessage()
    message['Subject'] = 'Восстановление пароля — Свободно.'
    message['From'] = f"{config.get('SMTP_FROM_NAME', 'Свободно.')} <{sender}>"
    message['To'] = recipient
    message.set_content(
        f"Здравствуйте, {display_name}!\n\n"
        f"Для создания нового пароля перейдите по ссылке (действует 30 минут):\n{reset_url}\n\n"
        "Если вы не запрашивали восстановление, просто проигнорируйте это письмо."
    )
    port = int(config.get('SMTP_PORT', 587))
    client = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
    with client(host, port, timeout=10) as smtp:
        smtp.ehlo()
        if port != 465:
            smtp.starttls()
            smtp.ehlo()
        username, password = config.get('SMTP_USERNAME'), config.get('SMTP_PASSWORD')
        if username:
            smtp.login(username, password or '')
        smtp.send_message(message)
