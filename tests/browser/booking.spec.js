const {test, expect} = require('@playwright/test');

async function openBooking(page) {
  await page.goto('/');
  await page.locator('.specialist-card').first().getByRole('button', {name:'Выбрать время'}).click();
  await page.getByRole('button', {name:'Выбрать дату и время'}).click();
  await expect(page.locator('[data-day]').first()).toBeVisible();
}
async function chooseTime(page) {
  await page.locator('[data-day]').first().click();
  await page.locator('[data-slot]:enabled').first().click();
}
async function login(page) {
  await page.goto('/');
  await page.locator('#account').click();
  await page.getByRole('button', {name:'Клиент',exact:true}).click();
  await expect(page.locator('.dashboard')).toBeVisible();
}

test('service change resets the old date/time and fetches the new duration', async ({page}) => {
  await openBooking(page);
  await chooseTime(page);
  await page.getByRole('button', {name:'Продолжить'}).click();
  await expect(page.locator('.confirmation-summary')).toContainText('60 мин');
  await page.locator('#booking-service').selectOption('2');
  await expect(page.locator('#booking-notice')).toContainText('Прежние дата и время сброшены');
  await expect(page.locator('[data-day]')).toHaveCount(4);
  await expect(page.locator('[data-day][aria-pressed=true]')).toHaveCount(0);
  await expect(page.locator('[data-slot]')).toHaveCount(0);
  await expect(page.locator('#confirm-booking')).toHaveCount(0);
  await chooseTime(page);
  await expect(page.locator('[data-slot]').first()).toContainText('90 мин');
  await page.getByRole('button', {name:'Продолжить'}).click();
  await expect(page.locator('.confirmation-summary')).toContainText('Установка смесителя');
  await expect(page.locator('.confirmation-summary')).toContainText('90 мин');
});

test('late responses cannot restore slots from an older service', async ({page}) => {
  await openBooking(page);
  let release;
  const hold = new Promise(resolve => {release = resolve;});
  await page.route('**/api/slots/1?service_id=2', async route => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({response});
  });
  await page.locator('#booking-service').selectOption('2');
  await expect(page.getByText('Проверяем расписание', {exact:true})).toBeVisible();
  await page.locator('#booking-service').selectOption('1');
  await expect(page.locator('[data-day]')).toHaveCount(4);
  release();
  await page.unrouteAll({behavior:'wait'});
  await chooseTime(page);
  await expect(page.locator('[data-slot]').first()).toContainText('60 мин');
});

test('last-slot race returns current alternatives and never submits stale selection twice', async ({page, browser}) => {
  await login(page);
  await openBooking(page);
  await chooseTime(page);
  const slotId = Number(await page.locator('[data-slot][aria-pressed=true]').getAttribute('data-slot'));
  await page.getByRole('button', {name:'Продолжить'}).click();
  await page.getByLabel('Адрес выезда').fill('Киров, Ленина 10');
  const competitor = await browser.newContext();
  const session = await (await competitor.request.get('http://127.0.0.1:5051/api/session')).json();
  const auth = await (await competitor.request.post('http://127.0.0.1:5051/api/login', {headers:{'X-CSRF-Token':session.csrf},data:{email:'ivan@svobodno.demo',password:'Demo2026!'}})).json();
  let competingBooking;
  await page.route('**/api/bookings', async route => {
    const r = await competitor.request.post('http://127.0.0.1:5051/api/bookings', {headers:{'X-CSRF-Token':auth.csrf},data:{slot_id:slotId,address:'Киров, Ленина 10'}});
    expect(r.status()).toBe(201);
    competingBooking = (await r.json()).id;
    await route.continue();
  }, {times:1});
  try {
    await page.getByRole('button', {name:'Подтвердить запись'}).click();
    await expect(page.locator('#booking-notice')).toContainText('уже занят');
    await expect(page.locator('#booking-notice')).toContainText('Выбор сброшен');
    await expect(page.locator('[data-day]')).toHaveCount(4);
    await expect(page.locator('#confirm-booking')).toHaveCount(0);
    await expect(page.locator('[data-day][aria-pressed=true]')).toHaveCount(0);
    await chooseTime(page);
    expect(Number(await page.locator('[data-slot][aria-pressed=true]').getAttribute('data-slot'))).not.toBe(slotId);
  } finally {
    if (competingBooking) await competitor.request.post(`http://127.0.0.1:5051/api/bookings/${competingBooking}/cancel`, {headers:{'X-CSRF-Token':auth.csrf},data:{}});
    await competitor.close();
  }
});

