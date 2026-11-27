/* Booking UI: one owner of the service/date/slot snapshot and request generation. */
let activeBooking = null;

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function serviceVisitDetails(service) {
  const place = service.mode === 'Выезд' ? 'Специалист приедет по адресу, который вы укажете.' :
    service.mode === 'Онлайн' ? 'Услуга проходит дистанционно.' :
    service.service_address ? `<strong>Адрес приёма</strong> · ${esc(service.service_address)}` :
    'Специалист пока не указал адрес приёма.';
  const contact = service.has_contact ? 'Контакты или инструкции появятся в личном кабинете после записи.' :
    'Специалист пока не добавил контакты и инструкции.';
  return `<div class="visit-details"><p>${place}</p><p class="muted">${contact}</p></div>`;
}

function scheduleForm(schedule) {
  return `<form id="weekly-schedule" class="panel form-grid">
    <div class="field schedule-mode-field"><span class="field-label">Режим записи</span>
      <div class="schedule-mode-switch" role="group" aria-label="Режим записи">
       <button type="button" data-schedule-mode="manual">Ручные слоты</button>
       <button type="button" data-schedule-mode="time">На конкретное время</button>
       <button type="button" data-schedule-mode="day">На день с лимитом</button>
      </div>
      <select name="mode" data-current="${schedule?.mode || 'manual'}" class="visually-hidden" aria-hidden="true" tabindex="-1">
       <option value="manual">Ручные слоты</option><option value="time">На конкретное время</option><option value="day">На день с лимитом</option>
      </select>
    </div>
    <fieldset id="schedule-days" class="weekday-picker"><legend>Рабочие дни</legend><p class="muted">Выберите дни, когда запись доступна клиентам</p><div>${WEEKDAYS.map((day,i) =>
      `<label><input type="checkbox" name="weekdays" value="${i+1}" ${(schedule?.weekdays || [1,2,3,4,5]).includes(i+1)?'checked':''}><span>${day}</span></label>`).join('')}</div></fieldset>
    <fieldset id="schedule-hours" class="schedule-fields"><legend>Рабочие часы</legend>
     <label class="field">Начало работы<input type="time" name="opens_at" value="${esc(schedule?.opens_at || '09:00')}"></label>
     <label class="field">Окончание работы<input type="time" name="closes_at" value="${esc(schedule?.closes_at || '18:00')}"></label>
    </fieldset>
    <fieldset id="schedule-lunch" class="schedule-fields"><legend>Обеденный перерыв</legend>
     <label class="field">Начало обеда<input type="time" name="lunch_start" value="${esc(schedule?.lunch_start)}"></label>
     <label class="field">Окончание обеда<input type="time" name="lunch_end" value="${esc(schedule?.lunch_end)}"></label>
    </fieldset>
    <label class="field">Дневной лимит<input type="number" name="daily_limit" min="1" max="50" value="${schedule?.daily_limit ?? 5}"></label>
    <button class="button">Сохранить расписание</button><p class="form-error" role="alert"></p>
  </form>`;
}

