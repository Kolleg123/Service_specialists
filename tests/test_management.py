from datetime import datetime

import app as app_module
from tests.test_app import client, post
from tests.test_specialist_registration import APPLICATION, app


def test_service_edits_moderation_and_removal(app):
    master, admin, other, customer = (client(app, role) for role in ('master', 'admin', 'teacher', 'client'))
    details = dict(title='Новая услуга', price=800, duration=60, mode='Онлайн', category_id='plumbing')
    service_id = post(master, '/master/services', details).json['id']
    manage = f'/master/services/{service_id}'
    decide = f'/admin/service-applications/{service_id}/decision'
    assert post(other, manage + '/edit', details).status_code == 404
    assert post(master, manage + '/edit', {**details, 'price': 900}).status_code == 200
    pending, = admin.get('/api/admin/service-applications').json['applications']
    assert pending['price'] == 900
    assert post(admin, decide, {'status': 'approved', 'revision': 0}).status_code == 409
    assert post(admin, decide, {'status': 'approved', 'revision': pending['revision']}).status_code == 200
    assert post(master, manage + '/edit', {**details, 'price': 1000}).status_code == 200
    assert customer.get(f'/api/services/{service_id}').json['service']['price'] == 900
    draft, = admin.get('/api/admin/service-applications').json['applications']
    assert post(admin, decide, {'status': 'rejected', 'revision': draft['revision'], 'reason': 'Уточните цену'}).status_code == 200
    assert customer.get(f'/api/services/{service_id}').json['service']['price'] == 900
    assert post(master, manage + '/edit', {**details, 'price': 1100}).status_code == 200
    draft, = admin.get('/api/admin/service-applications').json['applications']
    assert post(admin, decide, {'status': 'approved', 'revision': draft['revision']}).status_code == 200
    assert customer.get(f'/api/services/{service_id}').json['service']['price'] == 1100

    assert post(master, '/master/slots', {'service_id': service_id, 'starts_at': '2030-05-22T10:00'}).status_code == 201
    slot, = customer.get(f'/api/slots/1?service_id={service_id}').json['slots']
    booking_id = post(customer, '/bookings', {'slot_id': slot['id']}).json['id']
    notices = master.get('/api/notifications').json['notifications']
    decisions = [n for n in notices if n['service_id'] == service_id]
    assert len(decisions) == 3
    notice_path = f"/notifications/{decisions[0]['id']}/open"
    assert post(master, notice_path, {}).json['target']['item']['price'] == 1100
    assert post(other, notice_path, {}).status_code == 404
    assert post(master, manage + '/delete', {}).status_code == 400
    assert post(master, manage + '/delete', {'confirm': True}).status_code == 200
    assert customer.get(f'/api/services/{service_id}').status_code == 404
    assert post(master, notice_path, {}).json['target'] is None
    assert any(b['id'] == booking_id and b['status'] == 'confirmed'
               for b in customer.get('/api/dashboard').json['bookings'])

    withdrawn = post(master, '/master/services', details).json['id']
    assert post(master, f'/master/services/{withdrawn}/delete', {'confirm': True}).status_code == 200
    assert admin.get('/api/admin/service-applications').json['applications'] == []
    assert post(admin, f'/admin/service-applications/{withdrawn}/decision', {'status': 'approved'}).status_code == 404


def test_cancellation_scopes_and_notification_details(app, monkeypatch):
    customer, master, admin = (client(app, role) for role in ('client', 'master', 'admin'))
    application = post(customer, '/specialist-applications', APPLICATION).json['application']
    path = f"/admin/specialist-applications/{application['id']}/decision"
    assert post(admin, path, {'status': 'rejected', 'reason': 'Уточните место'}).status_code == 200
    notice = customer.get('/api/notifications').json['notifications'][0]
    target = post(customer, f"/notifications/{notice['id']}/open", {}).json['target']
    assert target['item']['reason'] == 'Уточните место' and target['tab'] == 'specialist-application'

    slots = customer.get('/api/slots/1?service_id=1').json['slots']
    bookings = [post(customer, '/bookings', {'slot_id': s['id'], 'address': 'Киров, Ленина 10'}).json['id']
                for s in slots[:4]]
    other_slot = customer.get('/api/slots/4?service_id=7').json['slots'][0]
    other = post(customer, '/bookings', {'slot_id': other_slot['id']}).json['id']
    assert post(master, f'/bookings/{bookings[0]}/cancel', {'reason': 'Перенос'}).status_code == 200
    monkeypatch.setattr(app_module, 'now', lambda: datetime.fromisoformat(slots[1]['starts_at']))
    ids = master.get('/api/master/bookings/upcoming').json['ids']
    assert ids == bookings[2:]
    data = {'confirm': True, 'ids': ids, 'reason': 'Мастер заболел'}
    assert post(customer, '/master/bookings/cancel-all', data).status_code == 403
    assert post(master, '/master/bookings/cancel-all', {**data, 'ids': ids + [other]}).status_code == 409
    assert post(master, '/master/bookings/cancel-all', data).json['cancelled'] == 2
    rows = {b['id']: b for b in customer.get('/api/dashboard').json['bookings']}
    assert rows[bookings[0]]['cancel_reason'] == 'Перенос'
    assert rows[bookings[1]]['status'] == rows[other]['status'] == 'confirmed'
    assert all(rows[ident]['cancel_reason'] == 'Мастер заболел' for ident in ids)
    notices = customer.get('/api/notifications').json['notifications']
    notice = next(n for n in notices if n['booking_id'] == ids[0] and n['event'] == 'cancelled')
    assert 'Мастер заболел' in notice['message']
    target = post(customer, f"/notifications/{notice['id']}/open", {}).json['target']
    assert target['mode'] == 'client' and target['item']['id'] == ids[0]
    assert next(n for n in customer.get('/api/notifications').json['notifications'] if n['id'] == notice['id'])['is_read']
