"""Public visibility and the one-time decision on a service application."""

# Queries using this rule alias services as v and specialists as p.
PUBLIC_SERVICE = "p.active=1 AND v.active=1 AND v.moderation_status='approved'"


class ModerationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


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
    service = connection.execute('SELECT * FROM services WHERE id=?', (service_id,)).fetchone()
    if not service:
        raise ModerationError('Услуга не найдена', 404)
    if service['moderation_status'] != 'pending':
        if service['moderation_status'] == status and service['moderation_reason'] == reason:
            return dict(service)
        raise ModerationError('По этой услуге уже принято решение', 409)

    connection.execute('UPDATE services SET moderation_status=?,moderation_reason=? WHERE id=?',
                       (status, reason, service_id))
    message = f"Услуга «{service['title']}» одобрена" if status == 'approved' else (
        f"Услуга «{service['title']}» отклонена. Причина: {reason}"
    )
    connection.execute('''INSERT INTO notifications(user_id,service_id,event,message,created_at)
        SELECT id,?,?,?,? FROM users WHERE role='master' AND specialist_id=?''',
        (service_id, f'service_{status}', message, clock().isoformat(timespec='seconds'), service['specialist_id']))
    return {**dict(service), 'moderation_status': status, 'moderation_reason': reason}
