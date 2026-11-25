"""Transactional, resumable demo initialization. Never replace existing rows."""
from datetime import datetime, timedelta
from werkzeug.security import generate_password_hash

from backend.database.service_categories import backfill_categories, infer_category, initialize_categories

SCHEMA = """
CREATE TABLE IF NOT EXISTS specialists(id INTEGER PRIMARY KEY,name TEXT,profession TEXT,category TEXT,experience INTEGER,education TEXT,skills TEXT,bio TEXT,photo TEXT,location TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,password TEXT,role TEXT,specialist_id INTEGER REFERENCES specialists(id));
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY,specialist_id INTEGER REFERENCES specialists(id),title TEXT,price INTEGER,duration INTEGER,mode TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS slots(id INTEGER PRIMARY KEY,specialist_id INTEGER REFERENCES specialists(id),service_id INTEGER REFERENCES services(id),starts_at TEXT,capacity INTEGER CHECK(capacity>0),active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS specialist_schedules(
    specialist_id INTEGER PRIMARY KEY REFERENCES specialists(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('time','day')),
    weekdays TEXT NOT NULL,
    opens_at TEXT NOT NULL,
    closes_at TEXT NOT NULL,
    lunch_start TEXT,
    lunch_end TEXT,
    daily_limit INTEGER
);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),slot_id INTEGER REFERENCES slots(id),quantity INTEGER CHECK(quantity>0),address TEXT,note TEXT,status TEXT,created_at TEXT,total INTEGER);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),specialist_id INTEGER REFERENCES specialists(id),booking_id INTEGER UNIQUE REFERENCES bookings(id),rating INTEGER CHECK(rating BETWEEN 1 AND 5),content TEXT,status TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS searches(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),query TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS password_reset_tokens(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS password_reset_user ON password_reset_tokens(user_id);
CREATE TABLE IF NOT EXISTS password_reset_requests(id INTEGER PRIMARY KEY,ip_address TEXT NOT NULL,email_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS password_reset_rate_ip ON password_reset_requests(ip_address,created_at);
CREATE INDEX IF NOT EXISTS password_reset_rate_email ON password_reset_requests(email_hash,created_at);
CREATE INDEX IF NOT EXISTS booking_slot ON bookings(slot_id,status);
CREATE INDEX IF NOT EXISTS slot_specialist ON slots(specialist_id,starts_at);

CREATE TABLE IF NOT EXISTS specialist_applications(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    profession TEXT NOT NULL,
    category TEXT NOT NULL,
    experience INTEGER NOT NULL CHECK(experience BETWEEN 0 AND 80),
    education TEXT NOT NULL,
    skills TEXT NOT NULL,
    bio TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    reason TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_specialist_application
    ON specialist_applications(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS specialist_application_history ON specialist_applications(user_id,id DESC);

CREATE TABLE IF NOT EXISTS seed_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seed_entities(seed_key TEXT PRIMARY KEY,table_name TEXT NOT NULL,entity_id INTEGER NOT NULL);
"""

NOTIFICATIONS_TABLE = """
CREATE TABLE notifications(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    specialist_application_id INTEGER REFERENCES specialist_applications(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
    CHECK(
        (booking_id IS NOT NULL AND service_id IS NULL AND specialist_application_id IS NULL
            AND event IN ('confirmed','cancelled','completed'))
        OR
        (booking_id IS NULL AND service_id IS NOT NULL AND specialist_application_id IS NULL
            AND event IN ('service_approved','service_rejected'))
        OR
        (booking_id IS NULL AND service_id IS NULL AND specialist_application_id IS NOT NULL
            AND event IN ('specialist_approved','specialist_rejected'))
    ),
    UNIQUE(user_id,booking_id,event),
    UNIQUE(user_id,specialist_application_id)
)
"""


