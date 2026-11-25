"""Support requests and their single administrative response."""
import re

from backend.moderation.services import ModerationError


STATUSES = ('pending', 'resolved', 'cancelled')


def initialize_support(connection):
    connection.execute('''CREATE TABLE IF NOT EXISTS support_requests(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','cancelled')),
        created_at TEXT NOT NULL,
        response TEXT,
        admin_id INTEGER REFERENCES users(id),
        resolved_at TEXT,
        request_key TEXT,
        UNIQUE(user_id,request_key)
    )''')
    connection.execute('CREATE INDEX IF NOT EXISTS support_inbox ON support_requests(status,id DESC)')
    connection.execute('CREATE INDEX IF NOT EXISTS support_history ON support_requests(user_id,id DESC)')


def support_items(connection, user, ident=None, status='all', order='newest'):
    scope = '1=1' if user['role'] == 'admin' else 's.user_id=?'
    args = () if user['role'] == 'admin' else (user['id'],)
    direction = 'DESC' if order == 'newest' else 'ASC'
    rows = connection.execute(f'''SELECT s.id,s.user_id,s.sender_name,s.sender_email,s.sender_role,
        s.title,s.description,s.status,s.created_at,s.response,s.admin_id,s.resolved_at,u.name admin_name
        FROM support_requests s LEFT JOIN users u ON u.id=s.admin_id
        WHERE {scope} AND (? IS NULL OR s.id=?) AND (?='all' OR s.status=?)
        ORDER BY s.created_at {direction},s.id {direction}''', (*args, ident, ident, status, status))
    return [dict(row) for row in rows]


def message_text(data, key, label, maximum):
    value = data.get(key)
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum:
        raise ModerationError(f'{label}: укажите от 1 до {maximum} символов')
    return value.strip()


def create_support(connection, user, data, clock):
    title = message_text(data, 'title', 'Заголовок', 120)
    description = message_text(data, 'description', 'Описание', 3000)
    key = data.get('request_key')
    if key is not None and (not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9-]{16,80}', key)):
        raise ModerationError('Некорректный ключ отправки')

    connection.execute('BEGIN IMMEDIATE')
    previous = connection.execute('''SELECT id,title,description,request_key FROM support_requests
        WHERE user_id=? AND (request_key=? OR (status='pending' AND title=? AND description=?))
        ORDER BY request_key IS ? DESC LIMIT 1''', (user['id'], key, title, description, key)).fetchone()
    if previous:
        if key and previous['request_key'] != key:
            raise ModerationError('Такое обращение уже на рассмотрении', 409)
        if (previous['title'], previous['description']) != (title, description):
            raise ModerationError('Обращение уже отправлено. Откройте новую форму.', 409)
        return previous['id'], False

    timestamp = clock().isoformat(timespec='seconds')
    ident = connection.execute('''INSERT INTO support_requests
        (user_id,sender_name,sender_email,sender_role,title,description,created_at,request_key)
        VALUES(?,?,?,?,?,?,?,?)''',
        (user['id'], user['name'], user['email'], user['role'], title, description, timestamp, key)).lastrowid
    connection.execute('''INSERT INTO notifications(user_id,support_request_id,event,message,created_at)
        SELECT id,?,'support_created',?,? FROM users WHERE role='admin' ''',
        (ident, f'Новое обращение «{title}»', timestamp))
    return ident, True


def update_support(connection, user, ident, action, data, clock):
    connection.execute('BEGIN IMMEDIATE')
    items = support_items(connection, user, ident)
    if not items:
        raise ModerationError('Обращение не найдено', 404)
    item = items[0]
    if item['status'] != 'pending':
        raise ModerationError('Обращение уже обработано или отозвано', 409)
    if action == 'cancel':
        if data.get('confirm') is not True:
            raise ModerationError('Подтвердите отзыв обращения')
        connection.execute("UPDATE support_requests SET status='cancelled' WHERE id=?", (ident,))
        return

    response = message_text(data, 'response', 'Ответ', 3000)
    timestamp = clock().isoformat(timespec='seconds')
    connection.execute('''UPDATE support_requests SET status='resolved',response=?,admin_id=?,resolved_at=?
        WHERE id=?''', (response, user['id'], timestamp, ident))
    connection.execute('''INSERT INTO notifications(user_id,support_request_id,event,message,created_at)
        VALUES(?,?,'support_resolved',?,?)''',
        (item['user_id'], ident, f'Ответ на обращение «{item["title"]}»', timestamp))
