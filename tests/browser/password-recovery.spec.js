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

test('profile shows the login and opens recovery without leaving the signed-in account', async ({page}) => {
  const email = 'profile-recovery@example.test';
  await page.goto('/');
  await page.locator('#account').click();
  await page.locator('#auth-switch').click();
  await page.getByLabel('Ваше имя').fill('Профиль восстановления');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', {exact: true}).fill('BrowserOriginal123');
  await page.locator('#login-form button').click();
  await page.getByRole('button', {name: 'Профиль', exact: true}).click();
  const login = page.getByLabel('Логин (электронная почта)');
  await expect(login).toHaveValue(email);
  await expect(login).toHaveAttribute('readonly', '');

  const form = page.locator('#profile-form');
  const current = form.getByLabel('Текущий пароль');
  const passwords = [
    current,
    form.getByLabel('Новый пароль', {exact: true}),
    form.getByLabel('Повторите новый пароль')
  ];
  await current.fill('BrowserOriginal123');
  await form.getByRole('button', {name: 'Показать пароли'}).click();
  for (const input of passwords) await expect(input).toHaveAttribute('type', 'text');
  await form.getByRole('button', {name: 'Скрыть пароли'}).click();
  for (const input of passwords) await expect(input).toHaveAttribute('type', 'password');
  await expect(current).toHaveValue('BrowserOriginal123');

  await form.getByRole('button', {name: 'Забыли пароль?'}).click();
  const modal = page.locator('#modal');
  await expect(modal.getByLabel('Электронная почта')).toHaveValue(email);
  await modal.getByRole('button', {name: 'Отправить ссылку'}).click();
  await expect(modal.getByRole('heading', {name: 'Проверьте почту'})).toBeVisible();
  const mail = await page.request.get('/__test__/recovery-mail', {params: {email}});
  expect((await mail.json()).url).toContain('/reset-password#token=');
  await modal.getByRole('button', {name: 'Вернуться в профиль'}).click();
  await expect(modal).toBeHidden();
  await expect(login).toBeVisible();
  await expect(current).toHaveValue('BrowserOriginal123');
});
