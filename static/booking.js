/* Booking UI: one owner of the service/date/slot snapshot and request generation. */
let activeBooking = null;

async function profile(id) {
  const specialist = state.specialists.find(s => s.id === id);
  if (!specialist) return toast('Специалист сейчас недоступен');
  activeBooking = new BookingFlow(specialist);
  activeBooking.open();
}

class BookingFlow {
  constructor(specialist) {
    this.specialist = specialist;
    this.serviceId = specialist.services[0]?.id ?? null;
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
  get service() { return this.specialist.services.find(s => s.id === this.serviceId); }
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
    $('#booking-service').onchange = e => {
      this.serviceId = Number(e.target.value);
      this.resetChoice('Услуга изменена. Прежние дата и время сброшены — выберите новый слот.');
      this.step = 2;
      this.fields.quantity = 1;
      this.refresh();
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
    $('.booking-steps').innerHTML = ['Услуга', 'Дата и время', 'Подтверждение'].map((label, i) =>
      `<button type="button" data-step="${i + 1}" ${this.submitting || (i === 2 && !this.slot) || (i > 0 && !this.service) ? 'disabled' : ''} ${this.step === i + 1 ? 'aria-current="step"' : ''}><span>${i + 1}</span>${label}</button>`).join('');
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
        ${this.service ? `<div class="service-summary"><strong>${esc(this.service.title)}</strong><span>${this.service.duration} мин · ${this.service.mode}</span><b>${money(this.service.price)}</b></div><button id="choose-date" class="button full">Выбрать дату и время →</button>` : '<div class="empty compact">У специалиста пока нет доступных услуг.</div>'}`;
      if ($('#choose-date')) $('#choose-date').onclick = () => { this.step = 2; this.refresh(); };
    } else if (this.step === 2) {
      this.renderTimes(content);
    } else {
      this.renderConfirmation(content);
    }
  }

  renderTimes(content) {
    content.innerHTML = '<h3 tabindex="-1">2. Выберите дату и время</h3>';
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
      <p class="date-range">Расписание опубликовано до ${date(days.at(-1))}. Более поздние даты появятся, когда мастер добавит слоты.</p>
      <label class="field date-jump">Перейти к дате<input id="jump-date" type="date" min="${days[0]}" max="${days.at(-1)}" value="${this.day || ''}"></label>
      <div id="times" class="time-grid" role="group" aria-label="Свободное время">${this.day ? this.slots.filter(s => s.starts_at.startsWith(this.day)).map(s => `<button class="slot ${this.slot?.id === s.id ? 'selected' : ''}" data-slot="${s.id}" aria-pressed="${this.slot?.id === s.id}" ${s.remaining < 1 ? 'disabled' : ''}>${time(s.starts_at)}<small>${s.remaining > 0 ? s.capacity > 1 ? `${s.remaining} из ${s.capacity} мест` : `${s.duration} мин` : 'Мест нет'}</small></button>`).join('') : '<p class="muted">Сначала выберите дату выше.</p>'}</div>
      <div id="booking-details">${this.slot ? `<div class="service-summary"><strong>${date(this.slot.starts_at)} · ${time(this.slot.starts_at)}</strong><span>${this.slot.duration} мин · ${esc(this.slot.service)}</span><b>${money(this.slot.price)}</b></div><button id="to-confirmation" class="button full">Продолжить →</button>` : ''}</div>`);
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
      this.slot = null;
      this.render();
      $(`[data-day="${this.day}"]`)?.focus();
    });
    $('#jump-date').onchange = e => {
      const index = days.indexOf(e.target.value);
      this.slot = null;
      this.day = index >= 0 ? days[index] : null;
      if (index >= 0) this.page = Math.floor(index / pageSize);
      this.notice = index < 0 ? 'На эту дату нет свободного времени. Выберите одну из доступных дат.' : '';
      this.render();
      $('#jump-date').focus();
    };
    $$('[data-slot]').forEach(b => b.onclick = () => {
      this.slot = {...this.slots.find(s => s.id === Number(b.dataset.slot))};
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
    if (!s) { this.step = 2; this.render(); return; }
    content.innerHTML = `<h3 id="confirmation-title" tabindex="-1">3. Проверьте запись</h3>
      <dl class="confirmation-summary"><div><dt>Специалист</dt><dd>${esc(this.specialist.name)}</dd></div><div><dt>Услуга</dt><dd>${esc(s.service)}</dd></div><div><dt>Дата и время · UTC+3</dt><dd>${date(s.starts_at)} · ${time(s.starts_at)}</dd></div><div><dt>Продолжительность</dt><dd>${s.duration} мин</dd></div><div><dt>Формат</dt><dd>${esc(s.mode)}</dd></div><div><dt>Цена за участника</dt><dd>${money(s.price)}</dd></div></dl>
      <form id="book-form" class="booking-form">
      ${s.capacity > 1 ? `<label class="field">Количество участников<input name="quantity" type="number" min="1" max="${s.remaining}" value="${this.fields.quantity}" required></label>` : '<input name="quantity" type="hidden" value="1">'}
      ${s.mode === 'Выезд' ? `<label class="field">Адрес выезда<input name="address" value="${esc(this.fields.address)}" placeholder="Улица, дом, квартира" minlength="5" maxlength="250" required></label>` : ''}
      <label class="field">Комментарий (необязательно)<textarea name="note" maxlength="1000" placeholder="Что важно знать специалисту?">${esc(this.fields.note)}</textarea></label>
      <p class="form-error" role="alert"></p>
      <div class="booking-total"><span>Итого <strong id="total-price">${money(s.price * this.fields.quantity)}</strong></span><button id="confirm-booking" class="button" ${state.user && state.user.role !== 'client' ? 'disabled' : ''}>${state.user ? 'Подтвердить запись' : 'Войти и записаться'} →</button></div>
      <p class="muted">${state.user && state.user.role !== 'client' ? 'Для записи войдите как клиент.' : 'Перед подтверждением мы ещё раз проверим свободные места.'}</p></form>`;
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
    if (!state.user) { login(() => profile(this.specialist.id)); return; }
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
      const live = slots.find(s => s.id === snapshot.id);
      if (!live || live.remaining < this.fields.quantity || ['service_id','starts_at','duration','price'].some(k => live[k] !== snapshot[k])) {
        await this.recover('Выбранное время занято или условия услуги изменились.');
        return;
      }
      await api('/bookings', {slot_id: snapshot.id, service_id: this.serviceId, starts_at: snapshot.starts_at,
        duration: snapshot.duration, price: snapshot.price, ...this.fields});
      closeModal();
      toast('Вы записаны! Подробности — в личном кабинете.');
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
