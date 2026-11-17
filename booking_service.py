"""Availability and atomic booking creation, independent of Flask.

A slot belongs to a specific service, not to a generic interchangeable start time.
The service duration determines its occupied interval. Both listing and booking
use the same rules; booking repeats them under a SQLite write transaction.
"""
from datetime import datetime, timedelta


class BookingError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def parse_start(value):
    try:
        result = datetime.fromisoformat(value)
        if result.tzinfo is not None:
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise BookingError('Некорректная дата слота. Выберите другое время.', 409) from None


def _rows(connection, specialist_id):
    return connection.execute('''SELECT s.*,v.title service,v.duration,v.price,v.mode,
        s.capacity-COALESCE((SELECT SUM(b.quantity) FROM bookings b
            WHERE b.slot_id=s.id AND b.status='confirmed'),0) remaining
        FROM slots s JOIN services v ON s.service_id=v.id
        JOIN specialists p ON p.id=s.specialist_id
        WHERE s.specialist_id=? AND s.active=1 AND v.active=1 AND p.active=1
        ORDER BY s.starts_at''', (specialist_id,)).fetchall()


def _fits_schedule(connection, slot):
    """Protect against overlapping legacy/imported slots and duration changes."""
    start = parse_start(slot['starts_at'])
    end = start + timedelta(minutes=slot['duration'])
    # An existing *different* slot reserves its full interval, including groups.
    occupied = connection.execute('''SELECT DISTINCT s.starts_at,v.duration
        FROM bookings b JOIN slots s ON s.id=b.slot_id
        JOIN services v ON v.id=s.service_id
        WHERE s.specialist_id=? AND s.id<>? AND b.status='confirmed' ''',
        (slot['specialist_id'], slot['id'])).fetchall()
    return not any(start < parse_start(r['starts_at']) + timedelta(minutes=r['duration'])
                   and end > parse_start(r['starts_at']) for r in occupied)


def available_slots(connection, specialist_id, current_time, service_id=None):
    slots = []
    for row in _rows(connection, specialist_id):
        slot = dict(row)
        if service_id is not None and slot['service_id'] != service_id:
            continue
        try:
            if parse_start(slot['starts_at']) <= current_time:
                continue
            if not _fits_schedule(connection, slot):
                slot['remaining'] = 0
        except BookingError:
            continue  # Broken imported dates must never appear as bookable.
        slots.append(slot)
    return slots


def create_booking(connection, user_id, data, current_time):
    qty = data.get('quantity', 1)
    if type(qty) is not int or not 1 <= qty <= 50:
        raise BookingError('Количество мест должно быть от 1 до 50')
    slot_id = data.get('slot_id')
    if type(slot_id) is not int or slot_id < 1:
        raise BookingError('Укажите корректный слот записи')
    service_id = data.get('service_id')
    if service_id is not None and (type(service_id) is not int or service_id < 1):
        raise BookingError('Укажите корректную услугу')
    address, note = str(data.get('address', '')).strip(), str(data.get('note', '')).strip()
    if len(address) > 250 or len(note) > 1000:
        raise BookingError('Слишком длинный адрес или комментарий')

    # Caller owns the connection/commit. No availability check outside this lock
    # authorizes a reservation: concurrent requests must serialize here.
    connection.execute('BEGIN IMMEDIATE')
    slot = connection.execute('''SELECT s.*,v.mode,v.price,v.duration,
        v.active service_active,p.active specialist_active FROM slots s
        JOIN services v ON v.id=s.service_id JOIN specialists p ON p.id=s.specialist_id
        WHERE s.id=?''', (slot_id,)).fetchone()
    if not slot or not slot['active'] or not slot['service_active'] or not slot['specialist_active']:
        raise BookingError('Это время больше недоступно. Выберите другой слот.', 409)
    if parse_start(slot['starts_at']) <= current_time:
        raise BookingError('Дата записи уже прошла. Выберите другое время.', 409)
    if service_id is not None and service_id != slot['service_id']:
        raise BookingError('Услуга изменилась. Заново выберите дату и время.', 409)
    # Optional snapshot guards keep old clients compatible while protecting the
    # new confirmation screen if a master changes a slot/price during selection.
    for key in ('starts_at', 'duration', 'price'):
        if key in data and data[key] != slot[key]:
            raise BookingError('Условия записи изменились. Проверьте дату, время и цену заново.', 409)
    if not _fits_schedule(connection, slot):
        raise BookingError('Мастер уже занят в этом интервале. Выберите другое время.', 409)
    if slot['mode'] == 'Выезд' and len(address) < 5:
        raise BookingError('Укажите адрес выезда специалиста')
    used = connection.execute('''SELECT COALESCE(SUM(quantity),0) FROM bookings
        WHERE slot_id=? AND status='confirmed' ''', (slot_id,)).fetchone()[0]
    if used + qty > slot['capacity']:
        message = ('Этот слот уже занят. Выберите другое время.' if slot['capacity'] == 1
                   else 'Недостаточно свободных мест в группе. Выберите другое время или количество участников.')
        raise BookingError(message, 409)
    if connection.execute('''SELECT id FROM bookings WHERE slot_id=? AND user_id=?
        AND status='confirmed' ''', (slot_id, user_id)).fetchone():
        raise BookingError('Вы уже записаны на это время', 409)
    return connection.execute('''INSERT INTO bookings
        (user_id,slot_id,quantity,address,note,status,created_at,total)
        VALUES(?,?,?,?,?,'confirmed',?,?)''',
        (user_id, slot_id, qty, address, note, current_time.isoformat(timespec='minutes'), slot['price'] * qty)).lastrowid
