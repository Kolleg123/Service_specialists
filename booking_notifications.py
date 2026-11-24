"""Create inbox notifications inside the caller's booking transaction."""
from datetime import datetime


MESSAGES = {
    'confirmed': ('Запись подтверждена', 'Новая запись клиента'),
    'cancelled': ('Запись отменена', 'Запись отменена'),
    'completed': ('Встреча завершена', None),
}


def notify_booking(connection, booking_id, event, current_time):
    booking = connection.execute('''SELECT b.user_id,s.specialist_id,s.starts_at,v.title
        FROM bookings b JOIN slots s ON s.id=b.slot_id
        JOIN services v ON v.id=s.service_id WHERE b.id=?''', (booking_id,)).fetchone()
    client_message, master_message = MESSAGES[event]
    recipients = [(booking['user_id'], client_message)]
    if master_message:
        masters = connection.execute(
            "SELECT id FROM users WHERE role='master' AND specialist_id=?",
            (booking['specialist_id'],))
        recipients.extend((master['id'], master_message) for master in masters)

    starts = datetime.fromisoformat(booking['starts_at'])
    created_at = current_time.isoformat(timespec='seconds')
    connection.executemany('''INSERT INTO notifications(user_id,booking_id,event,message,created_at)
        VALUES(?,?,?,?,?) ON CONFLICT(user_id,booking_id,event) DO NOTHING''',
        [(user_id, booking_id, event, f"{message} — {booking['title']}, {starts:%d.%m.%Y %H:%M}",
          created_at) for user_id, message in recipients])
