const directoryView = {query: '', order: 'asc', open: new Set()};

function renderCategoryDirectory(root, groups) {
 if (!$('#directory-list', root)) {
  root.innerHTML = `<div class="section-title"><h2>Категории услуг</h2>
   <button id="add-category-group" class="button">Добавить группу</button></div>
   <div class="support-filters">
    <label class="field">Поиск по справочнику<input type="search" id="directory-search"></label>
    <label class="field">Сортировка<select id="directory-order">
     <option value="asc">От А до Я</option><option value="desc">От Я до А</option>
    </select></label>
   </div><div id="directory-list"></div>`;
  const search = $('#directory-search', root);
  search.value = directoryView.query;
  search.oninput = () => {
   directoryView.query = search.value;
   renderCategoryList(root, root.directoryGroups);
  };
  const order = $('#directory-order', root);
  order.value = directoryView.order;
  order.onchange = () => {
   directoryView.order = order.value;
   renderCategoryList(root, root.directoryGroups);
  };
  $('#add-category-group', root).onclick = () => categoryEditor(root.directoryGroups);
 }
 root.directoryGroups = groups;
 renderCategoryList(root, groups);
}

function renderCategoryList(root, groups) {
 const list = $('#directory-list', root);
 const query = directoryView.query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
 const matches = name => name.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(query);
 const direction = directoryView.order === 'desc' ? -1 : 1;
 const sorted = items => [...items].sort((a, b) => direction * a.name.localeCompare(b.name, 'ru'));
 const visible = sorted(groups).map(group => ({
  ...group, visible: sorted(group.categories.filter(item => matches(group.name) || matches(item.name)))
 })).filter(group => matches(group.name) || group.visible.length);
 const html = visible.map(group => `<details class="panel directory-group" data-directory-group="${esc(group.id)}"
  ${directoryView.open.has(group.id) || query ? 'open' : ''}>
  <summary><strong>${esc(group.name)}</strong>
   <span class="muted">Категорий: ${group.categories.length} · Услуг: ${group.service_count}</span></summary>
  <div class="dialog-actions">
   <button data-category-add class="button pale">Добавить категорию</button>
   <button data-category-edit class="button outline">Изменить группу</button>
   <button data-category-delete class="button outline directory-delete">Удалить группу</button>
  </div>
  ${group.visible.length ? group.visible.map(item => `<article class="admin-service directory-category" data-directory-item="${esc(item.id)}">
   <div><strong>${esc(item.name)}</strong><p class="muted">Услуг: ${item.service_count} · Опубликовано: ${item.published_count}</p></div>
   <div class="dialog-actions"><button data-category-edit class="text-button">Изменить</button>
    <button data-category-delete class="text-button directory-delete">Удалить</button></div>
  </article>`).join('') : '<p class="muted">В группе пока нет категорий.</p>'}
 </details>`).join('');
 const signature = JSON.stringify([visible, directoryView.order, Boolean(query)]);
 if (signature === list.dataset.snapshot) return;
 list.dataset.snapshot = signature;
 list.innerHTML = html || '<p class="empty" role="status">Группы и категории не найдены.</p>';
 $$('[data-directory-group]', list).forEach(details => {
  details.ontoggle = () => {
   if (!details.isConnected || query) return;
   if (details.open) directoryView.open.add(details.dataset.directoryGroup);
   else directoryView.open.delete(details.dataset.directoryGroup);
  };
 });
 list.onclick = event => {
  const button = event.target.closest('button');
  if (!button) return;
  const group = groups.find(entry => entry.id === button.closest('details').dataset.directoryGroup);
  const category = group.categories.find(item => item.id === button.closest('[data-directory-item]')?.dataset.directoryItem);
  if (button.hasAttribute('data-category-add')) categoryEditor(groups, null, group);
  if (button.hasAttribute('data-category-edit')) categoryEditor(groups, category ?? group, category ? group : null);
  if (button.hasAttribute('data-category-delete')) confirmDirectoryRemoval(groups, group, category);
 };
}

