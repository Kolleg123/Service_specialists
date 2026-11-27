function openNotificationDetails({message, event, created_at, target}) {
 const item = target?.item;
 const titles = {
  specialist_approved:'Заявка специалиста одобрена', specialist_rejected:'Заявка специалиста отклонена',
  specialist_revoked:'Права специалиста сняты', service_approved:'Услуга одобрена', service_rejected:'Услуга отклонена',
  confirmed:message.startsWith('Новая запись клиента') ? 'Новая запись клиента' : 'Запись подтверждена',
  cancelled:'Запись отменена', completed:'Встреча завершена',
  support_created:'Новое обращение в поддержку', support_resolved:'Поддержка ответила',
  payment_pending:'Платёж ожидает подтверждения', payment_succeeded:'Платёж подтверждён',
  payment_canceled:'Платёж отменён', payment_failed:'Ошибка оплаты',
  refund_pending:'Ожидается возврат', refund_succeeded:'Возврат выполнен', refund_canceled:'Возврат отменён'
 };
 const title = titles[event] || 'Уведомление';
 let copy = message;
 let fields = [];
 let content = '';
 let label;
 if (target?.kind === 'booking') {
  fields = [['Услуга',item.title], ['Специалист',item.specialist],
   ['Встреча', date(item.starts_at) + (item.booking_mode === 'day' ? '' : ' · ' + time(item.starts_at))],
   ['Причина отмены',item.cancel_reason]];
  if (['confirmed','cancelled','completed'].includes(event)) copy = '';
  label = 'Открыть запись';
 } else if (target?.kind === 'service') {
  fields = [['Услуга',item.draft?.title || item.title], ['Формат',item.mode],
   ['Длительность',item.duration + ' мин'], ['Цена',money(item.price)],
   ['Причина отклонения',event === 'service_rejected' ? (item.draft_reason || item.moderation_reason) : null]];
  copy = '';
  label = 'Открыть услуги';
 } else if (target?.kind === 'application') {
  if (event === 'specialist_approved' && state.user.role === 'master') {
   copy = 'Вам доступен режим «Специалист».';
   label = 'Открыть кабинет специалиста';
  } else if (event === 'specialist_rejected') {
   copy = '';
   fields = [['Причина отклонения',item.reason]];
   label = 'Открыть заявку';
  }
 } else if (target?.kind === 'support') {
  fields = [['Тема',item.title]];
  if (state.user.role === 'admin') fields.push(['Автор',item.sender_name]);
  content = supportDetails(item);
  copy = '';
  label = 'Открыть обращение';
 } else if (event !== 'specialist_revoked') {
  content = '<p class="muted">Связанный объект больше недоступен.</p>';
 }
 const status = event.endsWith('_approved') ? ['Одобрено','approved'] :
  event.endsWith('_rejected') ? ['Отклонено','rejected'] :
  event === 'specialist_revoked' ? ['Клиент','rejected'] : null;
 modal(`<article class="notice-detail">
  <h2>${esc(title)}</h2>
  <div class="notice-meta"><time datetime="${esc(created_at)}">${date(created_at)} · ${time(created_at)} (Киров)</time>
   ${status ? `<span class="badge ${status[1]}">${status[0]}</span>` : ''}</div>
  ${copy ? `<p class="notice-copy">${esc(copy)}</p>` : ''}
  ${fields.some(([,value]) => value) ? `<dl class="detail-grid">${fields.filter(([,value]) => value)
   .map(([key,value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}
  ${content}
  ${label ? `<button id="${target.kind === 'support' ? 'support-go' : 'notification-go'}" class="button">${label}</button>` : ''}
 </article>`);
 const go = $('#notification-go, #support-go');
 if (!go) return;
 go.onclick = async () => {
  dashboardMode = target.mode;
  dashboardTab = target.tab;
  dashboardStatusFilter = 'all';
  if (event === 'specialist_approved') {
   dashboardMode = 'master';
   dashboardTab = 'bookings';
  }
  if (target.kind === 'support') {
   supportView.status = 'all';
   supportView.open.add(item.id);
  }
  closeModal();
  try {
   await dashboard();
   const attribute = {booking:'data-booking-id', service:'data-service-id', support:'data-support-id'}[target.kind];
   if (attribute) $(`[${attribute}="${item.id}"]`)?.scrollIntoView({block:'center'});
  } catch (error) {
   toast(error.message, 'error');
  }
 };
}

function managementConfirmation(title, description, reason, action, options = {}) {
 modal(`<h2>${esc(title)}</h2><p>${esc(description)}</p>
  <form id="management-confirmation">
   ${reason ? `<label class="field">${options.reasonLabel || 'Причина отмены (необязательно)'}<textarea name="reason" maxlength="500" ${options.reasonLabel ? 'required' : ''}></textarea></label>` : ''}
   <div class="dialog-actions">
    <button id="keep-booking" class="button outline" type="button">${esc(options.back ?? 'Назад')}</button>
    <button id="confirm-cancel" class="button ${options.confirmClass || ''}">${esc(options.confirm ?? 'Да, подтвердить')}</button>
   </div>
   <p class="form-error" role="alert"></p>
  </form>`);
 $('#keep-booking').onclick = closeModal;
 const form = $('#management-confirmation');
 form.onsubmit = async event => {
  event.preventDefault();
  const button = $('#confirm-cancel', form);
  if (button.disabled) return;
  button.disabled = true;
  if (options.lockWhilePending) form.setAttribute('data-pending-deletion', '');
  try {
   const message = await action(form.elements.reason?.value ?? '');
   form.removeAttribute('data-pending-deletion');
   if (form.isConnected) closeModal();
   toast(message, 'success');
   if (location.hash === '#dashboard') await dashboard();
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   form.removeAttribute('data-pending-deletion');
   button.disabled = false;
  }
 };
}

function serviceFormFields(service = {}) {
 return `<label class="field">Название<input name="title" minlength="3" maxlength="100" required value="${esc(service.title)}"></label>
  <label class="field">Стоимость, ₽<input name="price" type="number" min="0" max="1000000" required value="${service.price ?? ''}"></label>
  <label class="field">Длительность, мин<input name="duration" type="number" min="15" max="480" required value="${service.duration ?? 60}"></label>
  <label class="field">Формат<select name="mode">${['Выезд','У специалиста','Онлайн','Группа'].map(mode =>
   `<option ${mode === service.mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label>
  ${serviceCategoryFields()}
  <label class="field"><span>Адрес оказания услуги</span>
   <input name="service_address" minlength="5" maxlength="250" value="${esc(service.service_address)}">
   <small class="muted">Этот адрес увидят посетители каталога.</small></label>
  <label class="field">Контактный телефон
   <input name="contact_phone" type="tel" maxlength="32" autocomplete="tel" value="${esc(service.contact_phone)}"></label>
  <label class="field">Инструкции для клиента
   <textarea name="contact_instructions" maxlength="1000" placeholder="Например, как найти вход или подключиться к встрече">${esc(service.contact_instructions)}</textarea>
   <small class="muted">Телефон и инструкции доступны участникам после записи.</small></label>`;
}

function bindServiceForm(form, path, categories, initialCategory, inModal = false) {
 bindServiceCategories(form, categories, initialCategory);
 const mode = form.elements.mode;
 const address = form.elements.service_address;
 const syncAddress = () => {
  const visible = ['У специалиста', 'Группа'].includes(mode.value);
  address.required = mode.value === 'У специалиста';
  address.disabled = !visible;
  address.closest('label').classList.toggle('hidden', !visible);
 };
 mode.addEventListener('change', syncAddress);
 syncAddress();
 $('[data-suggest-category]', form).onclick = () => showSupportForm('Предложение новой категории', form);
 form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  delete data.category_group;
  data.price = Number(data.price);
  data.duration = Number(data.duration);
  const button = $('button[type=submit]', form);
  if (button.disabled) return;
  button.disabled = true;
  try {
   if (path === '/master/services') {
    await submitOperation(path, data);
    form.reset();
    syncAddress();
    form.updateServiceDirectory(categories);
   } else {
    await api(path, data);
   }
   if (inModal && form.isConnected) closeModal();
   toast('Услуга отправлена на проверку', 'success');
   dashboard().catch(error => toast(error.message, 'error'));
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   button.disabled = false;
  }
 };
}

function renderManagedServices(root, services, categories) {
 if (!$('#service-form', root)) {
  root.innerHTML = `<h2>Мои услуги</h2><div class="service-list"></div>
   <h3>Добавить услугу</h3><form id="service-form" class="panel form-grid">${serviceFormFields()}
   <button type="submit" class="button">Добавить услугу +</button><p class="form-error" role="alert"></p></form>`;
  bindServiceForm($('#service-form', root), '/master/services', categories);
 } else {
  $('#service-form', root).updateServiceDirectory(categories);
 }
 const list = $('.service-list', root);
 const snapshot = JSON.stringify([services, categories]);
 if (list.dataset.snapshot === snapshot) return;
 list.dataset.snapshot = snapshot;
 list.innerHTML = services.map(service => `
  <article class="panel service-row" data-service-id="${service.id}">
   <div><h3>${esc(service.title)}</h3><p>${esc(service.mode)} · ${service.duration} мин ·
    ${serviceStatus[service.moderation_status]}${service.active ? '' : ' · Скрыта'}</p>
   <p>${esc(serviceCategoryLabel(categories, service.category_id))} · ${money(service.price)}</p>
   ${service.draft ? `<p>Изменения «${esc(service.draft.title)}» · ${serviceStatus[service.draft_status]} · ${esc(serviceCategoryLabel(categories, service.draft.category_id))}</p>` : ''}
   ${(service.draft_reason || service.moderation_reason) ? `<p>Причина отклонения: ${esc(service.draft_reason || service.moderation_reason)}</p>` : ''}
   <div class="dialog-actions"><button data-edit-service class="button outline">Изменить</button>
   <button data-delete-service class="button outline">Удалить</button></div></div>
  </article>`).join('');
 for (const service of services) {
  const row = $(`[data-service-id="${service.id}"]`, root);
  $('[data-edit-service]', row).onclick = () => {
   const edited = service.draft ?? service;
   modal(`<h2>Изменить услугу</h2><form id="edit-service-form">${serviceFormFields(edited)}
    <button type="submit" class="button">Отправить на проверку</button><p class="form-error" role="alert"></p></form>`, 'service-editor');
   bindServiceForm($('#edit-service-form'), `/master/services/${service.id}/edit`, categories, edited.category_id, true);
  };
  $('[data-delete-service]', row).onclick = async () => {
   try {
    const {services: updated} = await api('/master');
    if (!row.isConnected) return;
    const current = updated.find(item => item.id === service.id);
    if (!current) return toast('Услуга уже недоступна', 'warning');
    const warning = current.upcoming_count ? `Предстоящих записей: ${current.upcoming_count}. ` : '';
    managementConfirmation('Удалить услугу?', warning + 'Существующие записи сохранятся. Новые записи будут недоступны.',
     false, async () => {
      await api(`/master/services/${service.id}/delete`, {confirm:true, upcoming_count:current.upcoming_count});
      return 'Услуга удалена';
     });
   } catch (error) {
    toast(error.message, 'error');
   }
  };
 }
}

let focusAdminUser = null;

function renderAdminUsers(root, users) {
 const roles = {client:'Клиент',master:'Специалист',admin:'Администратор'};
 root.innerHTML = `<h2>Пользователи</h2>
  <div class="admin-user-filters">
   <label class="field">Поиск<input id="user-query" type="search" placeholder="Имя, логин или почта"></label>
   <label class="field">Роль<select id="user-role"><option value="">Все роли</option>
    ${Object.entries(roles).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
   <label class="field">Сортировка<select id="user-sort">
    <option value="1">По имени (А–Я)</option><option value="-1">По имени (Я–А)</option>
   </select></label>
  </div>
  <p class="muted" id="user-count" role="status"></p><div id="user-results"></div>`;
 const search = $('#user-query', root);
 const role = $('#user-role', root);
 const sort = $('#user-sort', root);
 const results = $('#user-results', root);
 const open = new Set(focusAdminUser ? [focusAdminUser] : []);
 const draw = () => {
  const query = search.value.trim().toLocaleLowerCase('ru');
  const filtered = users.filter(user => (!role.value || user.role === role.value) &&
   [user.name,user.username,user.email].some(value => value?.toLocaleLowerCase('ru').includes(query)));
  filtered.sort((a,b) => sort.value * a.name.localeCompare(b.name, 'ru') || a.id-b.id);
  $('#user-count', root).textContent = 'Найдено: ' + filtered.length;
  results.innerHTML = filtered.length ? filtered.map(user => `
   <details class="panel admin-user" data-account-id="${user.id}" ${open.has(user.id) ? 'open' : ''}>
    <summary><strong>${esc(user.name)}</strong><span class="badge ${user.role === 'master' ? 'approved' : ''}">${roles[user.role]}</span></summary>
    <div class="admin-user-body">
     <dl class="detail-grid"><dt>Логин</dt><dd>${esc(user.username || '—')}</dd>
      <dt>Почта</dt><dd>${esc(user.email || '—')}</dd></dl>
     ${user.specialist ? `<h3>Профиль специалиста</h3>
      <dl class="detail-grid"><dt>Профессия</dt><dd>${esc(user.specialist.profession || '—')}</dd>
       <dt>Категория</dt><dd>${esc(user.specialist.category || '—')}</dd>
       <dt>Каталог</dt><dd>${user.specialist.active ? 'Опубликован' : 'Скрыт'}</dd>
       <dt>Описание</dt><dd>${esc(user.specialist.bio || '—')}</dd></dl>
      <h3>Услуги</h3>${user.specialist.services.length ? `<ul class="admin-user-services">${user.specialist.services
       .map(service => `<li>${esc(service.title)}${service.active ? '' : ' · Скрыта'}</li>`).join('')}</ul>` :
       '<p class="muted">Услуг пока нет.</p>'}
      ${user.role === 'master' ? `<button class="button outline danger" data-revoke="${user.id}">Снять права специалиста</button>` : ''}` : ''}
    </div>
   </details>`).join('') : '<p class="empty">По выбранным условиям пользователей нет.</p>';
 };
 search.oninput = role.onchange = sort.onchange = draw;
 results.addEventListener('toggle', event => {
  const row = event.target;
  const id = Number(row.dataset.accountId);
  if (!id) return;
  if (row.open) open.add(id);
  else open.delete(id);
 }, true);
 results.onclick = event => {
  const button = event.target.closest('[data-revoke]');
  if (!button) return;
  const user = users.find(user => user.id === Number(button.dataset.revoke));
  managementConfirmation('Снять права специалиста?',
   `${user.name} останется клиентом. Услуги исчезнут из каталога, а история записей сохранится.`,
   true, async reason => {
    await api(`/admin/users/${user.id}/revoke-specialist`, {reason});
    await refreshCatalog();
    return 'Права специалиста сняты';
   }, {back:'Оставить права',confirm:'Снять права',reasonLabel:'Причина снятия прав',
    confirmClass:'danger-solid',lockWhilePending:true});
 };
 draw();
 if (focusAdminUser) {
  const summary = $(`[data-account-id="${focusAdminUser}"] summary`, root);
  summary?.focus();
  focusAdminUser = null;
 }
}
