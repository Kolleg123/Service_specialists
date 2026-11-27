const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const date = s => new Date(s.length === 10 ? s + 'T12:00' : s).toLocaleDateString('ru-RU', {day:'numeric', month:'long'});
const reviewCount = n => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'отзывов' : n % 10 === 1 ? 'отзыв' : n % 10 >= 2 && n % 10 <= 4 ? 'отзыва' : 'отзывов'}`;
const time = s => s.slice(11,16);
const localNow = () => new Date().toLocaleString('sv-SE', {timeZone:'Europe/Kirov'}).replace(' ', 'T').slice(0,16);
const serviceStatus = {pending:'На проверке',approved:'Одобрена',rejected:'Отклонена'};
let state = {user:null, csrf:'', specialists:[], categories:[], categoryGroup:'', category:'', query:'', sort:'recommended', maxPrice:'', mode:''};
let dashboardTab = 'bookings';
let dashboardMode = 'master';
let dashboardStatusFilter = 'all';
let dashboardRefreshTimer;
let dashboardRequest = 0;
let catalogRequest = 0;
const chatLauncher = $('#chat-launch');
async function api(path, data, method = data === undefined ? 'GET' : 'POST', extraHeaders = {}) {
  const multipart = data instanceof FormData;
  const headers = {'X-CSRF-Token': state.csrf, ...extraHeaders};
  if (!multipart) headers['Content-Type'] = 'application/json';
  const body = multipart || data === undefined ? data : JSON.stringify(data);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api' + path, {method, signal:controller.signal, headers, body});
    let result; try { result = await response.json(); } catch { throw new Error('Сервер временно недоступен'); }
    if (!response.ok) { const error = new Error(result.error || 'Не удалось выполнить действие'); error.status = response.status; throw error; }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите попытку.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.');
    throw error;
  } finally { clearTimeout(timeout); }
}
const pendingOperations = new Map();

function uncertainOperation(error) {
 return !error.status || [408, 429].includes(error.status) || error.status >= 500;
}

function operationIdentity(path, data) {
 const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
 return JSON.stringify([state.demoMode, state.user.id, path, entries]);
}

async function submitOperation(path, data) {
 const identity = operationIdentity(path, data);
 let key = pendingOperations.get(identity);
 if (!key) {
  key = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  pendingOperations.set(identity, key);
 }
 try {
  const result = await api(path, data, 'POST', {'Idempotency-Key': key});
  pendingOperations.delete(identity);
  return result;
 } catch (error) {
  if (!uncertainOperation(error) && ![401, 403].includes(error.status)) pendingOperations.delete(identity);
  throw error;
 }
}

function toast(message, type) {
 const node = $('#toast');
 const inferred = type || (/ошиб|не удалось|недоступ|не отвечает|нет связи|повторите|не удалось|не создан/i.test(String(message)) ? 'error' : 'success');
 node.textContent = message;
 node.dataset.type = inferred;
 node.setAttribute('role', inferred === 'error' ? 'alert' : 'status');
 node.setAttribute('aria-live', inferred === 'error' ? 'assertive' : 'polite');
 node.classList.add('show');
 clearTimeout(toast.timer);
 toast.timer = setTimeout(() => node.classList.remove('show'), 4500);
}
function modal(html) {$('#modal-content').innerHTML = html; if (!$('#modal').open) $('#modal').showModal();}
function closeModal() {
 if (!$('#modal form[data-pending-deletion]')) $('#modal').close();
}
function updateAccount() {
 const user = state.user;
 const avatar = user?.avatar ? `<img class="avatar avatar-img" src="${esc(user.avatar)}" alt="">` :
  `<span class="avatar">${esc(user?.name[0])}</span>`;
 $('#account').innerHTML = user ? `${esc(user.name.split(' ')[0])} ${avatar}` : 'Личный кабинет <span>↗</span>';
}
function endSession({csrf}) {
 stopNotificationPolling();
 clearTimeout(dashboardRefreshTimer);
 state.user = null;
 state.csrf = csrf;
 specialistApplicationFilter = 'pending';
 serviceApplicationFilter = 'pending';
 Object.assign(supportView, {status:'', order:'newest'});
 supportView.open.clear();
 supportView.drafts.clear();
 Object.assign(directoryView, {query:'', order:'asc'});
 directoryView.open.clear();
 Object.assign(adminFilters, defaultAdminFilters);
 dashboardMode = 'master';
 dashboardTab = 'bookings';
 dashboardStatusFilter = 'all';
 updateAccount();
 location.hash = 'catalog';
 catalog();
}
async function refreshCatalog() {const data = await api('/catalog'); state.specialists = data.specialists; state.categories = data.categories;}
function card({specialist: s, service, price, category}) {
 const profileAttributes = `data-profile="${s.id}" data-preferred-service="${service.id}"`;
 return `<article class="specialist-card"><button class="photo-button" ${profileAttributes} aria-label="Профиль: ${esc(s.name)}"><img src="${esc(s.photo)}" alt="Фото специалиста ${esc(s.name)}" loading="lazy">${category ? `<span class="photo-label">${esc(category)}</span>` : ''}<span class="photo-arrow">↗</span></button><div class="card-body"><div class="rating">★ <b>${s.rating ?? 'Новый'}</b><span>${s.reviews.length ? reviewCount(s.reviews.length) : 'Пока без отзывов'}</span></div><button class="name-link" ${profileAttributes}>${esc(s.name)}</button><p class="profession">${esc(s.profession)} <span>· ${s.experience} лет опыта</span></p><p class="location">⌖ ${esc(s.location)}</p><div class="tags">${s.skills.split(',').slice(0,2).map(x => `<span>${esc(x)}</span>`).join('')}</div><div class="card-bottom"><div><small>Стоимость услуг</small><strong>от ${money(price)}</strong></div><button class="button pale" ${profileAttributes}>Выбрать время <span>↗</span></button></div></div></article>`;
}
function catalog() {
 $('#app').innerHTML = `<section class="hero"><div class="hero-text"><span class="eyebrow"><i></i> ХОРОШИЕ СПЕЦИАЛИСТЫ РЯДОМ</span><h1>Нужный человек.<br><em>В удобное время.</em></h1><p>От ремонта крана до нового увлечения — найдите своего<br class="desktop"> специалиста и запишитесь без лишних звонков.</p><form id="search-form" class="search-box"><span>⌕</span><input id="search-input" placeholder="Какая помощь вам нужна?" aria-label="Поиск специалистов" value="${esc(state.query)}"><button class="button">Найти <span>↗</span></button></form><div class="popular">Например: <button data-query="Сантехник">сантехник</button><button data-query="Стрижка">стрижка</button><button data-query="Английский">английский</button></div><div class="hero-proof"><div class="mini-faces">${state.specialists.slice(0,3).map(s=>`<img src="${s.photo}" alt="">`).join('')}</div><div><strong>Меньше поисков. Больше жизни.</strong><span>Свободные слоты и понятные цены</span></div></div></div><div class="hero-art"><img src="/static/photos/hero.jpg" alt="Стилист работает над причёской клиента в салоне"><span class="art-caption">Хорошая работа<br>начинается с человека.</span><div class="float-card"><span class="check-round">✓</span><div><strong>Всё складывается</strong><span>Выбирайте время — остальное за нами</span></div><span>✧</span></div><div class="art-top">СВОБОДНО ДЛЯ ВАШИХ ПЛАНОВ <span>↗</span></div></div></section>
 <section class="catalog-section" id="catalog-section"><div class="section-title"><div><span class="eyebrow">НАЙДИТЕ СВОЕГО</span><h2>Специалисты, которым по пути с вами</h2></div><span class="catalog-count"></span></div><div class="filter-bar"><div class="filters"><label><span>Направление</span><select id="direction-filter"></select></label><label><span>Категория</span><select id="category-filter"></select></label><label><span>Формат</span><select id="mode-filter"><option value="">Любой формат</option>${['Выезд','У специалиста','Онлайн','Группа'].map(m=>`<option ${state.mode===m?'selected':''}>${m}</option>`).join('')}</select></label><label><span>Цена до</span><select id="price-filter"><option value="">Любая цена</option>${[1500,2500,5000].map(n=>`<option value="${n}" ${state.maxPrice==n?'selected':''}>${money(n)}</option>`).join('')}</select></label><button id="reset-filter" class="text-button">Сбросить</button></div><label class="sort-label">Сначала <select id="sort-filter"><option value="recommended">рекомендуемые</option><option value="price">недорогие</option><option value="rating">с высоким рейтингом</option><option value="experience">опытные</option></select></label></div><div id="cards" class="card-grid"></div></section>
 <section class="help-banner"><div class="help-symbol">✧</div><div><h2>Не знаете, кого выбрать?</h2><p>Опишите задачу — наш помощник подскажет, к кому обратиться.</p></div><button class="button light" id="banner-chat">Спросить помощника ↗</button></section>
 <section class="how" id="how-section"><div><span class="eyebrow">ВСЁ ПРОСТО</span><h2>От задачи до встречи —<br>три шага</h2></div>${[['01','Найдите специалиста','Выберите категорию, сравните услуги и прочитайте отзывы.'],['02','Выберите время','Только доступные слоты. Дата, время и стоимость — сразу перед вами.'],['03','Занимайтесь своим','Ваша запись в личном кабинете. Планы изменились? Её можно отменить.']].map(([n,t,p])=>`<article><span>${n}</span><h3>${t}</h3><p>${p}</p></article>`).join('')}</section>`;
 $('#sort-filter').value = state.sort;
 $('#search-form').onsubmit = async e => {e.preventDefault(); state.query = $('#search-input').value.trim(); drawCards(); if (['client','master'].includes(state.user?.role) && state.query) {try {await api('/searches',{query:state.query});} catch(e){toast(e.message);}} $('#catalog-section').scrollIntoView({behavior:'smooth'});};
 $$('[data-query]').forEach(b=>b.onclick=()=>{$('#search-input').value=b.dataset.query; $('#search-form').requestSubmit();});
 bindCatalogCategories();
 $('#mode-filter').onchange=e=>{state.mode=e.target.value;drawCards();};
 $('#price-filter').onchange=e=>{state.maxPrice=e.target.value;drawCards();};
 $('#sort-filter').onchange=e=>{state.sort=e.target.value;drawCards();};
 $('#reset-filter').onclick=()=>{state.categoryGroup='';state.category='';state.mode='';state.maxPrice='';state.query='';catalog();};
 $('#banner-chat').onclick=openChat;
 $('#catalog-section').insertBefore(chatLauncher,$('.filter-bar'));
 drawCards();
}
function drawCards() {
 const query = state.query.toLowerCase();
 const labels = new Map(state.categories.flatMap(group => [
  [group.id, group.name], ...group.categories.map(category => [category.id, category.name])
 ]));
 const list = [];
 for (const specialist of state.specialists) {
  const profileMatches = [specialist.name, specialist.profession, specialist.skills]
   .some(value => value?.toLowerCase().includes(query));
  const services = specialist.services.filter(service =>
   (!state.categoryGroup || service.category_group_id === state.categoryGroup) &&
   (!state.category || service.category_id === state.category) &&
   (!state.mode || service.mode === state.mode) &&
   (!state.maxPrice || service.price <= Number(state.maxPrice)) &&
   (!query || profileMatches || [service.title, labels.get(service.category_id), labels.get(service.category_group_id)]
    .some(value => value?.toLowerCase().includes(query))));
  if (services.length) {
   const service = services[0];
   list.push({specialist, service, price: Math.min(...services.map(item => item.price)),
    category: labels.get(service.category_id)});
  }
 }
 if (state.sort === 'price') list.sort((a, b) => a.price - b.price);
 if (state.sort === 'rating') list.sort((a, b) => (b.specialist.rating || 0) - (a.specialist.rating || 0));
 if (state.sort === 'experience') list.sort((a, b) => b.specialist.experience - a.specialist.experience);
 $('#cards').innerHTML = list.length ? list.map(card).join('') :
  '<div class="empty"><span>⌕</span><h3>Пока никого не нашли</h3><p>Попробуйте другую задачу или сбросьте фильтры.</p></div>';
 $('.catalog-count').textContent = `Найдено: ${list.length}`;
 bindProfiles($('#cards'));
}
function bindProfiles(root=document) {
 $$('[data-profile]', root).forEach(button => button.onclick = () =>
  profile(Number(button.dataset.profile), Number(button.dataset.preferredService))
   .catch(error => toast(error.message)));
}
function requestPasswordReset() {
 modal('<span class="eyebrow">ВОССТАНОВЛЕНИЕ ДОСТУПА</span><h2>Забыли пароль?</h2><p class="muted">Укажите почту, связанную с аккаунтом. Если адрес зарегистрирован, мы отправим инструкцию.</p><form id="reset-request-form"><label class="field">Электронная почта<input name="email" type="email" autocomplete="email" required maxlength="120"></label><p class="form-error" role="alert"></p><button class="button full">Отправить ссылку →</button></form>');
 const form=$('#reset-request-form');
 form.onsubmit=async e=>{e.preventDefault();const button=$('button',form);button.disabled=true;try{const r=await api('/password-reset/request',{email:new FormData(form).get('email')});modal('<h2>Проверьте почту</h2><p class="muted">'+esc(r.message)+'</p><button id="back-login" class="button full">Вернуться ко входу</button>');$('#back-login').onclick=()=>login();}catch(err){$('.form-error',form).textContent=err.message;}finally{button.disabled=false;}};
}
function resetPasswordPage() {
 const token=new URLSearchParams(location.hash.slice(1)).get('token')||
  new URLSearchParams(location.search).get('token')||'';
 history.replaceState(null,'','/reset-password');
 modal('<span class="eyebrow">НОВЫЙ ПАРОЛЬ</span><h2>Восстановление пароля</h2><p class="muted">Придумайте пароль длиной от 8 до 128 символов.</p><form id="reset-confirm-form"><label class="field">Новый пароль<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label><label class="field">Повторите пароль<input name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label><p class="form-error" role="alert"></p><button class="button full">Изменить пароль →</button></form>');
 const form=$('#reset-confirm-form');
 form.onsubmit=async e=>{e.preventDefault();const button=$('button',form);button.disabled=true;try{const values=Object.fromEntries(new FormData(form));const result=await api('/password-reset/confirm',{token,...values});state.user=null;state.csrf=result.csrf;updateAccount();history.replaceState(null,'','/');void route();modal('<h2>Пароль изменён</h2><p class="muted">Теперь войдите с новым паролем.</p><button id="reset-login" class="button full">Войти</button>');$('#reset-login').onclick=()=>login();}catch(err){$('.form-error',form).textContent=err.message;}finally{button.disabled=false;}};
}
function login(after=null,register=false) {
 modal(`<span class="eyebrow">ВАШЕ ВРЕМЯ — В ВАШИХ РУКАХ</span><h2>${register?'Создать аккаунт':'Рады видеть вас'}</h2><p class="muted">${register?'Сохраните свои записи, отзывы и историю поиска.':'Войдите, чтобы управлять записями и расписанием.'}</p><form id="login-form">${register?'<label class="field">Ваше имя<input name="name" required minlength="2" maxlength="80" autocomplete="name"></label><label class="field">Логин<input name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.\\-]+" autocomplete="username" aria-describedby="username-hint"></label><small id="username-hint" class="muted">3–30 символов: латинские буквы, цифры, точка, дефис или подчёркивание. После регистрации логин нельзя изменить.</small><label class="field">Электронная почта<input name="email" type="email" autocomplete="email" required maxlength="120"></label>':''}${!register?'<label class="field">Логин или почта<input name="identifier" type="text" autocomplete="username" maxlength="120" required></label>':''}<label class="field">Пароль<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="8" maxlength="128" required></label><p class="form-error" role="alert"></p><button class="button full">${register?'Зарегистрироваться':'Войти'} →</button></form>${!register?'<button id="forgot-password" class="text-button auth-switch">Забыли пароль?</button>':''}<button type="button" id="auth-switch" class="text-button auth-switch">${register?'Уже есть аккаунт? Войти':'Нет аккаунта? Зарегистрироваться'}</button>${!register && state.demoMode?`<div class="demo-access"><span class="eyebrow">ПОПРОБУЙТЕ ДЕМО</span><p>Вымышленные данные, настоящие сценарии</p><div>${[['client','Клиент'],['master','Мастер'],['teacher','Преподаватель'],['admin','Администратор']].map(([k,v])=>`<button data-demo="${k}" class="button outline">${v}</button>`).join('')}</div><small>Общие демо-аккаунты. Не вводите личные данные.</small></div>`:''}`);
 const form=$('#login-form');
 async function submit(data){const button=$('button',form);button.disabled=true;try{const res=await api(register?'/register':'/login',data);state.user=res.user;state.csrf=res.csrf;updateAccount();closeModal(); if(after)await after();else{location.hash='dashboard';await dashboard();}}catch(e){$('.form-error',form).textContent=e.message;}finally{button.disabled=false;}}
 form.onsubmit=e=>{e.preventDefault();submit(Object.fromEntries(new FormData(form)));};
 $$('[data-demo]').forEach(b=>b.onclick=()=>submit({email:b.dataset.demo+'@svobodno.demo',password:'Demo2026!'}));
 $('#auth-switch').addEventListener('click',()=>login(after,!register));
 $('#forgot-password')?.addEventListener('click',requestPasswordReset);
}
let notificationTimer;
const notificationRequests = new Map();
let refreshNotifications;

function stopNotificationPolling() {
 clearInterval(notificationTimer);
 refreshNotifications = null;
}

document.addEventListener('visibilitychange', () => {
 if (!document.hidden) refreshNotifications?.();
});
window.addEventListener('online', () => refreshNotifications?.());

function bindNotifications(user) {
 stopNotificationPolling();
 const toggle=$('#notifications-toggle'), panel=$('#notifications-panel');
 const count=$('.notification-count',toggle);
 const sessionToken = state.csrf;
 const isCurrent=()=>panel.isConnected && state.user?.id===user.id && state.csrf===sessionToken && location.hash==='#dashboard';
 let notifications=[];
 let busy=false;
 let loaded=false;
 let snapshot;

 function render() {
  const unread=notifications.filter(n=>!n.is_read).length;
  count.textContent=unread;
  count.classList.toggle('hidden',!unread);
  toggle.setAttribute('aria-label',unread?`Уведомления, непрочитанных: ${unread}`:'Уведомления');
  const scroll = $('.notification-list',panel)?.scrollTop ?? 0;
  panel.innerHTML=`<div class="notification-panel-head">
   <div><strong>Уведомления</strong><span role="status">${unread?`Непрочитанных: ${unread}`:'Непрочитанных нет'}</span></div>
   <button id="notifications-mark-read" class="text-button" ${unread?'':'disabled'}>Прочитать всё</button>
  </div><div class="notification-list">${notifications.length?notifications.map(n=>`
   <article class="notification-item ${n.is_read?'read':'unread'}">
    <span class="notification-dot ${['cancelled','service_rejected','specialist_rejected'].includes(n.event)?'warning':'success'}" aria-hidden="true"></span>
    <div class="notification-copy"><button class="text-button" data-open-notification="${n.id}"><strong>${esc(n.message)}</strong></button>
     <small>${date(n.created_at.slice(0,10)+'T12:00:00')} · ${time(n.created_at)} (Киров)</small>
     ${n.is_read?'<small>Прочитано</small>':`<button class="text-button" data-read-notification="${esc(n.id)}">Отметить прочитанным</button>`}
    </div>
   </article>`).join(''):'<p class="notification-status">Уведомлений пока нет.</p>'}</div>`;
  $('.notification-list',panel).scrollTop = scroll;
 }

 async function load() {
  if(busy || document.hidden || !isCurrent()) return;
  busy=true;
  try {
   if (!notificationRequests.has(sessionToken)) {
    notificationRequests.set(sessionToken,
     api('/notifications').finally(() => notificationRequests.delete(sessionToken)));
   }
   const result = await notificationRequests.get(sessionToken);
   if (!isCurrent()) return;
   const next = JSON.stringify(result.notifications);
   if (!loaded || snapshot !== next) {
    notifications = result.notifications;
    snapshot = next;
    render();
   }
   loaded = true;
  } catch(error) {
   if (isCurrent() && !loaded) panel.textContent = error.message;
  } finally {busy=false;}
 }

 function setOpen(open) {
  panel.classList.toggle('hidden',!open);
  toggle.setAttribute('aria-expanded',String(open));
 }
 toggle.onclick=()=>{
  const open=panel.classList.contains('hidden');
  setOpen(open);
  if(open)load();
 };
 toggle.parentElement.onkeydown=event=>{
  if(event.key==='Escape'&&!panel.classList.contains('hidden')){
   setOpen(false);
   toggle.focus();
  }
 };
 panel.onclick=async event=>{
  const button=event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.openNotification) {
   button.disabled = true;
   try {
    const result = await api('/notifications/' + button.dataset.openNotification + '/open', {});
    if (!isCurrent()) return;
    setOpen(false);
    openNotificationDetails(result);
    await notificationRequests.get(sessionToken)?.catch(() => {});
    await load();
   } catch (error) {
    toast(error.message);
   } finally {
    button.disabled = false;
   }
   return;
  }
  if (busy) return;
  const items=notifications.filter(n=>!n.is_read &&
   (button.id==='notifications-mark-read'||String(n.id)===button.dataset.readNotification));
  if(!items.length)return;
  busy=true;
  $$('button',panel).forEach(control=>control.disabled=true);
  try {
   const results=await Promise.allSettled(items.map(async n=>{
    await api('/notifications/'+n.id+'/read',{});
    n.is_read=true;
   }));
   if(!isCurrent())return;
   render();
   const failure=results.find(result=>result.status==='rejected');
   if(failure)toast(failure.reason.message);
   if(!panel.classList.contains('hidden'))toggle.focus();
  } finally {busy=false;}
 };
 refreshNotifications = load;
 notificationTimer = setInterval(load, 10000);
 load();
}

const paymentLabels = {
 unpaid:'Не оплачено', creating:'Проверяем создание платежа', pending:'Ожидает оплаты',
 waiting_for_capture:'Ожидает подтверждения', succeeded:'Оплачено', canceled:'Платёж отменён',
 failed:'Платёж не создан', refund_pending:'Ожидается возврат', refund_succeeded:'Возврат выполнен',
 refund_canceled:'Возврат отменён. Обратитесь к администратору', needs_review:'Требуется проверка администратором'
};

function bookedVisitDetails(booking) {
  const address = booking.address ? `<p><strong>${booking.mode === 'Выезд' ? 'Адрес выезда' : 'Адрес записи'}</strong> · ${esc(booking.address)}</p>` :
    booking.service_address ? `<p><strong>Адрес приёма</strong> · ${esc(booking.service_address)}</p>` : '';
  const phone = booking.contact_phone ? `<p><strong>Телефон специалиста</strong> · <a href="tel:${booking.contact_phone.replace(/[^+0-9]/g, '')}">${esc(booking.contact_phone)}</a></p>` : '';
  const instructions = booking.contact_instructions ? `<p class="visit-instructions"><strong>Инструкции</strong> · ${esc(booking.contact_instructions)}</p>` : '';
  return address + phone + instructions;
}

function bookingActions(booking) {
 const buttons = [];
 if (booking.payment) {
  const {status, can_pay} = booking.payment;
  buttons.push(`<span class="payment-state payment-${esc(status)}"><span class="payment-state-label">Оплата</span><strong>${esc(paymentLabels[status] || 'Статус уточняется')}</strong></span>`);
  if (can_pay) {
   const label = {creating:'Проверить платёж', pending:'Продолжить оплату', canceled:'Повторить оплату', failed:'Повторить оплату'};
   buttons.push(`<button data-pay="${booking.id}" class="button pale">${label[status] || 'Оплатить'}</button>`);
  }
 }
 if (booking.actions.cancel) buttons.push(`<button data-cancel="${booking.id}" class="text-button danger">Отменить запись</button>`);
 if (booking.actions.complete) buttons.push(`<button class="button pale" data-complete="${booking.id}">Завершить встречу</button>`);
 if (booking.actions.review) buttons.push(`<button data-review="${booking.id}" class="button pale">Оставить отзыв</button>`);
 const reasons = Object.values(booking.action_reasons).map(reason => `<p class="action-reason">${esc(reason)}</p>`).join('');
 return `<div class="booking-total-price"><small>Итого к оплате</small><strong>${money(booking.total)}</strong></div>${buttons.join('')}${reasons}`;
}
let serviceApplicationFilter = 'pending';
const defaultAdminFilters = {'review-filter':'pending', 'specialist-visibility':'all', 'service-visibility':'all'};
const adminFilters = {...defaultAdminFilters};
const reviewStatuses = {pending:'На модерации', approved:'Опубликован', rejected:'Отклонён'};
const visibilityOptions = [['all','Все'], ['active','Не скрытые'], ['hidden','Скрытые']];

function adminFilter(id, label, options) {
 return `<label class="field">${label}<select id="${id}">${options.map(([value, name]) =>
  `<option value="${value}" ${adminFilters[id] === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
}

function bindAdminFilter(root, id) {
 const filter = $('#' + id, root);
 filter.onchange = () => {
  adminFilters[id] = filter.value;
  dashboard().then(() => $('#' + id)?.focus()).catch(error => toast(error.message));
 };
}

function matchesVisibility(item, filter) {
 return filter === 'all' || Boolean(item.active) === (filter === 'active');
}
let dashboardSnapshot;
let dashboardLoads = 0;
let catalogRefreshPending = false;

function scheduleDashboardRefresh() {
 clearTimeout(dashboardRefreshTimer);
 if (location.hash === '#dashboard' ? !state.user : !$('#cards')) return;
 dashboardRefreshTimer = setTimeout(refreshDashboard, 10000);
}

async function refreshDashboard() {
 if (location.hash !== '#dashboard' && $('#cards') && !document.hidden) {
  if (catalogRefreshPending) return;
  catalogRefreshPending = true;
  const routeId = catalogRequest;
  try {
   const {specialists, categories} = await api('/catalog');
   if (routeId === catalogRequest && location.hash !== '#dashboard' && $('#cards')) {
    const categoriesChanged = JSON.stringify(categories) !== JSON.stringify(state.categories);
    if (categoriesChanged || JSON.stringify(specialists) !== JSON.stringify(state.specialists)) {
     state.specialists = specialists;
     state.categories = categories;
     if (categoriesChanged) updateCatalogCategories();
     drawCards();
     if (activeBooking?.alive) activeBooking.updateCategoryLabels(specialists);
    }
   }
  } catch {
   // Keep the last catalog until the connection returns.
  } finally {
   catalogRefreshPending = false;
   scheduleDashboardRefresh();
  }
  return;
 }
 if (location.hash !== '#dashboard' || !state.user || document.hidden || dashboardLoads) {
  scheduleDashboardRefresh();
  return;
 }
 dashboard(true).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
 if (!document.hidden) refreshDashboard();
});
window.addEventListener('online', refreshDashboard);

async function dashboard(background = false) {
 dashboardLoads++;
 clearTimeout(dashboardRefreshTimer);
 try {
  await renderDashboard(background);
 } finally {
  dashboardLoads--;
  scheduleDashboardRefresh();
 }
}

async function renderDashboard(background) {
 const requestId = ++dashboardRequest;
 if(!state.user){login();return;}
 const previousUser=state.user;
 const mode=previousUser.role==='client' ? 'client' : dashboardMode;
 const tab = dashboardTab;
 const sectionPath = {
  schedule:'/master', services:'/master', people:'/admin',
  'specialist-applications':'/admin/specialist-applications',
  'service-applications':'/admin/service-applications?status=' + serviceApplicationFilter,
  support:'/support', categories:'/admin/categories'
 }[tab];
 const [data, section] = await Promise.all([
  api(mode==='client' ? '/dashboard?mode=client' : '/dashboard'),
  sectionPath ? api(sectionPath) : null
 ]);
 if (requestId !== dashboardRequest || state.user !== previousUser || location.hash !== '#dashboard') return;
 const {server_now, ...snapshotData} = data;
 const snapshot = JSON.stringify([tab, mode, snapshotData, section]);
 const previousRoot = $('#dashboard-content');
 const notificationControlNode = background ? $('.notification-control') : null;
 if (background && previousRoot) {
  for (const [key, count] of Object.entries(data.pending)) {
   const badge = $(`[data-pending-tab="${key}"]`);
   if (badge) badge.textContent = count ? ` (${count})` : '';
  }
  if (snapshot === dashboardSnapshot) return;
  if (previousRoot.dataset.tab === tab && data.user.role === previousUser.role) {
   if (tab === 'support') {
    renderSupport(previousRoot, section.items, data.user.role === 'admin');
    dashboardSnapshot = snapshot;
    return;
   }
   if (tab === 'categories') {
    renderCategoryDirectory(previousRoot, section.groups);
    dashboardSnapshot = snapshot;
    return;
   }
   if (tab === 'services') {
    renderManagedServices(previousRoot, section.services, section.categories);
    $('#edit-service-form')?.updateServiceDirectory(section.categories);
    dashboardSnapshot = snapshot;
    return;
   }
   if (tab === 'specialist-application') {
    $('#specialist-profile-group', previousRoot)?.updateProfileGroups(data.specialist_categories);
   }
  }
  if ($('#modal[open], #support-dialog[open]') ||
      previousRoot.querySelector('form[data-dirty], form :is(input,textarea,select):focus, form button:disabled')) return;
 }
 dashboardSnapshot = snapshot;
 const openApplications = new Set($$('details[open][data-application-key]', previousRoot ?? document)
  .map(details => details.dataset.applicationKey));
 $('#chat').before(chatLauncher);
 const user=state.user=data.user;
 const hasSpecialistProfile=user.role==='master', isAdmin=user.role==='admin';
 const isClient=user.role==='client' || (hasSpecialistProfile && mode==='client');
 const isMaster=hasSpecialistProfile && !isClient;
 if (hasSpecialistProfile) dashboardMode=mode;
 const tabs=isClient?[['bookings','Мои записи'],['searches','История поиска'],['reviews','Мои отзывы']]:isMaster?[['bookings','Записи клиентов'],['schedule','Моё расписание'],['services','Мои услуги']]:[['bookings','Все записи'],['moderation','Модерация отзывов'],['service-applications','Заявки на услуги'],['specialist-applications','Заявки специалистов'],['people','Специалисты и услуги']];
 if (isAdmin) tabs.push(['support','Обращения'], ['categories','Категории услуг']);
 else tabs.push(['support','Поддержка'], ['profile','Профиль']);
 const application=data.specialist_application;
 if (isClient && (!hasSpecialistProfile || application)) {
  const label=!application || application.status==='rejected' || (!hasSpecialistProfile && application.status==='approved') ? 'Стать специалистом' : 'Статус заявки';
  tabs.push(['specialist-application',label]);
 }
 const modeControl=hasSpecialistProfile ? `<div class="mode-switch" role="group" aria-label="Режим кабинета">
  <button type="button" data-dashboard-mode="client" class="${isClient?'active':''}" aria-pressed="${isClient}">Клиент</button>
  <button type="button" data-dashboard-mode="master" class="${isMaster?'active':''}" aria-pressed="${isMaster}">Специалист</button>
 </div>` : '';
 if(!tabs.some(x=>x[0]===dashboardTab))dashboardTab='bookings';
 const notificationControl=`<div class="notification-control"><button id="notifications-toggle" class="button outline notification-trigger" aria-label="Уведомления" aria-expanded="false" aria-controls="notifications-panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span>Уведомления</span><span class="notification-count hidden" aria-hidden="true"></span></button><div id="notifications-panel" class="notification-panel hidden" aria-label="Список уведомлений"></div></div>`;
 $('#app').innerHTML=`<section class="dashboard"><div class="dashboard-heading"><div><span class="eyebrow">${isClient?'ЛИЧНЫЙ КАБИНЕТ':isMaster?'КАБИНЕТ СПЕЦИАЛИСТА':'АДМИНИСТРИРОВАНИЕ'}</span><h1>Здравствуйте, ${esc(user.name.split(' ')[0])}<span class="wave">✧</span></h1><p class="muted">${isClient?'Встречи, которые делают жизнь проще.':isMaster?'Ваше время, ваши услуги и ваши клиенты.':'Управляйте качеством сервиса и публикациями.'}</p></div><div class="dashboard-actions">${modeControl}<div class="dashboard-account-chip"><span class="dashboard-account-avatar">${esc(user.name.trim().charAt(0).toUpperCase())}</span><span class="dashboard-account-name">${esc(user.name.split(' ')[0])}</span></div>${notificationControl}<button id="logout" class="button outline logout-button"><span aria-hidden="true">↗</span> Выйти</button></div></div><div class="stats"><div><span>${isClient?'Предстоящих встреч':'Активных записей'}</span><strong>${data.bookings.filter(b=>isClient?b.phase==='upcoming':b.status==='confirmed').length}</strong></div><div><span>Завершённых встреч</span><strong>${data.bookings.filter(b=>b.status==='completed').length}</strong></div><div><span>${isAdmin?'На модерации':'Всего записей'}</span><strong>${isAdmin?data.reviews.filter(r=>r.status==='pending').length:data.bookings.length}</strong></div></div><div class="dashboard-tabs">${tabs.map(([id,t])=>`<button data-tab="${id}" class="${dashboardTab===id?'selected':''}">${t}${id in data.pending ? `<span aria-hidden="true" data-pending-tab="${id}">${data.pending[id] ? ` (${data.pending[id]})` : ''}</span>` : ''}</button>`).join('')}</div><div id="dashboard-content"></div></section>`;
 $('#logout').onclick = async () => endSession(await api('/logout', {}));
 if (hasSpecialistProfile) $$('[data-dashboard-mode]').forEach(button => button.onclick = () => {
  if (button.dataset.dashboardMode === dashboardMode) return;
  dashboardMode=button.dataset.dashboardMode;
  dashboardTab='bookings';
  dashboardStatusFilter='all';
  dashboard().catch(error=>toast(error.message));
 });
 $$('[data-tab]').forEach(b=>b.onclick=()=>{dashboardTab=b.dataset.tab;dashboard().catch(e=>toast(e.message));});
 if (notificationControlNode && $('#notifications-toggle')) {
  $('.notification-control').replaceWith(notificationControlNode);
 } else bindNotifications(user);
 const root=$('#dashboard-content');
 root.dataset.tab = dashboardTab;

 if(dashboardTab==='bookings'){
  root.innerHTML=`<div class="section-title"><h2>${isClient?'Мои встречи':'История записей'}</h2><select id="booking-status" aria-label="Статус записи"><option value="all">Все записи</option><option value="confirmed">Активные</option><option value="completed">Завершённые</option><option value="cancelled">Отменённые</option></select></div><div class="dashboard-update"><p>Время Кирова · UTC+3. Статус и действия проверяет сервер.</p><button id="refresh-bookings" class="button outline">Обновить статусы</button><p id="dashboard-update-status" role="status"></p></div>${isMaster ? '<button id="cancel-all-bookings" class="button outline">Отменить все предстоящие записи</button>' : ''}<div id="booking-list"></div>`;
  if (isMaster) $('#cancel-all-bookings').onclick = async event => {
   const button = event.currentTarget;
   button.disabled = true;
   try {
    const {ids} = await api('/master/bookings/upcoming');
    if (!button.isConnected) return;
    if (!ids.length) return toast('Нет предстоящих записей для отмены', 'warning');
    managementConfirmation('Отменить все предстоящие записи?',
     `Будет отменено записей: ${ids.length}. Клиенты получат уведомления, места освободятся.`,
     true, async reason => {
      const result = await api('/master/bookings/cancel-all', {confirm:true, ids, reason});
      return `Отменено записей: ${result.cancelled}`;
     });
   } catch (error) {
    toast(error.message);
   } finally {
    button.disabled = false;
   }
  };
  $('#booking-status').value=dashboardStatusFilter;
  $('#refresh-bookings').onclick=async()=>{try{await dashboard();$('#dashboard-update-status').textContent='Статусы обновлены';$('#refresh-bookings').focus();}catch(error){toast(error.message);}};
  const draw=()=>{
   const rows=data.bookings.filter(b=>$('#booking-status').value==='all'||b.status===$('#booking-status').value);
   $('#booking-list').innerHTML=rows.length?rows.map(b=>`<article class="booking-row" data-booking-id="${b.id}"><img src="${esc(b.photo)}" alt=""><div class="booking-info"><span class="badge ${b.status} ${b.phase}">${esc(b.status_label)}</span><h3>${esc(b.service)}</h3><p>${esc(b.specialist)}${!isClient?' · Клиент: '+esc(b.client):''}</p><p><b>${date(b.starts_at)}${b.booking_mode==='day'?'':` · ${time(b.starts_at)}–${b.starts_at.slice(0,10)===b.ends_at.slice(0,10)?'':date(b.ends_at)+' · '}${time(b.ends_at)}`}</b> · ${b.duration} мин · ${esc(b.mode)} · ${b.quantity} мест(о)</p>${bookedVisitDetails(b)}${b.note?`<p class="muted">${esc(b.note)}</p>`:''}${b.cancel_reason ? `<p>Причина отмены: ${esc(b.cancel_reason)}</p>` : ''}</div><div class="booking-actions">${bookingActions(b)}</div></article>`).join(''):'<div class="empty"><span>▦</span><h3>Здесь пока нет записей</h3><p>Выберите специалиста и удобное время в каталоге.</p><a class="button" href="#catalog">Найти специалиста ↗</a></div>';
   $$('[data-pay]', $('#booking-list')).forEach(button => button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
     const payment = await submitOperation(`/bookings/${button.dataset.pay}/payment`, {});
     if (payment.confirmation_url) {
      location.assign(payment.confirmation_url);
      return;
     }
     toast(paymentLabels[payment.status] || 'Проверяем состояние платежа');
     await dashboard();
    } catch (error) {
     toast(error.message);
    } finally {
     button.disabled = false;
    }
   });
   if (state.newBookingId) {
    $(`[data-booking-id="${state.newBookingId}"]`)?.scrollIntoView({block:'center'});
    state.newBookingId = null;
   }
   $$('[data-cancel]').forEach(button => button.onclick = () => {
    managementConfirmation('Отменить запись?', 'Место освободится, клиент получит уведомление.',
     isMaster, async reason => {
      await api('/bookings/' + button.dataset.cancel + '/cancel', {reason});
      return 'Запись отменена, место освобождено';
     });
   });
   $$('[data-complete]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('/bookings/'+b.dataset.complete+'/complete',{});toast('Встреча завершена');}catch(e){toast(e.message);}finally{await dashboard();}});
   $$('[data-review]').forEach(b=>b.onclick=()=>reviewForm(Number(b.dataset.review)));
  };$('#booking-status').onchange=()=>{dashboardStatusFilter=$('#booking-status').value;draw();};draw();
 }else if(dashboardTab==='searches'){
  root.innerHTML='<h2>Недавно вы искали</h2>'+(data.searches.length?data.searches.map(s=>`<button class="search-history" data-query-history="${esc(s.query)}"><span>⌕ &nbsp; ${esc(s.query)}</span><small>${date(s.created_at)}</small><span>↗</span></button>`).join(''):'<div class="empty">Ваши поисковые запросы появятся здесь.</div>');
  $$('[data-query-history]').forEach(b=>b.onclick=()=>{state.query=b.dataset.queryHistory;state.categoryGroup='';state.category='';state.mode='';state.maxPrice='';location.hash='catalog';});
 }else if(dashboardTab==='reviews'||dashboardTab==='moderation'){
  const reviewFilter = adminFilters['review-filter'];
  const reviews = isAdmin && reviewFilter !== 'all' ? data.reviews.filter(review => review.status === reviewFilter) : data.reviews;
  root.innerHTML=`<h2>${isAdmin?'Отзывы и модерация':'Мои отзывы'}</h2>` +
   (isAdmin ? adminFilter('review-filter', 'Статус отзыва',
    [['pending','На модерации'],['approved','Опубликованные'],['rejected','Отклонённые'],['all','Все']]) : '') +
   (reviews.length?reviews.map(r=>`<article class="review panel"><div><strong>${esc(r.specialist)}</strong><span class="stars">${'★'.repeat(r.rating)}</span></div><p>${esc(r.content)}</p><small>${esc(r.author)} · ${date(r.created_at)} · ${reviewStatuses[r.status]}</small>${isAdmin?`<div class="dialog-actions"><button data-moderate="${r.id}" data-status="approved" class="button pale" ${r.status==='approved'?'disabled':''}>Опубликовать</button><button data-moderate="${r.id}" data-status="rejected" class="button outline" ${r.status==='rejected'?'disabled':''}>Отклонить</button></div>`:''}</article>`).join(''): `<div class="empty">${isAdmin ? 'Отзывов с этим статусом нет.' : 'Отзывов пока нет. Клиент может оставить отзыв после завершённой встречи.'}</div>`);
  if (isAdmin) bindAdminFilter(root, 'review-filter');
  $$('[data-moderate]').forEach(b=>b.onclick=async()=>{try{await api('/admin/moderate',{kind:'review',id:Number(b.dataset.moderate),status:b.dataset.status});await refreshCatalog();await dashboard();toast('Статус отзыва обновлён');}catch(e){toast(e.message);}});
 }else if(dashboardTab==='profile'){
  renderAccountProfile(root, user);
 }else if(dashboardTab==='schedule'||dashboardTab==='services'){
  const m=section;
  if(dashboardTab==='schedule'){
   root.innerHTML=`<div class="section-title"><div><h2>Свободные слоты</h2><p class="muted">Время Кирова (UTC+3). Пересекающиеся интервалы недоступны.</p></div></div><form id="slot-form" class="panel form-grid"><label class="field">Услуга<select name="service_id">${m.services.filter(s=>s.active).map(s=>`<option value="${s.id}" data-mode="${s.mode}">${esc(s.title)} · ${s.duration} мин</option>`).join('')}</select></label><label class="field">Дата и время<input type="datetime-local" name="starts_at" min="${localNow()}" required></label><label class="field">Количество мест<input type="number" name="capacity" min="1" max="50" value="1" required></label><button class="button">Добавить слот +</button><p class="form-error" role="alert"></p></form><div class="schedule-list">${m.slots.length?m.slots.map(s=>`<article class="schedule-row ${!s.active?'inactive':''}"><div><strong>${date(s.starts_at)} · ${time(s.starts_at)}</strong><p>${esc(s.service)}</p></div><span>${s.booked} / ${s.capacity} мест занято</span>${s.active?`<button data-close-slot="${s.id}" class="button outline">Закрыть слот</button>`:'<span class="muted">Закрыт</span>'}</article>`).join(''):'<div class="empty">Добавьте первый слот в своё расписание.</div>'}</div>`;
   root.insertAdjacentHTML('afterbegin', scheduleForm(m.schedule));
   bindScheduleForm();
   $('#slot-form').classList.toggle('hidden', Boolean(m.schedule));
   $('.schedule-list').classList.toggle('hidden', Boolean(m.schedule));
   $('.section-title', root).classList.toggle('hidden', Boolean(m.schedule));
   const form=$('#slot-form');
   const capacity=()=>{const group=form.elements.service_id.selectedOptions[0]?.dataset.mode==='Группа';form.elements.capacity.max=group?'50':'1';if(!group)form.elements.capacity.value=1;};form.elements.service_id.onchange=capacity;capacity();
   form.onsubmit = async event => {
    event.preventDefault();
    const button = $('button', form);
    if (button.disabled) return;
    const data = Object.fromEntries(new FormData(form));
    data.service_id = Number(data.service_id);
    data.capacity = Number(data.capacity);
    button.disabled = true;
    try {
     await submitOperation('/master/slots', data);
     form.reset();
     toast('Слот добавлен');
     dashboard().catch(error => toast(error.message));
    } catch (error) {
     $('.form-error', form).textContent = error.message;
    } finally {
     button.disabled = false;
    }
   };
   $$('[data-close-slot]').forEach(b=>b.onclick=async()=>{try{await api('/master/slots/'+b.dataset.closeSlot+'/close',{});await dashboard();toast('Слот закрыт');}catch(e){toast(e.message);}});
  }else{
   renderManagedServices(root, m.services, m.categories);
  }
 }else if(dashboardTab==='support'){
  renderSupport(root, section.items, isAdmin);
 }else if(dashboardTab==='categories'){
  renderCategoryDirectory(root, section.groups);
 }else if(dashboardTab==='specialist-application'){
  renderSpecialistApplication(root, application, user, data.specialist_categories);
 }else if(dashboardTab==='specialist-applications'){
  const {applications}=section;
  renderSpecialistApplications(root, applications);
 }else if(dashboardTab==='service-applications'){
  const {applications} = section;
  root.innerHTML = `<h2>Заявки на услуги</h2><label class="field">Статус заявки
   <select id="service-application-filter"><option value="pending">На проверке</option>
   <option value="approved">Одобренные</option><option value="rejected">Отклонённые</option>
   <option value="all">Все</option></select></label>` + (applications.length ? applications.map(service => `
   <details class="panel moderation-card" data-application-key="service-${service.id}">
    <summary><span class="moderation-card-title"><strong>${service.draft_status ? 'Изменения: ' : ''}${esc(service.title)}</strong><span class="badge ${service.application_status}">${serviceStatus[service.application_status]}</span></span>
     <span class="moderation-card-meta">${esc(service.specialist)} · ${service.category_name ? esc(service.category_name) : 'Без категории'}</span>
     <span class="moderation-card-date">Заявка от ${date(service.created_at)}</span></summary>
    <div class="moderation-preview"><span class="eyebrow">ПРЕДПРОСМОТР УСЛУГИ</span><h3>${esc(service.title)}</h3>
     <p>${service.category_name ? `${esc(service.category_direction)} / ${esc(service.category_name)}` : 'Категория не указана'}</p>
     <strong>${money(service.price)}</strong><span>${esc(service.mode)} · ${service.duration} мин</span></div>
    ${bookedVisitDetails(service)}
    ${service.application_status === 'rejected' ? `<p>Причина: ${esc(service.draft_reason ?? service.moderation_reason)}</p>` : ''}
    ${service.application_status === 'pending' ? `<form data-service-decision="${service.id}" data-revision="${service.revision}">
     <label class="field">Причина отклонения<textarea name="reason" maxlength="500"></textarea></label>
     <p class="form-error" role="alert"></p>
     <div class="dialog-actions moderation-actions">
      <button value="approved" class="button moderation-approve">Одобрить услугу</button>
      <button value="rejected" class="button outline danger">Отклонить</button>
     </div>
    </form>` : ''}
   </details>`).join('') : '<div class="empty">Заявок с этим статусом нет.</div>');
  const filter = $('#service-application-filter', root);
  filter.value = serviceApplicationFilter;
  filter.onchange = () => {
   serviceApplicationFilter = filter.value;
   dashboard().then(() => $('#service-application-filter')?.focus()).catch(error => toast(error.message));
  };
  $$('[data-service-decision]', root).forEach(form => form.onsubmit = async event => {
   event.preventDefault();
   const status = event.submitter?.value;
   if (!status) return;
   const buttons = $$('button', form);
   buttons.forEach(button => button.disabled = true);
   try {
    await api(`/admin/service-applications/${form.dataset.serviceDecision}/decision`, {
     status, reason: form.elements.reason.value, revision: Number(form.dataset.revision)
    });
    await dashboard();
    toast('Решение сохранено');
   } catch (error) {
    $('.form-error', form).textContent = error.message;
   } finally {
    buttons.forEach(button => button.disabled = false);
   }
  });
 }else if(dashboardTab==='people'){
  const serviceFilter = adminFilters['service-visibility'];
  const services = section.services.filter(service => matchesVisibility(service, serviceFilter));
  const specialists = section.specialists.filter(specialist =>
   matchesVisibility(specialist, adminFilters['specialist-visibility']) &&
   (serviceFilter === 'all' || services.some(service => service.specialist_id === specialist.id)));
  root.innerHTML = '<h2>Специалисты и услуги</h2><p class="muted">Скрытые специалисты и услуги недоступны для новых записей. Существующие записи сохраняются.</p>' +
   adminFilter('specialist-visibility', 'Видимость специалистов', visibilityOptions) +
   adminFilter('service-visibility', 'Видимость услуг', visibilityOptions) +
   (specialists.length ? specialists.map(specialist => `
    <article class="panel admin-person">
     <div class="service-row">
      <div><h3>${esc(specialist.name)}</h3><p>${esc(specialist.profession)} · ${specialist.active ? 'В каталоге' : 'Скрыт'}</p></div>
      <button class="button ${specialist.active ? 'outline' : 'pale'}" data-toggle="specialist"
       data-id="${specialist.id}" data-active="${!specialist.active}">${specialist.active ? 'Скрыть' : 'Показать'}</button>
      <button class="button outline danger" data-delete-specialist="${specialist.id}">Удалить</button>
     </div>
     ${services.filter(service => service.specialist_id === specialist.id).map(service => `
      <div class="admin-service">
       <span>${esc(service.title)} · ${money(service.price)} · ${serviceStatus[service.moderation_status]}</span>
       <button class="text-button" data-toggle="service" data-id="${service.id}"
        data-active="${!service.active}">${service.active ? 'Скрыть услугу' : 'Показать услугу'}</button>
      </div>`).join('')}
    </article>`).join('') : '<div class="empty">По выбранным фильтрам ничего не найдено.</div>');
  bindAdminFilter(root, 'specialist-visibility');
  bindAdminFilter(root, 'service-visibility');
  $$('[data-toggle]').forEach(b=>b.onclick=async()=>{try{await api('/admin/moderate',{kind:b.dataset.toggle,id:Number(b.dataset.id),active:b.dataset.active==='true'});await refreshCatalog();await dashboard();toast('Изменения сохранены');}catch(e){toast(e.message);}});
  $$('[data-delete-specialist]', root).forEach(button => button.onclick = () => {
   managementConfirmation('Удалить специалиста?',
    'Профиль, услуги и расписание будут закрыты. Аккаунт клиента и история записей сохранятся.',
    false, async () => {
     await api('/admin/specialists/' + button.dataset.deleteSpecialist, undefined, 'DELETE');
     await refreshCatalog();
     return 'Специалист удалён';
    }, {back: 'Оставить', confirm: 'Удалить навсегда', confirmClass: 'danger-solid', lockWhilePending: true});
  });
 }
 for (const form of $$('form', root)) {
  const values = () => JSON.stringify([...new FormData(form)].map(([key, value]) =>
   [key, value instanceof File ? [value.name, value.size, value.lastModified] : value]));
  const initial = values();
  form.addEventListener('input', () => form.toggleAttribute('data-dirty', values() !== initial));
 }
 for (const details of $$('details[data-application-key]', root)) {
  details.open = openApplications.has(details.dataset.applicationKey);
 }
}
function reviewForm(booking_id){
 modal(`<h2>Как прошла встреча?</h2><p class="muted">Отзыв появится в профиле после проверки администратором.</p>
  <form id="review-form"><fieldset class="rating-picker"><legend>Ваша оценка</legend>
   <div class="rating-stars" role="radiogroup" aria-label="Оценка от 1 до 5">
    ${[1,2,3,4,5].map(value=>`<button type="button" role="radio" aria-checked="${value===5}" data-rating="${value}" class="${value<=5?'selected':''}" aria-label="${value} из 5">★</button>`).join('')}
   </div><input type="hidden" name="rating" value="5"><strong class="rating-caption">5 из 5 · Отлично</strong>
  </fieldset>
  <label class="field">Ваш отзыв<textarea name="content" minlength="5" maxlength="1500" required placeholder="Что вам понравилось? Что можно улучшить?"></textarea></label>
  <p class="form-error" role="alert"></p><button class="button full">Отправить отзыв →</button></form>`);
 const form=$('#review-form');
 const labels={1:'Очень плохо',2:'Плохо',3:'Нормально',4:'Хорошо',5:'Отлично'};
 $$('[data-rating]',form).forEach(button=>button.onclick=()=>{
  const rating=Number(button.dataset.rating); form.elements.rating.value=rating;
  $$('[data-rating]',form).forEach(star=>{const selected=Number(star.dataset.rating)<=rating;star.classList.toggle('selected',selected);star.setAttribute('aria-checked',String(Number(star.dataset.rating)===rating));});
  $('.rating-caption',form).textContent=`${rating} из 5 · ${labels[rating]}`;
 });
 form.onsubmit=async e=>{e.preventDefault();try{await api('/reviews',{booking_id,rating:Number(form.elements.rating.value),content:form.elements.content.value});closeModal();toast('Спасибо! Отзыв отправлен на модерацию');await dashboard();}catch(e){$('.form-error',form).textContent=e.message;}};
}
function openChat(){$('#chat').classList.remove('hidden');chatLauncher.classList.add('hidden');$('#chat-input').focus();}
$('#chat-launch').onclick=openChat;
$('#chat-close').onclick=()=>{$('#chat').classList.add('hidden');chatLauncher.classList.remove('hidden');};
$('#chat-form').onsubmit=async e=>{e.preventDefault();const input=$('#chat-input'),message=input.value.trim();if(!message)return;const list=$('#chat-messages');list.insertAdjacentHTML('beforeend',`<div class="bubble user">${esc(message)}</div>`);input.value='';const button=$('button',$('#chat-form'));button.disabled=true;try{const r=await api('/consult',{message});list.insertAdjacentHTML('beforeend',`<div class="bubble">${esc(r.reply)}${r.specialist_id?`<button class="button pale" data-profile="${r.specialist_id}" data-preferred-service="${r.service_id}">Посмотреть специалиста ↗</button>`:''}</div>`);bindProfiles(list);}catch(e){list.insertAdjacentHTML('beforeend',`<div class="bubble">${esc(e.message)}. Попробуйте ещё раз.</div>`);}finally{button.disabled=false;list.scrollTop=list.scrollHeight;}};
$('#modal-close').onclick=closeModal;
$('#modal').addEventListener('cancel', event => {
 if ($('#modal form[data-pending-deletion]')) event.preventDefault();
});
$('#modal').onclick=e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};
$('#account').onclick=()=>{if(state.user){location.hash='dashboard';dashboard().catch(e=>toast(e.message));}else login();};
async function route(){const id=++catalogRequest;try{if(location.hash==='#dashboard'){await dashboard();}else{clearTimeout(dashboardRefreshTimer);stopNotificationPolling();await refreshCatalog();if(id!==catalogRequest)return;catalog();scheduleDashboardRefresh();if(location.hash==='#how')$('#how-section').scrollIntoView({behavior:'smooth'});}$$('[data-nav]').forEach(a=>a.classList.toggle('active',a.getAttribute('href')===(location.hash||'#catalog')));}catch(e){$('#chat').before(chatLauncher);$('#app').innerHTML=`<div class="empty" role="alert"><h2>Не удалось загрузить страницу</h2><p>${esc(e.message)}</p><button id="retry-page" class="button">Повторить загрузку</button></div>`;$('#retry-page').onclick=route;}}
window.addEventListener('hashchange',route);
(async()=>{try{const s=await api('/session');state.user=s.user;state.csrf=s.csrf;state.demoMode=s.demo_mode;
 if (state.demoMode) $('#site-mode').textContent = 'Демонстрационный проект · 2026. Примеры специалистов и отзывов вымышлены. Фото: Unsplash и Barber demo.';
 if (new URLSearchParams(location.search).has('payment_return')) dashboardMode='client';
 updateAccount();if(location.pathname==='/reset-password'){resetPasswordPage();}await route();}catch(e){$('#app').innerHTML=`<div class="empty"><h2>Не удалось загрузить приложение</h2><p>${esc(e.message)}</p><button class="button" onclick="location.reload()">Повторить</button></div>`;}})();
