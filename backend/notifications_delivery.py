"""Durable external notification delivery with a test adapter and safe retries."""
import json
import os
import urllib.request
from datetime import timedelta


MAX_ATTEMPTS = 5


class DeliveryError(Exception):
    pass


class TestNotificationAdapter:
    def __init__(self, sink=None):
        self.sink = sink or os.environ.get('TEST_NOTIFICATION_SINK', '')

    def send(self, payload):
        if self.sink:
            with open(self.sink, 'a', encoding='utf-8') as stream:
                stream.write(json.dumps(payload, ensure_ascii=False) + '\n')
        return True


class WebhookNotificationAdapter:
    def __init__(self, url):
        self.url = url

    def send(self, payload):
        if not self.url:
            raise DeliveryError('Внешний канал не настроен')
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(
            self.url, data=body,
            headers={'Content-Type': 'application/json', 'User-Agent': 'ServiceSpecialists/1.0'},
            method='POST')
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                if not 200 <= response.status < 300:
                    raise DeliveryError(f'HTTP {response.status}')
        except Exception as error:
            raise DeliveryError(str(error)) from error
        return True


def adapter():
    if os.environ.get('NOTIFICATION_ADAPTER', 'test').lower() == 'webhook':
        return WebhookNotificationAdapter(os.environ.get('NOTIFICATION_WEBHOOK_URL', ''))
    return TestNotificationAdapter()


def enqueue(connection, event_key, recipient_id, event, message, created_at, booking_id=None):
    if hasattr(created_at, 'isoformat'):
        created_at = created_at.isoformat()
    payload = {'event_key': event_key, 'recipient_id': recipient_id, 'event': event, 'message': message}
    connection.execute(
        """INSERT INTO outgoing_notifications
           (event_key,recipient_id,booking_id,event,payload,status,attempts,next_attempt_at,created_at)
           VALUES(?,?,?,?,?,'pending',0,?,?)
           ON CONFLICT(event_key) DO NOTHING""",
        (event_key, recipient_id, booking_id, event, json.dumps(payload, ensure_ascii=False),
         created_at, created_at)
    )


def deliver_pending(connection, current_time, limit=50):
    rows = connection.execute(
        """SELECT * FROM outgoing_notifications
           WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?))
           ORDER BY id LIMIT ?""", (current_time.isoformat(), limit)).fetchall()
    sent = failed = 0
    for row in rows:
        try:
            adapter().send(json.loads(row[5]))
            connection.execute(
                """UPDATE outgoing_notifications
                   SET status='delivered',delivered_at=?,last_error=NULL WHERE id=?""",
                (current_time.isoformat(), row[0]))
            sent += 1
        except Exception as error:
            attempts = row[7] + 1
            status = 'failed' if attempts >= MAX_ATTEMPTS else 'retry'
            delay = min(60 * (2 ** max(attempts - 1, 0)), 3600)
            next_time = (current_time + timedelta(seconds=delay)).isoformat(timespec='seconds')
            connection.execute(
                """UPDATE outgoing_notifications
                   SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?""",
                (status, attempts, next_time, str(error)[:500], row[0]))
            failed += 1
    return {'sent': sent, 'failed': failed, 'processed': sent + failed}


def enqueue_reminder(connection, reminder, booking, current_time):
    starts = booking['starts_at']
    message = f"Напоминание о записи: {booking['title']} — {starts}"
    event_key = f"booking:{booking['id']}:{reminder['kind']}"
    enqueue(connection, event_key, booking['user_id'], reminder['kind'], message, current_time,
            booking_id=booking['id'])