function bindScheduleForm() {
  const form = $('#weekly-schedule');
  const mode = form.elements.mode;
  mode.value = mode.dataset.current;
  const syncFields = () => {
    $('#schedule-days').disabled = mode.value === 'manual';
    $('#schedule-days').hidden = mode.value === 'manual';
    $('#schedule-hours').hidden = mode.value === 'manual';
    $('#schedule-lunch').hidden = mode.value !== 'time';
    for (const [name, enabled] of Object.entries({
      opens_at: mode.value !== 'manual', closes_at: mode.value !== 'manual',
      lunch_start: mode.value === 'time', lunch_end: mode.value === 'time', daily_limit: mode.value === 'day'
    })) {
      const field = form.elements[name];
      field.disabled = !enabled;
      field.required = enabled && !name.startsWith('lunch');
      field.closest('label').classList.toggle('hidden', !enabled);
    }
  };
  mode.onchange = () => {
    syncFields();
    $$('[data-schedule-mode]', form).forEach(button => {
      const active = button.dataset.scheduleMode === mode.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  $$('[data-schedule-mode]', form).forEach(button => button.onclick = () => {
    mode.value = button.dataset.scheduleMode;
    mode.dispatchEvent(new Event('change', {bubbles:true}));
  });
  mode.onchange();
  form.onsubmit = async event => {
    event.preventDefault();
    const fields = new FormData(form);
    const data = Object.fromEntries(fields);
    data.weekdays = fields.getAll('weekdays').map(Number);
    data.lunch_start = data.lunch_start || null;
    data.lunch_end = data.lunch_end || null;
    if (fields.has('daily_limit')) data.daily_limit = Number(data.daily_limit);
    try {
      await api('/master/schedule', data);
      await dashboard();
      toast('Расписание сохранено', 'success');
    } catch (error) {
      $('.form-error', form).textContent = error.message;
    }
  };
}


async function profile(id, preferredServiceId) {
  let specialist = state.specialists.find(s => s.id === id);
  if (!specialist || (preferredServiceId && !specialist.services.some(service => service.id === preferredServiceId))) {
    const {specialists} = await api('/catalog');
    specialist = specialists.find(s => s.id === id);
  }
  if (!specialist?.services.length) return toast('Специалист сейчас недоступен', 'warning');
  activeBooking = new BookingFlow(specialist, preferredServiceId);
  activeBooking.open();
}

class BookingFlow {
  constructor(specialist, preferredServiceId) {
    this.specialist = specialist;
    const preferred = specialist.services.find(service => service.id === preferredServiceId);
    this.categoryLabels = specialist;
    this.serviceId = (preferred ?? specialist.services[0])?.id ?? null;
    this.step = 1;
    this.slots = [];
    this.day = null;
    this.slot = null;
    this.page = 0;
    this.generation = 0;
    this.loading = false;
    this.submitting = false;
    this.pendingConfirmation = false;
    this.error = '';
    this.notice = '';
    this.fields = {address: '', note: '', quantity: 1};
  }

  get alive() { return activeBooking === this && Boolean($('#booking-flow')); }
  get ownProfile() { return state.user?.specialist_id === this.specialist.id; }
  get service() { return this.specialist.services.find(s => s.id === this.serviceId); }
  get dateOnly() { return (this.slots[0]?.booking_mode ?? this.specialist.booking_mode) === 'day'; }
  slotKey(slot) { return slot.id ?? slot.starts_at; }
  get days() { return [...new Set(this.slots.filter(s => s.remaining > 0).map(s => s.starts_at.slice(0, 10)))]; }

  open() {
    const s = this.specialist;
    modal(`<section id="booking-flow" aria-label="Запись к специалисту">
      <div class="profile-head"><img src="${esc(s.photo)}" alt="${esc(s.name)}"><div><span class="eyebrow">${esc(s.profession)}</span><h2>${esc(s.name)}</h2><p class="profile-rating"><strong>${s.rating == null ? 'Новый специалист' : `★ ${s.rating}`}</strong> · ${reviewCount(s.reviews.length)}</p><p>${s.experience} лет опыта · ${esc(s.location)}</p><p data-profile-category></p></div></div>
      <nav class="booking-steps" aria-label="Этапы записи"></nav>
      <label class="field">Услуга<select id="booking-service">${s.services.map(v => `<option value="${v.id}">${esc(v.title)} · ${money(v.price)} · ${v.duration} мин</option>`).join('')}</select></label>
      <p class="muted" data-profile-service-category></p>
      <p class="timezone-note">Время Кирова · UTC+3.</p>
      <div id="service-visit"></div>
      <div id="booking-notice" role="status" aria-live="polite"></div>
      <div id="step-content"></div>
    </section>`);
    if (this.serviceId !== null) $('#booking-service').value = String(this.serviceId);
    $('#booking-service').onchange = e => {
      this.serviceId = Number(e.target.value);
      this.slots = [];
      this.fields.address = '';
      this.renderCategoryLabels();
      this.resetChoice('Услуга изменена. Прежние дата и время сброшены — выберите новый слот.');
      this.step = this.ownProfile ? 1 : 2;
      this.fields.quantity = 1;
      if (this.ownProfile) this.render();
      else this.refresh();
    };
    this.renderCategoryLabels();
    this.render();
    $('#booking-service').focus();
  }

  updateCategoryLabels(specialists) {
    this.categoryLabels = specialists.find(specialist => specialist.id === this.specialist.id);
    this.renderCategoryLabels();
  }

  renderCategoryLabels() {
    $('[data-profile-category]').textContent = this.categoryLabels?.category_label ?? '';
    const service = this.categoryLabels?.services.find(item => item.id === this.serviceId);
    $('[data-profile-service-category]').textContent = service?.category_name ?? '';
  }

  resetChoice(message = '') {
    this.day = null;
    this.slot = null;
    this.page = 0;
    this.notice = message;
  }

  async refresh(message = this.notice) {
    const generation = ++this.generation;
    this.loading = true;
    this.error = '';
    this.resetChoice(message);
    this.render();
    try {
      const {slots} = await api(`/slots/${this.specialist.id}?service_id=${this.serviceId}`);
      if (!this.alive || generation !== this.generation) return;
      this.slots = slots.filter(s => s.service_id === this.serviceId);
    } catch (error) {
      if (!this.alive || generation !== this.generation) return;
      this.slots = [];
      this.error = error.message;
    } finally {
      if (this.alive && generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  render() {
    if (!this.alive) return;
    $('#booking-flow').dataset.step = this.step;
    $('#booking-service').disabled = this.submitting || this.pendingConfirmation || !this.service;
    $('.booking-steps').innerHTML = ['Услуга', this.dateOnly ? 'Дата' : 'Дата и время', 'Подтверждение'].map((label, i) =>
      `<button type="button" data-step="${i + 1}" ${this.submitting || this.pendingConfirmation || (i === 2 && !this.slot) || (i > 0 && (!this.service || this.ownProfile)) ? 'disabled' : ''} ${this.step === i + 1 ? 'aria-current="step"' : ''}><span>${i + 1}</span>${label}</button>`).join('');
    $$('.booking-steps [data-step]').forEach(b => b.onclick = () => {
      this.step = Number(b.dataset.step);
      if (this.step === 2) this.refresh('Проверьте актуальное расписание и выберите время.');
      else this.render();
    });
    const details = this.slot ?? this.slots[0] ?? this.service;
    $('#service-visit').innerHTML = details ? serviceVisitDetails(details) : '';
    $('#booking-notice').textContent = this.notice;
    const content = $('#step-content');
    if (this.step === 1) {
      const s = this.specialist;
      content.innerHTML = `<h3 tabindex="-1">1. Выберите услугу</h3><p class="bio">${esc(s.bio)}</p>
        <details class="education"><summary>Опыт, образование и навыки</summary><p>${esc(s.education)}</p><div class="tags">${s.skills.split(',').map(x => `<span>${esc(x)}</span>`).join('')}</div></details>
        <details class="profile-reviews"><summary>${reviewCount(s.reviews.length)}</summary>${s.reviews.length ? s.reviews.map(r => `<article class="review"><div><strong>${esc(r.name)}</strong><span class="stars">${'★'.repeat(r.rating)}</span></div><p>${esc(r.content)}</p><small>${date(r.created_at)} · Подтверждённая встреча</small></article>`).join('') : '<p class="muted">Пока нет опубликованных отзывов.</p>'}</details>
        ${this.service ? `<div class="service-summary"><strong>${esc(this.service.title)}</strong><span>${this.service.duration} мин · ${this.service.mode}</span><b>${money(this.service.price)}</b></div>${this.ownProfile ? '<p>Записаться на собственную услугу нельзя.</p>' : `<button id="choose-date" class="button full">Выбрать ${this.dateOnly ? 'дату' : 'дату и время'} →</button>`}` : '<div class="empty compact">У специалиста пока нет доступных услуг.</div>'}`;
      if ($('#choose-date')) $('#choose-date').onclick = () => { this.step = 2; this.refresh(); };
    } else if (this.step === 2) {
      this.renderTimes(content);
    } else {
      this.renderConfirmation(content);
    }
  }

  renderTimes(content) {
    content.innerHTML = `<h3 tabindex="-1">2. Выберите ${this.dateOnly ? 'дату' : 'дату и время'}</h3>`;
    if (this.loading) {
      content.insertAdjacentHTML('beforeend', '<div class="booking-state" role="status" aria-busy="true"><span class="spinner" aria-hidden="true"></span><h4>Проверяем расписание</h4><p>Загружаем свободное время для выбранной услуги…</p></div>');
      return;
    }
    if (this.error) {
      content.insertAdjacentHTML('beforeend', `<div class="booking-state state-error" role="alert"><span aria-hidden="true">!</span><h4>Не удалось загрузить время</h4><p>${esc(this.error)}</p><button class="button" id="retry-slots">Повторить загрузку</button></div>`);
      $('#retry-slots').onclick = () => this.refresh();
      return;
    }
    const days = this.days;
    if (!days.length) {
      content.insertAdjacentHTML('beforeend', '<div class="booking-state"><span aria-hidden="true">▦</span><h4>Свободных дат пока нет</h4><p>Мастер ещё не открыл расписание или все места заняты. Выберите другую услугу, проверьте позже или вернитесь в каталог.</p><div class="dialog-actions"><button id="retry-slots" class="button pale">Обновить расписание</button><button id="back-catalog" class="button outline">Другой специалист</button></div></div>');
      $('#retry-slots').onclick = () => this.refresh();
      $('#back-catalog').onclick = closeModal;
      return;
    }
    const pageSize = 4;
    const pageDays = days.slice(this.page * pageSize, (this.page + 1) * pageSize);
    content.insertAdjacentHTML('beforeend', `<div class="date-navigation"><button id="previous-dates" class="button outline" aria-label="Предыдущие даты" ${this.page === 0 ? 'disabled' : ''}>← Назад</button><strong aria-live="polite">${date(pageDays[0])} — ${date(pageDays.at(-1))}</strong><button id="next-dates" class="button outline" aria-label="Следующие даты" ${(this.page + 1) * pageSize >= days.length ? 'disabled' : ''}>Далее →</button></div>
      <div class="date-grid" role="group" aria-label="Доступные даты">${pageDays.map(d => `<button data-day="${d}" aria-pressed="${this.day === d}"><b>${new Date(d + 'T12:00:00').getDate()}</b><span>${new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', {month:'short', weekday:'short'})}</span></button>`).join('')}</div>
      <p class="date-range">Расписание опубликовано до ${date(days.at(-1))}.</p>
      <label class="field date-jump">Перейти к дате<input id="jump-date" type="date" min="${days[0]}" max="${days.at(-1)}" value="${this.day || ''}"></label>
      ${this.dateOnly ? (this.slot ? `<section class="booking-availability" tabindex="-1"><h4>Дата доступна</h4>
        ${this.slot.remaining !== undefined ? `<p>Свободных мест: ${this.slot.remaining}</p>` : ''}</section>` : '') :
        `<section class="booking-availability" tabindex="-1">${this.day ? '<h4>Доступное время</h4>' : ''}<div id="times"  class="time-grid" role="group" aria-label="Свободное время">${this.day ? this.slots.filter(s => s.starts_at.startsWith(this.day)).map(s => `<button class="slot ${this.slot && this.slotKey(this.slot) === this.slotKey(s) ? 'selected' : ''}" data-slot="${this.slotKey(s)}" aria-pressed="${this.slot && this.slotKey(this.slot) === this.slotKey(s)}" ${s.remaining < 1 ? 'disabled' : ''}>${time(s.starts_at)}<small>${s.remaining > 0 ? s.capacity > 1 ? `${s.remaining} из ${s.capacity} мест` : `${s.duration} мин` : 'Мест нет'}</small></button>`).join('') : '<p class="muted">Сначала выберите дату выше.</p>'}</div></section>`}
      <div id="booking-details">${this.slot ? `<div class="service-summary"><strong>${date(this.slot.starts_at)}${this.dateOnly ? '' : ' · ' + time(this.slot.starts_at)}</strong><span>${this.slot.duration} мин · ${esc(this.slot.service)}</span><b>${money(this.slot.price)}</b></div><button id="to-confirmation" class="button full">Продолжить →</button>` : ''}</div>`);
    const turnPage = offset => {
      this.page += offset;
      this.day = null;
      this.slot = null;
      this.render();
      $('[data-day]')?.focus();
    };
    $('#previous-dates').onclick = () => turnPage(-1);
    $('#next-dates').onclick = () => turnPage(1);
    $$('[data-day]').forEach(b => b.onclick = () => {
      this.day = b.dataset.day;
      this.slot = this.dateOnly ? this.slots.find(s => s.date === this.day) : null;
      this.render();
      $(`[data-day="${this.day}"]`)?.focus({preventScroll:true});
      this.revealAvailability();
    });
    $('#jump-date').onchange = e => {
      const index = days.indexOf(e.target.value);
      this.day = index >= 0 ? days[index] : null;
      this.slot = this.dateOnly ? this.slots.find(s => s.date === this.day) || null : null;
      if (index >= 0) this.page = Math.floor(index / pageSize);
      this.notice = index < 0 ? 'На эту дату нет свободного времени. Выберите одну из доступных дат.' : '';
      this.render();
      $('#jump-date').focus({preventScroll:true});
      if (this.day) this.revealAvailability();
    };
    $$('[data-slot]').forEach(b => b.onclick = () => {
      this.slot = {...this.slots.find(s => String(this.slotKey(s)) === b.dataset.slot)};
      this.render();
      $('#to-confirmation').focus();
    });
    if ($('#to-confirmation')) $('#to-confirmation').onclick = () => {
      this.step = 3;
      this.notice = '';
      this.render();
      $('#confirmation-title').focus();
    };
  }

  renderConfirmation(content) {
    const s = this.slot;
    const bookingBlocked = this.ownProfile || state.user?.role === 'admin';
    if (!s) { this.step = 2; this.render(); return; }
    content.innerHTML = `<h3 id="confirmation-title" tabindex="-1">3. Проверьте запись</h3>
      <dl class="confirmation-summary"><div><dt>Специалист</dt><dd>${esc(this.specialist.name)}</dd></div><div><dt>Услуга</dt><dd>${esc(s.service)}</dd></div><div><dt>${this.dateOnly ? 'Дата' : 'Дата и время · UTC+3'}</dt><dd>${date(s.starts_at)}${this.dateOnly ? '' : ' · ' + time(s.starts_at)}</dd></div><div><dt>Продолжительность</dt><dd>${s.duration} мин</dd></div><div><dt>Формат</dt><dd>${esc(s.mode)}</dd></div><div><dt>Цена за участника</dt><dd>${money(s.price)}</dd></div></dl>
      <form id="book-form" class="booking-form">
      ${s.capacity > 1 ? `<label class="field">Количество участников<input name="quantity" type="number" min="1" max="${s.remaining}" value="${this.fields.quantity}" required></label>` : '<input name="quantity" type="hidden" value="1">'}
      ${s.mode === 'Выезд' ? `<label class="field">Адрес выезда<input name="address" value="${esc(this.fields.address)}" placeholder="Улица, дом, квартира" minlength="5" maxlength="250" required></label>` : ''}
      <label class="field">Комментарий (необязательно)<textarea name="note" maxlength="1000" placeholder="Что важно знать специалисту?">${esc(this.fields.note)}</textarea></label>
      <p class="form-error" role="alert"></p>
      <div class="booking-total"><span>Итого <strong id="total-price">${money(s.price * this.fields.quantity)}</strong></span><button id="confirm-booking" class="button" ${bookingBlocked ? 'disabled' : ''}>${this.pendingConfirmation ? 'Проверить запись' : state.user ? 'Подтвердить запись' : 'Войти и записаться'} →</button></div>
      <p class="muted">${this.ownProfile ? 'Записаться на собственную услугу нельзя.' : bookingBlocked ? 'Для записи войдите как клиент.' : 'Перед подтверждением мы ещё раз проверим свободные места.'}</p></form>`;
    const form = $('#book-form');
    if (this.pendingConfirmation) {
      for (const field of form.querySelectorAll('input, textarea')) field.readOnly = true;
    }
    form.oninput = () => {
      this.fields = {address: form.elements.address?.value || '', note: form.elements.note.value, quantity: Number(form.elements.quantity.value)};
      $('#total-price').textContent = money(s.price * this.fields.quantity);
    };
    form.onsubmit = e => { e.preventDefault(); this.submit(); };
  }

  revealAvailability() {
    const section = $('.booking-availability');
    const dialog = $('#modal');
    if (!section) return;
    const bounds = section.getBoundingClientRect();
    const frame = dialog.getBoundingClientRect();
    if (bounds.top < frame.top + 55 || bounds.top + Math.min(bounds.height, 130) > frame.bottom) {
      dialog.scrollTop += bounds.top - frame.top - 65;
    }
  }

  async recover(message) {
    this.submitting = false;
    this.step = 2;
    await this.refresh(message + ' Выбор сброшен. Ниже — актуальные свободные даты.');
    if (this.alive) $('#step-content h3')?.focus();
  }

  async submit() {
    if (this.submitting || !this.slot) return;
    if (!state.user) {
      const form = $('#book-form');
      if (form) {
        this.fields = {
          address: form.elements.address?.value || '',
          note: form.elements.note.value,
          quantity: Number(form.elements.quantity.value)
        };
      }
      const pending = {
        specialist: this.specialist,
        serviceId: this.serviceId,
        slot: {...this.slot},
        slots: this.slots,
        categoryLabels: this.categoryLabels,
        fields: {...this.fields},
        day: this.day,
        page: this.page
      };
      login(async () => {
        const resumed = new BookingFlow(pending.specialist, pending.serviceId);
        resumed.slot = pending.slot;
        resumed.slots = pending.slots;
        resumed.categoryLabels = pending.categoryLabels;
        resumed.fields = pending.fields;
        resumed.day = pending.day;
        resumed.page = pending.page;
        resumed.step = 3;
        activeBooking = resumed;
        resumed.open();
        resumed.notice = 'Данные записи сохранены. Проверьте доступность времени перед подтверждением.';
        resumed.render();
      });
      return;
    }
    const snapshot = this.slot;
    const selection = snapshot.id === null
      ? {booking_mode: snapshot.booking_mode, date: snapshot.date, ends_at: snapshot.ends_at}
      : {slot_id: snapshot.id};
    const payload = {...selection, service_id: this.serviceId, starts_at: snapshot.starts_at,
      duration: snapshot.duration, price: snapshot.price, mode: snapshot.mode,
      service_address: snapshot.service_address, ...this.fields,
      address: snapshot.mode === 'Выезд' ? this.fields.address : ''};
    if (this.submitting) return;
    this.submitting = true;
    let identity, saved;
    try {
      identity = await bookingIdentity(payload);
      saved = sessionStorage.getItem(identity);
    } catch {
      this.submitting = false;
      $('.form-error', $('#book-form') ?? document)?.replaceChildren('Не удалось сохранить ключ записи. Откройте сайт через HTTPS и проверьте доступ к хранилищу браузера.');
      return;
    }
    if (!this.alive) { this.submitting = false; return; }
    const checking = this.pendingConfirmation || saved !== null;
    $('#booking-service').disabled = true;
    $$('.booking-steps [data-step]').forEach(button => button.disabled = true);
    for (const field of $('#book-form').querySelectorAll('input, textarea')) field.readOnly = true;
    $('#confirm-booking').disabled = true;
    $('#confirm-booking').textContent = checking ? 'Проверяем результат…' : 'Подтверждаем запись…';
    let booking;
    let sent = checking;
    try {
      if (!checking) {
        const {slots} = await api(`/slots/${this.specialist.id}?service_id=${this.serviceId}`);
        if (!this.alive) return;
        const live = slots.find(s => s.booking_mode === snapshot.booking_mode && this.slotKey(s) === this.slotKey(snapshot));
        if (!live || live.remaining < payload.quantity || ['service_id','starts_at','ends_at','duration','price','mode','service_address'].some(
          field => live[field] !== snapshot[field])) {
          await this.recover('Выбранное время занято или условия услуги изменились.');
          return;
        }
      }
      sent = true;
      booking = await submitOperation('/bookings', payload, identity);
    } catch (error) {
      if (!this.alive) return;
      this.submitting = false;
      this.pendingConfirmation = sent && (uncertainOperation(error) || (checking && [401, 403].includes(error.status)));
      if (this.pendingConfirmation) {
        this.notice = 'Ответ не получен или результат пока не подтверждён. Нажмите «Проверить запись», когда связь восстановится.';
        this.render();
        if ([401, 403].includes(error.status)) $('.form-error', $('#book-form')).textContent = error.message;
      } else if (error.status === 409) {
        await this.recover(error.message);
      } else {
        this.notice = 'Запись не создана.';
        this.render();
        $('.form-error', $('#book-form')).textContent = error.message;
      }
      return;
    } finally {
      this.submitting = false;
    }
    if (this.alive) closeModal();
    toast(`Вы записаны! Запись №${booking.id}. Подробности — в личном кабинете.`, 'success');
    state.newBookingId = booking.id;
    dashboardMode = 'client';
    dashboardTab = 'bookings';
    dashboardStatusFilter = 'all';
    if (location.hash === '#dashboard') dashboard().catch(error => toast(error.message, 'error'));
    else location.hash = 'dashboard';
  }

}

$('#modal').addEventListener('close', () => { if (!$('#modal').open) activeBooking = null; });
