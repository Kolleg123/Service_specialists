/* Booking UI: one owner of the service/date/slot snapshot and request generation. */
let activeBooking = null;

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function scheduleForm(schedule) {
  return `<form id="weekly-schedule" class="panel form-grid">
    <label class="field">Режим записи<select name="mode" data-current="${schedule?.mode || 'manual'}">
      <option value="manual">Ручные слоты</option><option value="time">На конкретное время</option><option value="day">На день с лимитом</option>
    </select></label>
    <fieldset id="schedule-days"><legend>Рабочие дни</legend>${WEEKDAYS.map((day,i) =>
      `<label><input type="checkbox" name="weekdays" value="${i+1}" ${(schedule?.weekdays || [1,2,3,4,5]).includes(i+1)?'checked':''}>${day} </label>`).join('')}</fieldset>
    <label class="field">Начало работы<input type="time" name="opens_at" value="${esc(schedule?.opens_at || '09:00')}"></label>
    <label class="field">Окончание работы<input type="time" name="closes_at" value="${esc(schedule?.closes_at || '18:00')}"></label>
    <label class="field">Начало обеда<input type="time" name="lunch_start" value="${esc(schedule?.lunch_start)}"></label>
    <label class="field">Окончание обеда<input type="time" name="lunch_end" value="${esc(schedule?.lunch_end)}"></label>
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
  mode.onchange = syncFields;
  syncFields();
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
      toast('Расписание сохранено');
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
  if (!specialist?.services.length) return toast('Специалист сейчас недоступен');
  activeBooking = new BookingFlow(specialist, preferredServiceId);
  activeBooking.open();
}

class BookingFlow {
  constructor(specialist, preferredServiceId) {
    this.specialist = specialist;
    const preferred = specialist.services.find(service => service.id === preferredServiceId);
    this.serviceId = (preferred ?? specialist.services[0])?.id ?? null;
    this.step = 1;
    this.slots = [];
    this.day = null;
    this.slot = null;
    this.page = 0;
    this.generation = 0;
    this.loading = false;
    this.submitting = false;
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
      <div class="profile-head"><img src="${esc(s.photo)}" alt="${esc(s.name)}"><div><span class="eyebrow">${esc(s.profession)}</span><h2>${esc(s.name)}</h2><p>${s.experience} лет опыта · ${reviewCount(s.reviews.length)}</p><p>${esc(s.location)}</p></div></div>
      <nav class="booking-steps" aria-label="Этапы записи"></nav>
      <label class="field">Услуга<select id="booking-service">${s.services.map(v => `<option value="${v.id}">${esc(v.title)} · ${money(v.price)} · ${v.duration} мин</option>`).join('')}</select></label>
      <p class="timezone-note">Время Кирова · UTC+3. Оплата после встречи.</p>
      <div id="booking-notice" role="status" aria-live="polite"></div>
      <div id="step-content"></div>
    </section>`);
    if (this.serviceId !== null) $('#booking-service').value = String(this.serviceId);
    $('#booking-service').onchange = e => {
      this.serviceId = Number(e.target.value);
      this.resetChoice('Услуга изменена. Прежние дата и время сброшены — выберите новый слот.');
      this.step = this.ownProfile ? 1 : 2;
      this.fields.quantity = 1;
      if (this.ownProfile) this.render();
      else this.refresh();
    };
    this.render();
    $('#booking-service').focus();
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
    $('#booking-service').disabled = this.submitting || !this.service;
    $('.booking-steps').innerHTML = ['Услуга', this.dateOnly ? 'Дата' : 'Дата и время', 'Подтверждение'].map((label, i) =>
      `<button type="button" data-step="${i + 1}" ${this.submitting || (i === 2 && !this.slot) || (i > 0 && (!this.service || this.ownProfile)) ? 'disabled' : ''} ${this.step === i + 1 ? 'aria-current="step"' : ''}><span>${i + 1}</span>${label}</button>`).join('');
    $$('.booking-steps [data-step]').forEach(b => b.onclick = () => {
      this.step = Number(b.dataset.step);
      if (this.step === 2) this.refresh('Проверьте актуальное расписание и выберите время.');
      else this.render();
    });
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
      ${this.dateOnly ? '' : `<div id="times" class="time-grid" role="group" aria-label="Свободное время">${this.day ? this.slots.filter(s => s.starts_at.startsWith(this.day)).map(s => `<button class="slot ${this.slot && this.slotKey(this.slot) === this.slotKey(s) ? 'selected' : ''}" data-slot="${this.slotKey(s)}" aria-pressed="${this.slot && this.slotKey(this.slot) === this.slotKey(s)}" ${s.remaining < 1 ? 'disabled' : ''}>${time(s.starts_at)}<small>${s.remaining > 0 ? s.capacity > 1 ? `${s.remaining} из ${s.capacity} мест` : `${s.duration} мин` : 'Мест нет'}</small></button>`).join('') : '<p class="muted">Сначала выберите дату выше.</p>'}</div>`}
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
      $(`[data-day="${this.day}"]`)?.focus();
    });
    $('#jump-date').onchange = e => {
      const index = days.indexOf(e.target.value);
      this.day = index >= 0 ? days[index] : null;
      this.slot = this.dateOnly ? this.slots.find(s => s.date === this.day) || null : null;
      if (index >= 0) this.page = Math.floor(index / pageSize);
      this.notice = index < 0 ? 'На эту дату нет свободного времени. Выберите одну из доступных дат.' : '';
      this.render();
      $('#jump-date').focus();
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
      <div class="booking-total"><span>Итого <strong id="total-price">${money(s.price * this.fields.quantity)}</strong></span><button id="confirm-booking" class="button" ${bookingBlocked ? 'disabled' : ''}>${state.user ? 'Подтвердить запись' : 'Войти и записаться'} →</button></div>
      <p class="muted">${this.ownProfile ? 'Записаться на собственную услугу нельзя.' : bookingBlocked ? 'Для записи войдите как клиент.' : 'Перед подтверждением мы ещё раз проверим свободные места.'}</p></form>`;
    const form = $('#book-form');
    form.oninput = () => {
      this.fields = {address: form.elements.address?.value || '', note: form.elements.note.value, quantity: Number(form.elements.quantity.value)};
      $('#total-price').textContent = money(s.price * this.fields.quantity);
    };
    form.onsubmit = e => { e.preventDefault(); this.submit(); };
  }

  async recover(message) {
    this.submitting = false;
    this.step = 2;
    await this.refresh(message + ' Выбор сброшен. Ниже — актуальные свободные даты.');
    if (this.alive) $('#step-content h3')?.focus();
  }

  async submit() {
    if (this.submitting || !this.slot) return;
    if (!state.user) { login(() => profile(this.specialist.id, this.serviceId)); return; }
    const snapshot = {...this.slot};
    const generation = this.generation;
    this.submitting = true;
    $('#booking-service').disabled = true;
    $$('.booking-steps [data-step]').forEach(b => b.disabled = true);
    $('#confirm-booking').disabled = true;
    $('#confirm-booking').textContent = 'Проверяем доступность…';
    try {
      const {slots} = await api(`/slots/${this.specialist.id}?service_id=${this.serviceId}`);
      if (!this.alive || generation !== this.generation) return;
      const live = slots.find(s => s.booking_mode === snapshot.booking_mode && this.slotKey(s) === this.slotKey(snapshot));
      if (!live || live.remaining < this.fields.quantity || ['service_id','starts_at','ends_at','duration','price'].some(k => live[k] !== snapshot[k])) {
        await this.recover('Выбранное время занято или условия услуги изменились.');
        return;
      }
      const selection = snapshot.id === null
        ? {booking_mode: snapshot.booking_mode, date: snapshot.date, ends_at: snapshot.ends_at}
        : {slot_id: snapshot.id};
      await api('/bookings', {...selection, service_id: this.serviceId, starts_at: snapshot.starts_at,
        duration: snapshot.duration, price: snapshot.price, ...this.fields});
      closeModal();
      toast('Вы записаны! Подробности — в личном кабинете.');
      dashboardMode = 'client';
      dashboardTab = 'bookings';
      dashboardStatusFilter = 'all';
      if (location.hash === '#dashboard') await dashboard();
      else location.hash = 'dashboard';
    } catch (error) {
      if (!this.alive) return;
      if (error.status === 409) {
        await this.recover(error.message);
      } else {
        this.submitting = false;
        this.render();
        $('.form-error', $('#book-form')).textContent = error.message;
      }
    } finally {
      this.submitting = false;
    }
  }
}

$('#modal').addEventListener('close', () => { if (!$('#modal').open) activeBooking = null; });
