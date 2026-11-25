"""Applications for a professional profile, separate from service moderation."""
from backend.database.service_categories import profile_group
from backend.moderation.services import ModerationError


TEXT_FIELDS = {
    'name': ('Имя', 2, 80),
    'profession': ('Профессия', 2, 100),
    'education': ('Образование', 2, 500),
    'skills': ('Профессиональные навыки', 2, 500),
    'bio': ('Информация о себе', 2, 1500),
    'location': ('Место оказания услуг', 2, 250),
}
PROFILE_FIELDS = (*TEXT_FIELDS, 'category', 'experience', 'category_group_id')


def submit_application(connection, user_id, data, clock):
    values = {}
    for key, (label, minimum, maximum) in TEXT_FIELDS.items():
        value = data.get(key)
        if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
            raise ModerationError(f'{label}: укажите от {minimum} до {maximum} символов')
        values[key] = value.strip()
    category, experience = data.get('category'), data.get('experience')
    if type(experience) is not int or not 0 <= experience <= 80:
        raise ModerationError('Укажите стаж от 0 до 80 полных лет')
    connection.execute('BEGIN IMMEDIATE')
    group = profile_group(connection, category)
    if not group:
        raise ModerationError('Выберите категорию из каталога')
    label = connection.execute('SELECT name FROM service_categories WHERE id=?', (group,)).fetchone()[0]
    values.update(category=label if category == group else category, experience=experience, category_group_id=group)

    user = connection.execute('SELECT role,specialist_id FROM users WHERE id=?', (user_id,)).fetchone()
    if not user or user['role'] != 'client' or user['specialist_id'] is not None:
        raise ModerationError('Заявку может подать клиент без профиля специалиста', 403)
    if connection.execute("""SELECT 1 FROM specialist_applications
            WHERE user_id=? AND status='pending'""", (user_id,)).fetchone():
        raise ModerationError('У вас уже есть заявка на рассмотрении', 409)

    connection.execute('''INSERT INTO specialist_applications
        (user_id,name,profession,education,skills,bio,location,category,experience,category_group_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (user_id, *(values[key] for key in PROFILE_FIELDS), clock().isoformat(timespec='seconds')))
    return latest_application(connection, user_id)


def latest_application(connection, user_id):
    row = connection.execute('SELECT * FROM specialist_applications WHERE user_id=? ORDER BY id DESC LIMIT 1',
                             (user_id,)).fetchone()
    return dict(row) if row else None


def decide_application(connection, application_id, data, clock):
    status = data.get('status')
    if status not in ('approved', 'rejected'):
        raise ModerationError('Выберите решение: одобрить или отклонить')
    reason = None
    if status == 'rejected':
        value = data.get('reason')
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 500:
            raise ModerationError('Укажите причину отклонения от 1 до 500 символов')
        reason = value.strip()

    connection.execute('BEGIN IMMEDIATE')
    application = connection.execute('''SELECT a.*,u.role,u.specialist_id FROM specialist_applications a
        JOIN users u ON u.id=a.user_id WHERE a.id=?''', (application_id,)).fetchone()
    if not application:
        raise ModerationError('Заявка не найдена', 404)
    if application['status'] != 'pending':
        raise ModerationError('По этой заявке уже принято решение', 409)

    user_id = application['user_id']
    if status == 'approved':
        if application['role'] != 'client' or application['specialist_id'] is not None:
            raise ModerationError('Учётная запись уже имеет профиль или другую роль', 409)
        specialist_id = connection.execute('''INSERT INTO specialists
            (name,profession,education,skills,bio,location,category,experience,category_group_id,photo)
            VALUES(?,?,?,?,?,?,?,?,?,?)''',
            (*(application[key] for key in PROFILE_FIELDS), '/static/favicon.svg')).lastrowid
        connection.execute("UPDATE users SET role='master',specialist_id=? WHERE id=?", (specialist_id, user_id))
        message = 'Заявка одобрена. В личном кабинете доступен режим «Специалист».'
    else:
        message = f'Заявка на статус специалиста отклонена. Причина: {reason}'

    timestamp = clock().isoformat(timespec='seconds')
    connection.execute('UPDATE specialist_applications SET status=?,reason=?,decided_at=? WHERE id=?',
                       (status, reason, timestamp, application_id))
    connection.execute('''INSERT INTO notifications(user_id,specialist_application_id,event,message,created_at)
        VALUES(?,?,?,?,?)''', (user_id, application_id, f'specialist_{status}', message, timestamp))
