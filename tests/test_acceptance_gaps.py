"""Acceptance tests for the remaining T-024..T-027 edge cases.

All tests use disposable SQLite databases. They do not connect to a production
database and do not add test-only routes to the application.
"""
from datetime import datetime, timedelta
import sqlite3

import app as app_module
from app import create_app
from seed_data import initialize_database
from tests.test_app import client, post


def test_slot_horizon_and_capacity_boundaries(tmp_path, monkeypatch):
    clock = datetime(2030, 5, 10, 9, 0)
    monkeypatch.setattr(app_module, "now", lambda: clock)
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "horizon.sqlite"),
        "SECRET_KEY": "test-only",
    })
    master = client(app, "master")
    services = master.get("/api/master").json["services"]
    individual = services[0]["id"]

    at_limit = clock + timedelta(days=365)
    response = post(master, "/master/slots", {
        "service_id": individual,
        "starts_at": at_limit.isoformat(timespec="minutes"),
        "capacity": 1,
    })
    assert response.status_code == 201

    beyond_limit = at_limit + timedelta(minutes=1)
    response = post(master, "/master/slots", {
        "service_id": individual,
        "starts_at": beyond_limit.isoformat(timespec="minutes"),
        "capacity": 1,
    })
    assert response.status_code == 400

    group = post(master, "/master/services", {
        "title": "Граничная групповая услуга",
        "price": 0,
        "duration": 15,
        "mode": "Группа",
    })
    assert group.status_code == 201
    group_id = master.get("/api/master").json["services"][-1]["id"]
    group_start = (clock + timedelta(days=40)).replace(hour=8)

    for capacity in (1, 50):
        start = group_start + timedelta(days=capacity)
        result = post(master, "/master/slots", {
            "service_id": group_id,
            "starts_at": start.isoformat(timespec="minutes"),
            "capacity": capacity,
        })
        assert result.status_code == 201

    for capacity in (0, 51, True, 1.0, "2"):
        start = group_start + timedelta(days=60 + (capacity is True))
        result = post(master, "/master/slots", {
            "service_id": group_id,
            "starts_at": start.isoformat(timespec="minutes"),
            "capacity": capacity,
        })
        assert result.status_code == 400


def test_individual_service_rejects_multiple_places_and_group_accepts_boundary(tmp_path, monkeypatch):
    clock = datetime(2030, 5, 10, 9, 0)
    monkeypatch.setattr(app_module, "now", lambda: clock)
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "capacity.sqlite"),
        "SECRET_KEY": "test-only",
    })
    master = client(app, "master")
    service_id = master.get("/api/master").json["services"][0]["id"]
    start = (clock + timedelta(days=40)).replace(hour=8)

    assert post(master, "/master/slots", {
        "service_id": service_id,
        "starts_at": start.isoformat(timespec="minutes"),
        "capacity": 2,
    }).status_code == 400


def test_dangling_specialist_relations_are_ignored_without_server_errors(tmp_path):
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "dangling.sqlite"),
        "SECRET_KEY": "test-only",
    })
    customer = client(app)
    slot = customer.get("/api/slots/1").json["slots"][0]
    booking = post(customer, "/bookings", {
        "slot_id": slot["id"],
        "address": "Киров, Ленина 10",
    })
    assert booking.status_code == 201

    # Simulate a legacy/corrupt database created without FK enforcement.
    with sqlite3.connect(app.config["DATABASE"]) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DELETE FROM specialists WHERE id=1")
        connection.execute("UPDATE users SET specialist_id=999 WHERE email='master@svobodno.demo'")

    catalog = app.test_client().get("/api/catalog")
    assert catalog.status_code == 200
    assert all(person["id"] != 1 for person in catalog.json["specialists"])
    assert app.test_client().get("/api/slots/1").json == {"slots": []}

    master = client(app, "master")
    result = master.get("/api/master")
    assert result.status_code == 200
    assert result.json == {"services": [], "slots": []}

    # A booking whose joined specialist no longer exists is not rendered as a
    # broken dashboard row; the endpoint remains available.
    dashboard = customer.get("/api/dashboard")
    assert dashboard.status_code == 200
    assert dashboard.json["bookings"] == []


