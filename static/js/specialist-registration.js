const applicationTextFields = [
 ['name', 'Имя', 80],
 ['profession', 'Профессия', 100],
 ['education', 'Образование', 500],
 ['skills', 'Профессиональные навыки', 500],
 ['bio', 'Информация о себе', 1500],
 ['location', 'Место оказания услуг', 250]
];

function renderSpecialistApplication(root, application, user, categories) {
 const canApply = user.role === 'client' && application?.status !== 'pending';
 root.innerHTML = `<h2>Стать специалистом</h2>
  ${application ? `<p>Статус заявки: <strong>${serviceStatus[application.status]}</strong></p>` : ''}
  ${application?.reason ? `<p>Причина отклонения: ${esc(application.reason)}</p>` : ''}`;
 if (!canApply) return;

 const draft = application ?? {name: user.name};
 const textField = ([key, label, maximum]) => {
  const value = esc(draft[key]);
  const constraints = `name="${key}" required minlength="2" maxlength="${maximum}"`;
  const control = maximum >= 500 ? `<textarea ${constraints}>${value}</textarea>` : `<input ${constraints} value="${value}">`;
  return `<label class="field">${label}${control}</label>`;
 };
 root.insertAdjacentHTML('beforeend', `<form class="panel form-grid">
  ${applicationTextFields.slice(0, 2).map(textField).join('')}
  <label class="field">Категория<select id="specialist-profile-group" name="category" required></select>
   <span class="form-error profile-group-unavailable" role="status"></span></label>
  <label class="field">Опыт работы, полных лет<input name="experience" type="number" min="0" max="80" required value="${esc(draft.experience)}"></label>
  ${applicationTextFields.slice(2).map(textField).join('')}
  <button class="button">${application ? 'Подать повторную заявку' : 'Отправить заявку'}</button>
  <p class="form-error" role="alert"></p>
 </form>`);
 const form = $('form', root);
 const select = form.elements.category;
 const warning = $('.profile-group-unavailable', form);
 let categorySignature;
 select.updateProfileGroups = groups => {
  const signature = JSON.stringify(groups);
  if (signature === categorySignature) return;
  const selected = categorySignature === undefined ? draft.category_group_id : select.value;
  categorySignature = signature;
  select.innerHTML = '<option value="">Выберите категорию</option>' + categoryOptions(groups);
  select.value = groups.some(group => group.id === selected) ? selected : '';
  if (selected && !select.value) warning.textContent = 'Выбранная группа недоступна. Выберите другую.';
 };
 select.onchange = () => {warning.textContent = '';};
 select.updateProfileGroups(categories);
 form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.experience = Number(data.experience);
  const button = $('button:not([type]),button[type=submit]', form);
  button.disabled = true;
  try {
   await api('/specialist-applications', data);
   await dashboard();
   toast('Заявка отправлена администратору', 'success');
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   button.disabled = false;
  }
 };
}

let specialistApplicationFilter = 'pending';
let specialistApplicationOrder = 'newest';

function renderSpecialistApplications(root, applications) {
 const fields = [['account_name','Аккаунт'], ['email','Электронная почта'], ...applicationTextFields.slice(2),
  ['category', 'Категория'], ['experience', 'Опыт работы, полных лет']];
 const filtered = applications.filter(application => specialistApplicationFilter === 'all' ||
  application.status === specialistApplicationFilter).sort((a, b) => specialistApplicationOrder === 'oldest' ?
   new Date(a.created_at) - new Date(b.created_at) : new Date(b.created_at) - new Date(a.created_at));
 root.innerHTML = `<div class="section-title applications-heading"><h2>Заявки специалистов</h2>
  <label class="field application-filter">Статус заявки
  <select id="specialist-application-filter">
   <option value="pending">На проверке</option><option value="approved">Одобренные</option>
   <option value="rejected">Отклонённые</option><option value="all">Все</option>
  </select></label>
  <label class="field application-order">Сортировка
   <select id="specialist-application-order"><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select>
  </label></div>` + (filtered.length ? filtered.map(application => `
  <details class="panel specialist-application-card" data-application-key="specialist-${application.id}">
   <summary><span class="application-summary-main"><strong>${esc(application.name)}</strong><span class="badge ${application.status}">${serviceStatus[application.status]}</span></span>
    <span class="application-summary-meta">${esc(application.profession)}</span>
    <span class="application-summary-date">Подана ${date(application.created_at)} в ${time(application.created_at)}</span></summary>
   <div class="application-details-heading"><h3>Анкета кандидата</h3><span class="muted">Заявка №${application.id}</span></div>
   <dl>${fields.map(([key, label]) => `<dt><strong>${label}</strong></dt><dd>${esc(application[key])}</dd>`).join('')}</dl>
   ${application.reason ? `<p>Причина отклонения: ${esc(application.reason)}</p>` : ''}
   ${application.status === 'pending' ? `
    <form data-application-id="${application.id}">
     <label class="field">Причина (для отклонения)<textarea name="reason" maxlength="500"></textarea></label>
     <div class="dialog-actions moderation-actions">
      <button class="button moderation-approve" value="approved">Одобрить заявку</button>
      <button class="button outline danger" value="rejected">Отклонить</button>
     </div>
     <p class="form-error" role="alert"></p>
    </form>` : ''}
  </details>`).join('') : '<p class="empty">Заявок пока нет.</p>');

 const filter = $('#specialist-application-filter', root);
 filter.value = specialistApplicationFilter;
 filter.onchange = () => {
  specialistApplicationFilter = filter.value;
  renderSpecialistApplications(root, applications);
  queueMicrotask(() => $('#specialist-application-filter', root)?.focus());
 };
 const order = $('#specialist-application-order', root);
 order.value = specialistApplicationOrder;
 order.onchange = () => {
  specialistApplicationOrder = order.value;
  renderSpecialistApplications(root, applications);
  queueMicrotask(() => $('#specialist-application-order', root)?.focus());
 };

 $$('form[data-application-id]', root).forEach(form => form.onsubmit = async event => {
  event.preventDefault();
  const status = event.submitter?.value;
  if (!status) return;
  const reason = form.elements.reason.value.trim();
  const feedback = $('.form-error', form);
  if (status === 'rejected' && !reason) {
   feedback.textContent = 'Укажите причину отклонения';
   form.elements.reason.focus();
   return;
  }
  const buttons = $$('button', form);
  buttons.forEach(button => button.disabled = true);
  try {
   await api(`/admin/specialist-applications/${form.dataset.applicationId}/decision`, {status, reason});
   await dashboard();
   toast('Решение сохранено', 'success');
  } catch (error) {
   feedback.textContent = error.message;
  } finally {
   buttons.forEach(button => button.disabled = false);
  }
 });
}
