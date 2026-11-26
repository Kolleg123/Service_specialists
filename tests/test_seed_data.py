from datetime import datetime
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from app import create_app
from backend.database.seed_data import initialize_database, SCHEMA, PEOPLE
from tests.test_app import post


def connect(path):
    c = sqlite3.connect(path, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    return c


def initialize(path, when=datetime(2030, 5, 10, 9)):
    with connect(path) as c:
        initialize_database(c, when)


def snapshot(path):
    with connect(path) as c:
        return {table: [tuple(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY id')]
                for table in ['specialists','users','services','slots','bookings','reviews','searches']}


def test_repeat_does_not_duplicate_roll_forward_or_overwrite_user_changes(tmp_path):
    path = tmp_path / 'repeat.sqlite'
    initialize(path)
    with connect(path) as c:
        c.execute("UPDATE specialists SET name='Изменённое имя', active=0 WHERE id=1")
        c.execute("UPDATE services SET title='Личная услуга', price=9999, active=0 WHERE id=1")
        c.execute("UPDATE users SET name='Новое имя',password='preserve-existing-hash' WHERE id=1")
        c.execute("UPDATE slots SET active=0 WHERE id=1")
        c.execute("UPDATE reviews SET content='Правка клиента',status='rejected' WHERE id=1")
        c.execute("INSERT INTO searches(user_id,query,created_at) VALUES(1,'Личный поиск','2030-05-10')")
    before = snapshot(path)
    initialize(path, datetime(2030, 7, 20))
    initialize(path, datetime(2031, 1, 1))
    assert snapshot(path) == before


def test_legacy_partial_database_with_one_specialist_is_repaired(tmp_path):
    path = tmp_path / 'partial.sqlite'
    with connect(path) as c:
        c.executescript(SCHEMA)
        p = PEOPLE[0]
        c.execute('INSERT INTO specialists(id,name,profession,category,experience,education,skills,bio,photo,location) VALUES(?,?,?,?,?,?,?,?,?,?)',
                  (1, *p[:7], '/static/photos/1.jpg', p[8]))
        c.execute("INSERT INTO users(id,name,email,password,role) VALUES(900,'Мой пользователь','own@example.test','my-hash','client')")
    initialize(path)
    first = snapshot(path)
    assert len(first['specialists']) == 6
    assert len(first['users']) == 6
    assert len(first['services']) == 11
    assert len(first['slots']) == 160
    assert any(r[3] == 'own@example.test' and r[4] == 'my-hash' for r in first['users'])
    initialize(path)
    assert snapshot(path) == first


def test_resume_manifest_with_missing_rows_preserves_real_booking(tmp_path):
    path = tmp_path / 'resume.sqlite'
    initialize(path)
    with connect(path) as c:
        c.execute("INSERT INTO bookings(user_id,slot_id,quantity,address,note,status,created_at,total) VALUES(1,1,1,'Мой адрес','Моя запись','confirmed','2030-05-10',1500)")
        c.execute("DELETE FROM reviews WHERE id=1")
        c.execute("DELETE FROM slots WHERE id=2")
        c.execute("DELETE FROM seed_meta WHERE name='version'")
    before = snapshot(path)
    initialize(path)
    after = snapshot(path)
    assert after['bookings'] == before['bookings']
    assert all(row in after['slots'] for row in before['slots'])
    assert len(after['slots']) == len(before['slots']) + 1
    assert any(r[0] == 2 for r in after['slots'])
    assert any(r[0] == 1 for r in after['reviews'])
    assert len(after['reviews']) == len(before['reviews']) + 1
    initialize(path)
    assert snapshot(path) == after


def test_failure_rolls_back_and_next_start_repairs(tmp_path, monkeypatch):
    import backend.database.seed_data as seed_data
    path = tmp_path / 'interrupted.sqlite'
    original = seed_data.ensure
    def interrupted(connection, key, *args, **kwargs):
        if key == 'service:4':
            raise RuntimeError('Simulated interruption')
        return original(connection, key, *args, **kwargs)
    with monkeypatch.context() as m:
        m.setattr(seed_data, 'ensure', interrupted)
        with pytest.raises(RuntimeError, match='Simulated interruption'):
            initialize(path)
    assert snapshot(path)['specialists'] == []
    initialize(path)
    first = snapshot(path)
    assert len(first['services']) == 11 and len(first['bookings']) == 6
    initialize(path)
    assert snapshot(path) == first


def test_legacy_full_database_is_adopted_without_duplicates(tmp_path):
    path = tmp_path / 'legacy.sqlite'
    initialize(path)
    with connect(path) as c:
        c.execute('DROP TABLE seed_entities')
        c.execute('DROP TABLE seed_meta')
    before = snapshot(path)
    initialize(path, datetime(2031, 1, 1))
    assert snapshot(path) == before


def test_occupied_seed_ids_do_not_overwrite_unrelated_data(tmp_path):
    path = tmp_path / 'collision.sqlite'
    with connect(path) as c:
        c.executescript(SCHEMA)
        c.execute("INSERT INTO specialists(id,name,profession,active) VALUES(1,'Своя мастерская','Другая профессия',1)")
        c.execute("INSERT INTO users(id,name,email,password,role) VALUES(1,'Свой клиент','own@example.test','original-hash','client')")
    initialize(path)
    with connect(path) as c:
        assert c.execute('SELECT name FROM specialists WHERE id=1').fetchone()[0] == 'Своя мастерская'
        assert c.execute('SELECT password FROM users WHERE id=1').fetchone()[0] == 'original-hash'
        mapped = c.execute("SELECT entity_id FROM seed_entities WHERE seed_key='specialist:1'").fetchone()[0]
        assert mapped != 1
        master = c.execute("SELECT specialist_id FROM users WHERE email='master@svobodno.demo'").fetchone()[0]
        assert master == mapped
    app = create_app({'TESTING': True, 'DATABASE': str(path)})
    result = post(app.test_client(), '/consult', {'message': 'Протекает кран'})
    assert result.json['specialist_id'] == mapped


def test_concurrent_initialization_is_serialized(tmp_path):
    path = tmp_path / 'concurrent.sqlite'
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: initialize(path), range(2)))
    first = snapshot(path)
    assert len(first['specialists']) == 6 and len(first['slots']) == 160
    initialize(path)
    assert snapshot(path) == first


def test_recovered_user_keeps_original_id_when_higher_custom_ids_exist(tmp_path):
    path = tmp_path / 'restore-user.sqlite'
    initialize(path)
    with connect(path) as c:
        admin_id = c.execute("SELECT id FROM users WHERE email='admin@svobodno.demo'").fetchone()[0]
        c.execute('DELETE FROM users WHERE id=?', (admin_id,))
        c.execute("INSERT INTO users(id,name,email,password,role) VALUES(900,'Свой клиент','custom@example.test','hash','client')")
    initialize(path)
    with connect(path) as c:
        assert c.execute("SELECT id FROM users WHERE email='admin@svobodno.demo'").fetchone()[0] == admin_id
        assert c.execute("SELECT password FROM users WHERE id=900").fetchone()[0] == 'hash'


def test_legacy_history_only_keeps_original_anchor_and_history(tmp_path):
    path = tmp_path / 'history-only.sqlite'
    initialize(path)
    original = snapshot(path)
    with connect(path) as c:
        c.execute('DELETE FROM slots WHERE id NOT IN (SELECT slot_id FROM bookings)')
        c.execute('DROP TABLE seed_entities')
        c.execute('DROP TABLE seed_meta')
    initialize(path, datetime(2031, 1, 1))
    recovered = snapshot(path)
    assert recovered['bookings'] == original['bookings']
    assert recovered['reviews'] == original['reviews']
    assert len(recovered['slots']) == len(original['slots'])
    with connect(path) as c:
        assert c.execute("SELECT value FROM seed_meta WHERE name='anchor_date'").fetchone()[0] == '2030-05-10T00:00:00'
    initialize(path, datetime(2032, 1, 1))
    assert snapshot(path) == recovered



def test_legacy_users_table_gets_stable_username_without_losing_account_data(tmp_path):
    path = tmp_path / 'legacy-no-username.sqlite'
    legacy_schema = SCHEMA.replace('name TEXT,username TEXT,email TEXT', 'name TEXT,email TEXT')
    with connect(path) as connection:
        connection.executescript(legacy_schema)
        connection.execute(
            "INSERT INTO users(id,name,email,password,role) VALUES(700,'Старый пользователь','old.login@example.test','old-hash','client')"
        )
    initialize(path)
    with connect(path) as connection:
        user = connection.execute(
            'SELECT name,username,email,password FROM users WHERE id=700'
        ).fetchone()
        assert tuple(user) == ('Старый пользователь', 'old.login', 'old.login@example.test', 'old-hash')
        assert connection.execute(
            "SELECT COUNT(*) FROM users WHERE username='old.login'"
        ).fetchone()[0] == 1
