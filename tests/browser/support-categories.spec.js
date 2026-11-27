const { test, expect } = require('@playwright/test');

async function login(page, role) {
 await page.goto('/');
 await page.locator('#account').click();
 await page.getByRole('button', {name: role, exact: true}).click();
 await expect(page.locator('.dashboard')).toBeVisible();
}

async function post(page, path, data) {
 const session = await page.request.get('/api/session');
 const {csrf} = await session.json();
 return page.request.post('/api' + path, {data, headers: {'X-CSRF-Token': csrf}});
}

async function notice(page, text) {
 const panel = page.locator('#notifications-panel');
 if (!(await panel.isVisible())) await page.locator('#notifications-toggle').click();
 await panel.getByRole('button', {name: text}).click();
}

test('support suggestion, live catalog changes, moderation and confirmed transfers', async ({browser, page: admin}) => {
 test.setTimeout(75000);
 const master = await browser.newPage({viewport: {width: 390, height: 844}});
 const observer = await browser.newPage();
 try {
  await Promise.all([admin.clock.install(), master.clock.install(), observer.clock.install()]);
  await Promise.all([login(admin, 'Администратор'), login(master, 'Мастер'), observer.goto('/')]);
  await admin.setViewportSize({width: 850, height: 900});
  const tabs = admin.locator('.dashboard-tabs');
  expect(await tabs.evaluate(element => ({
   fits: element.scrollWidth === element.clientWidth,
   wraps: new Set([...element.children].map(tab => tab.offsetTop)).size > 1
  }))).toEqual({fits: true, wraps: true});
  await admin.getByRole('button', {name: 'Обращения', exact: true}).click();
  await expect(admin.locator('#support-status')).toHaveValue('pending');

  await master.getByRole('button', {name: 'Мои услуги', exact: true}).click();
  const form = master.locator('#service-form');
  await form.getByLabel('Название').fill('Настройка домашней автоматики');
  await form.getByLabel('Стоимость').fill('800');
  await form.getByRole('button', {name: 'Не нашли нужную категорию?'}).click();
  const dialog = master.locator('#support-dialog');
  await expect(dialog.getByLabel('Заголовок')).toHaveValue('Предложение новой категории');
  await dialog.getByLabel('Описание').fill('Нужна категория для домашней автоматики.');
  await dialog.getByRole('button', {name: 'Отправить обращение'}).click();
  await expect(dialog).toBeHidden();
  await expect(form.getByLabel('Название')).toHaveValue('Настройка домашней автоматики');

  await admin.clock.runFor(11000);
  await expect(admin.locator('[data-pending-tab="support"]')).toHaveText('(1)');
  await notice(admin, 'Новое обращение «Предложение новой категории»');
  await expect(admin.locator('#modal')).toContainText('Нужна категория для домашней автоматики.');
  await admin.getByRole('button', {name: 'Открыть обращение'}).click();
  const ticket = admin.locator('details[data-support-id]').filter({hasText: 'Предложение новой категории'});
  await expect(ticket).toHaveAttribute('open', '');
  expect((await ticket.innerText()).match(/master@svobodno\.demo/g)).toHaveLength(1);
  await expect(ticket).not.toContainText('Категории услуг');
  const id = await ticket.getAttribute('data-support-id');
  expect((await post(admin, `/support/${id}/resolve`, {response: '  '})).status()).toBe(400);
  await ticket.getByRole('button', {name: 'Ответить', exact: true}).click();
  await ticket.getByLabel('Ответ администратора').fill('Добавили категорию в справочник.');
  await admin.locator('#support-order').selectOption('oldest');
  const second = await post(master, '/support', {title: 'Уточнение', description: 'Дополнительная заявка'});
  const {id: secondId} = await second.json();
  expect((await post(master, '/admin/categories', {name: 'Запрещено'})).status()).toBe(403);
  const adminInbox = admin.locator('#support-list');
  await admin.clock.runFor(11000);
  await expect(adminInbox.locator('summary').first()).toContainText('Предложение новой категории');
  await expect(adminInbox.locator('summary').last()).toContainText('Уточнение');
  await expect(ticket.getByLabel('Ответ администратора')).toHaveValue('Добавили категорию в справочник.');
  await admin.getByRole('button', {name: 'Категории услуг', exact: true}).click();

  await admin.getByRole('button', {name: 'Добавить группу'}).click();
  await admin.locator('#category-editor').getByLabel('Название').fill('Домашние технологии');
  await admin.locator('#category-editor').getByRole('button', {name: 'Сохранить'}).click();
  const group = admin.locator('.directory-group').filter({hasText: 'Домашние технологии'});
  await group.locator('summary').click();
  await group.getByRole('button', {name: 'Добавить категорию'}).click();
  const editor = admin.locator('#category-editor');
  await editor.getByLabel('Название').fill('Автоматика');
  await editor.getByRole('button', {name: 'Сохранить'}).click();
  const item = admin.locator('.directory-category').filter({hasText: 'Автоматика'});
  await expect(item).toBeVisible();
  const categoryId = await item.getAttribute('data-directory-item');
  const groupId = await group.getAttribute('data-directory-group');
  expect((await post(admin, '/admin/categories', {name: '  аВТоМАТИКА  ', parent_id: groupId})).status()).toBe(409);
  await observer.clock.runFor(11000);
  await expect(observer.locator(`#category-filter option[value="${categoryId}"]`)).toHaveCount(0);

  await admin.locator('[data-tab="support"]').click();
  await expect(ticket.getByLabel('Ответ администратора')).toHaveValue('Добавили категорию в справочник.');
  await ticket.getByRole('button', {name: 'Ответить и завершить'}).click();
  await expect(ticket).toContainText('Обработано');
  await master.clock.runFor(11000);
  await expect(form.locator('select[name=category_id]').locator(`option[value="${categoryId}"]`)).toHaveCount(1);
  await notice(master, 'Ответ на обращение «Предложение новой категории»');
  await expect(master.locator('#modal')).toContainText('Добавили категорию в справочник.');
  await master.locator('#modal-close').click();
  await expect(form.getByLabel('Название')).toHaveValue('Настройка домашней автоматики');

  await form.locator('select[name=category_id]').selectOption(categoryId);
  await form.getByRole('button', {name: 'Добавить услугу'}).click();
  const service = master.locator('.service-row').filter({hasText: 'Настройка домашней автоматики'});
  await expect(service).toContainText('На проверке');
  await service.getByRole('button', {name: 'Изменить'}).click();
  const edit = master.locator('#edit-service-form');
  await edit.getByLabel('Название').fill('Локальные правки');
  await edit.getByRole('button', {name: 'Не нашли нужную категорию?'}).click();
  await dialog.getByRole('button', {name: 'Отмена'}).click();
  await expect(edit.getByLabel('Название')).toHaveValue('Локальные правки');
  await master.locator('#modal-close').click();
  const serviceId = await service.getAttribute('data-service-id');
  await admin.getByRole('button', {name: 'Заявки на услуги'}).click();
  const application = admin.locator(`[data-application-key="service-${serviceId}"]`);
  await application.locator('summary').click();
  await application.getByRole('button', {name: 'Одобрить'}).click();
  await expect(application).toHaveCount(0);
  await observer.clock.runFor(11000);
  await expect(observer.locator(`#category-filter option[value="${categoryId}"]`)).toHaveText('Автоматика');

  await admin.getByRole('button', {name: 'Категории услуг', exact: true}).click();
  await item.getByRole('button', {name: 'Изменить'}).click();
  await editor.getByLabel('Название').fill('Умный дом');
  await editor.locator('select[name=parent_id]').selectOption('it');
  await editor.getByRole('button', {name: 'Сохранить'}).click();
  await master.clock.runFor(11000);
  await expect(service).toContainText('IT и фриланс / Умный дом');
  expect((await master.request.get(`/api/services/${serviceId}`)).ok()).toBeTruthy();

  await form.locator('select[name=category_id]').selectOption(categoryId);
  await form.getByLabel('Название').fill('Сохранённый черновик');
  await admin.locator('#directory-search').fill('Умный дом');
  const renamed = admin.locator('.directory-category').filter({hasText: 'Умный дом'});
  await renamed.getByRole('button', {name: 'Удалить'}).click();
  await admin.locator('select[name=replacement_id]').selectOption('plumbing');
  await admin.getByRole('button', {name: 'Проверить перенос'}).click();
  await admin.getByRole('button', {name: 'Да, подтвердить'}).click();
  await expect(renamed).toHaveCount(0);
  await master.clock.runFor(11000);
  await expect(form).toContainText('Выбранная категория больше недоступна');
  await expect(form.getByLabel('Название')).toHaveValue('Сохранённый черновик');
  const published = await (await master.request.get(`/api/services/${serviceId}`)).json();
  expect(published.service.category_id).toBe('plumbing');

  await admin.locator('#directory-search').fill('Домашние технологии');
  await group.getByRole('button', {name: 'Удалить группу'}).click();
  await admin.getByRole('button', {name: 'Да, удалить'}).click();
  await expect(group).toHaveCount(0);
  await master.getByRole('button', {name: 'Поддержка', exact: true}).click();
  const pending = master.locator(`[data-support-id="${secondId}"]`);
  await pending.locator('summary').click();
  await pending.getByRole('button', {name: 'Отозвать обращение'}).click();
  await master.getByRole('button', {name: 'Да, подтвердить'}).click();
  await expect(pending).toContainText('Отозвано');
  await master.locator('#support-status').selectOption('resolved');
  await expect(pending).toHaveCount(0);

  await login(observer, 'Клиент');
  expect((await observer.request.get(`/api/support/${id}`)).status()).toBe(404);
 } finally {
  await master.close();
  await observer.close();
 }
});
