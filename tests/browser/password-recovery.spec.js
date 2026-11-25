const { test, expect } = require('@playwright/test');

test.use({ trace: 'off' });

test('request an email link, reset the password and sign in again', async ({ page }) => {
  const email = 'recovery-browser@example.test';
  const originalPassword = 'BrowserOriginal123';
  const newPassword = 'BrowserReplacement123';
  await page.goto('/');
  await page.locator('#account').click();
  await page.locator('#auth-switch').click();
  await page.getByLabel('Ваше имя').fill('Тест восстановления');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(originalPassword);
  await page.locator('#login-form button').click();
  await expect(page.locator('.dashboard')).toBeVisible();
  await page.locator('#logout').click();
  await page.locator('#account').click();
  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте почту' })).toBeVisible();

  const mail = await page.request.get('/__test__/recovery-mail', { params: { email } });
  const { url } = await mail.json();
  expect(typeof url === 'string').toBe(true);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Восстановление пароля' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Новый пароль', { exact: true }).fill(newPassword);
  await page.getByLabel('Повторите пароль').fill(newPassword);
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.getByRole('heading', { name: 'Пароль изменён' })).toBeVisible();

  await page.locator('#reset-login').click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(originalPassword);
  await page.locator('#login-form button').click();
  await expect(page.locator('#login-form .form-error')).toContainText('Неверная почта или пароль');
  await page.getByLabel('Пароль', { exact: true }).fill(newPassword);
  await page.locator('#login-form button').click();
  await expect(page.locator('.dashboard')).toBeVisible();
});
