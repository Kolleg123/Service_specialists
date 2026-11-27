"""Idempotent reminder scheduling for upcoming confirmed bookings."""
from datetime import timedelta
from backend.notifications_delivery import enqueue


def schedule_reminders(connection, current_time, lead_minutes=(1440, 60)):
    window_end = current_time + timedelta(days=2)
    rows = connection.execute("""SELECT b.id,b.user_id,s.starts_at,b.status,v.title
        FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id
        WHERE b.status='confirmed' AND s.starts_at>? AND s.starts_at<=?
        ORDER BY s.starts_at""", (current_time.isoformat(timespec='minutes'), window_end.isoformat(timespec='minutes'))).fetchall()
    created = 0
    for booking in rows:
        from datetime import datetime
        start = datetime.fromisoformat(booking[2])
        for minutes in lead_minutes:
            due = start - timedelta(minutes=minutes)
            if due <= current_time:
                continue
            kind = f'reminder_{minutes}m'
            key = f'booking:{booking[0]}:{kind}'
            before = connection.total_changes
            enqueue(connection, key, booking[1], kind,
                    f'Напоминание о записи: {booking[4]} — {start:%d.%m.%Y %H:%M}',
                    due.isoformat(timespec='minutes'), booking_id=booking[0])
            created += connection.total_changes - before
    return created
