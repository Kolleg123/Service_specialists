const {test, expect} = require('@playwright/test');
const fs = require('node:fs');

async function capture(page, name, width, fullPage = false) {
  if (!process.env.CAPTURE_DESIGN) return;
  fs.mkdirSync('docs/design/after', {recursive:true});
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:`docs/design/after/${name}-${width}.png`,fullPage,animations:'disabled'});
}

for (const width of [390,1280]) {
  test(`design states: loading, empty, error, retry, confirmation at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.goto('/');
    await expect(page.locator('.specialist-card')).toHaveCount(6);
    for (const img of await page.locator('.specialist-card img').all()) {
      await img.scrollIntoViewIfNeeded();
      await expect(img).toHaveJSProperty('complete',true);
    }
    await page.evaluate(()=>scrollTo(0,0));
    await capture(page,'catalog',width,true);
    await page.locator('[data-profile="1"]').first().click();
    await expect(page.locator('#choose-date')).toBeVisible();
    await capture(page,'service',width);
    let release;
    const hold = new Promise(resolve => {release = resolve;});
    await page.route('**/api/slots/1?service_id=1', async route => {await hold;await route.fulfill({json:{slots:[]}});});
    await page.getByRole('button',{name:'Выбрать дату и время'}).click();
    await expect(page.getByText('Проверяем расписание',{exact:true})).toBeVisible();
    await capture(page,'loading',width);
    release();
    await expect(page.getByText('Свободных дат пока нет',{exact:true})).toBeVisible();
    await capture(page,'empty',width);
    await page.unrouteAll({behavior:'wait'});
    await page.route('**/api/slots/1?service_id=1', route=>route.fulfill({status:503,json:{error:'Сервис расписания временно недоступен. Попробуйте ещё раз.'}}));
    await page.getByRole('button',{name:'Обновить расписание'}).click();
    await expect(page.getByText('Не удалось загрузить время',{exact:true})).toBeVisible();
    await capture(page,'error',width);
    await page.unrouteAll({behavior:'wait'});
    await page.getByRole('button',{name:'Повторить загрузку'}).click();
    await expect(page.locator('[data-day]')).toHaveCount(4);
    await page.getByRole('button',{name:'Следующие даты'}).click();
    await page.locator('[data-day]').first().click();
    await page.locator('[data-slot]:enabled').first().click();
    await capture(page,'time',width);
    // All rendered date/time controls stay within the dialog and viewport.
    for (const el of await page.locator('.date-navigation button, [data-day], [data-slot]').all()) {
      const box=await el.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x+box.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole('button',{name:'Продолжить'}).click();
    await expect(page.locator('.confirmation-summary')).toContainText('Устранение протечки');
    await capture(page,'confirmation',width);
    expect(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test('searchable dropdown supports touch, keyboard and Escape inside the booking dialog', async ({browser, baseURL}) => {
  const page = await browser.newPage({baseURL,viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  try {
    await page.goto('/');
    const trigger = page.getByRole('button',{name:/Направление —/});
    await trigger.tap();
    const menu = page.locator('.select-popup:popover-open');
    const search = menu.getByRole('searchbox');
    await expect(search).toBeFocused();
    await search.fill('образ');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#direction-filter')).toHaveValue('education');
    await expect(trigger).toHaveAttribute('aria-expanded','false');
    await page.getByRole('button',{name:/Профиль: Анна Лебедева/}).tap();
    const service = page.getByRole('button',{name:/Услуга —/});
    await service.tap();
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(service).toBeFocused();
    await expect(page.locator('#modal')).toBeVisible();
  } finally {
    await page.close();
  }
});
