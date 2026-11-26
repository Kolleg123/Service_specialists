"""Create inbox notifications inside the caller's booking transaction."""
from datetime import datetime


MESSAGES = {
    'confirmed': ('Запись подтверждена', 'Новая запись клиента'),
    'cancelled': ('Запись отменена', 'Запись отменена'),
    'completed': ('Встреча завершена', None),
}


def notify_booking(connection, booking_id, event, current_time):
    booking = connection.execute('''SELECT b.user_id,u.role,b.cancel_reason,s.specialist_id,s.starts_at,s.booking_mode,v.title
        FROM bookings b JOIN users u ON u.id=b.user_id JOIN slots s ON s.id=b.slot_id
        JOIN services v ON v.id=s.service_id WHERE b.id=?''', (booking_id,)).fetchone()
    client_message, master_message = MESSAGES[event]
    recipients = [] if booking['role'] == 'deleted' else [(booking['user_id'], client_message)]
    if master_message:
        masters = connection.execute(
            "SELECT id FROM users WHERE role='master' AND specialist_id=?",
            (booking['specialist_id'],))
        recipients.extend((master['id'], master_message) for master in masters)

    starts = datetime.fromisoformat(booking['starts_at'])
    when = f'{starts:%d.%m.%Y}' if booking['booking_mode'] == 'day' else f'{starts:%d.%m.%Y %H:%M}'
    details = f" — {booking['title']}, {when}"
    if event == 'cancelled' and booking['cancel_reason']:
        details += f". Причина: {booking['cancel_reason']}"
    created_at = current_time.isoformat(timespec='seconds')
    connection.executemany('''INSERT INTO notifications(user_id,booking_id,event,message,created_at)
        VALUES(?,?,?,?,?) ON CONFLICT(user_id,booking_id,event) DO NOTHING''',
        [(user_id, booking_id, event, message + details,
          created_at) for user_id, message in recipients])
