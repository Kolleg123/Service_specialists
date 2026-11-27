const {randomUUID} = require('node:crypto');
const {test, expect} = require('@playwright/test');

async function login(page, role) {
  await page.goto('/');
  await page.locator('#account').click();
  await page.getByRole('button', {name: role, exact: true}).click();
  await expect(page.locator('.dashboard')).toBeVisible();
}

async function post(page, path, data) {
  const {csrf} = await (await page.request.get('/api/session')).json();
  return page.request.post(path, {headers: {'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID()}, data});
}

for (const {width, specialist, service, title, travel} of [
  {width: 390, specialist: 3, service: 5, title: 'Стрижка и укладка', travel: false},
  {width: 1280, specialist: 1, service: 1, title: 'Устранение протечки', travel: true}
]) {
  test(`visit details and newest booking at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 900});
    const username = `visit-test-${width}`;
    const registered = await post(page, '/api/register', {
      name: 'Проверка записи', username, email: `${username}@example.test`, password: 'VisitTest2026!'
    });
    expect(registered.status()).toBe(200);
    const {slots} = await (await page.request.get(`/api/slots/${specialist}?service_id=${service}`)).json();
    const previous = await post(page, '/api/bookings', {
      slot_id: slots.at(-1).id, address: travel ? 'Киров, ул. Тестовая, 40' : ''
    });
    expect(previous.status()).toBe(201);
    const {id: previousId} = await previous.json();
    expect((await post(page, `/api/bookings/${previousId}/cancel`, {})).status()).toBe(200);
    await page.goto('/');
    await page.locator(`button.photo-button[data-profile="${specialist}"]`).click();

    const place = page.locator('#service-visit');
    await expect(place).toContainText(travel ? 'Специалист приедет по адресу' : 'Адрес приёма');
    await expect(place).toContainText('появятся в личном кабинете после записи');
    await expect(page.locator('#booking-flow')).not.toContainText('Запись используется для знакомства с сервисом.');
    await expect(page.locator('#booking-flow')).not.toContainText('+1 (202) 555-010');

    await page.getByRole('button', {name: 'Выбрать дату и время'}).click();
    await page.locator('[data-day]').last().click();
    await page.locator('[data-slot]:enabled').first().click();
    await page.getByRole('button', {name: 'Продолжить'}).click();
    await expect(place).toContainText(travel ? 'Специалист приедет по адресу' : 'Адрес приёма');
    const address = page.getByLabel('Адрес выезда');
    if (travel) await address.fill('Киров, ул. Тестовая, 42');
    else await expect(address).toHaveCount(0);

    const result = page.waitForResponse(r => r.url().endsWith('/api/bookings') && r.request().method() === 'POST');
    await page.getByRole('button', {name: 'Подтвердить запись'}).click();
    const response = await result;
    expect(response.status()).toBe(201);
    const {id} = await response.json();
    const first = page.locator('#booking-list .booking-row').first();
    await expect(first).toHaveAttribute('data-booking-id', String(id));
    await expect(first).toContainText(title);
    await expect(first).toContainText(travel ? 'Киров, ул. Тестовая, 42' : 'Киров, вымышленная ул. Локонная, 14');
    await expect(first.getByRole('link', {name: `+1 (202) 555-010${specialist}`})).toHaveAttribute(
      'href', `tel:+1202555010${specialist}`
    );
    await expect(first).toContainText('Запись используется для знакомства с сервисом.');
    await page.reload();
    await expect(first).toHaveAttribute('data-booking-id', String(id));
    await page.locator('#booking-status').selectOption('cancelled');
    await expect(first).toHaveAttribute('data-booking-id', String(previousId));
    await page.locator('#booking-status').selectOption('all');
    await expect(first).toHaveAttribute('data-booking-id', String(id));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await post(page, `/api/bookings/${id}/cancel`, {})).status()).toBe(200);
  });
}

test('the mobile service editor shows the address only for relevant formats', async ({page}) => {
  await page.setViewportSize({width: 390, height: 850});
  await login(page, 'Мастер');
  await page.getByRole('button', {name: 'Мои услуги'}).click();
  const form = page.locator('#service-form');
  const mode = form.locator('select[name=mode]');
  const address = form.getByLabel('Адрес оказания услуги');
  await expect(address).toBeHidden();
  await mode.selectOption('У специалиста');
  await expect(address).toBeVisible();
  expect(await address.evaluate(input => input.required)).toBe(true);
  await mode.selectOption('Онлайн');
  await expect(address).toBeHidden();
  await expect(form.getByLabel('Контактный телефон')).toBeVisible();
  await expect(form.getByLabel('Инструкции для клиента')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
