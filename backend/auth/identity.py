"""Allocate stable logins for accounts without one."""
import re


def available_username(connection, email, fallback):
    local_part = (email or '').split('@', 1)[0].lower()
    base = re.sub(r'[^a-z0-9_.-]', '', local_part)[:24]
    if len(base) < 3:
        base = fallback
    candidate = base
    suffix = 1
    while connection.execute('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', (candidate,)).fetchone():
        marker = f'_{suffix}'
        candidate = base[:30 - len(marker)] + marker
        suffix += 1
    return candidate
