"""Profile updates and account retirement while retaining shared booking history."""
import re
import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash

from backend.bookings.lifecycle import booking_interval


DEFAULT_PHOTO = '/static/favicon.svg'
DELETED_NAME = 'Удалённый пользователь'
IMAGE_TYPES = {'.jpg': ('JPEG', 'image/jpeg'), '.jpeg': ('JPEG', 'image/jpeg'),
               '.png': ('PNG', 'image/png'), '.webp': ('WEBP', 'image/webp')}
AVATAR_NAME = re.compile(r'user-[0-9]+-[a-f0-9]{24}\.(?:jpe?g|png|webp)')


class ProfileError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def account(connection, user_id):
    return connection.execute("SELECT * FROM users WHERE id=? AND role!='deleted'", (user_id,)).fetchone()


def update_details(connection, user_id, data):
    if 'username' in data or 'login' in data:
        raise ProfileError('Логин нельзя изменить после регистрации', 400)
    name = data.get('name', '')
    email = data.get('email')
    passwords = [data.get(key, '') for key in ('current_password', 'new_password', 'confirmation')]
    if not isinstance(name, str) or not 2 <= len(name.strip()) <= 80:
        raise ProfileError('ФИО должно содержать от 2 до 80 символов')
    if email is not None and (not isinstance(email, str) or len(email.strip()) > 120 or
                              not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email.strip())):
        raise ProfileError('Укажите корректный адрес электронной почты')
    if not all(isinstance(value, str) and len(value) <= 128 for value in passwords):
        raise ProfileError('Пароль должен содержать не более 128 символов')
    name = name.strip()
    email = email.strip().lower() if isinstance(email, str) else None
    current, new, confirmation = passwords
    connection.execute('BEGIN IMMEDIATE')
    user = account(connection, user_id)
    if not user:
        raise ProfileError('Войдите в личный кабинет', 401)
    if email is not None and email != user['email']:
        if connection.execute('SELECT 1 FROM users WHERE email=? COLLATE NOCASE AND id!=?', (email, user_id)).fetchone():
            raise ProfileError('Эта почта уже используется другим аккаунтом', 409)
        connection.execute('UPDATE users SET email=? WHERE id=?', (email, user_id))
        connection.execute('DELETE FROM password_reset_tokens WHERE user_id=?', (user_id,))
    if any(passwords):
        if not check_password_hash(user['password'], current):
            raise ProfileError('Текущий пароль указан неверно', 403)
        if len(new) < 8 or new != confirmation:
            raise ProfileError('Новый пароль должен содержать от 8 до 128 символов, а подтверждение должно совпадать')
        connection.execute('UPDATE users SET password=? WHERE id=?', (generate_password_hash(new), user_id))
        connection.execute('DELETE FROM password_reset_tokens WHERE user_id=?', (user_id,))
    connection.execute('UPDATE users SET name=? WHERE id=?', (name, user_id))
    connection.execute('UPDATE specialists SET name=? WHERE id=?', (name, user['specialist_id']))


