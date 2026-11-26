"""Availability and booking creation under the same SQLite write lock."""
from collections import Counter
from datetime import date, datetime, time, timedelta

from backend.bookings.notifications import notify_booking
from backend.bookings.schedule import BOOKING_WINDOW_DAYS, schedule_for, schedule_windows
from backend.moderation.services import PUBLIC_SERVICE


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


def slot_interval(slot):
    start = parse_start(slot['starts_at'])
    end = parse_start(slot['ends_at']) if slot['ends_at'] else start + timedelta(minutes=slot['duration'])
    return start, end


def _occupied(connection, specialist_id):
    return connection.execute('''SELECT s.id,s.starts_at,s.ends_at,s.booking_mode,v.duration
        FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN services v ON v.id=s.service_id
        WHERE s.specialist_id=? AND b.status='confirmed' GROUP BY s.id''', (specialist_id,)).fetchall()


def _occupied_intervals(connection, specialist_id):
    intervals = []
    for row in _occupied(connection, specialist_id):
        start, end = slot_interval(row)
        if row['booking_mode'] == 'day':
            start = datetime.combine(start.date(), time.min)
            end = start + timedelta(days=1)
        intervals.append((row['id'], start, end))
    return intervals


def _free(intervals, start, end, shared_slot=None):
    return all(ident == shared_slot or start >= busy_end or end <= busy_start
               for ident, busy_start, busy_end in intervals)


def _daily_usage(connection, specialist_id):
    days = connection.execute('''SELECT substr(s.starts_at,1,10) day
        FROM bookings b JOIN slots s ON s.id=b.slot_id
        WHERE s.specialist_id=? AND b.status IN ('confirmed','completed')''', (specialist_id,))
    return Counter(row['day'] for row in days)


def _services(connection, specialist_id, service_id):
    return connection.execute(f'''SELECT v.* FROM services v JOIN specialists p ON p.id=v.specialist_id
        WHERE p.id=? AND {PUBLIC_SERVICE} AND (? IS NULL OR v.id=?) ORDER BY v.id''',
        (specialist_id, service_id, service_id)).fetchall()


def _scheduled_slots(connection, schedule, services, current_time, requested_day=None):
    specialist_id = schedule['specialist_id']
    mode = schedule['mode']
    intervals = _occupied_intervals(connection, specialist_id) if mode == 'time' else ()
    usage = _daily_usage(connection, specialist_id) if mode == 'day' else {}
    first_day = current_time.date()
    last_day = first_day + timedelta(days=BOOKING_WINDOW_DAYS - 1)
    if requested_day is not None and not first_day <= requested_day <= last_day:
        return
    days = [requested_day] if requested_day else (first_day + timedelta(days=d) for d in range(BOOKING_WINDOW_DAYS))
    for day in days:
        date_key = day.isoformat()
        remaining = schedule['daily_limit'] - usage.get(date_key, 0) if mode == 'day' else 1
        if remaining <= 0:
            continue
        slots = []
        for service in services:
            for start, end in schedule_windows(schedule, day, service['duration']):
                if start <= current_time or not _free(intervals, start, end):
                    continue
                slots.append(dict(id=None, specialist_id=specialist_id, service_id=service['id'],
                           service=service['title'], starts_at=start.isoformat(timespec='minutes'),
                           ends_at=end.isoformat(timespec='minutes'), date=date_key, booking_mode=mode,
                           capacity=1, active=1, remaining=remaining, mode=service['mode'],
                           price=service['price'], duration=service['duration']))
        yield from sorted(slots, key=lambda slot: slot['starts_at'])


def _manual_slots(connection, specialist_id, current_time, service_id):
    rows = connection.execute(f'''SELECT s.*,v.title service,v.duration,v.price,v.mode,
        s.capacity-COALESCE((SELECT SUM(b.quantity) FROM bookings b
            WHERE b.slot_id=s.id AND b.status='confirmed'),0) remaining
        FROM slots s JOIN services v ON s.service_id=v.id
        JOIN specialists p ON p.id=s.specialist_id
        WHERE s.specialist_id=? AND s.booking_mode='manual' AND s.active=1 AND {PUBLIC_SERVICE}
          AND (? IS NULL OR v.id=?) ORDER BY s.starts_at''', (specialist_id, service_id, service_id))
    intervals = None
    for row in rows:
        try:
            if intervals is None:
                intervals = _occupied_intervals(connection, specialist_id)
            start, end = slot_interval(row)
            if start <= current_time:
                continue
            slot = dict(row)
            if not _free(intervals, start, end, shared_slot=slot['id']):
                slot['remaining'] = 0
            yield slot
        except BookingError:
            continue


def available_slots(connection, specialist_id, current_time, service_id=None):
    schedule = schedule_for(connection, specialist_id)
    if schedule is None:
        return _manual_slots(connection, specialist_id, current_time, service_id)
    services = _services(connection, specialist_id, service_id)
    return _scheduled_slots(connection, schedule, services, current_time) if services else iter(())


def _select_scheduled_slot(connection, service_id, data, current_time):
    try:
        day = date.fromisoformat(data.get('date'))
        if day.isoformat() != data['date']:
            raise ValueError
    except (TypeError, ValueError):
        raise BookingError('Укажите дату в формате ГГГГ-ММ-ДД') from None
    mode = data['booking_mode']
    specialist = connection.execute('SELECT specialist_id FROM services WHERE id=?', (service_id,)).fetchone()
    if specialist:
        specialist_id = specialist['specialist_id']
        schedule = schedule_for(connection, specialist_id)
        if schedule and schedule['mode'] == mode:
            services = _services(connection, specialist_id, service_id)
            for slot in _scheduled_slots(connection, schedule, services, current_time, day):
                if mode == 'day' or data.get('starts_at') == slot['starts_at']:
                    return slot
    raise BookingError('Выбранная дата или время больше недоступны. Обновите расписание.', 409)


