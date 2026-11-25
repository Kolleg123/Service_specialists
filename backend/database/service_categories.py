"""Shared service taxonomy and one-time backfill for existing installations."""
import json
import re


DIRECTORY = (
    ('home-repair', 'Дом и ремонт', (
        ('plumbing', 'Сантехника'), ('electrical', 'Электрика'), ('finishing', 'Отделочные работы'),
        ('furniture-assembly', 'Сборка мебели'), ('appliance-repair', 'Ремонт бытовой техники'),
        ('doors', 'Установка и ремонт дверей'), ('windows', 'Установка и ремонт окон'),
        ('flooring', 'Укладка напольных покрытий'), ('tiling', 'Плиточные работы'),
        ('painting', 'Малярные работы'), ('carpentry', 'Столярные работы'),
        ('heating', 'Монтаж отопления'), ('air-conditioning', 'Кондиционеры и вентиляция'),
        ('renovation', 'Ремонт квартир'), ('roofing', 'Кровельные работы'), ('welding', 'Сварочные работы'),
    )),
    ('beauty', 'Красота и уход', (
        ('hair', 'Парикмахерские услуги'), ('hair-color', 'Окрашивание волос'), ('manicure', 'Маникюр'),
        ('pedicure', 'Педикюр'), ('makeup', 'Макияж'), ('eyebrows', 'Оформление бровей'),
        ('eyelashes', 'Уход за ресницами'), ('skin-care', 'Уход за кожей'), ('depilation', 'Депиляция'),
        ('beauty-styling', 'Подбор стиля и гардероба'),
    )),
    ('education', 'Образование и репетиторство', (
        ('math', 'Математика'), ('english', 'Английский язык'), ('russian', 'Русский язык'),
        ('programming-lessons', 'Программирование'), ('music', 'Музыка и вокал'),
        ('exams', 'Подготовка к экзаменам'), ('primary-school', 'Начальная школа'),
        ('physics', 'Физика'), ('chemistry', 'Химия'), ('biology', 'Биология'), ('history', 'История'),
        ('art-lessons', 'Рисование'), ('german', 'Немецкий язык'), ('chinese', 'Китайский язык'),
        ('preschool', 'Подготовка к школе'), ('speech-therapy', 'Логопедические занятия'),
    )),
    ('it', 'IT и фриланс', (
        ('web-development', 'Веб-разработка'), ('software', 'Разработка программного обеспечения'),
        ('graphic-design', 'Графический дизайн'), ('ui-design', 'Дизайн интерфейсов'),
        ('computer-setup', 'Настройка компьютеров'), ('system-admin', 'Системное администрирование'),
        ('writing', 'Работа с текстами'), ('marketing', 'Маркетинг и реклама'),
        ('social-media', 'Ведение соцсетей'), ('seo', 'SEO'), ('data-analysis', 'Анализ данных'),
        ('translation', 'Переводы'), ('software-testing', 'Тестирование программ'),
    )),
    ('sports', 'Спорт и фитнес', (
        ('fitness', 'Фитнес'), ('gym', 'Силовые тренировки'), ('yoga', 'Йога'), ('pilates', 'Пилатес'),
        ('stretching', 'Растяжка'), ('swimming', 'Плавание'), ('running', 'Бег'), ('dance', 'Танцы'),
        ('martial-arts', 'Единоборства'), ('skiing', 'Лыжи и сноуборд'),
    )),
    ('wellness', 'Здоровье и восстановление', (
        ('massage', 'Массаж'), ('breathing', 'Дыхательные практики'),
        ('wellness-gymnastics', 'Оздоровительная гимнастика'),
        ('relaxation', 'Практики расслабления'), ('ergonomics', 'Эргономика рабочего места'),
    )),
    ('professional', 'Бухгалтерия и юридические услуги', (
        ('bookkeeping', 'Бухгалтерское сопровождение'), ('tax', 'Налоги и декларации'),
        ('payroll', 'Расчёт зарплаты'), ('business-registration', 'Регистрация ИП и организаций'),
        ('legal', 'Юридические консультации'), ('contracts', 'Составление договоров'),
        ('consumer-rights', 'Защита прав потребителей'), ('legal-representation', 'Представительство в суде'),
    )),
    ('media', 'Фото и видеосъёмка', (
        ('portrait', 'Портретная съёмка'), ('family-photo', 'Семейная съёмка'),
        ('event-photo', 'Репортажная съёмка'), ('product-photo', 'Предметная съёмка'),
        ('video', 'Видеосъёмка'), ('video-editing', 'Видеомонтаж'), ('retouching', 'Ретушь'),
        ('photo-lessons', 'Обучение фотографии'),
    )),
    ('events', 'Организация мероприятий', (
        ('event-planning', 'Организация праздников'), ('host', 'Ведущие мероприятий'),
        ('animation', 'Детская анимация'), ('dj', 'Диджеи и звуковое сопровождение'),
        ('event-decor', 'Оформление мероприятий'), ('floristry', 'Флористика'),
        ('catering', 'Кейтеринг'), ('workshops', 'Творческие мастер-классы'),
    )),
    ('household', 'Домашний персонал и бытовые услуги', (
        ('cleaning', 'Уборка помещений'), ('window-cleaning', 'Мытьё окон'),
        ('dry-cleaning', 'Химчистка мебели и ковров'), ('nanny', 'Услуги няни'),
        ('caregiver', 'Услуги сиделки'), ('cook', 'Приготовление еды на дому'),
        ('gardening', 'Уход за садом'), ('ironing', 'Стирка и глажка'),
        ('organizing', 'Организация хранения вещей'),
    )),
    ('pets', 'Уход за животными', (
        ('grooming', 'Груминг'), ('dog-training', 'Дрессировка собак'), ('dog-walking', 'Выгул собак'),
        ('pet-sitting', 'Передержка животных'), ('pet-visit', 'Уход за животными на дому'),
        ('pet-transport', 'Перевозка животных'),
    )),
    ('transport', 'Транспортные услуги', (
        ('moving', 'Переезды'), ('freight', 'Грузоперевозки'), ('loaders', 'Услуги грузчиков'),
        ('courier', 'Курьерская доставка'), ('driver', 'Услуги водителя'),
        ('transfer', 'Трансферы и пассажирские перевозки'),
    )),
    ('auto', 'Автоуслуги', (
        ('car-diagnostics', 'Диагностика автомобиля'), ('car-repair', 'Ремонт автомобиля'),
        ('car-electrics', 'Автоэлектрика'), ('tires', 'Шиномонтаж'),
        ('car-detailing', 'Детейлинг'), ('car-purchase', 'Подбор автомобиля'),
        ('driving-lessons', 'Уроки вождения'), ('towing', 'Эвакуация автомобилей'),
    )),
    ('consultations', 'Психология и консультации', (
        ('psychology', 'Индивидуальные консультации психолога'), ('family-therapy', 'Семейные консультации'),
        ('career', 'Карьерные консультации'), ('career-guidance', 'Профориентация'),
        ('mediation', 'Медиация'), ('business-consulting', 'Бизнес-консультации'),
    )),
    ('design-and-crafts', 'Дизайн и ремесло', (
        ('interior-design', 'Дизайн интерьера'), ('landscape-design', 'Ландшафтный дизайн'),
        ('tailoring', 'Пошив и ремонт одежды'), ('shoe-repair', 'Ремонт обуви'),
        ('furniture-restoration', 'Реставрация мебели'), ('jewelry-repair', 'Ремонт украшений'),
        ('cakes', 'Торты и десерты на заказ'), ('printing', 'Печать и полиграфия'),
    )),
)

