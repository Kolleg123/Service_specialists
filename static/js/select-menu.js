(() => {
 if (!HTMLElement.prototype.showPopover) return;
 const selector = 'select:not([multiple]):not([aria-hidden="true"]):not([size])';
 const controls = new WeakMap();
 const normalize = text => text.toLocaleLowerCase('ru').replaceAll('ё', 'е');
 let openMenu;
 let nextId = 0;

 function enhance(select) {
  const wrapper = document.createElement('span');
  wrapper.className = 'select-menu';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const value = document.createElement('span');
  value.className = 'select-value';
  trigger.append(value);

  const popup = document.createElement('div');
  popup.className = 'select-popup';
  popup.setAttribute('popover', 'manual');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Поиск по списку';
  search.setAttribute('aria-label', search.placeholder);
  const items = document.createElement('div');
  items.className = 'select-options';
  items.id = 'select-options-' + ++nextId;
  items.setAttribute('role', 'listbox');
  const empty = document.createElement('p');
  empty.className = 'select-empty';
  empty.setAttribute('role', 'status');
  empty.textContent = 'Ничего не найдено';
  popup.append(search, items, empty);
  trigger.setAttribute('aria-controls', items.id);

  const labels = [...select.labels].map(label => {
   const copy = label.cloneNode(true);
   copy.querySelectorAll('select, input, textarea, button, small').forEach(node => node.remove());
   return copy.textContent.trim();
  }).filter(Boolean);
  const label = select.getAttribute('aria-label') || labels.join(' ') || 'Выбор значения';
  items.setAttribute('aria-label', label);

  select.before(wrapper);
  wrapper.append(select, trigger, popup);
  select.classList.add('select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  function sync() {
   const text = select.selectedOptions[0]?.label || 'Выберите значение';
   if (value.textContent !== text) value.textContent = text;
   trigger.setAttribute('aria-label', label + ' — ' + text);
   const disabled = select.matches(':disabled');
   if (trigger.disabled !== disabled) trigger.disabled = disabled;
   if (trigger.disabled && openMenu === menu) close();
  }

  function position() {
   const rect = trigger.getBoundingClientRect();
   const viewport = window.visualViewport;
   const leftEdge = viewport?.offsetLeft || 0;
   const topEdge = viewport?.offsetTop || 0;
   const rightEdge = leftEdge + (viewport?.width || document.documentElement.clientWidth);
   const bottomEdge = topEdge + (viewport?.height || innerHeight);
   if (!trigger.getClientRects().length || rect.bottom < topEdge || rect.top > bottomEdge) {
    close();
    return;
   }
   const width = Math.min(Math.max(rect.width, 240), rightEdge - leftEdge - 16);
   const below = bottomEdge - rect.bottom - 12;
   const above = rect.top - topEdge - 12;
   const upward = below < 290 && above > below;
   popup.style.width = width + 'px';
   popup.style.left = Math.max(leftEdge + 8, Math.min(rect.left, rightEdge - width - 8)) + 'px';
   popup.style.maxHeight = Math.max(0, upward ? above : below) + 'px';
   popup.style.top = (upward ? rect.top - 4 - popup.offsetHeight : rect.bottom + 4) + 'px';
  }

  function choose(option) {
   const index = option.index;
   if (index < 0 || select.options[index] !== option || option.matches(':disabled')) return;
   close(true);
   if (select.selectedIndex === index) return;
   select.selectedIndex = index;
   sync();
   select.dispatchEvent(new Event('input', {bubbles: true}));
   select.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function render() {
   const query = normalize(search.value.trim());
   let lastGroup;
   const rows = [];
   for (const option of select.options) {
    const group = option.closest('optgroup');
    if (option.hidden || group?.hidden || !normalize(option.label).includes(query)) continue;
    if (group && group !== lastGroup) {
     const title = document.createElement('div');
     title.className = 'select-group';
     title.textContent = group.label;
     title.setAttribute('role', 'presentation');
     rows.push(title);
    }
    lastGroup = group;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'select-option';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(option.selected));
    row.tabIndex = -1;
    row.disabled = option.matches(':disabled');
    row.textContent = option.label;
    row.addEventListener('click', () => choose(option));
    rows.push(row);
   }
   items.replaceChildren(...rows);
   empty.hidden = rows.length > 0;
   position();
  }

  function focusOption(row) {
   if (!row) return;
   row.focus({preventScroll: true});
   const listRect = items.getBoundingClientRect();
   const rowRect = row.getBoundingClientRect();
   if (rowRect.top < listRect.top) items.scrollTop -= listRect.top - rowRect.top;
   if (rowRect.bottom > listRect.bottom) items.scrollTop += rowRect.bottom - listRect.bottom;
  }

  function close(restoreFocus = false) {
   if (openMenu !== menu) return;
   openMenu = null;
   popup.hidePopover();
   trigger.setAttribute('aria-expanded', 'false');
   if (restoreFocus) trigger.focus({preventScroll: true});
  }

  function open(key = '') {
   if (select.matches(':disabled')) return;
   openMenu?.close();
   openMenu = menu;
   search.value = '';
   search.hidden = select.options.length < 8 && !/категори|направлен/i.test(label);
   popup.showPopover();
   trigger.setAttribute('aria-expanded', 'true');
   render();
   const rows = [...items.querySelectorAll('button:enabled')];
   if (!search.hidden && !key) search.focus({preventScroll: true});
   else focusOption(items.querySelector('[aria-selected="true"]:enabled') ||
    (key === 'ArrowUp' ? rows.at(-1) : rows[0]));
  }

  const menu = {wrapper, select, close, position, sync, refresh() {
   const inList = items.contains(document.activeElement);
   render();
   if (inList) focusOption(items.querySelector('[aria-selected="true"]:enabled, button:enabled'));
  }};
  controls.set(select, menu);
  sync();

  trigger.addEventListener('click', () => openMenu === menu ? close() : open());
  trigger.addEventListener('keydown', event => {
   if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
   event.preventDefault();
   open(event.key);
  });
  search.addEventListener('input', render);
  popup.addEventListener('keydown', event => {
   const rows = [...items.querySelectorAll('button:enabled')];
   const index = rows.indexOf(document.activeElement);
   if (event.key === 'Enter' && document.activeElement === search) {
    event.preventDefault();
    rows[0]?.click();
    return;
   }
   if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
   if (document.activeElement === search && ['Home', 'End'].includes(event.key)) return;
   event.preventDefault();
   if (event.key === 'ArrowUp' && index === 0 && !search.hidden) {
    search.focus({preventScroll: true});
    return;
   }
   const target = {ArrowDown: Math.min(index + 1, rows.length - 1),
    ArrowUp: index < 0 ? rows.length - 1 : Math.max(0, index - 1), Home: 0, End: rows.length - 1};
   focusOption(rows[target[event.key]]);
  });
  select.addEventListener('focus', () => trigger.focus({preventScroll: true}));
  select.addEventListener('change', () => queueMicrotask(sync));
  select.addEventListener('invalid', event => {
   event.preventDefault();
   trigger.focus();
   if (openMenu !== menu) open();
  });
  select.form?.addEventListener('reset', () => queueMicrotask(sync));
 }

 function scan(mutations = []) {
  if (openMenu && !openMenu.wrapper.isConnected) openMenu.close();
  document.querySelectorAll(selector).forEach(enhance);
  document.querySelectorAll('.select-source').forEach(select => controls.get(select)?.sync());
  if (openMenu && mutations.some(({target}) => openMenu.select.contains(target))) openMenu.refresh();
 }

 new MutationObserver(scan).observe(document.body, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['disabled', 'selected', 'label', 'hidden']
 });
 scan();
 document.addEventListener('pointerdown', event => {
  if (openMenu && !openMenu.wrapper.contains(event.target)) openMenu.close();
 });
 document.addEventListener('focusin', event => {
  if (openMenu && !openMenu.wrapper.contains(event.target)) openMenu.close();
 });
 document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !openMenu) return;
  event.preventDefault();
  event.stopPropagation();
  openMenu.close(true);
 }, true);
 window.addEventListener('resize', () => openMenu?.position());
 window.addEventListener('scroll', () => openMenu?.position(), true);
 window.visualViewport?.addEventListener('resize', () => openMenu?.position());
 window.visualViewport?.addEventListener('scroll', () => openMenu?.position());
})();
