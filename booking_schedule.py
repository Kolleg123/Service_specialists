"""Weekly availability in the application's local time (Europe/Kirov)."""
import json
import re
from datetime import datetime, time, timedelta

BOOKING_WINDOW_DAYS = 30


def schedule_for(connection, specialist_id):
    row = connection.execute(
        'SELECT * FROM specialist_schedules WHERE specialist_id=?', (specialist_id,)
    ).fetchone()
    return {**dict(row), 'weekdays': json.loads(row['weekdays'])} if row else None


def save_schedule(connection, specialist_id, data):
    mode = data.get('mode')
    if mode == 'manual':
        connection.execute('DELETE FROM specialist_schedules WHERE specialist_id=?', (specialist_id,))
        return
    weekdays = data.get('weekdays')
    if mode not in ('time', 'day') or not isinstance(weekdays, list) or not weekdays or any(
        type(day) is not int or not 1 <= day <= 7 for day in weekdays
    ):
        raise ValueError('Выберите режим записи и рабочие дни')
    opens, closes = data.get('opens_at'), data.get('closes_at')
    lunch_start, lunch_end = data.get('lunch_start'), data.get('lunch_end')
    limit = data.get('daily_limit')

    def clock(value):
        if not isinstance(value, str) or not re.fullmatch(r'\d{2}:\d{2}', value, re.ASCII):
            raise ValueError('Укажите время в формате ЧЧ:ММ')
        try:
            return time.fromisoformat(value)
        except ValueError:
            raise ValueError('Укажите корректные часы работы и обеда') from None

    if clock(opens) >= clock(closes):
        raise ValueError('Окончание работы должно быть позже начала')
    if mode == 'time':
        if lunch_start is not None or lunch_end is not None:
            if not clock(opens) <= clock(lunch_start) < clock(lunch_end) <= clock(closes):
                raise ValueError('Обеденный перерыв должен быть в пределах рабочего дня')
        limit = None
    else:
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError('Дневной лимит должен быть от 1 до 50 записей')
        lunch_start = lunch_end = None
    connection.execute('''INSERT INTO specialist_schedules
        (specialist_id,mode,weekdays,opens_at,closes_at,lunch_start,lunch_end,daily_limit)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(specialist_id) DO UPDATE SET
        mode=excluded.mode,weekdays=excluded.weekdays,opens_at=excluded.opens_at,
        closes_at=excluded.closes_at,lunch_start=excluded.lunch_start,
        lunch_end=excluded.lunch_end,daily_limit=excluded.daily_limit''',
        (specialist_id, mode, json.dumps(sorted(set(weekdays))), opens, closes, lunch_start, lunch_end, limit))


def schedule_windows(schedule, date, duration):
    if date.isoweekday() not in schedule['weekdays'] or duration <= 0:
        return
    opens = datetime.combine(date, time.fromisoformat(schedule['opens_at']))
    closes = datetime.combine(date, time.fromisoformat(schedule['closes_at']))
    if schedule['mode'] == 'day':
        yield opens, closes
        return
    blocks = [(opens, closes)]
    if schedule['lunch_start']:
        blocks = [(opens, datetime.combine(date, time.fromisoformat(schedule['lunch_start']))),
                  (datetime.combine(date, time.fromisoformat(schedule['lunch_end'])), closes)]
    length = timedelta(minutes=duration)
    for start, stop in blocks:
        while start + length <= stop:
            yield start, start + length
            start += length