def test_seed_initialization_survives_real_app_recreation_and_preserves_edits(tmp_path, monkeypatch):
    clock = datetime(2030, 5, 10, 9, 0)
    monkeypatch.setattr(app_module, "now", lambda: clock)
    database = str(tmp_path / "restart.sqlite")
    config = {"TESTING": True, "DATABASE": database, "SECRET_KEY": "test-only"}

    first_app = create_app(config)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE specialists SET name='Сохранённое имя', active=0 WHERE id=1")
        connection.execute(
            "INSERT INTO searches(user_id,query,created_at) VALUES(1,'Сохранённый поиск','2030-05-10')"
        )
        before = {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in ("specialists", "users", "services", "slots", "bookings", "reviews", "searches")
        }

    second_app = create_app(config)
    with sqlite3.connect(database) as connection:
        after = {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in ("specialists", "users", "services", "slots", "bookings", "reviews", "searches")
        }
    assert after == before
    assert second_app.test_client().get("/api/catalog").status_code == 200


def test_failed_seed_resume_rolls_back_to_existing_snapshot(tmp_path, monkeypatch):
    import seed_data

    path = tmp_path / "resume-rollback.sqlite"
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        initialize_database(connection, datetime(2030, 5, 10, 9, 0))
        connection.execute("UPDATE specialists SET name='Моё имя' WHERE id=1")
        connection.execute(
            "INSERT INTO searches(user_id,query,created_at) VALUES(1,'Не удалять','2030-05-10')"
        )

    tables = ("specialists", "users", "services", "slots", "bookings", "reviews", "searches")

    def snapshot():
        with sqlite3.connect(path) as connection:
            return {
                table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                for table in tables
            }

    before = snapshot()
    original = seed_data.ensure

    def fail_midway(connection, key, *args, **kwargs):
        if key == "service:4":
            raise RuntimeError("planned test interruption")
        return original(connection, key, *args, **kwargs)

    monkeypatch.setattr(seed_data, "ensure", fail_midway)
    import pytest
    with pytest.raises(RuntimeError, match="planned test interruption"):
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            initialize_database(connection, datetime(2031, 1, 1, 9, 0))

    assert snapshot() == before


def test_admin_can_cancel_future_booking_but_terminal_actions_stay_closed(tmp_path, monkeypatch):
    clock = [datetime(2030, 5, 10, 9, 0)]
    monkeypatch.setattr(app_module, "now", lambda: clock[0])
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "admin-cancel.sqlite"),
        "SECRET_KEY": "test-only",
    })
    customer, admin = client(app), client(app, "admin")
    slot = customer.get("/api/slots/1").json["slots"][0]
    booking = post(customer, "/bookings", {
        "slot_id": slot["id"],
        "address": "Киров, Ленина 10",
    })
    assert booking.status_code == 201
    ident = booking.json["id"]

    assert post(admin, f"/bookings/{ident}/cancel", {}).status_code == 200
    assert post(admin, f"/bookings/{ident}/cancel", {}).status_code == 409
    assert post(admin, f"/bookings/{ident}/complete", {}).status_code == 403
    assert post(customer, f"/bookings/{ident}/complete", {}).status_code == 403


def test_review_input_validation_does_not_create_partial_records(tmp_path):
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "review-validation.sqlite"),
        "SECRET_KEY": "test-only",
    })
    customer = client(app)
    completed = next(
        item for item in customer.get("/api/dashboard").json["bookings"]
        if item["status"] == "completed"
    )

    invalid = [
        {"rating": 0, "content": "Нормально, спасибо!"},
        {"rating": 6, "content": "Нормально, спасибо!"},
        {"rating": True, "content": "Нормально, спасибо!"},
        {"rating": 5, "content": "Коротко"},
        {"rating": 5, "content": "x" * 1501},
    ]
    for values in invalid:
        result = post(customer, "/reviews", {"booking_id": completed["id"], **values})
        assert result.status_code == 400

    assert not any(
        review["booking_id"] == completed["id"]
        for review in customer.get("/api/dashboard").json["reviews"]
    )
