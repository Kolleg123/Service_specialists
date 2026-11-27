function renderAccountProfile(root, user) {
 const avatar = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : `<span>${esc(user.name[0])}</span>`;
 root.innerHTML = `<div class="panel profile-settings">
  <div class="profile-settings-head"><div><span class="eyebrow">МОЙ ПРОФИЛЬ</span><h2>Данные аккаунта</h2>
   <p class="muted">Просматривайте личные данные и изменяйте их по необходимости.</p></div></div>
  <div class="profile-settings-grid">
   <section><h3>Аватар</h3><div class="avatar-editor">
     <div class="avatar-cropper">
      <div id="avatar-preview" aria-label="Круглый предпросмотр аватарки">${avatar}</div>
      <span class="muted">Перетаскивайте фото, чтобы выбрать область</span>
     </div>
     <form id="avatar-form">
      <label class="button outline file-button">Выбрать фото
       <input id="avatar-file" type="file" name="avatar" accept="image/jpeg,image/png,image/webp">
      </label>
      <label class="field avatar-zoom">Масштаб <input id="avatar-zoom" type="range" min="1" max="3" step="0.01" value="1" disabled></label>
      <span class="muted avatar-file-hint">JPG, PNG или WEBP · до 1 МБ</span>
      <button class="button" type="submit" disabled>Сохранить фото</button>
      <p class="form-error" role="alert"></p>
     </form>
   </div></section>
   <section><h3>Личные данные</h3>
    <div id="profile-view" class="profile-view">
     <p><span>ФИО</span><strong>${esc(user.name)}</strong></p>
     <p><span>Неизменяемый логин</span><strong>${esc(user.username || '—')}</strong></p>
     <p><span>Электронная почта</span><strong>${esc(user.email || '—')}</strong></p>
     <button id="edit-profile" class="button">Изменить данные</button>
    </div>
    <form id="profile-form" hidden>
     <label class="field">ФИО<input name="name" value="${esc(user.name)}" minlength="2" maxlength="80" required></label>
     <label class="field">Логин<input value="${esc(user.username || '—')}" disabled readonly></label>
     <label class="field">Электронная почта<input name="email" type="email" value="${esc(user.email || '')}" maxlength="120" autocomplete="email" required></label>
     <p class="profile-email-note">Почта используется для восстановления пароля. Логин остаётся неизменным.</p>
     <h3 class="settings-subtitle">Смена пароля</h3>
     <label class="field">Текущий пароль<input id="profile-current-password" name="current_password" type="password" autocomplete="current-password"></label>
     <label class="field">Новый пароль<input id="profile-new-password" name="new_password" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <label class="field">Повторите новый пароль<input id="profile-confirm-password" name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <div class="profile-form-actions">
      <button type="button" id="toggle-profile-passwords" class="button outline">Показать пароли</button>
      <button type="button" id="profile-forgot-password" class="text-button">Забыли пароль?</button>
     </div>
     <p class="form-error" role="alert"></p>
     <div class="profile-form-actions">
      <button class="button" type="submit">Сохранить изменения</button>
      <button type="button" id="cancel-profile-edit" class="button outline">Отмена</button>
     </div>
    </form>
   </section>
  </div>
  <div class="danger-zone"><h3>Удаление аккаунта</h3>
   <p>Удаление необратимо. Предстоящие записи сначала нужно отменить.</p>
   <button id="delete-account" class="button outline danger">Удалить мой аккаунт</button>
  </div>
 </div>`;

 const avatarForm = $('#avatar-form', root);
 const avatarFile = $('#avatar-file', avatarForm);
 const preview = $('#avatar-preview', root);
 const zoomControl = $('#avatar-zoom', avatarForm);
 const saveAvatar = $('button[type="submit"]', avatarForm);
 const errorAvatar = $('.form-error', avatarForm);
 let image = null;
 let zoom = 1;
 let offsetX = 0;
 let offsetY = 0;
 let dragging = false;
 let dragStart = null;
 const canvas = document.createElement('canvas');
 canvas.id = 'avatar-crop-canvas';
 canvas.width = canvas.height = 512;
 const ctx = canvas.getContext('2d');
 const drawCrop = () => {
  if (!image) return;
  const base = Math.max(512 / image.naturalWidth, 512 / image.naturalHeight);
  const width = image.naturalWidth * base * zoom;
  const height = image.naturalHeight * base * zoom;
  const minX = 512 - width;
  const minY = 512 - height;
  offsetX = Math.min(0, Math.max(minX, offsetX));
  offsetY = Math.min(0, Math.max(minY, offsetY));
  ctx.clearRect(0, 0, 512, 512);
  ctx.drawImage(image, offsetX, offsetY, width, height);
  if (!$('#avatar-crop-canvas', preview)) preview.innerHTML = '';
  if (canvas.parentElement !== preview) preview.replaceChildren(canvas);
 };
 avatarFile.onchange = () => {
  const file = avatarFile.files[0];
  image = null;
  errorAvatar.textContent = '';
  saveAvatar.disabled = true;
  zoomControl.disabled = true;
  zoomControl.value = '1';
  zoom = 1;
  if (!file) { preview.innerHTML = avatar; return; }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
   errorAvatar.textContent = 'Выберите изображение JPG, PNG или WEBP'; avatarFile.value = ''; preview.innerHTML = avatar; return;
  }
  if (file.size > 1024 * 1024) {
   errorAvatar.textContent = 'Размер фотографии не должен превышать 1 МБ'; avatarFile.value = ''; preview.innerHTML = avatar; return;
  }
  const reader = new FileReader();
  reader.onload = () => {
   const candidate = new Image();
   candidate.onload = () => {
    image = candidate;
    const base = Math.max(512 / image.naturalWidth, 512 / image.naturalHeight);
    offsetX = (512 - image.naturalWidth * base) / 2;
    offsetY = (512 - image.naturalHeight * base) / 2;
    zoomControl.disabled = false; saveAvatar.disabled = false; drawCrop();
   };
   candidate.onerror = () => { errorAvatar.textContent = 'Не удалось открыть изображение'; };
   candidate.src = reader.result;
  };
  reader.readAsDataURL(file);
 };
 zoomControl.oninput = () => { zoom = Number(zoomControl.value); drawCrop(); };
 canvas.className = 'avatar-crop-canvas';
 canvas.setAttribute('aria-label', 'Перетащите фото для кадрирования');
 canvas.addEventListener('pointerdown', event => {
  if (!image) return;
  dragging = true; canvas.setPointerCapture(event.pointerId);
  dragStart = {x:event.clientX, y:event.clientY, ox:offsetX, oy:offsetY};
 });
 canvas.addEventListener('pointermove', event => {
  if (!dragging || !dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const factor = 512 / rect.width;
  offsetX = dragStart.ox + (event.clientX - dragStart.x) * factor;
  offsetY = dragStart.oy + (event.clientY - dragStart.y) * factor;
  drawCrop();
 });
 const stopDrag = () => { dragging = false; dragStart = null; };
 canvas.addEventListener('pointerup', stopDrag);
 canvas.addEventListener('pointercancel', stopDrag);
 avatarForm.onsubmit = async event => {
  event.preventDefault();
  if (!image) { errorAvatar.textContent = 'Сначала выберите фотографию'; return; }
  saveAvatar.disabled = true; errorAvatar.textContent = '';
  try {
   const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
   if (!blob) throw new Error('Не удалось подготовить фотографию');
   const formData = new FormData();
   formData.append('avatar', new File([blob], 'avatar.jpg', {type:'image/jpeg'}));
   const result = await api('/profile/avatar', formData, 'POST');
   state.user = result.user; state.csrf = result.csrf; updateAccount();
   toast('Фото профиля обновлено');
   image = null; avatarFile.value = ''; zoomControl.value = '1'; zoomControl.disabled = true;
   saveAvatar.disabled = true;
   const refreshedAvatar = state.user.avatar ? `<img src="${esc(state.user.avatar)}" alt="">` : `<span>${esc(state.user.name[0])}</span>`;
   preview.innerHTML = refreshedAvatar;
  } catch (error) { errorAvatar.textContent = error.message; }
  finally { saveAvatar.disabled = !image; }
 };

 const view = $('#profile-view', root);
 const details = $('#profile-form', root);
 $('#edit-profile', root).onclick = () => {
  view.hidden = true;
  details.hidden = false;
  details.elements.name.focus();
 };
 $('#cancel-profile-edit', root).onclick = () => {
  details.reset();
  $('.form-error', details).textContent = '';
  $$('input[type="password"]', details).forEach(input => input.type = 'password');
  $('#toggle-profile-passwords', details).textContent = 'Показать пароли';
  details.hidden = true;
  view.hidden = false;
 };
 $('#toggle-profile-passwords', details).onclick = event => {
  const fields = $$('input[type="password"], input[data-visible-password]', details);
  const reveal = fields.some(input => input.type === 'password');
  fields.forEach(input => {
   input.type = reveal ? 'text' : 'password';
   input.dataset.visiblePassword = reveal ? 'true' : '';
  });
  event.currentTarget.textContent = reveal ? 'Скрыть пароли' : 'Показать пароли';
 };
 $('#profile-forgot-password', details).onclick = () => requestPasswordReset();
 details.onsubmit = event => {
  event.preventDefault();
  return saveAccountProfile(details, '/profile', Object.fromEntries(new FormData(details)), 'PATCH', 'Профиль сохранён');
 };

 $('#delete-account', root).onclick = () => {
  managementConfirmation('Удалить аккаунт?',
   'Ваш аккаунт будет удалён в обоих режимах. История встреч сохранится с обезличенным именем. Действие нельзя отменить.',
   false, async () => {
    const response = await api('/account', undefined, 'DELETE');
    endSession(response);
    return 'Аккаунт удалён';
   }, {back: 'Оставить аккаунт', confirm: 'Удалить навсегда', confirmClass: 'danger-solid', lockWhilePending: true});
 };
}

async function saveAccountProfile(form, path, data, method, message, onError) {
 const button = $('button[type=submit]', form);
 const errorMessage = $('.form-error', form);
 if (button.disabled) return;
 const userId = state.user.id;
 button.disabled = true;
 errorMessage.textContent = '';
 try {
  const result = await api(path, data, method);
  if (state.user?.id !== userId) return;
  state.user = result.user;
  state.csrf = result.csrf;
  updateAccount();
  if (location.hash === '#dashboard') await dashboard();
  toast(message);
 } catch (error) {
  onError?.();
  errorMessage.textContent = error.message;
 } finally {
  button.disabled = false;
 }
}
