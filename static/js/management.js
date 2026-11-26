function openNotificationDetails({message, target}) {
 const item = target?.item;
 if (target?.kind === 'support') {
  openSupportFromNotice(item, state.user.role === 'admin');
  return;
 }
 let details = '<p>Связанный объект больше недоступен.</p>';
 if (target?.kind === 'booking') {
  const status = {confirmed:'Подтверждена', cancelled:'Отменена', completed:'Завершена'};
  details = `<h3>${esc(item.title)}</h3><p>${esc(item.specialist)} · ${date(item.starts_at)}
   ${item.booking_mode === 'day' ? '' : time(item.starts_at)} · ${status[item.status]}</p>
   ${item.cancel_reason ? `<p>Причина отмены: ${esc(item.cancel_reason)}</p>` : ''}`;
 } else if (target?.kind === 'service') {
  details = `<h3>${esc(item.title)}</h3><p>${esc(item.mode)} · ${item.duration} мин · ${money(item.price)}</p>
   <p>${serviceStatus[item.moderation_status]}</p>
   ${item.draft ? `<p>Изменения «${esc(item.draft.title)}» · ${serviceStatus[item.draft_status]}</p>` : ''}`;
 } else if (target?.kind === 'application') {
  details = `<h3>${esc(item.name)} · ${serviceStatus[item.status]}</h3>
   <p>${date(item.created_at)} · ${esc(item.category)} · Стаж: ${item.experience} лет</p>
   <dl>${applicationTextFields.slice(1).map(([field, label]) =>
    `<dt><strong>${label}</strong></dt><dd>${esc(item[field])}</dd>`).join('')}</dl>
   ${item.reason ? `<p>Причина отклонения: ${esc(item.reason)}</p>` : ''}`;
 }
 modal(`<h2>Уведомление</h2><p>${esc(message)}</p>${details}
  ${target ? '<button id="notification-go" class="button">Открыть раздел кабинета</button>' : ''}`);
 const go = $('#notification-go');
 if (go) go.onclick = async () => {
  dashboardMode = target.mode;
  dashboardTab = target.tab;
  dashboardStatusFilter = 'all';
  closeModal();
  try {
   await dashboard();
   const row = target.kind === 'booking' ? $(`[data-booking-id="${item.id}"]`) :
    target.kind === 'service' ? $(`[data-service-id="${item.id}"]`) : null;
   row?.scrollIntoView({block:'center'});
  } catch (error) {
   toast(error.message);
  }
 };
}

function managementConfirmation(title, description, reason, action, options = {}) {
 modal(`<h2>${esc(title)}</h2><p>${esc(description)}</p>
  <form id="management-confirmation">
   ${reason ? '<label class="field">Причина отмены (необязательно)<textarea name="reason" maxlength="500"></textarea></label>' : ''}
   <div class="dialog-actions">
    <button id="keep-booking" class="button outline" type="button">${esc(options.back ?? 'Назад')}</button>
    <button id="confirm-cancel" class="button">${esc(options.confirm ?? 'Да, подтвердить')}</button>
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
   toast(message);
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
  ${serviceCategoryFields()}`;
}

function bindServiceForm(form, path, categories, initialCategory, inModal = false) {
 bindServiceCategories(form, categories, initialCategory);
 $('[data-suggest-category]', form).onclick = () => showSupportForm('Предложение новой категории', form);
 form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  delete data.category_group;
  data.price = Number(data.price);
  data.duration = Number(data.duration);
  const button = $('button[type=submit]', form);
  button.disabled = true;
  try {
   await api(path, data);
   if (inModal && form.isConnected) closeModal();
   toast('Услуга отправлена на проверку');
   await dashboard();
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
    <button type="submit" class="button">Отправить на проверку</button><p class="form-error" role="alert"></p></form>`);
   bindServiceForm($('#edit-service-form'), `/master/services/${service.id}/edit`, categories, edited.category_id, true);
  };
  $('[data-delete-service]', row).onclick = async () => {
   try {
    const {services: updated} = await api('/master');
    if (!row.isConnected) return;
    const current = updated.find(item => item.id === service.id);
    if (!current) return toast('Услуга уже недоступна');
    const warning = current.upcoming_count ? `Предстоящих записей: ${current.upcoming_count}. ` : '';
    managementConfirmation('Удалить услугу?', warning + 'Существующие записи сохранятся. Новые записи будут недоступны.',
     false, async () => {
      await api(`/master/services/${service.id}/delete`, {confirm:true, upcoming_count:current.upcoming_count});
      return 'Услуга удалена';
     });
   } catch (error) {
    toast(error.message);
   }
  };
 }
}
