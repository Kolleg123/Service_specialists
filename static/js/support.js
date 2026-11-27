const supportStatuses = {
 pending: ['На рассмотрении', 'pending'],
 resolved: ['Обработано', 'confirmed'],
 cancelled: ['Отозвано', 'cancelled']
};
const supportRoles = {client: 'Клиент', master: 'Специалист'};
const supportView = {status: '', order: 'newest', open: new Set(), drafts: new Map()};
const supportDate = value => new Date(value).toLocaleString('ru-RU', {
 day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
});
const supportBadge = status => {
 const [label, style] = supportStatuses[status];
 return `<span class="badge ${style}">${label}</span>`;
};

function supportSender(item) {
 return `${esc(item.sender_name)} · ${supportRoles[item.sender_role]} · ${esc(item.sender_email)}`;
}

function supportDetails(item) {
 return `<section class="support-message"><h3>Обращение</h3>
   <p class="support-text">${esc(item.description)}</p></section>
  ${item.response ? `<section class="support-message support-reply"><h3>Ответ администратора</h3>
   <p class="muted">${esc(item.admin_name)} · ${supportDate(item.resolved_at)}</p>
   <p class="support-text">${esc(item.response)}</p></section>` : ''}`;
}

function showSupportForm(title = '', serviceForm = null) {
 const dialog = $('#support-dialog');
 if (dialog.open) return;
 const suggest = Boolean(title);
 const requestKey = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  value => value.toString(16).padStart(2, '0')).join('');
 dialog.innerHTML = `<button class="modal-close icon-button" data-dismiss-support aria-label="Закрыть окно">×</button>
  <h2 id="support-form-title">Создать обращение</h2>
  <form><label class="field">Заголовок<input name="title" maxlength="120" required value="${esc(title)}"></label>
   <label class="field">Описание<textarea name="description" maxlength="3000" required
    ${suggest ? 'placeholder="Какая категория нужна и для каких услуг?"' : ''}></textarea></label>
   <div class="dialog-actions"><button class="button">Отправить обращение</button>
    <button class="button outline" data-dismiss-support type="button">Отмена</button></div>
   <p class="form-error" role="alert"></p></form>`;
 $$('[data-dismiss-support]', dialog).forEach(button => button.onclick = () => dialog.close());
 const form = $('form', dialog);
 form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.request_key = requestKey;
  const button = $('button', form);
  button.disabled = true;
  try {
   const result = await api('/support', data);
   if (form.isConnected && dialog.open) dialog.close();
   if (!serviceForm && dashboardTab === 'support') {
    supportView.status = 'all';
    supportView.open.add(result.id);
    await dashboard();
   }
   toast('Обращение отправлено', 'success');
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   button.disabled = false;
  }
 };
 dialog.showModal();
 (suggest ? form.elements.description : form.elements.title).focus();
}

function openSupportFromNotice(item, admin) {
 modal(`<h2>${esc(item.title)}</h2><p>${supportBadge(item.status)} · ${supportDate(item.created_at)}</p>
  ${admin ? `<p class="muted">${supportSender(item)} · № ${item.user_id}</p>` : ''}
  ${supportDetails(item)}<button id="support-go" class="button">Открыть обращение</button>`);
 $('#support-go').onclick = async () => {
  supportView.status = 'all';
  supportView.open.add(item.id);
  dashboardTab = 'support';
  closeModal();
  try {
   await dashboard();
   const row = $(`[data-support-id="${item.id}"]`);
   row?.scrollIntoView({block: 'center'});
   $('summary', row ?? document)?.focus();
  } catch (error) {
   toast(error.message, 'error');
  }
 };
}

