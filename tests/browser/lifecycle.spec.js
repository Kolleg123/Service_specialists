const {test, expect} = require('@playwright/test');
const fs = require('node:fs');

async function post(context, url, data) {
  const session = await (await context.request.get('/api/session')).json();
  return context.request.post(url, {headers:{'X-CSRF-Token':session.csrf},data});
}
function shifted(start, seconds) {
  // Arithmetic on naive wall-clock components, matching Europe/Kirov API fields.
  return new Date(new Date(start + 'Z').getTime() + seconds * 1000).toISOString().slice(0,19);
}
async function update(page) {
  await page.getByRole('button',{name:'Обновить статусы'}).click();
  await expect(page.locator('#dashboard-update-status')).toHaveText('Статусы обновлены');
}
async function capture(page, name, width) {
  if (!process.env.CAPTURE_LIFECYCLE) return;
  fs.mkdirSync('docs/lifecycle/screenshots',{recursive:true});
  await page.setViewportSize({width,height:1000});
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:`docs/lifecycle/screenshots/${name}-${width}.png`,fullPage:true,animations:'disabled'});
}

test('client and assigned master agree on the full timed booking lifecycle', async ({browser}) => {
  const customer = await browser.newContext({baseURL:'http://127.0.0.1:5051'});
  const specialist = await browser.newContext({baseURL:'http://127.0.0.1:5051'});
  const page = await customer.newPage(), master = await specialist.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));master.on('pageerror',e=>errors.push(e.message));
  try {
    const register = await post(customer,'/api/register',{name:'Проверка времени',email:'lifecycle@example.test',password:'Lifecycle2026!'});
    expect(register.status()).toBe(200);
    await page.goto('/');
    await page.locator('.specialist-card').first().getByRole('button',{name:'Выбрать время'}).click();
    await page.getByRole('button',{name:'Выбрать дату и время'}).click();
    await page.locator('[data-day]').first().click();
    await page.locator('[data-slot]:enabled').first().click();
    await page.getByRole('button',{name:'Продолжить'}).click();
    await page.getByLabel('Адрес выезда').fill('Киров, Ленина 10');
    await page.getByRole('button',{name:'Подтвердить запись'}).click();
    await expect(page.locator('.booking-row')).toHaveCount(1);
    const data = await (await customer.request.get('/api/dashboard')).json();
    const booking = data.bookings[0];
    const row = page.locator(`[data-booking-id="${booking.id}"]`);
    expect((await post(specialist,'/api/login',{email:'master@svobodno.demo',password:'Demo2026!'})).status()).toBe(200);
    await master.goto('/#dashboard');
    const masterRow = master.locator(`[data-booking-id="${booking.id}"]`);
    await master.locator('#booking-status').selectOption('confirmed');
    await expect(row.locator('.badge')).toHaveText('Предстоит');
    await expect(masterRow.locator('.badge')).toHaveText('Предстоит');
    await expect(row.getByRole('button',{name:'Отменить запись'})).toBeVisible();
    await expect(masterRow.getByRole('button',{name:'Завершить встречу'})).toHaveCount(0);

    expect((await post(customer,'/__test__/clock',{now:shifted(booking.starts_at,1)})).status()).toBe(200);
    await update(page);await update(master);
    await expect(row.locator('.badge')).toHaveText('Идёт встреча');
    await expect(masterRow.locator('.badge')).toHaveText('Идёт встреча');
    await expect(row.getByRole('button',{name:'Отменить запись'})).toHaveCount(0);
    await expect(row.getByRole('button',{name:'Оставить отзыв'})).toHaveCount(0);
    await expect(masterRow.getByRole('button',{name:'Завершить встречу'})).toHaveCount(0);
    await expect(masterRow).toContainText('Завершение доступно с');
    expect((await post(specialist,`/api/bookings/${booking.id}/complete`,{})).status()).toBe(409);
    expect((await post(customer,'/api/reviews',{booking_id:booking.id,rating:5,content:'Слишком рано'})).status()).toBe(403);
    for(const width of [390,1280]) {
      await capture(page,'client-in-progress',width);await capture(master,'master-in-progress',width);
    }

    // Exact end, not one minute after it: completion is allowed at equality.
    expect((await post(customer,'/__test__/clock',{now:shifted(booking.starts_at,booking.duration*60)})).status()).toBe(200);
    await update(page);await update(master);
    await expect(row.locator('.badge')).toHaveText('Ожидает завершения');
    await expect(masterRow.locator('.badge')).toHaveText('Ожидает завершения');
    await expect(row.getByRole('button',{name:'Оставить отзыв'})).toHaveCount(0);
    await expect(masterRow.getByRole('button',{name:'Завершить встречу'})).toBeVisible();
    for(const width of [390,1280]) await capture(master,'master-ready',width);
    await masterRow.getByRole('button',{name:'Завершить встречу'}).click();
    await master.locator('#booking-status').selectOption('all');
    await expect(masterRow.locator('.badge')).toHaveText('Завершена');
    await update(page);
    await expect(row.locator('.badge')).toHaveText('Завершена');
    await expect(row.getByRole('button',{name:'Оставить отзыв'})).toBeVisible();
    expect((await post(specialist,`/api/bookings/${booking.id}/complete`,{})).status()).toBe(409);
    await row.getByRole('button',{name:'Оставить отзыв'}).click();
    await page.getByLabel('Ваш отзыв').fill('Услуга завершилась вовремя, всё отлично!');
    await page.getByRole('button',{name:'Отправить отзыв'}).click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await expect(row).toContainText('Отзыв уже отправлен');
    await expect(row.getByRole('button',{name:'Оставить отзыв'})).toHaveCount(0);
    for(const width of [390,1280]) {
      await page.setViewportSize({width,height:1000});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await capture(page,'client-completed',width);
    }
    expect(errors).toEqual([]);
  } finally {
    await post(customer,'/__test__/clock',{now:null});
    await customer.close();await specialist.close();
  }
});