def migrate_service_moderation(connection):
    columns = {row['name'] for row in connection.execute('PRAGMA table_info(services)')}
    if 'moderation_status' not in columns:
        connection.execute("""ALTER TABLE services ADD COLUMN moderation_status TEXT NOT NULL
            DEFAULT 'approved' CHECK(moderation_status IN ('pending','approved','rejected'))""")
    if 'moderation_reason' not in columns:
        connection.execute('ALTER TABLE services ADD COLUMN moderation_reason TEXT')

    for name, definition in (
        ('deleted', 'INTEGER NOT NULL DEFAULT 0'),
        ('draft', 'TEXT'),
        ('draft_status', 'TEXT'),
        ('draft_reason', 'TEXT'),
        ('revision', 'INTEGER NOT NULL DEFAULT 0'),
    ):
        if name not in columns:
            connection.execute(f'ALTER TABLE services ADD COLUMN {name} {definition}')
    booking_columns = {row['name'] for row in connection.execute('PRAGMA table_info(bookings)')}
    if 'cancel_reason' not in booking_columns:
        connection.execute('ALTER TABLE bookings ADD COLUMN cancel_reason TEXT')


def migrate_notifications(connection):
    columns = {row['name'] for row in connection.execute('PRAGMA table_info(notifications)')}
    schema = connection.execute("SELECT sql FROM sqlite_master WHERE name='notifications'").fetchone()
    if columns and ('specialist_application_id' not in columns or
                    'UNIQUE(user_id,service_id)' in schema['sql']):
        connection.execute('ALTER TABLE notifications RENAME TO previous_notifications')
        connection.execute(NOTIFICATIONS_TABLE)
        fields = 'id,user_id,booking_id,event,message,created_at,is_read'
        for field in ('service_id', 'specialist_application_id'):
            if field in columns:
                fields += ',' + field
        connection.execute(f"INSERT INTO notifications({fields}) SELECT {fields} FROM previous_notifications")
        connection.execute('DROP TABLE previous_notifications')
    elif not columns:
        connection.execute(NOTIFICATIONS_TABLE)
    connection.execute('CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id,id DESC)')


PEOPLE = [('Алексей Морозов',
  'Сантехник',
  'Дом и ремонт',
  12,
  'Колледж архитектуры и строительства, инженерные системы',
  'Сантехника,Поиск протечек,Монтаж оборудования',
  'Помогу вернуть дому комфорт. Аккуратно устраняю протечки, устанавливаю сантехнику и всегда объясняю, что '
  'и зачем делаю.',
  'photo-1500648767791-00dcc994a43e',
  'Киров · выезд по городу'),
 ('Михаил Волков',
  'Электрик',
  'Дом и ремонт',
  9,
  'ВятГУ, электроэнергетика',
  'Электромонтаж,Диагностика,Умный дом',
  'От одной розетки до домашнего освещения. Работаю внимательно и оставляю после себя порядок.',
  'photo-1560250097-0b93528c311a',
  'Киров · выезд по городу'),
 ('Мария Соколова',
  'Стилист по волосам',
  'Красота',
  7,
  'Академия парикмахерского искусства, колористика',
  'Стрижки,Укладки,Уход за волосами',
  'Нахожу форму и стиль, которые подходят именно вам. Спокойная атмосфера, внимание к деталям и вашим '
  'пожеланиям.',
  'photo-1580489944761-15a19d654956',
  'Киров · ул. Ленина, 54'),
 ('Анна Лебедева',
  'Преподаватель английского',
  'Обучение',
  8,
  'ВятГУ, лингвистика; сертификат CELTA',
  'Разговорный английский,Подготовка к экзаменам,Speaking club',
  'Помогаю заговорить уверенно. Живые темы, понятные объяснения и занятия в вашем темпе — онлайн и в '
  'небольших группах.',
  'photo-1438761681033-6461ffad8d80',
  'Онлайн · Киров'),
 ('Дмитрий Орлов',
  'Массажист',
  'Здоровье',
  6,
  'Кировский медицинский колледж, курсы оздоровительного массажа',
  'Расслабляющий массаж,Восстановление,Забота о теле',
  'Бережный оздоровительный массаж для отдыха после насыщенной недели. При медицинских жалобах рекомендую '
  'консультацию врача.',
  'photo-1519085360753-af0119f7cbe7',
  'Киров · ул. Карла Маркса, 18'),
 ('Елена Павлова',
  'Фотограф',
  'Мероприятия',
  10,
  'Школа фотографии, портрет и композиция',
  'Портреты,Семейные съёмки,Мастер-классы',
  'Сохраняю настоящие эмоции в кадре и учу видеть красоту в повседневном. Приглашаю на съёмки и практические '
  'мастер-классы.',
  'photo-1494790108377-be9c29b29330',
  'Киров · студия «Свет»')]

