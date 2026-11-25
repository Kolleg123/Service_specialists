const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const date = s => new Date(s).toLocaleDateString('ru-RU', {day:'numeric', month:'long'});
const reviewCount = n => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'отзывов' : n % 10 === 1 ? 'отзыв' : n % 10 >= 2 && n % 10 <= 4 ? 'отзыва' : 'отзывов'}`;
const time = s => s.slice(11,16);
const localNow = () => new Date().toLocaleString('sv-SE', {timeZone:'Europe/Kirov'}).replace(' ', 'T').slice(0,16);
const icons = {'Все специалисты':'✧','Дом и ремонт':'⌂','Красота':'✂','Обучение':'▤','Здоровье':'♡','Мероприятия':'◎'};
let state = {user:null, csrf:'', specialists:[], categories:[], category:'Все специалисты', query:'', sort:'recommended', maxPrice:'', mode:''};
let dashboardTab = 'bookings';
let dashboardStatusFilter = 'all';
let dashboardRefreshTimer;
let dashboardRequest = 0;
let catalogRequest = 0;
const chatLauncher = $('#chat-launch');
async function api(path, data, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api' + path, {method:method || (data === undefined ? 'GET':'POST'), signal:controller.signal,
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf}, body:data === undefined ? undefined : JSON.stringify(data)});
    let result; try { result = await response.json(); } catch { throw new Error('Сервер временно недоступен'); }
    if (!response.ok) { const error = new Error(result.error || 'Не удалось выполнить действие'); error.status = response.status; throw error; }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите попытку.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function toast(message) {$('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500);}
function modal(html) {$('#modal-content').innerHTML = html; if (!$('#modal').open) $('#modal').showModal();}
function closeModal() {$('#modal').close();}
function updateAccount() {
 if (!state.user) { $('#account').innerHTML='Личный кабинет <span>↗</span>'; return; }
 const avatar = state.user.avatar ? '<img class="avatar avatar-img" src="'+esc(state.user.avatar)+'" alt="">' : '<span class="avatar">'+esc(state.user.name[0])+'</span>';
 $('#account').innerHTML = esc(state.user.name.split(' ')[0])+' '+avatar;
}
async function refreshCatalog() {const data = await api('/catalog'); state.specialists = data.specialists; state.categories = data.categories;}
function card(s) {
 const min = s.services.length ? Math.min(...s.services.map(x => x.price)) : null;
 return `<article class="specialist-card"><button class="photo-button" data-profile="${s.id}" aria-label="Профиль: ${esc(s.name)}"><img src="${esc(s.photo)}" alt="Демонстрационное фото специалиста ${esc(s.name)}" loading="lazy"><span class="photo-label">${esc(s.category)}</span><span class="photo-arrow">↗</span></button><div class="card-body"><div class="rating">★ <b>${s.rating ?? 'Новый'}</b><span>${s.reviews.length ? reviewCount(s.reviews.length) : 'Пока без отзывов'}</span></div><button class="name-link" data-profile="${s.id}">${esc(s.name)}</button><p class="profession">${esc(s.profession)} <span>· ${s.experience} лет опыта</span></p><p class="location">⌖ ${esc(s.location)}</p><div class="tags">${s.skills.split(',').slice(0,2).map(x => `<span>${esc(x)}</span>`).join('')}</div><div class="card-bottom"><div><small>Стоимость услуг</small><strong>${min === null ? 'Нет услуг' : 'от ' + money(min)}</strong></div><button class="button pale" data-profile="${s.id}">Выбрать время <span>↗</span></button></div></div></article>`;
}
function catalog() {
 $('#app').innerHTML = `<section class="hero"><div class="hero-text"><span class="eyebrow"><i></i> ХОРОШИЕ СПЕЦИАЛИСТЫ РЯДОМ</span><h1>Нужный человек.<br><em>В удобное время.</em></h1><p>От ремонта крана до нового увлечения — найдите своего<br class="desktop"> специалиста и запишитесь без лишних звонков.</p><form id="search-form" class="search-box"><span>⌕</span><input id="search-input" placeholder="Какая помощь вам нужна?" aria-label="Поиск специалистов" value="${esc(state.query)}"><button class="button">Найти <span>↗</span></button></form><div class="popular">Например: <button data-query="Сантехник">сантехник</button><button data-query="Стрижка">стрижка</button><button data-query="Английский">английский</button></div><div class="hero-proof"><div class="mini-faces">${state.specialists.slice(0,3).map(s=>`<img src="${s.photo}" alt="">`).join('')}</div><div><strong>Меньше поисков. Больше жизни.</strong><span>Свободные слоты и понятные цены</span></div></div></div><div class="hero-art"><img src="/static/photos/hero.jpg" alt="Стилист работает над причёской клиента в салоне"><span class="art-caption">Хорошая работа<br>начинается с человека.</span><div class="float-card"><span class="check-round">✓</span><div><strong>Всё складывается</strong><span>Выбирайте время — остальное за нами</span></div><span>✧</span></div><div class="art-top">СВОБОДНО ДЛЯ ВАШИХ ПЛАНОВ <span>↗</span></div></div></section>
 <section class="catalog-section" id="catalog-section"><div class="section-title"><div><span class="eyebrow">НАЙДИТЕ СВОЕГО</span><h2>Специалисты, которым по пути с вами</h2></div><span class="catalog-count"></span></div><div class="category-tabs">${state.categories.map(c=>`<button data-category="${esc(c)}" class="${state.category===c?'selected':''}"><span>${icons[c]}</span>${esc(c)}</button>`).join('')}</div><div class="filter-bar"><div class="filters"><label><span>Формат</span><select id="mode-filter"><option value="">Любой формат</option>${['Выезд','У специалиста','Онлайн','Группа'].map(m=>`<option ${state.mode===m?'selected':''}>${m}</option>`).join('')}</select></label><label><span>Цена до</span><select id="price-filter"><option value="">Любая цена</option>${[1500,2500,5000].map(n=>`<option value="${n}" ${state.maxPrice==n?'selected':''}>${money(n)}</option>`).join('')}</select></label><button id="reset-filter" class="text-button">Сбросить</button></div><label class="sort-label">Сначала <select id="sort-filter"><option value="recommended">рекомендуемые</option><option value="price">недорогие</option><option value="rating">с высоким рейтингом</option><option value="experience">опытные</option></select></label></div><div id="cards" class="card-grid"></div></section>
 <section class="help-banner"><div class="help-symbol">✧</div><div><h2>Не знаете, кого выбрать?</h2><p>Опишите задачу — наш помощник подскажет, к кому обратиться.</p></div><button class="button light" id="banner-chat">Спросить помощника ↗</button></section>
 <section class="how" id="how-section"><div><span class="eyebrow">ВСЁ ПРОСТО</span><h2>От задачи до встречи —<br>три шага</h2></div>${[['01','Найдите специалиста','Выберите категорию, сравните услуги и прочитайте отзывы.'],['02','Выберите время','Только доступные слоты. Дата, время и стоимость — сразу перед вами.'],['03','Занимайтесь своим','Ваша запись в личном кабинете. Планы изменились? Её можно отменить.']].map(([n,t,p])=>`<article><span>${n}</span><h3>${t}</h3><p>${p}</p></article>`).join('')}</section>`;
 $('#sort-filter').value = state.sort;
 $('#search-form').onsubmit = async e => {e.preventDefault(); state.query = $('#search-input').value.trim(); drawCards(); if (state.user?.role==='client' && state.query) {try {await api('/searches',{query:state.query});} catch(e){toast(e.message);}} $('#catalog-section').scrollIntoView({behavior:'smooth'});};
 $$('[data-query]').forEach(b=>b.onclick=()=>{$('#search-input').value=b.dataset.query; $('#search-form').requestSubmit();});
 $$('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category; $$('[data-category]').forEach(x=>x.classList.toggle('selected',x===b)); drawCards();});
 $('#mode-filter').onchange=e=>{state.mode=e.target.value;drawCards();};
 $('#price-filter').onchange=e=>{state.maxPrice=e.target.value;drawCards();};
 $('#sort-filter').onchange=e=>{state.sort=e.target.value;drawCards();};
 $('#reset-filter').onclick=()=>{state.category='Все специалисты';state.mode='';state.maxPrice='';state.query='';catalog();};
 $('#banner-chat').onclick=openChat;
 $('#catalog-section').insertBefore(chatLauncher,$('.filter-bar'));
 drawCards();
}
function drawCards() {
 let list=state.specialists.filter(s=>(state.category==='Все специалисты'||s.category===state.category) && (!state.query||[s.name,s.profession,s.skills,...s.services.map(v=>v.title)].join(' ').toLowerCase().includes(state.query.toLowerCase())) && s.services.some(v=>(!state.mode||v.mode===state.mode)&&(!state.maxPrice||v.price<=Number(state.maxPrice))));
 if(state.sort==='price')list.sort((a,b)=>Math.min(...a.services.map(x=>x.price))-Math.min(...b.services.map(x=>x.price)));
 if(state.sort==='rating')list.sort((a,b)=>(b.rating||0)-(a.rating||0));
 if(state.sort==='experience')list.sort((a,b)=>b.experience-a.experience);
 $('#cards').innerHTML=list.length?list.map(card).join(''):'<div class="empty"><span>⌕</span><h3>Пока никого не нашли</h3><p>Попробуйте другую задачу или сбросьте фильтры.</p></div>';
 $('.catalog-count').textContent=`Найдено: ${list.length}`;
 bindProfiles($('#cards'));
}
function bindProfiles(root=document) {$$('[data-profile]',root).forEach(b=>b.onclick=()=>profile(Number(b.dataset.profile)).catch(e=>toast(e.message)));}
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
 modal(`<span class="eyebrow">ВАШЕ ВРЕМЯ — В ВАШИХ РУКАХ</span><h2>${register?'Создать аккаунт':'Рады видеть вас'}</h2><p class="muted">${register?'Сохраните свои записи, отзывы и историю поиска.':'Войдите, чтобы управлять записями и расписанием.'}</p><form id="login-form">${register?'<label class="field">Ваше имя<input name="name" required minlength="2" maxlength="80" autocomplete="name"></label>':''}<label class="field">Электронная почта<input name="email" type="email" autocomplete="email" required></label><label class="field">Пароль<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="8" maxlength="128" required></label><p class="form-error" role="alert"></p><button class="button full">${register?'Зарегистрироваться':'Войти'} →</button></form>${!register?'<button id="forgot-password" class="text-button auth-switch">Забыли пароль?</button>':''}<button id="auth-switch" class="text-button auth-switch">${register?'Уже есть аккаунт? Войти':'Нет аккаунта? Зарегистрироваться'}</button>${!register?`<div class="demo-access"><span class="eyebrow">ПОПРОБУЙТЕ ДЕМО</span><p>Вымышленные данные, настоящие сценарии</p><div>${[['client','Клиент'],['master','Мастер'],['teacher','Преподаватель'],['admin','Администратор']].map(([k,v])=>`<button data-demo="${k}" class="button outline">${v}</button>`).join('')}</div><small>Общие демо-аккаунты. Не вводите личные данные.</small></div>`:''}`);
 const form=$('#login-form');
 async function submit(data){const button=$('button',form);button.disabled=true;try{const res=await api(register?'/register':'/login',data);state.user=res.user;state.csrf=res.csrf;updateAccount();closeModal(); if(after)await after();else{location.hash='dashboard';await dashboard();}}catch(e){$('.form-error',form).textContent=e.message;}finally{button.disabled=false;}}
 form.onsubmit=e=>{e.preventDefault();submit(Object.fromEntries(new FormData(form)));};
 $$('[data-demo]').forEach(b=>b.onclick=()=>submit({email:b.dataset.demo+'@svobodno.demo',password:'Demo2026!'}));
 $('#auth-switch').onclick=()=>login(after,!register);
 $('#forgot-password')?.addEventListener('click',requestPasswordReset);
}
function bindNotifications(user) {
 const toggle=$('#notifications-toggle'), panel=$('#notifications-panel');
 const count=$('.notification-count',toggle);
 const isCurrent=()=>panel.isConnected && state.user===user && location.hash==='#dashboard';
 let notifications=[];
 let busy=false;

 function render() {
  const unread=notifications.filter(n=>!n.is_read).length;
  count.textContent=unread;
  count.classList.toggle('hidden',!unread);
  toggle.setAttribute('aria-label',unread?`Уведомления, непрочитанных: ${unread}`:'Уведомления');
  panel.innerHTML=`<div class="notification-panel-head">
   <div><strong>Уведомления</strong><span role="status">${unread?`Непрочитанных: ${unread}`:'Непрочитанных нет'}</span></div>
   <button id="notifications-mark-read" class="text-button" ${unread?'':'disabled'}>Прочитать всё</button>
  </div><div class="notification-list">${notifications.length?notifications.map(n=>`
   <article class="notification-item ${n.is_read?'read':'unread'}">
    <span class="notification-dot ${n.event==='cancelled'?'warning':'success'}" aria-hidden="true"></span>
    <div class="notification-copy"><strong>${esc(n.message)}</strong>
     <small>${date(n.created_at.slice(0,10)+'T12:00:00')} · ${time(n.created_at)} (Киров)</small>
     ${n.is_read?'<small>Прочитано</small>':`<button class="text-button" data-read-notification="${esc(n.id)}">Отметить прочитанным</button>`}
    </div>
   </article>`).join(''):'<p class="notification-status">Уведомлений пока нет.</p>'}</div>`;
 }

 async function load() {
  if(busy)return;
  busy=true;
  panel.innerHTML='<p class="notification-status" role="status">Загружаем уведомления…</p>';
  try {
   const result=await api('/notifications');
   if(!isCurrent())return;
   notifications=result.notifications;
   render();
  } catch(error) {
   if(isCurrent()){
    panel.innerHTML='<p class="notification-status" role="status"></p>';
    $('p',panel).textContent=error.message;
   }
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
  if(!button||busy)return;
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
 load();
}

function bookingActions(booking) {
 const buttons = [];
 if (booking.actions.cancel) buttons.push(`<button data-cancel="${booking.id}" class="text-button danger">Отменить запись</button>`);
 if (booking.actions.complete) buttons.push(`<button class="button pale" data-complete="${booking.id}">Завершить встречу</button>`);
 if (booking.actions.review) buttons.push(`<button data-review="${booking.id}" class="button pale">Оставить отзыв</button>`);
 const reasons = Object.values(booking.action_reasons).map(reason => `<p class="action-reason">${esc(reason)}</p>`).join('');
 return `<strong>${money(booking.total)}</strong>${buttons.join('')}${reasons}`;
}
function scheduleDashboardRefresh() {
 clearTimeout(dashboardRefreshTimer);
 dashboardRefreshTimer = setTimeout(async () => {
  if (location.hash !== '#dashboard' || dashboardTab !== 'bookings' || !state.user) return;
  // Do not destroy an open dialog, filter selection or keyboard focus.
  if (document.hidden || $('#modal').open || $('.dashboard')?.contains(document.activeElement)) {
   scheduleDashboardRefresh(); return;
  }
  try { await dashboard(); } catch (error) { toast(error.message); scheduleDashboardRefresh(); }
 }, 30000);
}
async function dashboard() {
 const requestId = ++dashboardRequest;
 clearTimeout(dashboardRefreshTimer);
 $('#chat').before(chatLauncher);
 if(!state.user){login();return;}
 const user=state.user;
 const data=await api('/dashboard');
 if (requestId !== dashboardRequest || state.user !== user || location.hash !== '#dashboard') return;
 const isClient=user.role==='client', isMaster=user.role==='master', isAdmin=user.role==='admin';
 const tabs=isClient?[['bookings','Мои записи'],['searches','История поиска'],['reviews','Мои отзывы'],['profile','Профиль']]:isMaster?[['bookings','Записи клиентов'],['schedule','Моё расписание'],['services','Мои услуги'],['profile','Профиль']]:[['bookings','Все записи'],['moderation','Модерация отзывов'],['people','Специалисты и услуги']];
 if(!tabs.some(x=>x[0]===dashboardTab))dashboardTab='bookings';
 const notificationControl=isAdmin?'':`<div class="notification-control"><button id="notifications-toggle" class="button outline notification-trigger" aria-label="Уведомления" aria-expanded="false" aria-controls="notifications-panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span>Уведомления</span><span class="notification-count hidden" aria-hidden="true"></span></button><div id="notifications-panel" class="notification-panel hidden" aria-label="Список уведомлений"></div></div>`;
 $('#app').innerHTML=`<section class="dashboard"><div class="dashboard-heading"><div><span class="eyebrow">${isClient?'ЛИЧНЫЙ КАБИНЕТ':isMaster?'КАБИНЕТ СПЕЦИАЛИСТА':'АДМИНИСТРИРОВАНИЕ'}</span><h1>Здравствуйте, ${esc(user.name.split(' ')[0])}<span class="wave">✧</span></h1><p class="muted">${isClient?'Встречи, которые делают жизнь проще.':isMaster?'Ваше время, ваши услуги и ваши клиенты.':'Управляйте качеством сервиса и публикациями.'}</p></div><div class="dashboard-actions">${notificationControl}<button id="logout" class="button outline">Выйти ↗</button></div></div><div class="stats"><div><span>${isClient?'Предстоящих встреч':'Активных записей'}</span><strong>${data.bookings.filter(b=>isClient?b.phase==='upcoming':b.status==='confirmed').length}</strong></div><div><span>Завершённых встреч</span><strong>${data.bookings.filter(b=>b.status==='completed').length}</strong></div><div><span>${isAdmin?'На модерации':'Всего записей'}</span><strong>${isAdmin?data.reviews.filter(r=>r.status==='pending').length:data.bookings.length}</strong></div></div><div class="dashboard-tabs">${tabs.map(([id,t])=>`<button data-tab="${id}" class="${dashboardTab===id?'selected':''}">${t}</button>`).join('')}</div><div id="dashboard-content"></div></section>`;
 $('#logout').onclick=async()=>{const r=await api('/logout',{});state.user=null;state.csrf=r.csrf;dashboardTab='bookings';dashboardStatusFilter='all';clearTimeout(dashboardRefreshTimer);updateAccount();location.hash='catalog';catalog();};
 $$('[data-tab]').forEach(b=>b.onclick=()=>{dashboardTab=b.dataset.tab;dashboard().catch(e=>toast(e.message));});
 if(!isAdmin)bindNotifications(user);
 const root=$('#dashboard-content');
 if(dashboardTab==='bookings'){
  root.innerHTML=`<div class="section-title"><h2>${isClient?'Мои встречи':'История записей'}</h2><select id="booking-status" aria-label="Статус записи"><option value="all">Все записи</option><option value="confirmed">Активные</option><option value="completed">Завершённые</option><option value="cancelled">Отменённые</option></select></div><div class="dashboard-update"><p>Время Кирова · UTC+3. Статус и действия проверяет сервер.</p><button id="refresh-bookings" class="button outline">Обновить статусы</button><p id="dashboard-update-status" role="status"></p></div><div id="booking-list"></div>`;
  $('#booking-status').value=dashboardStatusFilter;
  $('#refresh-bookings').onclick=async()=>{try{await dashboard();$('#dashboard-update-status').textContent='Статусы обновлены';$('#refresh-bookings').focus();}catch(error){toast(error.message);}};
  const draw=()=>{
   const rows=data.bookings.filter(b=>$('#booking-status').value==='all'||b.status===$('#booking-status').value);
   $('#booking-list').innerHTML=rows.length?rows.map(b=>`<article class="booking-row" data-booking-id="${b.id}"><img src="${esc(b.photo)}" alt=""><div class="booking-info"><span class="badge ${b.status} ${b.phase}">${esc(b.status_label)}</span><h3>${esc(b.service)}</h3><p>${esc(b.specialist)}${!isClient?' · Клиент: '+esc(b.client):''}</p><p><b>${date(b.starts_at)} · ${time(b.starts_at)}–${b.starts_at.slice(0,10)===b.ends_at.slice(0,10)?'':date(b.ends_at)+' · '}${time(b.ends_at)}</b> · ${b.duration} мин · ${b.mode} · ${b.quantity} мест(о)</p>${b.address?`<p>⌖ ${esc(b.address)}</p>`:''}${b.note?`<p class="muted">${esc(b.note)}</p>`:''}</div><div class="booking-actions">${bookingActions(b)}</div></article>`).join(''):'<div class="empty"><span>▦</span><h3>Здесь пока нет записей</h3><p>Выберите специалиста и удобное время в каталоге.</p><a class="button" href="#catalog">Найти специалиста ↗</a></div>';
   $$('[data-cancel]').forEach(b=>b.onclick=()=>{modal('<h2>Отменить запись?</h2><p>Место освободится, и его смогут выбрать другие клиенты.</p><div class="dialog-actions"><button id="keep-booking" class="button outline">Оставить запись</button><button id="confirm-cancel" class="button">Да, отменить</button></div>');$('#keep-booking').onclick=closeModal;$('#confirm-cancel').onclick=async()=>{try{await api('/bookings/'+b.dataset.cancel+'/cancel',{});closeModal();toast('Запись отменена, место освобождено');await dashboard();}catch(e){toast(e.message);closeModal();await dashboard();}};});
   $$('[data-complete]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('/bookings/'+b.dataset.complete+'/complete',{});toast('Встреча завершена');}catch(e){toast(e.message);}finally{await dashboard();}});
   $$('[data-review]').forEach(b=>b.onclick=()=>reviewForm(Number(b.dataset.review)));
  };$('#booking-status').onchange=()=>{dashboardStatusFilter=$('#booking-status').value;draw();};draw();scheduleDashboardRefresh();
 }else if(dashboardTab==='searches'){
  root.innerHTML='<h2>Недавно вы искали</h2>'+(data.searches.length?data.searches.map(s=>`<button class="search-history" data-query-history="${esc(s.query)}"><span>⌕ &nbsp; ${esc(s.query)}</span><small>${date(s.created_at)}</small><span>↗</span></button>`).join(''):'<div class="empty">Ваши поисковые запросы появятся здесь.</div>');
  $$('[data-query-history]').forEach(b=>b.onclick=()=>{state.query=b.dataset.queryHistory;state.category='Все специалисты';state.mode='';state.maxPrice='';location.hash='catalog';});
 }else if(dashboardTab==='reviews'||dashboardTab==='moderation'){
  root.innerHTML=`<h2>${isAdmin?'Отзывы и модерация':'Мои отзывы'}</h2>`+(data.reviews.length?data.reviews.map(r=>`<article class="review panel"><div><strong>${esc(r.specialist)}</strong><span class="stars">${'★'.repeat(r.rating)}</span></div><p>${esc(r.content)}</p><small>${esc(r.author)} · ${date(r.created_at)} · ${{pending:'На модерации',approved:'Опубликован',rejected:'Отклонён'}[r.status]}</small>${isAdmin?`<div class="dialog-actions"><button data-moderate="${r.id}" data-status="approved" class="button pale" ${r.status==='approved'?'disabled':''}>Опубликовать</button><button data-moderate="${r.id}" data-status="rejected" class="button outline" ${r.status==='rejected'?'disabled':''}>Отклонить</button></div>`:''}</article>`).join(''):'<div class="empty">Отзывов пока нет. Клиент может оставить отзыв после завершённой встречи.</div>');
  $$('[data-moderate]').forEach(b=>b.onclick=async()=>{try{await api('/admin/moderate',{kind:'review',id:Number(b.dataset.moderate),status:b.dataset.status});await refreshCatalog();await dashboard();toast('Статус отзыва обновлён');}catch(e){toast(e.message);}});
 }else if(dashboardTab==='profile'){
  root.innerHTML='<div class="panel profile-settings"><div class="profile-settings-head"><div><span class="eyebrow">МОЙ ПРОФИЛЬ</span><h2>Данные аккаунта</h2><p class="muted">Измените имя, пароль или фотографию профиля.</p></div></div><div class="profile-settings-grid"><section><h3>Аватар</h3><div class="avatar-editor"><div id="avatar-preview">'+(user.avatar?'<img src="'+esc(user.avatar)+'" alt="">':'<span>'+esc(user.name[0])+'</span>')+'</div><form id="avatar-form"><label class="button outline file-button">Выбрать фото<input id="avatar-file" type="file" name="avatar" accept="image/jpeg,image/png,image/webp"></label><button class="button" type="submit">Сохранить фото</button><p class="form-error" role="alert"></p></form></div></section><section><h3>Личные данные</h3><form id="profile-form"><label class="field">ФИО<input name="name" value="'+esc(user.name)+'" minlength="2" maxlength="80" required></label><h3 class="settings-subtitle">Смена пароля</h3><label class="field">Текущий пароль<input name="current_password" type="password" autocomplete="current-password"></label><label class="field">Новый пароль<input name="new_password" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label><label class="field">Повторите новый пароль<input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label><p class="form-error" role="alert"></p><button class="button" type="submit">Сохранить изменения</button></form></section></div>'+(isClient||isMaster?'<div class="danger-zone"><h3>Удаление аккаунта</h3><p>Удаление необратимо. '+(isClient?'Предстоящие записи сначала нужно отменить.':'Предстоящие записи клиентов сначала нужно отменить.')+'</p><button id="delete-account" class="button outline danger">Удалить мой аккаунт</button></div>':'')+'</div>';
  const avatarForm=$('#avatar-form'), avatarFile=$('#avatar-file');
  avatarFile.onchange=()=>{const file=avatarFile.files[0];if(file)$('#avatar-preview').innerHTML='<img src="'+URL.createObjectURL(file)+'" alt="">';};
  avatarForm.onsubmit=async e=>{e.preventDefault();const file=avatarFile.files[0];if(!file){$('.form-error',avatarForm).textContent='Выберите фото';return;}const formData=new FormData();formData.append('avatar',file);const button=$('button[type=submit]',avatarForm);button.disabled=true;try{const response=await fetch('/api/profile/avatar',{method:'POST',headers:{'X-CSRF-Token':state.csrf},body:formData});const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить фото');state.user=result.user;state.csrf=result.csrf;updateAccount();toast('Фото профиля обновлено');await dashboard();}catch(error){$('.form-error',avatarForm).textContent=error.message;}finally{button.disabled=false;}};
  const profileForm=$('#profile-form');
  profileForm.onsubmit=async e=>{e.preventDefault();try{const result=await api('/profile',Object.fromEntries(new FormData(profileForm)),'PATCH');state.user=result.user;state.csrf=result.csrf;updateAccount();toast('Профиль сохранён');await dashboard();}catch(error){$('.form-error',profileForm).textContent=error.message;}};
  $('#delete-account')?.addEventListener('click',()=>modal('<h2>Удалить аккаунт?</h2><p>Все ваши записи, отзывы и история поиска будут удалены. Действие нельзя отменить.</p><div class="dialog-actions"><button id="keep-account" class="button outline">Оставить аккаунт</button><button id="confirm-delete" class="button danger">Удалить навсегда</button></div>'));
  $('#confirm-delete')?.addEventListener('click',async()=>{try{const response=await api('/account',{},'DELETE');state.user=null;state.csrf=response.csrf;updateAccount();closeModal();toast('Аккаунт удалён');location.hash='catalog';await route();}catch(error){closeModal();toast(error.message);}});
 }else if(dashboardTab==='schedule'||dashboardTab==='services'){
  const m=await api('/master');
  if(dashboardTab==='schedule'){
   root.innerHTML=`<div class="section-title"><div><h2>Свободные слоты</h2><p class="muted">Время Кирова (UTC+3). Пересекающиеся интервалы недоступны.</p></div></div><form id="slot-form" class="panel form-grid"><label class="field">Услуга<select name="service_id">${m.services.filter(s=>s.active).map(s=>`<option value="${s.id}" data-mode="${s.mode}">${esc(s.title)} · ${s.duration} мин</option>`).join('')}</select></label><label class="field">Дата и время<input type="datetime-local" name="starts_at" min="${localNow()}" required></label><label class="field">Количество мест<input type="number" name="capacity" min="1" max="50" value="1" required></label><button class="button">Добавить слот +</button><p class="form-error" role="alert"></p></form><div class="schedule-list">${m.slots.length?m.slots.map(s=>`<article class="schedule-row ${!s.active?'inactive':''}"><div><strong>${date(s.starts_at)} · ${time(s.starts_at)}</strong><p>${esc(s.service)}</p></div><span>${s.booked} / ${s.capacity} мест занято</span>${s.active?`<button data-close-slot="${s.id}" class="button outline">Закрыть слот</button>`:'<span class="muted">Закрыт</span>'}</article>`).join(''):'<div class="empty">Добавьте первый слот в своё расписание.</div>'}</div>`;
   const form=$('#slot-form');
   const capacity=()=>{const group=form.elements.service_id.selectedOptions[0]?.dataset.mode==='Группа';form.elements.capacity.max=group?'50':'1';if(!group)form.elements.capacity.value=1;};form.elements.service_id.onchange=capacity;capacity();
   form.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(form));d.service_id=Number(d.service_id);d.capacity=Number(d.capacity);try{await api('/master/slots',d);await dashboard();toast('Слот добавлен');}catch(e){$('.form-error',form).textContent=e.message;}};
   $$('[data-close-slot]').forEach(b=>b.onclick=async()=>{try{await api('/master/slots/'+b.dataset.closeSlot+'/close',{});await dashboard();toast('Слот закрыт');}catch(e){toast(e.message);}});
  }else{
   root.innerHTML=`<h2>Мои услуги</h2><div class="service-list">${m.services.map(s=>`<article class="panel service-row"><div><h3>${esc(s.title)}</h3><p>${s.mode} · ${s.duration} минут ${s.active?'':'· Скрыто модератором'}</p></div><strong>${money(s.price)}</strong></article>`).join('')}</div><h3>Добавить услугу</h3><form id="service-form" class="panel form-grid"><label class="field">Название<input name="title" minlength="3" maxlength="100" required></label><label class="field">Стоимость, ₽<input name="price" type="number" min="0" max="1000000" required></label><label class="field">Длительность, мин<input name="duration" type="number" min="15" max="480" value="60" required></label><label class="field">Формат<select name="mode">${['Выезд','У специалиста','Онлайн','Группа'].map(x=>`<option>${x}</option>`).join('')}</select></label><button class="button">Добавить услугу +</button><p class="form-error" role="alert"></p></form>`;
   const form=$('#service-form');form.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(form));d.price=Number(d.price);d.duration=Number(d.duration);try{await api('/master/services',d);await refreshCatalog();await dashboard();toast('Услуга добавлена');}catch(e){$('.form-error',form).textContent=e.message;}};
  }
 }else if(dashboardTab==='people'){
  const a=await api('/admin');
  root.innerHTML='<h2>Специалисты и услуги</h2><p class="muted">Скрытые специалисты и услуги недоступны для новых записей. Существующие записи сохраняются.</p>'+a.specialists.map(s=>`<article class="panel admin-person"><div class="service-row"><div><h3>${esc(s.name)}</h3><p>${esc(s.profession)} · ${s.active?'В каталоге':'Скрыт'}</p></div><button class="button ${s.active?'outline':'pale'}" data-toggle="specialist" data-id="${s.id}" data-active="${!s.active}">${s.active?'Скрыть':'Показать'}</button><button class="button outline danger" data-delete-specialist="${s.id}">Удалить</button></div>${a.services.filter(v=>v.specialist_id===s.id).map(v=>`<div class="admin-service"><span>${esc(v.title)} · ${money(v.price)}</span><button class="text-button" data-toggle="service" data-id="${v.id}" data-active="${!v.active}">${v.active?'Скрыть услугу':'Показать услугу'}</button></div>`).join('')}</article>`).join('');
  $('[data-toggle]').forEach(b=>b.onclick=async()=>{try{await api('/admin/moderate',{kind:b.dataset.toggle,id:Number(b.dataset.id),active:b.dataset.active==='true'});await refreshCatalog();await dashboard();toast('Изменения сохранены');}catch(e){toast(e.message);}});
  $('[data-delete-specialist]').forEach(b=>b.onclick=()=>{
    modal('<h2>Удалить специалиста?</h2><p>Удалятся профиль специалиста, услуги, расписание и история его записей. Предстоящие записи сначала нужно отменить.</p><div class="dialog-actions"><button id="keep-specialist" class="button outline">Оставить</button><button id="confirm-specialist-delete" class="button danger">Удалить навсегда</button></div>');
    $('#confirm-specialist-delete').onclick=async()=>{
      try{
        await api('/admin/specialists/'+b.dataset.deleteSpecialist,{},'DELETE');
        closeModal();
        await refreshCatalog();
        await dashboard();
        toast('Специалист удалён');
      }catch(error){
        closeModal();
        toast(error.message);
      }
    };
  });
 }
}
function reviewForm(booking_id){modal('<h2>Как прошла встреча?</h2><p class="muted">Отзыв появится в профиле после проверки администратором.</p><form id="review-form"><label class="field">Ваша оценка<select name="rating"><option value="5">★★★★★ — Отлично</option><option value="4">★★★★ — Хорошо</option><option value="3">★★★ — Нормально</option><option value="2">★★ — Плохо</option><option value="1">★ — Очень плохо</option></select></label><label class="field">Ваш отзыв<textarea name="content" minlength="5" maxlength="1500" required placeholder="Что вам понравилось? Что можно улучшить?"></textarea></label><p class="form-error" role="alert"></p><button class="button">Отправить отзыв →</button></form>');const form=$('#review-form');form.onsubmit=async e=>{e.preventDefault();try{await api('/reviews',{booking_id,rating:Number(form.elements.rating.value),content:form.elements.content.value});closeModal();toast('Спасибо! Отзыв отправлен на модерацию');await dashboard();}catch(e){$('.form-error',form).textContent=e.message;}};}
function openChat(){$('#chat').classList.remove('hidden');chatLauncher.classList.add('hidden');$('#chat-input').focus();}
$('#chat-launch').onclick=openChat;
$('#chat-close').onclick=()=>{$('#chat').classList.add('hidden');chatLauncher.classList.remove('hidden');};
$('#chat-form').onsubmit=async e=>{e.preventDefault();const input=$('#chat-input'),message=input.value.trim();if(!message)return;const list=$('#chat-messages');list.insertAdjacentHTML('beforeend',`<div class="bubble user">${esc(message)}</div>`);input.value='';const button=$('button',$('#chat-form'));button.disabled=true;try{const r=await api('/consult',{message});list.insertAdjacentHTML('beforeend',`<div class="bubble">${esc(r.reply)}${r.specialist_id?`<button class="button pale" data-profile="${r.specialist_id}">Посмотреть специалиста ↗</button>`:''}</div>`);bindProfiles(list);}catch(e){list.insertAdjacentHTML('beforeend',`<div class="bubble">${esc(e.message)}. Попробуйте ещё раз.</div>`);}finally{button.disabled=false;list.scrollTop=list.scrollHeight;}};
$('#modal-close').onclick=closeModal;
$('#modal').onclick=e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};
$('#account').onclick=()=>{if(state.user){location.hash='dashboard';dashboard().catch(e=>toast(e.message));}else login();};
async function route(){const id=++catalogRequest;try{if(location.hash==='#dashboard'){await dashboard();}else{await refreshCatalog();if(id!==catalogRequest)return;catalog();if(location.hash==='#how')$('#how-section').scrollIntoView({behavior:'smooth'});}$$('[data-nav]').forEach(a=>a.classList.toggle('active',a.getAttribute('href')===(location.hash||'#catalog')));}catch(e){$('#chat').before(chatLauncher);$('#app').innerHTML=`<div class="empty" role="alert"><h2>Не удалось загрузить страницу</h2><p>${esc(e.message)}</p><button id="retry-page" class="button">Повторить загрузку</button></div>`;$('#retry-page').onclick=route;}}
window.addEventListener('hashchange',route);
(async()=>{try{const s=await api('/session');state.user=s.user;state.csrf=s.csrf;updateAccount();if(location.pathname==='/reset-password'){resetPasswordPage();}await route();}catch(e){$('#app').innerHTML=`<div class="empty"><h2>Не удалось загрузить приложение</h2><p>${esc(e.message)}</p><button class="button" onclick="location.reload()">Повторить</button></div>`;}})();
