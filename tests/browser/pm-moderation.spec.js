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
    await form.getByRole('button', { name: 'Добавить услугу' }).click();
    await expect(page.locator('.service-row').filter({ hasText: title })).toContainText('На проверке');
  }
  await logout(page);
  await search(page, approved);
  await expect(page.locator('.specialist-card')).toHaveCount(0);

  await login(page, 'Администратор');
  await page.getByRole('button', { name: 'Заявки на услуги' }).click();
  const rejection = page.locator('article').filter({ has: page.getByRole('heading', { name: rejected }) });
  await rejection.getByRole('button', { name: 'Отклонить' }).click();
  await expect(rejection.getByRole('alert')).toContainText('Укажите причину');
  await rejection.getByLabel('Причина отклонения').fill(reason);
  await rejection.getByRole('button', { name: 'Отклонить' }).click();
  await expect(rejection).toHaveCount(0);
  const approval = page.locator('article').filter({ has: page.getByRole('heading', { name: approved }) });
  await approval.getByRole('button', { name: 'Одобрить' }).click();
  await expect(approval).toHaveCount(0);
  await logout(page);

  await search(page, approved);
  await expect(page.locator('.specialist-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Профиль: Алексей Морозов' }).click();
  await expect(page.locator('#booking-service')).toContainText(approved);
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
