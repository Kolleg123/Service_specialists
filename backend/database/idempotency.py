"""Persist successful operation responses in the caller's write transaction."""
import hashlib
import json
import re


class IdempotencyError(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class Operation:
    def __init__(self, connection, user_id, name, key, payload):
        if key is not None and not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', key):
            raise IdempotencyError('Некорректный ключ операции', 400)
        self.connection = connection
        self.identity = (user_id, name, key)
        self.key = key
        self.fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        ).hexdigest()

    def previous(self):
        if self.key is None:
            return None
        row = self.connection.execute('''SELECT fingerprint,response FROM idempotent_operations
            WHERE user_id=? AND operation=? AND operation_key=?''', self.identity).fetchone()
        if not row:
            return None
        if row['fingerprint'] != self.fingerprint:
            raise IdempotencyError('Ключ уже использован с другими данными. Начните новую операцию.', 409)
        return json.loads(row['response'])

    def save(self, payload):
        if self.key is not None:
            self.connection.execute('''INSERT INTO idempotent_operations
                (user_id,operation,operation_key,fingerprint,response) VALUES(?,?,?,?,?)''',
                                    (*self.identity, self.fingerprint, json.dumps(payload)))
        return payload