function renderSupport(root, items, admin) {
 const status = supportView.status || (admin ? 'pending' : 'all');
 if (!$('#support-list', root)) {
  root.innerHTML = `<div class="section-title"><h2>${admin ? 'Обращения' : 'Поддержка'}</h2>
   ${admin ? '' : '<button id="create-support" class="button">Создать обращение</button>'}</div>
   <div class="support-filters"><label class="field">Статус<select id="support-status">
    <option value="all">Все обращения</option><option value="pending">На рассмотрении</option>
    <option value="resolved">Обработанные</option><option value="cancelled">Отозванные</option>
   </select></label>
   <label class="field">Сортировка<select id="support-order"><option value="newest">Сначала новые</option>
    <option value="oldest">Сначала старые</option></select></label></div>
   <div id="support-list"></div><p id="support-empty" class="empty" role="status">Обращений с таким статусом пока нет.</p>`;
  if (!admin) $('#create-support').onclick = () => showSupportForm();
  $('#support-status').onchange = event => {
   supportView.status = event.target.value;
   renderSupport(root, root.supportItems, admin);
  };
  $('#support-order').onchange = event => {
   supportView.order = event.target.value;
   renderSupport(root, root.supportItems, admin);
  };
 }
 root.supportItems = items;
 $('#support-status', root).value = status;
 $('#support-order', root).value = supportView.order;
 const visible = items.filter(item => status === 'all' || item.status === status);
 if (supportView.order === 'oldest') visible.reverse();
 const list = $('#support-list', root);
 const visibleIds = new Set(visible.map(item => item.id));
 const currentRows = new Map([...list.children].map(row => [Number(row.dataset.supportId), row]));
 for (const [id, row] of currentRows) {
  if (!visibleIds.has(id)) row.remove();
 }
 visible.forEach((item, index) => {
  const snapshot = JSON.stringify(item);
  let row = currentRows.get(item.id);
  if (row?.dataset.snapshot !== snapshot) {
   const replacement = supportRow(item, admin);
   replacement.dataset.snapshot = snapshot;
   row?.replaceWith(replacement);
   row = replacement;
  }
  row.open = supportView.open.has(item.id);
  if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
 });
 $('#support-empty', root).hidden = Boolean(visible.length);
}

function supportRow(item, admin) {
 const row = document.createElement('details');
 row.className = 'panel support-row';
 row.dataset.supportId = item.id;
 row.ontoggle = () => {
  if (!row.isConnected) return;
  if (row.open) supportView.open.add(item.id);
  else supportView.open.delete(item.id);
 };
 row.innerHTML = `<summary><strong>${esc(item.title)}</strong> ${supportBadge(item.status)}
  <span class="muted support-meta">${admin ? `${supportSender(item)} · ` : ''}${supportDate(item.created_at)}</span></summary>
  <div class="support-body">${supportDetails(item)}
  ${item.status === 'pending' ? (admin ? `
   <button class="button pale" data-show-response>Ответить</button>
   <form hidden><label class="field">Ответ администратора<textarea name="response" maxlength="3000" required></textarea></label>
    <div class="dialog-actions"><button class="button">Ответить и завершить</button>
     <button class="button outline" type="button" data-discard-response>Отмена</button></div>
    <p class="form-error" role="alert"></p></form>` :
   '<button class="button outline danger" data-withdraw>Отозвать обращение</button>') : ''}
  </div>`;
 if (item.status !== 'pending') {
  supportView.drafts.delete(item.id);
  return row;
 }
 if (!admin) {
  $('[data-withdraw]', row).onclick = () => managementConfirmation('Отозвать обращение?',
   'Обращение останется в истории. Администратор больше не сможет ответить.', false, async () => {
    await api(`/support/${item.id}/cancel`, {confirm: true});
    return 'Обращение отозвано';
   });
  return row;
 }
 const button = $('[data-show-response]', row);
 const form = $('form', row);
 const response = form.elements.response;
 if (supportView.drafts.has(item.id)) {
  response.value = supportView.drafts.get(item.id);
  form.hidden = false;
  button.hidden = true;
 }
 button.onclick = () => {
  button.hidden = true;
  form.hidden = false;
  supportView.drafts.set(item.id, response.value);
  response.focus();
 };
 response.oninput = () => supportView.drafts.set(item.id, response.value);
 $('[data-discard-response]', form).onclick = () => {
  supportView.drafts.delete(item.id);
  form.reset();
  $('.form-error', form).textContent = '';
  form.hidden = true;
  button.hidden = false;
  button.focus();
 };
 form.onsubmit = async event => {
  event.preventDefault();
  const buttons = $$('button', form);
  buttons.forEach(control => control.disabled = true);
  try {
   await api(`/support/${item.id}/resolve`, {response: response.value});
   supportView.drafts.delete(item.id);
   await dashboard();
   toast('Ответ отправлен, обращение обработано', 'success');
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   buttons.forEach(control => control.disabled = false);
  }
 };
 return row;
}