def validate_avatar(upload):
    if not upload or not upload.filename:
        raise ProfileError('Выберите изображение')
    extension = Path(upload.filename).suffix.lower()
    image_type = IMAGE_TYPES.get(extension)
    if not image_type or upload.mimetype != image_type[1]:
        raise ProfileError('Укажите файл JPG, PNG или WEBP', 415)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(upload.stream, formats=[image_type[0]]) as image:
                image.verify()
            upload.stream.seek(0)
            with Image.open(upload.stream, formats=[image_type[0]]) as image:
                decoded_pixels = 0
                for index in range(getattr(image, 'n_frames', 1)):
                    image.seek(index)
                    decoded_pixels += image.width * image.height
                    if decoded_pixels > 24_000_000:
                        raise ProfileError('Изображение слишком большое для аватарки', 415)
                    image.load()
    except (UnidentifiedImageError, OSError, SyntaxError, EOFError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise ProfileError('Файл повреждён или его формат не соответствует расширению', 415) from error
    upload.stream.seek(0)
    return extension


def set_avatar(connection, user_id, url):
    connection.execute('BEGIN IMMEDIATE')
    user = account(connection, user_id)
    if not user:
        raise ProfileError('Войдите в личный кабинет', 401)
    specialist = connection.execute('SELECT photo FROM specialists WHERE id=?', (user['specialist_id'],)).fetchone()
    connection.execute('UPDATE users SET avatar=? WHERE id=?', (url, user_id))
    connection.execute('UPDATE specialists SET photo=? WHERE id=?', (url, user['specialist_id']))
    return user['avatar'], specialist['photo'] if specialist else None


def remove_unused_avatars(connection, directory, candidates):
    for url in set(filter(None, candidates)):
        name = url.removeprefix('/uploads/')
        if url == name or not AVATAR_NAME.fullmatch(name):
            continue
        if connection.execute('SELECT 1 FROM users WHERE avatar=? UNION ALL SELECT 1 FROM specialists WHERE photo=?',
                              (url, url)).fetchone():
            continue
        (directory / name).unlink(missing_ok=True)


def retire_specialist(connection, specialist_id, *, remove_identity=False):
    specialist = connection.execute('SELECT photo FROM specialists WHERE id=? AND deleted=0',
                                    (specialist_id,)).fetchone()
    if not specialist:
        raise ProfileError('Специалист не найден', 404)
    if connection.execute("""SELECT 1 FROM bookings b JOIN slots s ON s.id=b.slot_id
            WHERE s.specialist_id=? AND b.status='confirmed' LIMIT 1""", (specialist_id,)).fetchone():
        raise ProfileError('Сначала отмените предстоящие записи специалиста и завершите прошедшие', 409)
    connection.execute('UPDATE slots SET active=0 WHERE specialist_id=?', (specialist_id,))
    connection.execute('UPDATE services SET active=0,deleted=1,revision=revision+1 WHERE specialist_id=? AND deleted=0',
                       (specialist_id,))
    connection.execute('DELETE FROM specialist_schedules WHERE specialist_id=?', (specialist_id,))
    connection.execute('''UPDATE specialists SET active=0,deleted=1,photo=? WHERE id=?''',
                       (DEFAULT_PHOTO, specialist_id))
    if remove_identity:
        connection.execute('''UPDATE specialists SET name=?,education='',skills='',bio='',location=''
            WHERE id=?''', (DELETED_NAME, specialist_id))
    connection.execute("UPDATE users SET role='client',specialist_id=NULL WHERE specialist_id=? AND role='master'",
                       (specialist_id,))
    return specialist['photo']


def retire_account(connection, user_id, current_time):
    connection.execute('BEGIN IMMEDIATE')
    user = account(connection, user_id)
    if not user:
        raise ProfileError('Войдите в личный кабинет', 401)
    if user['role'] not in ('client', 'master'):
        raise ProfileError('Удаление этого аккаунта недоступно', 403)
    bookings = connection.execute("""SELECT s.starts_at,s.ends_at slot_ends_at,v.duration
        FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id
        WHERE b.user_id=? AND b.status='confirmed'""", (user_id,))
    if any(booking_interval(booking)[1] > current_time for booking in bookings):
        raise ProfileError('Сначала отмените предстоящие записи и дождитесь окончания текущих', 409)

    photo = None
    if user['specialist_id'] is not None:
        photo = retire_specialist(connection, user['specialist_id'], remove_identity=True)

    # Keep joins and foreign keys for shared history. No login or private account data survives.
    for table in ('notifications', 'searches', 'password_reset_tokens', 'specialist_applications'):
        connection.execute(f'DELETE FROM {table} WHERE user_id=?', (user_id,))
    connection.execute('UPDATE bookings SET address=NULL,note=NULL WHERE user_id=?', (user_id,))
    connection.execute("""UPDATE support_requests SET sender_name=?,sender_email='',
        status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE user_id=?""",
        (DELETED_NAME, user_id))
    connection.execute("""UPDATE users SET name=?,username=NULL,email=NULL,password='',role='deleted',
        avatar=NULL,specialist_id=NULL WHERE id=?""", (DELETED_NAME, user_id))
    return user['avatar'], photo