function categoryEditor(groups, item = null, parent = null) {
 const kind = parent ? 'категорию' : 'группу';
 modal(`<h2>${item ? 'Изменить' : 'Добавить'} ${kind}</h2><form id="category-editor">
  <label class="field">Название<input name="name" maxlength="100" required value="${esc(item?.name)}"></label>
  ${parent ? `<label class="field">Группа<select name="parent_id" required>${categoryOptions(groups)}</select></label>` : ''}
  <div class="dialog-actions"><button class="button">Сохранить</button>
   <button class="button outline" type="button" data-directory-back>Отмена</button></div>
  <p class="form-error" role="alert"></p></form>`);
 const form = $('#category-editor');
 if (parent) form.elements.parent_id.value = parent.id;
 const path = item ? `/admin/categories/${encodeURIComponent(item.id)}/edit` : '/admin/categories';
 bindDirectoryAction(form, path, () => ({name: form.elements.name.value, parent_id: form.elements.parent_id?.value ?? null}),
  item ? 'Изменения сохранены' : parent ? 'Категория добавлена' : 'Группа добавлена');
}

function confirmDirectoryRemoval(groups, group, category) {
 const item = category ?? group;
 const transfer = category ? category.service_count || category.draft_count : group.categories.length;
 const impact = category ? [item.service_count, item.draft_count, item.pending_count, item.historical_count] :
  [group.service_count, ...group.categories.map(child => child.id).sort()];
 const options = category ? categorySelectOptions(groups, '', entry => entry.id !== item.id) :
  categoryOptions(groups.filter(entry => entry.id !== group.id));
 const title = category ? 'Удалить категорию?' : 'Удалить группу?';
 const consequence = category ? (transfer ? 'Услуги и изменения перейдут в выбранную категорию, их статусы сохранятся.' :
  'Категория исчезнет из справочника.') : (transfer ? 'Все категории перейдут в выбранную группу.' : 'Группа исчезнет из справочника.');
 const description = `${category ? `${category.name} · ` : ''}${group.name}. Связанных услуг: ${item.service_count}.`;
 const affected = category ? `<p>Черновиков изменений: ${item.draft_count}. На модерации: ${item.pending_count}.
  Исторических услуг: ${item.historical_count}.</p>` : `<p>Категорий в группе: ${group.categories.length}.</p>`;
 modal(`<h2>${title}</h2><p>${esc(description)}</p>${affected}
  <p>${consequence} Записи и отзывы сохранятся.</p>
  <form id="directory-delete-form">
   ${transfer ? `<label class="field">${category ? 'Категория для переноса' : 'Группа для переноса'}
    <select name="replacement_id" required><option value="">${options ? 'Выберите из справочника' : 'Нет доступных вариантов'}</option>
    ${options}</select></label>` : ''}
   <div class="dialog-actions"><button class="button directory-delete" ${transfer && !options ? 'disabled' : ''}>
    ${transfer ? 'Проверить перенос' : 'Да, удалить'}</button>
    <button class="button outline" type="button" data-directory-back>Отмена</button></div>
   <p class="form-error" role="alert"></p></form>`);
 const form = $('#directory-delete-form');
 const path = `/admin/categories/${encodeURIComponent(item.id)}/delete`;
 const message = category ? 'Категория удалена' : 'Группа удалена';
 if (!transfer) {
  bindDirectoryAction(form, path, () => ({confirm: true, impact}), message);
  return;
 }
 $('[data-directory-back]', form).onclick = closeModal;
 form.onsubmit = event => {
  event.preventDefault();
  const select = form.elements.replacement_id;
  const replacement = select.value;
  const target = select.selectedOptions[0];
  const targetLabel = target.parentElement.tagName === 'OPTGROUP' ? `${target.parentElement.label} / ${target.text}` : target.text;
  managementConfirmation('Подтвердить перенос и удаление?',
   `${description} Перенос в «${targetLabel}». ${consequence}`, false, async () => {
    await api(path, {confirm: true, replacement_id: replacement, impact});
    return message;
   });
 };
}

function bindDirectoryAction(form, path, data, message) {
 $('[data-directory-back]', form).onclick = closeModal;
 form.onsubmit = async event => {
  event.preventDefault();
  const submit = $('button:not([type]),button[type=submit]', form);
  submit.disabled = true;
  try {
   await api(path, data());
   if (form.isConnected) closeModal();
   await dashboard();
   toast(message, 'success');
  } catch (error) {
   $('.form-error', form).textContent = error.message;
  } finally {
   submit.disabled = false;
  }
 };
}