SERVICES = [(1, 'Устранение протечки', 1500, 60, 'Выезд'),
 (1, 'Установка смесителя', 2200, 90, 'Выезд'),
 (2, 'Диагностика электрики', 1800, 60, 'Выезд'),
 (2, 'Установка розетки', 1200, 60, 'Выезд'),
 (3, 'Стрижка и укладка', 2500, 90, 'У специалиста'),
 (3, 'Вечерняя укладка', 2000, 60, 'У специалиста'),
 (4, 'Английский индивидуально', 1600, 60, 'Онлайн'),
 (4, 'Разговорный клуб', 700, 90, 'Группа'),
 (5, 'Расслабляющий массаж', 2800, 60, 'У специалиста'),
 (6, 'Портретная фотосессия', 5000, 60, 'У специалиста'),
 (6, 'Мастер-класс по фотографии', 1200, 120, 'Группа')]

def ensure(connection, key, table, match, values, preferred_id=None):
    """Match old installs by natural key, then use persistent IDs to keep edits.

    The SQL identifiers are constants from this module, never request input.
    Occupied preferred IDs belong to existing data and are not overwritten.
    """
    tracked = connection.execute('SELECT entity_id FROM seed_entities WHERE seed_key=?', (key,)).fetchone()
    if tracked:
        row = connection.execute(f'SELECT id FROM {table} WHERE id=?', (tracked['entity_id'],)).fetchone()
        if row:
            return row['id']
        preferred_id = tracked['entity_id']
    where = ' AND '.join(f'{column} IS ?' for column in match)
    row = connection.execute(f'SELECT id FROM {table} WHERE {where} ORDER BY id LIMIT 1', tuple(match.values())).fetchone()
    if row:
        ident = row['id']
    else:
        values = dict(values() if callable(values) else values)
        if preferred_id is not None and not connection.execute(f'SELECT id FROM {table} WHERE id=?', (preferred_id,)).fetchone():
            values['id'] = preferred_id
        columns = ','.join(values)
        placeholders = ','.join('?' for _ in values)
        ident = connection.execute(f'INSERT INTO {table}({columns}) VALUES({placeholders})', tuple(values.values())).lastrowid
    connection.execute('''INSERT INTO seed_entities(seed_key,table_name,entity_id) VALUES(?,?,?)
        ON CONFLICT(seed_key) DO UPDATE SET table_name=excluded.table_name,entity_id=excluded.entity_id''', (key, table, ident))
    return ident