test('preflight sees a newly unavailable slot without sending a booking POST', async ({page}) => {
  await login(page);
  await openBooking(page);
  await chooseTime(page);
  await page.getByRole('button', {name:'Продолжить'}).click();
  await page.getByLabel('Адрес выезда').fill('Киров, Ленина 10');
  let posts = 0;
  page.on('request', r => {if (r.method() === 'POST' && r.url().endsWith('/api/bookings')) posts++;});
  await page.route('**/api/slots/1?service_id=1', route => route.fulfill({json:{slots:[]}}));
  await page.getByRole('button', {name:'Подтвердить запись'}).click();
  await expect(page.locator('#booking-notice')).toContainText('Выбор сброшен');
  await expect(page.getByText('Свободных дат пока нет', {exact:true})).toBeVisible();
  expect(posts).toBe(0);
});

test('Russian review counts are correct including teens', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.specialist-card')).toHaveCount(6);
  const counts = [0,1,2,4,5,11,12,14,21,22,25,101,111];
  const labels = await page.evaluate(ns => ns.map(n => reviewCount(n)), counts);
  expect(labels).toEqual(['0 отзывов','1 отзыв','2 отзыва','4 отзыва','5 отзывов','11 отзывов','12 отзывов','14 отзывов','21 отзыв','22 отзыва','25 отзывов','101 отзыв','111 отзывов']);
  await expect(page.locator('.specialist-card').nth(1).locator('.rating')).toContainText('1 отзыв');
});

for (const width of [390,1280]) {
  test(`keyboard dates and non-overlapping catalog at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.goto('/');
    await expect(page.locator('.specialist-card')).toHaveCount(6);
    const launcher = await page.locator('#chat-launch').boundingBox();
    for (const card of await page.locator('.specialist-card').all()) {
      const box = await card.boundingBox();
      expect(launcher.y + launcher.height).toBeLessThanOrEqual(box.y);
    }
    await page.locator('.specialist-card').first().getByRole('button', {name:'Выбрать время'}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', {name:'Выбрать дату и время'}).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-day]')).toHaveCount(4);
    const first = await page.locator('[data-day]').first().getAttribute('data-day');
    await page.getByRole('button', {name:'Следующие даты'}).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-day]').first()).not.toHaveAttribute('data-day',first);
    await expect(page.locator('[data-day]').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await page.locator('[data-slot]:enabled').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button',{name:'Продолжить'})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#confirmation-title')).toBeFocused();
    await expect(page.locator('.confirmation-summary')).toContainText('Устранение протечки');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('#modal').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).not.toBeVisible();
    // Launcher survives repeated catalog renders and remains interactive.
    await page.getByRole('button',{name:'Сбросить',exact:true}).click();
    await page.getByRole('button',{name:'Открыть онлайн-консультацию'}).click();
    await expect(page.locator('#chat')).toBeVisible();
  });
}


test('catalog network failure has a working retry instead of an endless spinner', async ({page}) => {
  await page.route('**/api/catalog', route => route.fulfill({status:503,json:{error:'Сервис временно недоступен'}}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Не удалось загрузить страницу'})).toBeVisible();
  await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:'Повторить загрузку'}).click();
  await expect(page.locator('.specialist-card')).toHaveCount(6);
});
