"""Isolated browser-test server. The controllable clock is NEVER in app.py."""
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as app_module
from flask import jsonify, request

real_now = app_module.now
clock_override = None
app_module.now = lambda: clock_override if clock_override is not None else real_now()

with tempfile.TemporaryDirectory(prefix='svobodno-e2e-') as folder:
    mailbox = {}

    def capture_email(config, email, name, url):
        mailbox[email] = url

    app = app_module.create_app({
        'DEMO_MODE': True, 'DEMO_DATABASE': str(Path(folder) / 'test.sqlite'),
        'TESTING': True,
        'UPLOAD_FOLDER': str(Path(folder) / 'uploads'),
        'APP_BASE_URL': 'http://127.0.0.1:5051',
        'MAIL_SENDER': capture_email,
    })

    @app.get('/__test__/recovery-mail')
    def recovery_mail():
        return jsonify(url=mailbox.get(request.args.get('email')))

    @app.post('/__test__/clock')
    def test_clock():
        # Test-only fixture route on a loopback server with a disposable database.
        # Existing CSRF middleware still applies; no route is added to create_app.
        global clock_override
        value = request.get_json().get('now')
        try:
            parsed = datetime.fromisoformat(value) if value is not None else None
            if parsed is not None and parsed.tzinfo is not None:
                raise ValueError
        except (ValueError, TypeError):
            return jsonify(error='Expected a naive ISO datetime or null'), 400
        clock_override = parsed
        return jsonify(ok=True)

    app.run(host='127.0.0.1', port=5051)