def _persist_slot(connection, slot):
    keys = ('specialist_id', 'service_id', 'booking_mode', 'starts_at', 'ends_at')
    values = tuple(slot[key] for key in keys)
    existing = connection.execute('''SELECT id FROM slots WHERE specialist_id=? AND service_id=?
        AND booking_mode=? AND starts_at=? AND ends_at=?''', values).fetchone()
    if existing:
        return existing['id']
    return connection.execute('''INSERT INTO slots
        (specialist_id,service_id,booking_mode,starts_at,ends_at,capacity) VALUES(?,?,?,?,?,1)''', values).lastrowid


def create_booking(connection, user_id, data, clock):
    # The caller holds a write transaction across replay lookup, capacity and notifications.
    qty = data.get('quantity', 1)
    if type(qty) is not int or not 1 <= qty <= 50:
        raise BookingError('Количество мест должно быть от 1 до 50')
    mode = data.get('booking_mode', 'manual')
    if mode not in ('manual', 'time', 'day'):
        raise BookingError('Неизвестный режим записи')
    slot_id, service_id = data.get('slot_id'), data.get('service_id')
    if mode == 'manual' and (type(slot_id) is not int or not 1 <= slot_id < 2**63):
        raise BookingError('Укажите корректный слот записи')
    if (mode != 'manual' or service_id is not None) and (type(service_id) is not int or not 1 <= service_id < 2**63):
        raise BookingError('Укажите корректную услугу')
    address, note = str(data.get('address', '')).strip(), str(data.get('note', '')).strip()
    if len(address) > 250 or len(note) > 1000:
        raise BookingError('Слишком длинный адрес или комментарий')

    user = connection.execute("SELECT specialist_id FROM users WHERE id=? AND role IN ('client','master')",
                              (user_id,)).fetchone()
    if not user:
        raise BookingError('Войдите в личный кабинет', 401)
    current_time = clock()
    if mode == 'manual':
        slot = connection.execute(f'''SELECT s.*,v.mode,v.price,v.duration FROM slots s
            JOIN services v ON v.id=s.service_id JOIN specialists p ON p.id=s.specialist_id
            WHERE s.id=? AND s.active=1 AND s.booking_mode='manual' AND {PUBLIC_SERVICE}''',
            (slot_id,)).fetchone()
        if not slot or schedule_for(connection, slot['specialist_id']) is not None:
            raise BookingError('Это время больше недоступно. Выберите другой слот.', 409)
        start, end = slot_interval(slot)
        if start <= current_time:
            raise BookingError('Дата записи уже прошла. Выберите другое время.', 409)
        if service_id is not None and service_id != slot['service_id']:
            raise BookingError('Услуга изменилась. Заново выберите дату и время.', 409)
        if not _free(_occupied_intervals(connection, slot['specialist_id']), start, end, shared_slot=slot_id):
            raise BookingError('Мастер уже занят в этом интервале. Выберите другое время.', 409)
    else:
        if qty != 1:
            raise BookingError('По рабочему расписанию доступно одно место на запись')
        slot = _select_scheduled_slot(connection, service_id, data, current_time)
        if mode == 'day' and connection.execute('''SELECT 1 FROM bookings b JOIN slots s ON s.id=b.slot_id
            WHERE b.user_id=? AND b.status='confirmed' AND s.service_id=? AND substr(s.starts_at,1,10)=?''',
            (user_id, service_id, slot['date'])).fetchone():
            raise BookingError('Вы уже записаны на эту услугу на выбранную дату', 409)

    if user['specialist_id'] == slot['specialist_id']:
        raise BookingError('Записаться на собственную услугу нельзя', 403)
    for key in ('starts_at', 'ends_at', 'duration', 'price'):
        if key in data and data[key] != slot[key]:
            raise BookingError('Условия записи изменились. Проверьте дату, время и цену заново.', 409)
    if slot['mode'] == 'Выезд' and len(address) < 5:
        raise BookingError('Укажите адрес выезда специалиста')
    if mode == 'manual':
        used = connection.execute('''SELECT COALESCE(SUM(quantity),0) FROM bookings
            WHERE slot_id=? AND status='confirmed' ''', (slot_id,)).fetchone()[0]
        if used + qty > slot['capacity']:
            message = ('Этот слот уже занят. Выберите другое время.' if slot['capacity'] == 1
                       else 'Недостаточно свободных мест в группе. Выберите другое время или количество участников.')
            raise BookingError(message, 409)
        if connection.execute('''SELECT 1 FROM bookings WHERE slot_id=? AND user_id=?
            AND status='confirmed' ''', (slot_id, user_id)).fetchone():
            raise BookingError('Вы уже записаны на это время', 409)
    else:
        slot_id = _persist_slot(connection, slot)
    booking_id = connection.execute('''INSERT INTO bookings
        (user_id,slot_id,quantity,address,note,status,created_at,total)
        VALUES(?,?,?,?,?,'confirmed',?,?)''',
        (user_id, slot_id, qty, address, note, current_time.isoformat(timespec='minutes'), slot['price'] * qty)).lastrowid
    notify_booking(connection, booking_id, 'confirmed', current_time)
    return booking_id