# These rules classify clear titles only. A profile direction alone is too broad.
TITLE_RULES = (
    ('plumbing', r'сантехник|устранение протеч|монтаж сантех|установк[аи] смесител|прочистк[аи] засор'),
    ('electrical', r'электромонтаж|электрики|установк[аи] розет|ремонт проводки'),
    ('furniture-assembly', r'сборк[аи] мебели'), ('appliance-repair', r'ремонт бытовой техники'),
    ('hair', r'стрижк|укладк[аи] волос|вечерняя укладка'),
    ('hair-color', r'окрашивание волос'), ('manicure', r'маникюр'), ('pedicure', r'педикюр'),
    ('makeup', r'макияж'), ('massage', r'массаж'),
    ('english', r'английск'), ('math', r'математик'), ('russian', r'русск\w+ язык'),
    ('portrait', r'портретная (фотосессия|съемка)'), ('family-photo', r'семейная (фотосессия|съемка)'),
    ('photo-lessons', r'(мастер-класс|обучение) по фотографии'),
    ('computer-setup', r'настройк[аи] компьютер'), ('web-development', r'веб-разработка|разработка сайт'),
    ('cleaning', r'уборк[аи] (квартир|домов|помещений)'), ('dog-walking', r'выгул собак'),
    ('grooming', r'груминг|стрижк[аи] (собак|кошек|животных)'), ('tires', r'шиномонтаж'), ('yoga', r'йог[аи]'),
)


def infer_category(title, profession):
    title = (title or '').casefold().replace('ё', 'е')
    if title == 'разговорный клуб' and 'английск' in (profession or '').casefold():
        return 'english'
    if title.startswith(('семинар ', 'мастер-класс ')) and not title.startswith('мастер-класс по фотографии'):
        return None
    matches = [ident for ident, pattern in TITLE_RULES if re.search(pattern, title)]
    return matches[0] if len(matches) == 1 else None


