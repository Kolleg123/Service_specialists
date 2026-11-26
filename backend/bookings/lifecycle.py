"""Shared server-side state, action permissions and atomic booking transitions."""
from datetime import timedelta

from backend.bookings.notifications import notify_booking
from backend.bookings.service import BookingError, parse_start
from backend.audit import audit


CUSTOMER_ROLES = ('client', 'master')


def booking_interval(booking):
    start = parse_start(booking['starts_at'])
    return start, (parse_start(booking['slot_ends_at']) if booking['slot_ends_at']
                   else start + timedelta(minutes=booking['duration']))


def booking_policy(booking, user, current_time, has_review=False):
    start, end = booking_interval(booking)
    status = booking['status']
    if status == 'confirmed':
        phase = 'upcoming' if current_time < start else 'in_progress' if current_time < end else 'awaiting_completion'
    else:
        phase = status
    labels = {'upcoming': 'Предстоит', 'in_progress': 'Идёт встреча',
              'awaiting_completion': 'Ожидает завершения', 'completed': 'Завершена', 'cancelled': 'Отменена'}
    owner = user['role'] in CUSTOMER_ROLES and booking['user_id'] == user['id']
    assigned = user['role'] == 'master' and booking['specialist_id'] == user['specialist_id']
    can_manage = owner or assigned or user['role'] == 'admin'
    can_cancel = can_manage and status == 'confirmed' and current_time < start
    can_complete = assigned and status == 'confirmed' and current_time >= end
    can_review = owner and status == 'completed' and current_time >= end and not has_review
    reasons = {}
    if can_manage and not can_cancel and status == 'confirmed':
        reasons['cancel'] = 'Отмена доступна только до начала встречи.'
    if assigned and not can_complete:
        reasons['complete'] = (f'Завершение доступно с {end:%d.%m.%Y %H:%M} (Киров, UTC+3).'
                               if status == 'confirmed' else 'Завершить можно только активную запись.')
    if owner and not can_review:
        reasons['review'] = ('Отзыв уже отправлен.' if has_review else 'Для отменённой записи отзыв недоступен.'
                             if status == 'cancelled' else 'Отзыв доступен после окончания услуги и подтверждения завершения мастером.')
    return {'phase': phase, 'status_label': labels.get(phase, status),
            'ends_at': end.isoformat(timespec='seconds'),
            'actions': {'cancel': can_cancel, 'complete': can_complete, 'review': can_review},
            'action_reasons': reasons}


def cancellation_reason(data):
    reason = data.get('reason', '')
    if not isinstance(reason, str) or len(reason.strip()) > 500:
        raise BookingError('Причина отмены должна содержать не более 500 символов')
    return reason.strip() or None


def upcoming_master_bookings(connection, user, current_time):
    rows = connection.execute("""SELECT b.id,s.starts_at FROM bookings b JOIN slots s ON s.id=b.slot_id
        WHERE s.specialist_id=? AND b.status='confirmed' ORDER BY b.id""", (user['specialist_id'],))
    return [row['id'] for row in rows if parse_start(row['starts_at']) > current_time]


def store_transition(connection, booking_id, target, current_time, reason=None, actor_id=None):
    before = connection.execute('SELECT status,cancel_reason FROM bookings WHERE id=?', (booking_id,)).fetchone()
    changed = connection.execute("""UPDATE bookings SET status=?,cancel_reason=?
        WHERE id=? AND status='confirmed'""", (target, reason, booking_id)).rowcount
    if changed != 1:
        raise BookingError('Статус записи изменился. Обновите список.', 409)
    if actor_id is not None:
        audit(connection, actor_id, 'booking_transition', 'booking', booking_id,
              dict(before) if before else None, {'status': target, 'cancel_reason': reason}, reason)
    notify_booking(connection, booking_id, target, current_time)


def transition_booking(connection, user, booking_id, action, clock, reason=None):
    # Reading status and updating it must be one serialized transaction, including
    # duplicate or concurrent requests. Terminal states are never reopened.
    connection.execute('BEGIN IMMEDIATE')
    if not 1 <= booking_id < 2**63:
        raise BookingError('Запись не найдена', 404)
    booking = connection.execute('''SELECT b.*,s.starts_at,s.ends_at slot_ends_at,s.specialist_id,v.duration
        FROM bookings b JOIN slots s ON s.id=b.slot_id
        JOIN services v ON v.id=s.service_id WHERE b.id=?''', (booking_id,)).fetchone()
    if not booking:
        raise BookingError('Запись не найдена', 404)
    if action == 'complete':
        if user['role'] != 'master':
            raise BookingError('Недостаточно прав', 403)
        if booking['specialist_id'] != user['specialist_id']:
            raise BookingError('Запись не найдена', 404)
    elif action == 'cancel':
        if not (user['role'] == 'admin' or user['role'] in CUSTOMER_ROLES and booking['user_id'] == user['id']
                or user['role'] == 'master' and booking['specialist_id'] == user['specialist_id']):
            raise BookingError('Недостаточно прав', 403)
    else:
        raise BookingError('Неизвестное действие')
    current_time = clock()
    policy = booking_policy(booking, user, current_time)
    if not policy['actions'][action]:
        reason = policy['action_reasons'].get(action, 'Можно отменить только предстоящую активную запись.')
        raise BookingError(reason, 409)
    target = 'completed' if action == 'complete' else 'cancelled'
    if not (action == 'cancel' and user['role'] == 'master' and user['specialist_id'] == booking['specialist_id']):
        reason = None
    store_transition(connection, booking_id, target, current_time, reason, user['id'])
