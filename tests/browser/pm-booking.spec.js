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

const testEmail = 'weekly-schedule-test@example.test';
const testPassword = 'WeeklyTest2026!';

async function loginCustomer(page, register = false) {
  await page.locator('#account').click();
  if (register) {
    await page.getByRole('button', { name: 'Нет аккаунта? Зарегистрироваться' }).click();
    await page.getByLabel('Ваше имя').fill('Клиент расписания');
  }
  await page.getByLabel('Электронная почта').fill(testEmail);
  await page.getByLabel('Пароль', { exact: true }).fill(testPassword);
  await page.locator('#login-form').getByRole('button').click();
  await expect(page.locator('.dashboard')).toBeVisible();
}

async function configure(page, mode, specialist = 'Преподаватель') {
  await login(page, specialist);
  await page.getByRole('button', { name: 'Моё расписание' }).click();
  await page.getByLabel('Режим записи').selectOption(mode);
  if (mode === 'time') {
    await page.getByLabel('Начало обеда').fill('12:00');
    await page.getByLabel('Окончание обеда').fill('13:00');
  }
  if (mode === 'day') await page.getByLabel('Дневной лимит').fill('1');
  await page.getByRole('button', { name: 'Сохранить расписание' }).click();
  await expect(page.locator('#toast')).toHaveText('Расписание сохранено');
  await logout(page);
}

async function chooseLesson(page, mode) {
  await loginCustomer(page);
  await page.getByRole('link', { name: 'Найти специалиста', exact: true }).click();
  await page.getByRole('button', { name: 'Профиль: Анна Лебедева' }).click();
  await page.locator('#choose-date').click();
  await page.locator('[data-day]').first().click();
  if (mode === 'time') {
    await expect(page.locator('#times')).toBeVisible();
    await expect(page.locator('[data-slot]').filter({ hasText: '12:00' })).toHaveCount(0);
    await page.locator('[data-slot]').first().click();
  } else {
    await expect(page.locator('#times')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.locator('.confirmation-summary dt').filter({ hasText: 'Дата' }))
    .toHaveText(mode === 'day' ? 'Дата' : 'Дата и время · UTC+3');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await expect(page.locator('#toast')).toContainText('Вы записаны');
  const booking = page.locator('.booking-row').filter({ hasText: 'Английский индивидуально' })
    .filter({ has: page.getByRole('button', { name: 'Отменить запись', exact: true }) });
  await booking.getByRole('button', { name: 'Отменить запись', exact: true }).click();
  await page.getByRole('button', { name: 'Да, подтвердить' }).click();
  await expect(page.locator('#toast')).toContainText('Запись отменена');
  await logout(page);
}

test('weekly timed slots and date-only bookings work in the existing pages', async ({ page }) => {
  await page.goto('/');
  await loginCustomer(page, true);
  await logout(page);
  await configure(page, 'time');
  await chooseLesson(page, 'time');
  await configure(page, 'day');
  await chooseLesson(page, 'day');
  await configure(page, 'manual');
});