def initialize_categories(connection):
    connection.execute('''CREATE TABLE IF NOT EXISTS service_categories(
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES service_categories(id),
        CHECK(parent_id IS NULL OR parent_id != id)
    )''')
    columns = {row['name'] for row in connection.execute('PRAGMA table_info(service_categories)')}
    if 'archived' not in columns:
        connection.execute('ALTER TABLE service_categories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
        connection.execute('ALTER TABLE service_categories ADD COLUMN replacement_id TEXT REFERENCES service_categories(id)')
        connection.execute('DROP INDEX IF EXISTS service_category_name')
    connection.execute("""CREATE UNIQUE INDEX IF NOT EXISTS active_service_category_name
        ON service_categories(COALESCE(parent_id, ''), name) WHERE archived=0""")
    if not connection.execute("SELECT 1 FROM seed_meta WHERE name='service_directory_initialized'").fetchone():
        for ident, name, children in DIRECTORY:
            connection.executemany('INSERT INTO service_categories(id,name,parent_id) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
                                   [(ident, name, None), *((child, label, ident) for child, label in children)])
        connection.execute("INSERT INTO seed_meta(name,value) VALUES('service_directory_initialized','1')")
    columns = {row['name'] for row in connection.execute('PRAGMA table_info(services)')}
    if 'category_id' not in columns:
        connection.execute('ALTER TABLE services ADD COLUMN category_id TEXT REFERENCES service_categories(id)')
    for table in ('specialists', 'specialist_applications'):
        columns = {row['name'] for row in connection.execute(f'PRAGMA table_info({table})')}
        if 'category_group_id' not in columns:
            connection.execute(f'''ALTER TABLE {table} ADD COLUMN category_group_id TEXT
                REFERENCES service_categories(id) ON DELETE SET NULL''')


def backfill_categories(connection):
    if connection.execute("SELECT 1 FROM seed_meta WHERE name='service_categories_backfill'").fetchone():
        return
    rows = connection.execute('''SELECT v.id,v.title,v.category_id,v.draft,p.profession FROM services v
        LEFT JOIN specialists p ON p.id=v.specialist_id''').fetchall()
    for row in rows:
        category = row['category_id'] or active_category_id(connection, infer_category(row['title'], row['profession']))
        draft = json.loads(row['draft']) if row['draft'] else None
        if draft is not None and 'category_id' not in draft:
            title = draft.get('title')
            draft['category_id'] = category if title == row['title'] else active_category_id(connection, infer_category(title, row['profession']))
        connection.execute('UPDATE services SET category_id=?,draft=? WHERE id=?',
                           (category, json.dumps(draft, ensure_ascii=False) if draft is not None else None, row['id']))
    connection.execute("INSERT INTO seed_meta(name,value) VALUES('service_categories_backfill','1')")


def category_groups(connection, available=None, *, include_empty=False):
    rows = connection.execute('''SELECT id,name,parent_id FROM service_categories WHERE archived=0
        ORDER BY parent_id IS NOT NULL, rowid''')
    groups = {}
    for row in rows:
        ident, name, parent = row
        if parent is None:
            groups[ident] = dict(id=ident, name=name, categories=[])
        elif available is None or ident in available:
            groups[parent]['categories'].append(dict(id=ident, name=name))
    return [group for group in groups.values() if include_empty or group['categories']]


def active_category_id(connection, ident):
    if ident:
        row = connection.execute('''SELECT CASE WHEN archived=0 THEN id ELSE replacement_id END
            FROM service_categories WHERE id=? AND parent_id IS NOT NULL''', (ident,)).fetchone()
        if row:
            return row[0]
    return None


LEGACY_PROFILE_GROUPS = {
    'Дом и ремонт': ('home-repair', 'Дом и ремонт'),
    'Красота': ('beauty', 'Красота и уход'),
    'Обучение': ('education', 'Образование и репетиторство'),
    'Здоровье': ('wellness', 'Здоровье и восстановление'),
    'Мероприятия': ('events', 'Организация мероприятий'),
}


def profile_group(connection, value):
    if not isinstance(value, str):
        return None
    row = connection.execute('''SELECT id FROM service_categories
        WHERE archived=0 AND parent_id IS NULL AND (name=? OR id=?)''', (value, value)).fetchone()
    if row:
        return row['id']
    if value in LEGACY_PROFILE_GROUPS:
        ident, original = LEGACY_PROFILE_GROUPS[value]
        row = connection.execute('''SELECT id FROM service_categories
            WHERE archived=0 AND parent_id IS NULL AND id=? AND name=?''', (ident, original)).fetchone()
        if row:
            return row['id']
    return None


def backfill_profile_groups(connection):
    if connection.execute("SELECT 1 FROM seed_meta WHERE name='profile_groups_backfill'").fetchone():
        return
    for table in ('specialists', 'specialist_applications'):
        for row in connection.execute(f'SELECT id,category FROM {table}').fetchall():
            group = profile_group(connection, row['category'])
            if group:
                connection.execute(f'UPDATE {table} SET category_group_id=? WHERE id=?', (group, row['id']))
    connection.execute("INSERT INTO seed_meta(name,value) VALUES('profile_groups_backfill','1')")
