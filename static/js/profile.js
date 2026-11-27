function renderAccountProfile(root, user) {
 const avatar = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : `<span>${esc(user.name[0])}</span>`;
 root.innerHTML = `<div class="panel profile-settings">
  <h2>Настройки профиля</h2>
  <div class="profile-settings-grid">
   <section><h3>Фотография профиля</h3><div class="avatar-editor">
     <div class="avatar-cropper">
      <div id="avatar-preview" aria-label="Круглый предпросмотр аватарки">${avatar}</div>
      <span id="avatar-crop-hint" class="muted" hidden>Перетащите фото или используйте стрелки</span>
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
     <h3>Электронная почта</h3><p class="profile-email"><strong>${esc(user.email || '—')}</strong></p>
     <button id="edit-profile" class="button">Изменить данные</button>
    </div>
    <form id="profile-form" hidden>
     <label class="field">ФИО<input name="name" value="${esc(user.name)}" minlength="2" maxlength="80" required></label>
     <label class="field">Электронная почта<input name="email" type="email" value="${esc(user.email || '')}" maxlength="120" autocomplete="email" required></label>
     <p class="profile-email-note">Почта используется для восстановления пароля. Логин остаётся неизменным.</p>
     <p class="form-error" role="alert"></p>
     <div class="profile-form-actions">
      <button class="button" type="submit">Сохранить изменения</button>
      <button type="button" id="cancel-profile-edit" class="button outline">Отмена</button>
     </div>
    </form>
   </section>
  </div>
  ${passwordForm()}
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
 const hint = $('#avatar-crop-hint', root);
 const errorAvatar = $('.form-error', avatarForm);
 let image = null;
 let currentAvatar = avatar;
 let selection = 0;
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
  if (canvas.parentElement !== preview) preview.replaceChildren(canvas);
 };
 avatarFile.onchange = async () => {
  const request = ++selection;
  const file = avatarFile.files[0];
  image = null;
  errorAvatar.textContent = '';
  saveAvatar.disabled = true;
  zoomControl.disabled = true;
  zoomControl.value = '1';
  zoom = 1;
  preview.removeAttribute('aria-busy');
  preview.innerHTML = currentAvatar;
  hint.hidden = true;
  dragging = false;
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
   errorAvatar.textContent = 'Выберите изображение JPG, PNG или WEBP'; avatarFile.value = ''; return;
  }
  if (file.size > 1024 * 1024) {
   errorAvatar.textContent = 'Размер фотографии не должен превышать 1 МБ'; avatarFile.value = ''; return;
  }
  const candidate = new Image();
  const url = URL.createObjectURL(file);
  preview.setAttribute('aria-busy', 'true');
  try {
   candidate.src = url;
   await candidate.decode();
   if (request !== selection || !preview.isConnected) return;
   image = candidate;
   const base = Math.max(512 / image.naturalWidth, 512 / image.naturalHeight);
   offsetX = (512 - image.naturalWidth * base) / 2;
   offsetY = (512 - image.naturalHeight * base) / 2;
   zoomControl.disabled = false;
   saveAvatar.disabled = false;
   hint.hidden = false;
   drawCrop();
  } catch {
   if (request === selection) errorAvatar.textContent = 'Не удалось открыть изображение';
  } finally {
   URL.revokeObjectURL(url);
   if (request === selection) preview.removeAttribute('aria-busy');
  }
 };
 zoomControl.oninput = () => {
  const scale = Number(zoomControl.value) / zoom;
  offsetX = 256 + (offsetX - 256) * scale;
  offsetY = 256 + (offsetY - 256) * scale;
  zoom = Number(zoomControl.value);
  drawCrop();
 };
 canvas.className = 'avatar-crop-canvas';
 canvas.tabIndex = 0;
 canvas.setAttribute('aria-label', 'Область кадрирования фотографии');
 canvas.setAttribute('aria-describedby', 'avatar-crop-hint');
 canvas.addEventListener('keydown', event => {
  const offset = {ArrowLeft:[-16,0], ArrowRight:[16,0], ArrowUp:[0,-16], ArrowDown:[0,16]}[event.key];
  if (!offset) return;
  event.preventDefault();
  offsetX += offset[0];
  offsetY += offset[1];
  drawCrop();
 });
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
 canvas.addEventListener('lostpointercapture', stopDrag);
 avatarForm.onsubmit = async event => {
  event.preventDefault();
  if (saveAvatar.disabled) return;
  if (!image) { errorAvatar.textContent = 'Сначала выберите фотографию'; return; }
  const userId = state.user.id;
  saveAvatar.disabled = avatarFile.disabled = zoomControl.disabled = true;
  saveAvatar.textContent = 'Сохраняем…';
  errorAvatar.textContent = '';
  try {
   const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
   if (!blob) throw new Error('Не удалось подготовить фотографию');
   const formData = new FormData();
   formData.append('avatar', new File([blob], 'avatar.jpg', {type:'image/jpeg'}));
   const result = await api('/profile/avatar', formData, 'POST');
   if (state.user?.id !== userId) return;
   state.user = result.user; state.csrf = result.csrf; updateAccount();
   toast('Фото профиля обновлено', 'success');
   image = null; avatarFile.value = ''; zoomControl.value = '1'; zoomControl.disabled = true;
   saveAvatar.disabled = true;
   hint.hidden = true;
   currentAvatar = state.user.avatar ? `<img src="${esc(state.user.avatar)}" alt="">` : `<span>${esc(state.user.name[0])}</span>`;
   preview.innerHTML = currentAvatar;
  } catch (error) { errorAvatar.textContent = error.message; }
  finally {
   avatarFile.disabled = false;
   saveAvatar.disabled = zoomControl.disabled = !image;
   saveAvatar.textContent = 'Сохранить фото';
  }
 };

 const view = $('#profile-view', root);
 const details = $('#profile-form', root);
 $('#edit-profile', root).onclick = () => {
  if (!passwords.hidden) $('#cancel-password-edit', passwords).click();
  view.hidden = true;
  details.hidden = false;
  details.elements.name.focus();
 };
 $('#cancel-profile-edit', root).onclick = () => {
  details.reset();
  $('.form-error', details).textContent = '';
  details.hidden = true;
  view.hidden = false;
  $('#edit-profile', view).focus();
 };
 details.onsubmit = event => {
  event.preventDefault();
  return saveAccountProfile(details, Object.fromEntries(new FormData(details)), 'Профиль сохранён');
 };

 const passwords = bindPasswordForm(root, () => {
  if (!details.hidden) $('#cancel-profile-edit', details).click();
 });

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

function renderAdminProfile(root, user) {
 root.innerHTML = `<div class="panel profile-settings">
  <h2>Профиль администратора</h2>
  <dl class="detail-grid"><dt>Имя</dt><dd>${esc(user.name)}</dd><dt>Логин</dt><dd>${esc(user.username || '—')}</dd>
   <dt>Почта</dt><dd>${esc(user.email || '—')}</dd></dl>
  ${passwordForm()}
 </div>`;
 bindPasswordForm(root);
}

function passwordForm() {
 return `<section class="profile-security"><h3>Смена пароля</h3>
   <button id="change-password" class="button outline" type="button">Изменить пароль</button>
   <form id="profile-password-form" hidden>
     <label class="field">Текущий пароль<input id="profile-current-password" name="current_password" type="password" autocomplete="current-password" required></label>
     <label class="field">Новый пароль<input id="profile-new-password" name="new_password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
     <label class="field">Повторите новый пароль<input id="profile-confirm-password" name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
     <div class="profile-form-actions">
      <button type="button" id="toggle-profile-passwords" class="button outline">Показать пароли</button>
      <button type="button" id="profile-forgot-password" class="text-button">Забыли пароль?</button>
     </div>
    <p class="form-error" role="alert"></p>
    <div class="profile-form-actions">
     <button class="button" type="submit">Сохранить пароль</button>
     <button class="button outline" type="button" id="cancel-password-edit">Отмена</button>
    </div>
   </form>
  </section>`;
}

function bindPasswordForm(root, beforeEdit) {
 const passwords = $('#profile-password-form', root);
 const changePassword = $('#change-password', root);
 const showPasswords = $('#toggle-profile-passwords', passwords);
 const passwordFields = [...passwords.querySelectorAll('input')];
 changePassword.onclick = () => {
  beforeEdit?.();
  passwords.hidden = false;
  changePassword.hidden = true;
  passwordFields[0].focus();
 };
 $('#cancel-password-edit', passwords).onclick = () => {
  passwords.reset();
  $('.form-error', passwords).textContent = '';
  passwordFields.forEach(input => input.type = 'password');
  showPasswords.textContent = 'Показать пароли';
  passwords.hidden = true;
  changePassword.hidden = false;
  changePassword.focus();
 };
 showPasswords.onclick = () => {
  const reveal = passwordFields[0].type === 'password';
  passwordFields.forEach(input => input.type = reveal ? 'text' : 'password');
  showPasswords.textContent = reveal ? 'Скрыть пароли' : 'Показать пароли';
 };
 $('#profile-forgot-password', passwords).onclick = () => requestPasswordReset();
 passwords.onsubmit = event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(passwords));
  return saveAccountProfile(passwords, state.user.role === 'admin' ? data : {...data, name:state.user.name}, 'Пароль изменён');
 };

 return passwords;
}

async function saveAccountProfile(form, data, message) {
 const button = $('button[type=submit]', form);
 const errorMessage = $('.form-error', form);
 if (button.disabled) return;
 const userId = state.user.id;
 button.disabled = true;
 errorMessage.textContent = '';
 try {
  const result = await api('/profile', data, 'PATCH');
  if (state.user?.id !== userId) return;
  state.user = result.user;
  state.csrf = result.csrf;
  updateAccount();
  if (location.hash === '#dashboard') await dashboard();
  toast(message, 'success');
 } catch (error) {
  errorMessage.textContent = error.message;
 } finally {
  button.disabled = false;
 }
}
