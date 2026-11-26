"""Public visibility and moderation of new services and edits."""
import json
import re


PUBLIC_SERVICE = "p.active=1 AND v.active=1 AND v.deleted=0 AND v.moderation_status='approved'"
FIELDS = ('title', 'price', 'duration', 'mode', 'category_id')
CONTACT_FIELDS = ('service_address', 'contact_phone', 'contact_instructions')
PUBLIC_DETAILS = """v.service_address,
    (v.contact_phone IS NOT NULL OR v.contact_instructions IS NOT NULL) AS has_contact"""


class ModerationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def service_fields(connection, data, existing=None):
    title, price, duration, mode, category_id = (data.get(key) for key in FIELDS)
    if (not isinstance(title, str) or not 3 <= len(title.strip()) <= 100
            or type(price) is not int or not 0 <= price <= 1000000
            or type(duration) is not int or not 15 <= duration <= 480
            or mode not in ('Выезд', 'У специалиста', 'Онлайн', 'Группа')):
        raise ModerationError('Проверьте название, формат, стоимость и длительность (15–480 минут)')
    if not isinstance(category_id, str) or not category_id.isascii() or not connection.execute(
            'SELECT 1 FROM service_categories WHERE id=? AND parent_id IS NOT NULL AND archived=0', (category_id,)
    ).fetchone():
        raise ModerationError('Выберите категорию услуги из справочника')
    fields = dict(zip(FIELDS, (title.strip(), price, duration, mode, category_id)))
    previous = existing or {}
    for key, label, limit in (
        ('service_address', 'адрес оказания услуги', 250),
        ('contact_phone', 'контактный телефон', 32),
        ('contact_instructions', 'инструкции для клиента', 1000),
    ):
        value = data.get(key, previous.get(key))
        if value is not None and (not isinstance(value, str) or len(value.strip()) > limit):
            raise ModerationError(f'Проверьте поле «{label}» (до {limit} символов)')
        fields[key] = (value.strip() or None) if value is not None else None

    address = fields['service_address']
    if mode not in ('У специалиста', 'Группа'):
        fields['service_address'] = None
    elif (address and len(address) < 5 or
          mode == 'У специалиста' and not address and (
              'service_address' in data or previous.get('mode') != mode)):
        raise ModerationError('Укажите адрес оказания услуги (от 5 до 250 символов)')
    phone = fields['contact_phone']
    if phone and (not re.fullmatch(r'\+?[0-9][0-9 ().-]*', phone)
                  or not 7 <= sum(char.isdigit() for char in phone) <= 15):
        raise ModerationError('Укажите корректный контактный телефон (от 7 до 15 цифр)')
    return fields


def service_details(row):
    result = dict(row)
    draft = json.loads(row['draft']) if row['draft'] else None
    if draft is not None:
        for key in CONTACT_FIELDS:
            draft.setdefault(key, result[key])
    result['draft'] = draft
    return result


def manage_service(connection, specialist_id, service_id, data, action, clock):
    connection.execute('BEGIN IMMEDIATE')
    service = connection.execute('SELECT * FROM services WHERE id=? AND specialist_id=? AND deleted=0',
                                 (service_id, specialist_id)).fetchone()
    if not service:
        raise ModerationError('Услуга не найдена', 404)
    if action == 'delete':
        if data.get('confirm') is not True:
            raise ModerationError('Подтвердите удаление услуги')
        if 'upcoming_count' in data:
            count = connection.execute('''SELECT count(*) FROM bookings b JOIN slots s ON s.id=b.slot_id
                WHERE s.service_id=? AND b.status='confirmed' AND s.starts_at>?''',
                                       (service_id, clock().isoformat(timespec='minutes'))).fetchone()[0]
            if type(data['upcoming_count']) is not int or data['upcoming_count'] != count:
                raise ModerationError('Количество предстоящих записей изменилось. Откройте подтверждение заново.', 409)
        connection.execute('UPDATE services SET deleted=1,active=0,revision=revision+1 WHERE id=?',
                           (service_id,))
        return
    current = service_details(service)
    fields = service_fields(connection, data, current['draft'] or current)
    if service['moderation_status'] == 'approved':
        connection.execute("""UPDATE services SET draft=?,draft_status='pending',draft_reason=NULL,
            revision=revision+1 WHERE id=?""", (json.dumps(fields, ensure_ascii=False), service_id))
    else:
        if (fields['duration'], fields['mode']) != (service['duration'], service['mode']):
            connection.execute("UPDATE slots SET active=0 WHERE service_id=? AND booking_mode='manual'",
                               (service_id,))
        connection.execute("""UPDATE services SET title=?,price=?,duration=?,mode=?,category_id=?,
            service_address=?,contact_phone=?,contact_instructions=?,
            moderation_status='pending',moderation_reason=NULL,revision=revision+1 WHERE id=?""",
                           (*fields.values(), service_id))


def decide_service(connection, service_id, data, clock):
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
    row = connection.execute('SELECT * FROM services WHERE id=? AND deleted=0', (service_id,)).fetchone()
    if not row:
        raise ModerationError('Услуга не найдена', 404)

    service = service_details(row)
    is_edit = service['draft'] is not None
    current_status = service['draft_status'] if is_edit else service['moderation_status']
    current_reason = service['draft_reason'] if is_edit else service['moderation_reason']
    revision = data.get('revision', 0)
    if type(revision) is not int or revision != service['revision']:
        raise ModerationError('Заявка изменилась. Обновите список перед рассмотрением.', 409)
    if current_status != 'pending':
        if current_status == status and current_reason == reason:
            return service
        raise ModerationError('По этой услуге уже принято решение', 409)

    fields = service['draft'] if is_edit else service
    if not is_edit:
        connection.execute('UPDATE services SET moderation_status=?,moderation_reason=? WHERE id=?',
                           (status, reason, service_id))
    elif status == 'approved':
        if (fields['duration'], fields['mode']) != (service['duration'], service['mode']):
            # Freeze old manual intervals for booking history and retire obsolete slots.
            connection.execute("""UPDATE slots SET active=0,ends_at=COALESCE(ends_at,
                strftime('%Y-%m-%dT%H:%M', starts_at, '+' || ? || ' minutes'))
                WHERE service_id=? AND booking_mode='manual'""", (service['duration'], service_id))
        connection.execute("""UPDATE services SET title=?,price=?,duration=?,mode=?,category_id=?,
            service_address=?,contact_phone=?,contact_instructions=?,
            draft=NULL,draft_status=NULL,draft_reason=NULL WHERE id=?""",
                           (*(fields[key] for key in (*FIELDS, *CONTACT_FIELDS)), service_id))
    else:
        connection.execute("UPDATE services SET draft_status='rejected',draft_reason=? WHERE id=?",
                           (reason, service_id))

    subject = 'Изменения услуги' if is_edit else 'Услуга'
    decision = ('одобрены' if status == 'approved' else 'отклонены') if is_edit else (
        'одобрена' if status == 'approved' else 'отклонена')
    message = f"{subject} «{fields['title']}» {decision}"
    if reason:
        message += f'. Причина: {reason}'
    connection.execute('''INSERT INTO notifications(user_id,service_id,event,message,created_at)
        SELECT id,?,?,?,? FROM users WHERE role='master' AND specialist_id=?''',
        (service_id, f'service_{status}', message, clock().isoformat(timespec='seconds'), service['specialist_id']))
    return service_details(connection.execute('SELECT * FROM services WHERE id=?', (service_id,)).fetchone())
