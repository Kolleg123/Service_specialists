function renderAccountProfile(root, user) {
 const avatar = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : `<span>${esc(user.name[0])}</span>`;
 root.innerHTML = `<div class="panel profile-settings">
  <div class="profile-settings-head"><div><span class="eyebrow">МОЙ ПРОФИЛЬ</span><h2>Данные аккаунта</h2>
   <p class="muted">Измените имя, пароль или фотографию профиля.</p></div></div>
  <div class="profile-settings-grid">
   <section><h3>Аватар</h3><div class="avatar-editor">
     <div id="avatar-preview">${avatar}</div>
     <form id="avatar-form">
      <label class="button outline file-button">Выбрать фото
       <input id="avatar-file" type="file" name="avatar" accept="image/jpeg,image/png,image/webp">
      </label>
      <button class="button" type="submit">Сохранить фото</button>
      <p class="form-error" role="alert"></p>
     </form>
   </div></section>
   <section><h3>Личные данные</h3><form id="profile-form">
     <label class="field">ФИО<input name="name" value="${esc(user.name)}" minlength="2" maxlength="80" required></label>
     <label class="field">Логин (электронная почта)<input type="email" value="${esc(user.email)}" readonly></label>
     <h3 class="settings-subtitle">Смена пароля</h3>
     <label class="field">Текущий пароль<input id="profile-current-password" name="current_password" type="password" autocomplete="current-password"></label>
     <label class="field">Новый пароль<input id="profile-new-password" name="new_password" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <label class="field">Повторите новый пароль<input id="profile-confirmation" name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
     <div class="profile-password-actions">
      <button id="toggle-profile-passwords" class="text-button" type="button"
       aria-controls="profile-current-password profile-new-password profile-confirmation">Показать пароли</button>
      <button id="profile-forgot-password" class="text-button" type="button">Забыли пароль?</button>
     </div>
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
 let previewImage;
 avatarFile.onchange = () => {
  const file = avatarFile.files[0];
  previewImage = undefined;
  preview.innerHTML = avatar;
  if (!file || file.size > 1024 * 1024) return;
  const image = new FileReader();
  previewImage = image;
  image.onload = () => {
   if (previewImage === image) preview.innerHTML = `<img src="${esc(image.result)}" alt="">`;
  };
  image.readAsDataURL(file);
 };
 avatarForm.onsubmit = async event => {
  event.preventDefault();
  if (!avatarFile.files.length) {
   $('.form-error', avatarForm).textContent = 'Выберите фото';
   return;
  }
  await saveAccountProfile(avatarForm, '/profile/avatar', new FormData(avatarForm), 'POST',
   'Фото профиля обновлено', () => {
    previewImage = undefined;
    preview.innerHTML = avatar;
   });
 };

 const details = $('#profile-form', root);
 const passwords = $$('input[type="password"]', details);
 const togglePasswords = $('#toggle-profile-passwords', details);
 togglePasswords.onclick = () => {
  const show = passwords[0].type === 'password';
  passwords.forEach(input => {input.type = show ? 'text' : 'password';});
  togglePasswords.textContent = show ? 'Скрыть пароли' : 'Показать пароли';
 };
 $('#profile-forgot-password', details).onclick = () => requestPasswordReset({
  email: user.email,
  onBack: closeModal,
  backLabel: 'Вернуться в профиль'
 });
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
