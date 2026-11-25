const applicationTextFields = [
 ['name', 'Имя', 80],
 ['profession', 'Профессия', 100],
 ['education', 'Образование', 500],
 ['skills', 'Профессиональные навыки', 500],
 ['bio', 'Информация о себе', 1500],
 ['location', 'Место оказания услуг', 250]
];

function renderSpecialistApplication(root, application, user, categories) {
 const canApply = user.role === 'client' && (!application || application.status === 'rejected');
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
  <label class="field">Категория<select name="category" required>
   <option value="">Выберите категорию</option>
   ${categories.map(category => `<option ${category === draft.category ? 'selected' : ''}>${esc(category)}</option>`).join('')}
  </select></label>
  <label class="field">Опыт работы, полных лет<input name="experience" type="number" min="0" max="80" required value="${esc(draft.experience)}"></label>
  ${applicationTextFields.slice(2).map(textField).join('')}
  <button class="button">${application ? 'Подать повторную заявку' : 'Отправить заявку'}</button>
  <p class="form-error" role="alert"></p>
 </form>`);
 const form = $('form', root);
 form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.experience = Number(data.experience);
  const button = $('button', form);
  button.disabled = true;
  try {
   await api('/specialist-applications', data);
   await dashboard();
   toast('Заявка отправлена администратору');
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   button.disabled = false;
  }
 };
}

let specialistApplicationFilter = 'pending';

function renderSpecialistApplications(root, applications) {
 const fields = [...applicationTextFields, ['category', 'Категория'], ['experience', 'Опыт работы, полных лет']];
 const filtered = applications.filter(application => specialistApplicationFilter === 'all' ||
  application.status === specialistApplicationFilter);
 root.innerHTML = `<h2>Заявки специалистов</h2><label class="field">Статус заявки
  <select id="specialist-application-filter">
   <option value="pending">На проверке</option><option value="approved">Одобренные</option>
   <option value="rejected">Отклонённые</option><option value="all">Все</option>
  </select></label>` + (filtered.length ? filtered.map(application => `
  <details class="panel">
   <summary><strong>${esc(application.name)} · ${serviceStatus[application.status]}</strong>
    · ${esc(application.account_name)} · ${esc(application.email)}
    · ${date(application.created_at)} ${time(application.created_at)}</summary>
   <dl>${fields.map(([key, label]) => `<dt><strong>${label}</strong></dt><dd>${esc(application[key])}</dd>`).join('')}</dl>
   ${application.reason ? `<p>Причина отклонения: ${esc(application.reason)}</p>` : ''}
   ${application.status === 'pending' ? `
    <form data-application-id="${application.id}">
     <label class="field">Причина (для отклонения)<textarea name="reason" maxlength="500"></textarea></label>
     <div class="dialog-actions">
      <button class="button" value="approved">Одобрить</button>
      <button class="button outline" value="rejected">Отклонить</button>
     </div>
     <p class="form-error" role="alert"></p>
    </form>` : ''}
  </details>`).join('') : '<p class="empty">Заявок пока нет.</p>');

 const filter = $('#specialist-application-filter', root);
 filter.value = specialistApplicationFilter;
 filter.onchange = () => {
  specialistApplicationFilter = filter.value;
  renderSpecialistApplications(root, applications);
  $('#specialist-application-filter', root).focus();
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
   toast('Решение сохранено');
  } catch (error) {
   feedback.textContent = error.message;
  } finally {
   buttons.forEach(button => button.disabled = false);
  }
 });
}
