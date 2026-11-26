const {test, expect} = require('@playwright/test');

const picture = Buffer.from(
 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64'
);

async function post(page, path, data) {
 const session = await page.request.get('/api/session');
 const {csrf} = await session.json();
 return page.request.post('/api' + path, {data, headers: {'X-CSRF-Token': csrf}});
}

async function register(page, email) {
 await page.goto('/');
 const registration = await post(page, '/register', {name:'Тестовый пользователь', username:email.split('@')[0].replace(/[^a-z0-9]/gi,'').slice(0,20), email, password:'BrowserTest123'});
 expect(registration.status()).toBe(200);
 await page.goto('/#dashboard');
 await page.reload();
 await page.getByRole('button', {name:'Профиль', exact:true}).click();
}

test('client can cancel account deletion, then confirm and return to the catalog', async ({page}) => {
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await register(page, 'profile-delete@example.test');
 const remove = page.getByRole('button', {name:'Удалить мой аккаунт'});
 const dialog = page.locator('#modal');
 await remove.click();
 await dialog.getByRole('button', {name:'Оставить аккаунт'}).click();
 await expect(dialog).toBeHidden();
 await expect(remove).toBeVisible();

 const requests = [];
 page.on('request', request => {
  if (request.method() === 'DELETE' && request.url().endsWith('/api/account')) requests.push(request);
 });
 await page.route('**/api/account', async route => {
  await expect(dialog.getByRole('button', {name:'Удалить навсегда'})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await route.continue();
 });
 await remove.click();
 await dialog.getByRole('button', {name:'Удалить навсегда'}).click();
 await expect(page).toHaveURL(/#catalog$/);
 await expect(page.locator('#account')).toContainText('Личный кабинет');
 await expect(dialog).toBeHidden();
 expect(requests).toHaveLength(1);
 expect((await (await page.request.get('/api/session')).json()).user).toBeNull();
 expect(errors).toEqual([]);
});

test('specialist updates their public name and photo, and admin removes only the professional profile', async ({browser, page}) => {
 const admin = await browser.newPage();
 try {
  await register(page, 'profile-master@example.test');
  const application = await post(page, '/specialist-applications', {
   name:'Имя из заявки', profession:'Сантехник', category:'home-repair', experience:3,
   education:'Среднее специальное', skills:'Установка оборудования', bio:'Ремонт сантехники', location:'Киров'
  });
  expect(application.status()).toBe(201);
  const {application:{id: applicationId}} = await application.json();
  await admin.goto('/');
  await admin.locator('#account').click();
  await admin.getByRole('button', {name:'Администратор', exact:true}).click();
  await expect(admin.locator('.dashboard')).toBeVisible();
  expect((await post(admin, `/admin/specialist-applications/${applicationId}/decision`, {status:'approved'})).ok()).toBeTruthy();
  const offer = await post(page, '/master/services', {
   title:'Проверка аватарки специалиста', price:500, duration:60, mode:'Выезд', category_id:'plumbing'
  });
  expect(offer.status()).toBe(201);
  const {id: serviceId} = await offer.json();
  const applications = await (await admin.request.get('/api/admin/service-applications')).json();
  const {revision} = applications.applications.find(item => item.id === serviceId);
  expect((await post(admin, `/admin/service-applications/${serviceId}/decision`, {status:'approved', revision})).ok()).toBeTruthy();

  await page.reload();
  await page.locator('#dashboard-mode').selectOption('client');
  await page.getByRole('button', {name:'Профиль', exact:true}).click();
  await page.getByRole('button', {name:'Изменить данные'}).click();
  await page.getByLabel('ФИО').fill('ФИО после обновления');
  await page.getByLabel('Электронная почта').fill('profile-updated@example.test');
  await page.getByRole('button', {name:'Сохранить изменения'}).click();
  await expect(page.locator('#toast')).toContainText('Профиль сохранён');
  const avatar = page.locator('#avatar-file');
  await avatar.setInputFiles({name:'portrait.png', mimeType:'image/png', buffer:picture});
  await page.getByRole('button', {name:'Сохранить фото'}).click();
  const accountAvatar = page.locator('#account img');
  await expect(accountAvatar).toHaveAttribute('src', /^\/uploads\//);
  const photo = await accountAvatar.getAttribute('src');
  await expect(page.locator('#avatar-preview img')).toHaveAttribute('src', photo);
  await avatar.setInputFiles({name:'broken.png', mimeType:'image/png', buffer:Buffer.from('bad image')});
  await page.getByRole('button', {name:'Сохранить фото'}).click();
  await expect(page.locator('#avatar-form [role=alert]')).toContainText('Файл повреждён');
  await expect(accountAvatar).toHaveAttribute('src', photo);
  await page.locator('#dashboard-mode').selectOption('master');
  await page.getByRole('button', {name:'Профиль', exact:true}).click();
  await expect(page.locator('#profile-view')).toContainText('ФИО после обновления');
  await expect(page.locator('#profile-view')).toContainText('profile-updated@example.test');
  await expect(page.locator('#profile-view')).toContainText('Неизменяемый логин');
  await expect(page.locator('#profile-form')).toBeHidden();

  await page.goto('/#catalog');
  const publicCard = page.getByRole('button', {name:'Профиль: ФИО после обновления'});
  await expect(publicCard.locator('img')).toHaveAttribute('src', photo);
  await publicCard.first().click();
  await expect(page.locator('#modal .profile-head img')).toHaveAttribute('src', photo);
  await page.reload();
  await expect(accountAvatar).toHaveAttribute('src', photo);

  await admin.getByRole('button', {name:'Специалисты и услуги'}).click();
  const person = admin.locator('.admin-person').filter({hasText:'ФИО после обновления'});
  await person.getByRole('button', {name:'Удалить', exact:true}).click();
  const confirmation = admin.locator('#modal');
  await confirmation.getByRole('button', {name:'Оставить', exact:true}).click();
  await expect(person).toBeVisible();
  await person.getByRole('button', {name:'Удалить', exact:true}).click();
  await confirmation.getByRole('button', {name:'Удалить навсегда'}).click();
  await expect(person).toHaveCount(0);
  await page.reload();
  await expect(publicCard).toHaveCount(0);
  const session = await (await page.request.get('/api/session')).json();
  expect(session.user.role).toBe('client');
  expect(session.user.avatar).toBe(photo);
 } finally {
  await admin.close();
 }
});
