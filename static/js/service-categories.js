/* Category controls for the public catalog and the service form. */
function categoryOptions(items) {
 return items.map(({id, name}) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
}

function categorySelectOptions(groups, groupId, matches = () => true) {
 if (groupId) return categoryOptions(groups.find(group => group.id === groupId)?.categories.filter(matches) ?? []);
 return groups.map(group => {
  const options = categoryOptions(group.categories.filter(matches));
  return options ? `<optgroup label="${esc(group.name)}">${options}</optgroup>` : '';
 }).join('');
}

function selectCatalogCategory(select, value, unavailableLabel) {
 select.value = value;
 if (value && select.selectedIndex < 0) {
  const option = new Option(unavailableLabel, '', true, true);
  option.disabled = true;
  select.prepend(option);
  select.selectedIndex = 0;
 }
}

function updateCatalogCategories() {
 const direction = $('#direction-filter');
 const category = $('#category-filter');
 direction.innerHTML = '<option value="">Все направления</option>' + categoryOptions(state.categories);
 category.innerHTML = '<option value="">Все категории</option>' +
  categorySelectOptions(state.categories, state.categoryGroup);
 selectCatalogCategory(direction, state.categoryGroup, 'Выбранное направление недоступно');
 selectCatalogCategory(category, state.category, 'Выбранная категория недоступна');
}

function bindCatalogCategories() {
 updateCatalogCategories();
 $('#direction-filter').onchange = event => {
  state.categoryGroup = event.target.value;
  state.category = '';
  updateCatalogCategories();
  drawCards();
 };
 $('#category-filter').onchange = event => {
  state.category = event.target.value;
  drawCards();
 };
}

function serviceCategoryFields() {
 return `<label class="field">Направление<select name="category_group"></select></label>
  <label class="field">Поиск категории<input type="search" data-category-search placeholder="Например, сантехника"></label>
  <label class="field">Категория услуги<select name="category_id" required></select></label>`;
}

function bindServiceCategories(form, groups, initialCategory) {
 const direction = form.elements.category_group;
 const category = form.elements.category_id;
 const search = $('[data-category-search]', form);
 const groupOf = id => groups.find(group => group.categories.some(item => item.id === id));
 direction.innerHTML = '<option value="">Все направления</option>' + categoryOptions(groups);
 direction.value = groupOf(initialCategory)?.id ?? '';

 function update(selected) {
  const query = search.value.trim().toLowerCase().replaceAll('ё', 'е');
  const matches = item => item.id === selected || item.name.toLowerCase().replaceAll('ё', 'е').includes(query);
  const options = categorySelectOptions(groups, direction.value, matches);
  category.innerHTML = `<option value="">${options ? 'Выберите категорию' : 'Категории не найдены'}</option>` + options;
  category.value = selected;
 }

 direction.onchange = () => {
  search.value = '';
  update('');
 };
 search.oninput = () => update(category.value);
 category.onchange = () => {
  direction.value = groupOf(category.value)?.id ?? direction.value;
  update(category.value);
 };
 update(initialCategory ?? '');
}

function serviceCategoryLabel(groups, categoryId) {
 for (const group of groups) {
  const category = group.categories.find(item => item.id === categoryId);
  if (category) return `${group.name} / ${category.name}`;
 }
 return 'Категория не указана';
}
