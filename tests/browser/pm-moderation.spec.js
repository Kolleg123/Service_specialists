const { test, expect } = require('@playwright/test');

async function login(page, role) {
  await page.locator('#account').click();
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page.locator('.dashboard')).toBeVisible();
}

async function logout(page) {
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.locator('#account')).toContainText('Личный кабинет');
}

async function search(page, title) {
  await page.getByRole('textbox', { name: 'Поиск специалистов' }).fill(title);
  await page.locator('#search-form').getByRole('button', { name: 'Найти' }).click();
}

test('service applications are private until approval and decisions reach the master inbox', async ({ page }) => {
  const approved = 'Проверка водоснабжения';
  const rejected = 'Диагностика водоснабжения';
  const reason = 'Уточните название услуги';
  await page.goto('/');
  await login(page, 'Мастер');
  await page.getByRole('button', { name: 'Мои услуги' }).click();
  for (const title of [approved, rejected]) {
    const form = page.locator('#service-form');
    await form.getByLabel('Название').fill(title);
    await form.getByLabel('Стоимость').fill('800');
    await form.locator('select[name=category_group]').selectOption('home-repair');
    await form.getByRole('button', {name:/Категория услуги —/}).click();
    const menu = page.locator('.select-popup:popover-open');
    const query = title === approved ? 'отоплен' : 'вентиляция';
    await menu.getByRole('searchbox').fill(query);
    await menu.getByRole('option', {name: new RegExp(query, 'i')}).click();
    await form.getByRole('button', { name: 'Добавить услугу' }).click();
    await expect(page.locator('.service-row').filter({ hasText: title })).toContainText('На проверке');
  }
  await logout(page);
  await page.locator('#direction-filter').selectOption('home-repair');
  await expect(page.locator('#category-filter option[value="heating"]')).toHaveCount(0);
  await search(page, approved);
  await expect(page.locator('.specialist-card')).toHaveCount(0);

  await login(page, 'Администратор');
  await page.getByRole('button', { name: 'Заявки на услуги' }).click();
  const rejection = page.locator('details[data-application-key]').filter({ hasText: rejected });
  await rejection.locator('summary').click();
  await rejection.getByRole('button', { name: 'Отклонить' }).click();
  await expect(rejection.getByRole('alert')).toContainText('Укажите причину');
  await rejection.getByLabel('Причина отклонения').fill(reason);
  await rejection.getByRole('button', { name: 'Отклонить' }).click();
  await expect(rejection).toHaveCount(0);
  const approval = page.locator('details[data-application-key]').filter({ hasText: approved });
  await approval.locator('summary').click();
  await expect(approval).toContainText('Дом и ремонт / Монтаж отопления');
  await approval.getByRole('button', { name: 'Одобрить' }).click();
  await expect(approval).toHaveCount(0);
  await logout(page);

  await expect(page.locator('#direction-filter')).toHaveValue('home-repair');
  await page.locator('#category-filter').selectOption('heating');
  await search(page, approved);
  await expect(page.locator('.specialist-card')).toHaveCount(1);
  await page.locator('#mode-filter').selectOption('Онлайн');
  await expect(page.locator('.specialist-card')).toHaveCount(0);
  await page.locator('#mode-filter').selectOption('Выезд');
  await page.locator('#price-filter').selectOption('1500');
  await expect(page.locator('.specialist-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Профиль: Алексей Морозов' }).click();
  await expect(page.locator('#booking-service option:checked')).toContainText(approved);
  await expect(page.locator('#booking-service')).toContainText('Устранение протечки');
  await expect(page.locator('#booking-service')).not.toContainText(rejected);
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  await search(page, rejected);
  await expect(page.locator('.specialist-card')).toHaveCount(0);

  await login(page, 'Мастер');
  await page.getByRole('button', { name: 'Мои услуги' }).click();
  await expect(page.locator('.service-row').filter({ hasText: rejected })).toContainText(reason);
  await page.getByRole('button', { name: /Уведомления/ }).click();
  const inbox = page.locator('#notifications-panel');
  await expect(inbox).toContainText(`Услуга «${approved}» одобрена`);
  await expect(inbox).toContainText(`Услуга «${rejected}» отклонена`);
});

test('open moderation and service tabs refresh without reloading', async ({ browser, page: admin }) => {
  test.setTimeout(45000);
  const master = await browser.newPage();
  const title = 'Услуга с автообновлением';
  try {
    await admin.goto('/');
    await login(admin, 'Администратор');
    await admin.getByRole('button', { name: 'Заявки на услуги' }).click();
    await expect(admin.locator('#service-application-filter')).toHaveValue('pending');

    await master.goto('/');
    await login(master, 'Мастер');
    await master.getByRole('button', { name: 'Мои услуги' }).click();
    const form = master.locator('#service-form');
    await form.getByLabel('Название').fill(title);
    await form.getByLabel('Стоимость').fill('900');
    await form.locator('select[name=category_id]').selectOption('plumbing');
    await form.getByRole('button', { name: 'Добавить услугу' }).click();
    const service = master.locator('.service-row').filter({ hasText: title });
    await expect(service).toContainText('На проверке');

    const application = admin.locator('details[data-application-key]').filter({ hasText: title });
    await expect(application).toBeVisible({ timeout: 15000 });
    await application.locator('summary').click();
    await application.getByRole('button', { name: 'Одобрить' }).click();
    await expect(application).toHaveCount(0);
    await admin.locator('#service-application-filter').selectOption('approved');
    await expect(application).toContainText('Одобрена');
    await expect(service).toContainText('Одобрена', { timeout: 15000 });
  } finally {
    await master.close();
  }
});
