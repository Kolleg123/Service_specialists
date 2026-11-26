"""Administrative edits to the shared service directory."""
import json
from uuid import uuid4

from backend.database.service_categories import category_groups
from backend.moderation.services import ModerationError, PUBLIC_SERVICE


def name_key(name):
    return ' '.join(name.split()).casefold()


def category_entry(connection, ident, group=None):
    if not isinstance(ident, str) or len(ident) > 80:
        raise ModerationError('Выберите запись из справочника')
    row = connection.execute('SELECT * FROM service_categories WHERE id=? AND archived=0', (ident,)).fetchone()
    if not row or (group is not None and (row['parent_id'] is None) != group):
        raise ModerationError('Запись справочника больше недоступна', 404)
    return row


def associated_services(connection, ident=None):
    rows = connection.execute(f'''SELECT v.id,v.category_id,v.draft,v.draft_status,v.deleted,
        v.moderation_status,({PUBLIC_SERVICE}) published
        FROM services v LEFT JOIN specialists p ON p.id=v.specialist_id
        WHERE ? IS NULL OR v.category_id=? OR
        json_extract(CASE WHEN json_valid(v.draft) THEN v.draft END,'$.category_id')=?''',
        (ident, ident, ident))
    for row in rows:
        yield row, json.loads(row['draft']) if row['draft'] else None


def admin_directory(connection):
    groups = category_groups(connection, include_empty=True)
    stats = {item['id']: item for group in groups for item in group['categories']}
    for item in stats.values():
        item.update(service_count=0, published_count=0, pending_count=0, draft_count=0, historical_count=0)
    for service, draft in associated_services(connection):
        current = service['category_id']
        proposed = draft.get('category_id') if draft else None
        if current in stats and not service['deleted']:
            stats[current]['service_count'] += 1
            stats[current]['published_count'] += int(bool(service['published']))
        if not service['deleted']:
            if proposed in stats:
                stats[proposed]['draft_count'] += 1
            pending = set()
            if service['moderation_status'] == 'pending':
                pending.add(current)
            if service['draft_status'] == 'pending':
                pending.add(proposed)
            for ident in pending & stats.keys():
                stats[ident]['pending_count'] += 1
        else:
            for ident in {current, proposed} & stats.keys():
                stats[ident]['historical_count'] += 1

    for group in groups:
        group['service_count'] = sum(item['service_count'] for item in group['categories'])
        group['categories'].sort(key=lambda item: name_key(item['name']))
    return sorted(groups, key=lambda group: name_key(group['name']))


def validate_names(connection, parent, names, exclude=None):
    seen = {name_key(row['name']) for row in connection.execute('''SELECT id,name FROM service_categories
        WHERE parent_id IS ? AND archived=0 AND id IS NOT ?''', (parent, exclude))}
    conflicts = []
    for name in names:
        key = name_key(name)
        if key in seen:
            conflicts.append(name)
        seen.add(key)
    if conflicts:
        raise ModerationError('Название уже используется: ' + ', '.join(conflicts), 409)


def update_profile_group(connection, source, target, label):
    connection.execute('UPDATE specialists SET category_group_id=?,category=? WHERE category_group_id=?',
                       (target, label, source))
    connection.execute('UPDATE specialist_applications SET category_group_id=?,category=? WHERE category_group_id=?',
                       (target, label, source))


def save_category(connection, data, ident=None):
    connection.execute('BEGIN IMMEDIATE')
    existing = category_entry(connection, ident) if ident else None
    name = data.get('name')
    if not isinstance(name, str) or not 1 <= len(' '.join(name.split())) <= 100:
        raise ModerationError('Укажите название от 1 до 100 символов')
    name = ' '.join(name.split())

    parent = data.get('parent_id')
    if existing and (existing['parent_id'] is None) != (parent is None):
        raise ModerationError('Группа и категория занимают разные уровни справочника')
    if parent is not None:
        category_entry(connection, parent, group=True)
    validate_names(connection, parent, [name], ident)

    if not existing:
        ident = uuid4().hex
        connection.execute('INSERT INTO service_categories(id,name,parent_id) VALUES(?,?,?)', (ident, name, parent))
    else:
        connection.execute('UPDATE service_categories SET name=?,parent_id=? WHERE id=?', (name, parent, ident))
        if parent is None and existing['name'] != name:
            update_profile_group(connection, ident, ident, name)
    return ident


def remove_category(connection, ident, data):
    if data.get('confirm') is not True:
        raise ModerationError('Подтвердите удаление')
    connection.execute('BEGIN IMMEDIATE')
    entry = category_entry(connection, ident)
    replacement = data.get('replacement_id')
    if replacement == ident:
        raise ModerationError('Выберите другую запись справочника')
    expected = data.get('impact')
    if expected is not None:
        groups = admin_directory(connection)
        if entry['parent_id'] is None:
            current = next(group for group in groups if group['id'] == ident)
            actual = [current['service_count'], *sorted(item['id'] for item in current['categories'])]
        else:
            current = next(item for group in groups for item in group['categories'] if item['id'] == ident)
            actual = [current[key] for key in ('service_count', 'draft_count', 'pending_count', 'historical_count')]
        if actual != expected:
            raise ModerationError('Связи изменились. Откройте подтверждение заново.', 409)
    if entry['parent_id'] is None:
        remove_group(connection, ident, replacement)
    else:
        remove_leaf(connection, ident, replacement)


def remove_group(connection, ident, replacement):
    children = connection.execute('SELECT name FROM service_categories WHERE parent_id=? AND archived=0',
                                  (ident,)).fetchall()
    if children and replacement is None:
        raise ModerationError('Выберите группу для переноса категорий', 409)
    if replacement is not None:
        destination = category_entry(connection, replacement, group=True)
        validate_names(connection, replacement, [child['name'] for child in children])
        connection.execute('UPDATE service_categories SET parent_id=? WHERE parent_id=? AND archived=0',
                           (replacement, ident))
        update_profile_group(connection, ident, replacement, destination['name'])
    if connection.execute('SELECT 1 FROM service_categories WHERE parent_id=?', (ident,)).fetchone():
        connection.execute('UPDATE service_categories SET archived=1 WHERE id=?', (ident,))
    else:
        connection.execute('DELETE FROM service_categories WHERE id=?', (ident,))


def remove_leaf(connection, ident, replacement):
    linked = list(associated_services(connection, ident))
    if any(not row['deleted'] for row, _ in linked) and replacement is None:
        raise ModerationError('Выберите категорию для переноса услуг и изменений', 409)
    if replacement is not None:
        category_entry(connection, replacement, group=False)
    for row, draft in linked:
        if row['deleted']:
            continue
        category = replacement if row['category_id'] == ident else row['category_id']
        if draft and draft.get('category_id') == ident:
            draft['category_id'] = replacement
        connection.execute('UPDATE services SET category_id=?,draft=?,revision=revision+1 WHERE id=?',
                           (category, json.dumps(draft, ensure_ascii=False) if draft is not None else None, row['id']))
    connection.execute('UPDATE service_categories SET replacement_id=? WHERE replacement_id=?', (replacement, ident))
    if replacement or any(row['deleted'] for row, _ in linked):
        connection.execute('UPDATE service_categories SET archived=1,replacement_id=? WHERE id=?', (replacement, ident))
    else:
        connection.execute('DELETE FROM service_categories WHERE id=?', (ident,))
