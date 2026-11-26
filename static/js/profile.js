function renderAccountProfile(root, user) {
 const avatar = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : `<span>${esc(user.name[0])}</span>`;
 root.innerHTML = `<div class="panel profile-settings">
  <div class="profile-settings-head"><div><span class="eyebrow">МОЙ ПРОФИЛЬ</span><h2>Данные аккаунта</h2>
   <p class="muted">Измените имя, пароль или фотографию профиля.</p></div></div>
  <div class="profile-settings-grid">
   <section class="avatar-settings"><h3>Фотография профиля</h3>
    <p class="muted avatar-intro">Выберите кадр, который будет отображаться в профиле и рядом с вашими записями.</p>
    <form id="avatar-form">
     <div class="avatar-crop-layout">
      <div class="avatar-crop-stage" aria-label="Область кадрирования фотографии">
       <div id="avatar-preview">${avatar}</div>
       <canvas id="avatar-canvas" class="hidden" width="512" height="512" role="img" tabindex="0" aria-label="Предпросмотр кадрированной фотографии. Перемещайте стрелками клавиатуры."></canvas>
      </div>
      <div class="avatar-crop-controls">
       <label class="field avatar-zoom-field" for="avatar-zoom">Масштаб фотографии
        <input id="avatar-zoom" type="range" min="1" max="3" step="0.05" value="1" disabled>
       </label>
       <button id="avatar-reset" class="button outline" type="button" disabled>Сбросить кадрирование</button>
       <p class="avatar-hint" id="avatar-hint">После выбора фотографии перемещайте её мышью или пальцем внутри круга.</p>
      </div>
     </div>
     <div class="avatar-upload-row">
      <label class="button outline file-button">${user.avatar ? 'Выбрать другое фото' : 'Выбрать фотографию'}
       <input id="avatar-file" type="file" name="avatar" accept="image/jpeg,image/png,image/webp">
      </label>
      <button class="button" type="submit" disabled>Сохранить фото</button>
     </div>
     <p class="avatar-file-note">JPG, PNG или WEBP · до 1 МБ</p>
     <p class="avatar-upload-status" id="avatar-upload-status" role="status" aria-live="polite"></p>
     <p class="form-error" role="alert" aria-live="polite"></p>
    </form>
   </section>
   <section><h3>Личные данные</h3><form id="profile-form">
     <label class="field">ФИО<input name="name" value="${esc(user.name)}" minlength="2" maxlength="80" required></label>
     <h3 class="settings-subtitle">Смена пароля</h3>
     <label class="field">Текущий пароль<input name="current_password" type="password" autocomplete="current-password"></label>
     <label class="field">Новый пароль<input name="new_password" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <label class="field">Повторите новый пароль<input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <p class="form-error" role="alert"></p>
     <button class="button" type="submit">Сохранить изменения</button>
   </form></section>
  </div>
  <div class="danger-zone"><h3>Удаление аккаунта</h3>
   <p>Удаление необратимо. Предстоящие записи сначала нужно отменить.</p>
   <button id="delete-account" class="button outline danger">Удалить мой аккаунт</button>
  </div>
 </div>`;

 const avatarForm = $('#avatar-form', root);
 const avatarFile = $('#avatar-file', avatarForm);
 const preview = $('#avatar-preview', root);
 const canvas = $('#avatar-canvas', root);
 const context = canvas.getContext('2d');
 const zoomControl = $('#avatar-zoom', avatarForm);
 const resetControl = $('#avatar-reset', avatarForm);
 const hint = $('#avatar-hint', avatarForm);
 const uploadStatus = $('#avatar-upload-status', avatarForm);
 const saveButton = $('button[type=submit]', avatarForm);
 const error = $('.form-error', avatarForm);
 let image = null;
 let objectUrl = null;
 let zoom = 1;
 let offsetX = 0;
 let offsetY = 0;
 let dragStart = null;
 const stageSize = canvas.width;

 function clampOffsets() {
  if (!image) return;
  const scale = Math.max(stageSize / image.naturalWidth, stageSize / image.naturalHeight) * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = (stageSize - width) / 2;
  const top = (stageSize - height) / 2;
  offsetX = Math.min(-left, Math.max(stageSize - width - left, offsetX));
  offsetY = Math.min(-top, Math.max(stageSize - height - top, offsetY));
 }

 function drawCrop() {
  if (!image) return;
  clampOffsets();
  const scale = Math.max(stageSize / image.naturalWidth, stageSize / image.naturalHeight) * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (stageSize - width) / 2 + offsetX;
  const y = (stageSize - height) / 2 + offsetY;
  context.clearRect(0, 0, stageSize, stageSize);
  context.fillStyle = '#e0f5f0';
  context.fillRect(0, 0, stageSize, stageSize);
  context.drawImage(image, x, y, width, height);
 }

 function clearSelectedImage() {
  image = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  canvas.classList.add('hidden');
  preview.classList.remove('hidden');
  zoomControl.disabled = true;
  resetControl.disabled = true;
  zoomControl.value = '1';
  offsetX = 0;
  offsetY = 0;
  zoom = 1;
  avatarFile.value = '';
  $('button[type=submit]', avatarForm).disabled = true;
 }

 avatarFile.onchange = () => {
  const file = avatarFile.files[0];
  error.textContent = '';
  uploadStatus.textContent = '';
  if (!file) return;
  const acceptedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!acceptedTypes.includes(file.type)) {
   error.textContent = 'Выберите изображение в формате JPG, PNG или WEBP.';
   clearSelectedImage();
   return;
  }
  if (file.size > 1024 * 1024) {
   error.textContent = 'Размер фотографии не должен превышать 1 МБ.';
   clearSelectedImage();
   return;
  }
  const nextUrl = URL.createObjectURL(file);
  saveButton.disabled = true;
  hint.textContent = 'Открываем фотографию и готовим предпросмотр…';
  const nextImage = new Image();
  nextImage.onload = () => {
   if (objectUrl && objectUrl !== nextUrl) URL.revokeObjectURL(objectUrl);
   objectUrl = nextUrl;
   image = nextImage;
   zoom = 1;
   offsetX = 0;
   offsetY = 0;
   zoomControl.value = '1';
   zoomControl.disabled = false;
   resetControl.disabled = false;
   saveButton.disabled = false;
   preview.classList.add('hidden');
   canvas.classList.remove('hidden');
   hint.textContent = `${file.name} · ${nextImage.naturalWidth} × ${nextImage.naturalHeight} px. Перемещайте фото внутри круга или используйте стрелки на клавиатуре.`;
   uploadStatus.textContent = 'Предпросмотр готов. Настройте кадр и сохраните фотографию.';
   drawCrop();
  };
  nextImage.onerror = () => {
   URL.revokeObjectURL(nextUrl);
   error.textContent = 'Не удалось открыть фотографию. Проверьте файл и попробуйте ещё раз.';
   uploadStatus.textContent = '';
   clearSelectedImage();
  };
  nextImage.src = nextUrl;
 };

 zoomControl.oninput = () => {
  zoom = Number(zoomControl.value);
  drawCrop();
 };
 canvas.onkeydown = event => {
  if (!image || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 24 : 10;
  if (event.key === 'ArrowLeft') offsetX += step;
  if (event.key === 'ArrowRight') offsetX -= step;
  if (event.key === 'ArrowUp') offsetY += step;
  if (event.key === 'ArrowDown') offsetY -= step;
  drawCrop();
 };
 resetControl.onclick = () => {
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  zoomControl.value = '1';
  drawCrop();
 };

 canvas.onpointerdown = event => {
  if (!image) return;
  dragStart = {x:event.clientX, y:event.clientY, offsetX, offsetY};
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
 };
 canvas.onpointermove = event => {
  if (!dragStart || !image) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = stageSize / rect.width;
  offsetX = dragStart.offsetX + (event.clientX - dragStart.x) * ratio;
  offsetY = dragStart.offsetY + (event.clientY - dragStart.y) * ratio;
  drawCrop();
 };
 const endDrag = () => {
  dragStart = null;
  canvas.classList.remove('is-dragging');
 };
 canvas.onpointerup = endDrag;
 canvas.onpointercancel = endDrag;
 canvas.onlostpointercapture = endDrag;

 avatarForm.onsubmit = async event => {
  event.preventDefault();
  if (!image) {
   error.textContent = 'Сначала выберите фотографию.';
   avatarFile.focus();
   return;
  }
  const button = $('button[type=submit]', avatarForm);
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Сохраняем…';
  error.textContent = '';
  uploadStatus.textContent = 'Подготавливаем и загружаем фотографию…';
  try {
   const uploadCanvas = document.createElement('canvas');
   uploadCanvas.width = 512;
   uploadCanvas.height = 512;
   uploadCanvas.getContext('2d').drawImage(canvas, 0, 0, 512, 512);
   const blob = await new Promise(resolve => uploadCanvas.toBlob(resolve, 'image/jpeg', 0.88));
   if (!blob) throw new Error('Не удалось подготовить фотографию. Попробуйте другой файл.');
   if (blob.size > 1024 * 1024) throw new Error('Подготовленная фотография превышает 1 МБ. Уменьшите масштаб и повторите попытку.');
   const data = new FormData();
   data.append('avatar', new File([blob], 'avatar.jpg', {type:'image/jpeg'}));
   const userId = state.user.id;
   const result = await api('/profile/avatar', data);
   if (state.user?.id !== userId) return;
   state.user = result.user;
   state.csrf = result.csrf;
   if (objectUrl) URL.revokeObjectURL(objectUrl);
   objectUrl = null;
   image = null;
   uploadStatus.textContent = 'Фотография профиля обновлена.';
   updateAccount();
   if (location.hash === '#dashboard') await dashboard();
   toast('Фотография профиля обновлена');
  } catch (uploadError) {
   error.textContent = uploadError.message;
   uploadStatus.textContent = 'Не удалось сохранить фотографию. Исправьте ошибку и повторите попытку.';
  } finally {
   button.textContent = 'Сохранить фото';
   button.disabled = !image;
  }
 };

 const details = $('#profile-form', root);
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
   }, {back: 'Оставить аккаунт', confirm: 'Удалить навсегда', lockWhilePending: true});
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
