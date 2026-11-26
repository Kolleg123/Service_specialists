"""SQLite backup and restore helpers."""
import sqlite3
from pathlib import Path


def backup_database(source_path, target_path):
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source_path) as source, sqlite3.connect(target) as destination:
        source.backup(destination)
        result = destination.execute('PRAGMA integrity_check').fetchone()[0]
    if result != 'ok':
        raise sqlite3.DatabaseError(f'integrity_check: {result}')
    return str(target)


def restore_database(source_path, target_path):
    source = Path(source_path)
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as source_connection, sqlite3.connect(target) as target_connection:
        source_connection.backup(target_connection)
        result = target_connection.execute('PRAGMA integrity_check').fetchone()[0]
    if result != 'ok':
        raise sqlite3.DatabaseError(f'integrity_check: {result}')
    return str(target)


def check_database(path):
    with sqlite3.connect(path) as connection:
        return connection.execute('PRAGMA integrity_check').fetchone()[0]