def initialize_database(connection, current_time):
    connection.executescript(SCHEMA)
    connection.execute('BEGIN IMMEDIATE')
    slot_columns = {row['name'] for row in connection.execute('PRAGMA table_info(slots)')}
    if 'booking_mode' not in slot_columns:
        connection.execute("ALTER TABLE slots ADD COLUMN booking_mode TEXT NOT NULL DEFAULT 'manual'")
    if 'ends_at' not in slot_columns:
        connection.execute('ALTER TABLE slots ADD COLUMN ends_at TEXT')
    migrate_service_moderation(connection)
    migrate_notifications(connection)
    initialize_categories(connection)
    specialist_ids = {}
    for index, person in enumerate(PEOPLE, 1):
        keys = ['name','profession','category','experience','education','skills','bio']
        values = dict(zip(keys, person[:7]))
        values.update(photo=f'/static/photos/{index}.jpg', location=person[8])
        specialist_ids[index] = ensure(connection, f'specialist:{index}', 'specialists',
                                       {'name': person[0], 'profession': person[1]}, values, index)

    user_ids = {}
    users = [('Александра Смирнова', 'client', 'client', None), ('Алексей Морозов', 'master', 'master', 1),
             ('Администратор', 'admin', 'admin', None), ('Анна Лебедева', 'teacher', 'master', 4),
             ('Иван Петров', 'ivan', 'client', None)]
    for name, alias, role, specialist in users:
        email = alias + '@svobodno.demo'
        user_ids[alias] = ensure(connection, f'user:{alias}', 'users', {'email': email},
            lambda: dict(name=name, email=email, role=role, specialist_id=specialist_ids.get(specialist),
                         password=generate_password_hash('Demo2026!')))

    service_ids = {}
    for index, (specialist, title, price, duration, mode) in enumerate(SERVICES, 1):
        values = dict(specialist_id=specialist_ids[specialist], title=title, price=price, duration=duration,
                      mode=mode, category_id=infer_category(title, PEOPLE[specialist - 1][1]))
        service_ids[index] = ensure(connection, f'service:{index}', 'services',
                                    {'specialist_id': values['specialist_id'], 'title': title}, values, index)

    backfill_categories(connection)

    anchor_row = connection.execute("SELECT value FROM seed_meta WHERE name='anchor_date'").fetchone()
    if anchor_row:
        anchor = datetime.fromisoformat(anchor_row['value'])
    else:
        # Legacy installs have no manifest. Reuse their original schedule instead
        # of rolling it forward at every startup. The historical sample has its
        # own marker and must not be mistaken for the first scheduled day.
        ids = tuple(service_ids.values())
        existing = connection.execute(f'''SELECT MIN(s.starts_at) start FROM slots s
            WHERE s.booking_mode='manual' AND s.service_id IN ({','.join('?' for _ in ids)})
              AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.slot_id=s.id
                  AND b.note='Демонстрационная завершённая запись')''', ids).fetchone()['start']
        history = connection.execute(f"""SELECT MIN(s.starts_at) start FROM slots s
            JOIN bookings b ON b.slot_id=s.id
            WHERE s.booking_mode='manual' AND s.service_id IN ({','.join('?' for _ in ids)})
              AND b.note='Демонстрационная завершённая запись'""", ids).fetchone()['start']
        if existing:
            anchor = datetime.fromisoformat(existing) - timedelta(days=1)
        elif history:
            anchor = datetime.fromisoformat(history) + timedelta(days=7)
        else:
            anchor = current_time
        anchor = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
        connection.execute("INSERT INTO seed_meta(name,value) VALUES('anchor_date',?)", (anchor.isoformat(),))

    for index, definition in enumerate(SERVICES, 1):
        specialist, _, _, _, mode = definition
        service_id = service_ids[index]
        hour = 10 if index in [1, 3, 5, 7, 9, 10] else 14
        for day in range(1, 15):
            start = (anchor + timedelta(days=day)).replace(hour=hour).isoformat(timespec='minutes')
            values = dict(specialist_id=specialist_ids[specialist], service_id=service_id,
                          starts_at=start, capacity=6 if mode == 'Группа' else 1)
            ensure(connection, f'slot:{index}:{day}', 'slots', {'service_id': service_id, 'starts_at': start, 'booking_mode': 'manual'}, values)

    for specialist, index in [(1, 1), (3, 5), (4, 7), (5, 9), (6, 10), (2, 3)]:
        start = (anchor - timedelta(days=7)).replace(hour=10).isoformat(timespec='minutes')
        slot_id = ensure(connection, f'history-slot:{index}', 'slots',
                         {'service_id': service_ids[index], 'starts_at': start, 'booking_mode': 'manual'},
                         dict(specialist_id=specialist_ids[specialist], service_id=service_ids[index], starts_at=start, capacity=1))
        user_id = user_ids['client' if specialist == 1 else 'ivan']
        booking_id = ensure(connection, f'history-booking:{index}', 'bookings', {'slot_id': slot_id, 'user_id': user_id},
            dict(user_id=user_id, slot_id=slot_id, quantity=1, address='Киров, ул. Московская, 10',
                 note='Демонстрационная завершённая запись', status='completed', created_at=start, total=SERVICES[index-1][2]))
        if specialist != 1:
            ensure(connection, f'history-review:{index}', 'reviews', {'booking_id': booking_id},
                dict(user_id=user_id, specialist_id=specialist_ids[specialist], booking_id=booking_id, rating=5,
                     content='Всё прошло отлично! Внимательное отношение, пунктуальность и отличный результат. Рекомендую.',
                     status='approved', created_at=start[:10]))
    ensure(connection, 'search:client', 'searches', {'user_id': user_ids['client'], 'query': 'Сантехник'},
           dict(user_id=user_ids['client'], query='Сантехник', created_at=anchor.isoformat(timespec='minutes')))
    connection.execute("INSERT INTO seed_meta(name,value) VALUES('version','1') ON CONFLICT(name) DO UPDATE SET value=excluded.value")
