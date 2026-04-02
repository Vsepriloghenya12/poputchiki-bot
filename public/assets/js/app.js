
import { apiRequest, getStartParam, getTelegramUser, initUser, openChat, showAlert } from './shared/api.js';
import { escapeHtml, formatDateTime, formatMoney, formatName, getInitials, isUpcoming, statusBadge } from './shared/format.js';

const state = {
  user: null,
  isOwner: false,
  currentView: 'feed',
  currentFeed: 'driver-trips',
  seatSelection: new Map(),
  pendingHighlight: null,
  data: {
    feedTrips: [],
    feedPlans: [],
    activeDriverTrip: null,
    activeDriverBookings: [],
    activePassengerBookings: [],
    activeTakenPlans: [],
    historyDriverTrips: [],
    historyPassengerBookings: [],
    historyPassengerPlans: [],
    historyTakenPlans: [],
  },
};

const refs = {
  feedDriverBtn: document.getElementById('feedDriverBtn'),
  feedPlansBtn: document.getElementById('feedPlansBtn'),
  tabsPanel: document.getElementById('tabsPanel'),
  statusBanner: document.getElementById('statusBanner'),
  viewFeed: document.getElementById('viewFeed'),
  viewActive: document.getElementById('viewActive'),
  viewHistory: document.getElementById('viewHistory'),
  bottomSearchBtn: document.getElementById('bottomSearchBtn'),
  bottomActiveBtn: document.getElementById('bottomActiveBtn'),
  feedList: document.getElementById('feedList'),
  activeDriverTripList: document.getElementById('activeDriverTripList'),
  activeDriverBookingsList: document.getElementById('activeDriverBookingsList'),
  activePassengerBookingsList: document.getElementById('activePassengerBookingsList'),
  activeTakenPlansList: document.getElementById('activeTakenPlansList'),
  historyDriverTripsList: document.getElementById('historyDriverTripsList'),
  historyPassengerBookingsList: document.getElementById('historyPassengerBookingsList'),
  historyPassengerPlansList: document.getElementById('historyPassengerPlansList'),
  historyTakenPlansList: document.getElementById('historyTakenPlansList'),
  drawer: document.getElementById('drawer'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  drawerUserName: document.getElementById('drawerUserName'),
  drawerUserTag: document.getElementById('drawerUserTag'),
  ownerDrawerItem: document.getElementById('ownerDrawerItem'),
  menuBtn: document.getElementById('menuBtn'),
  createBtn: document.getElementById('createBtn'),
  sheetBackdrop: document.getElementById('sheetBackdrop'),
  closeComposerBtn: document.getElementById('closeComposerBtn'),
  composerTitle: document.getElementById('composerTitle'),
  composerSubtitle: document.getElementById('composerSubtitle'),
  composerForm: document.getElementById('composerForm'),
  composerFrom: document.getElementById('composerFrom'),
  composerTo: document.getElementById('composerTo'),
  composerDatetime: document.getElementById('composerDatetime'),
  composerSeats: document.getElementById('composerSeats'),
  composerPrice: document.getElementById('composerPrice'),
  composerNote: document.getElementById('composerNote'),
  composerSeatsLabel: document.getElementById('composerSeatsLabel'),
  composerPriceLabel: document.getElementById('composerPriceLabel'),
  composerSubmit: document.getElementById('composerSubmit'),
};

function parseStartAction(value) {
  const raw = String(value || '').trim();
  const tripMatch = raw.match(/^trip_(\d+)$/i);
  if (tripMatch) return { type: 'trip', id: Number(tripMatch[1]), feed: 'driver-trips' };

  const planMatch = raw.match(/^plan_(\d+)$/i);
  if (planMatch) return { type: 'plan', id: Number(planMatch[1]), feed: 'passenger-requests' };

  return null;
}

function setStatus(message = '', tone = '') {
  refs.statusBanner.textContent = message;
  refs.statusBanner.classList.toggle('hidden', !message);
  refs.statusBanner.classList.toggle('is-error', tone === 'error');
}

function updateUserCard() {
  const user = state.user || getTelegramUser();
  refs.drawerUserName.textContent = user ? formatName(user.first_name, user.last_name, user.username) : 'Откройте через Telegram';
  refs.drawerUserTag.textContent = user?.username ? `@${user.username}` : 'Мини-приложение для поездок';
  refs.ownerDrawerItem.classList.toggle('hidden', !state.isOwner);
}

function updateTabs() {
  refs.feedDriverBtn.classList.toggle('is-active', state.currentFeed === 'driver-trips');
  refs.feedPlansBtn.classList.toggle('is-active', state.currentFeed === 'passenger-requests');
}

function updateViews() {
  refs.viewFeed.classList.toggle('is-active', state.currentView === 'feed');
  refs.viewActive.classList.toggle('is-active', state.currentView === 'active');
  refs.viewHistory.classList.toggle('is-active', state.currentView === 'history');
  refs.tabsPanel.classList.toggle('hidden', state.currentView !== 'feed');
  refs.bottomSearchBtn.classList.toggle('is-active', state.currentView === 'feed');
  refs.bottomActiveBtn.classList.toggle('is-active', state.currentView === 'active');

  document.querySelectorAll('.drawer-link[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === state.currentView);
  });
}

function openDrawer() {
  refs.drawer.classList.add('is-open');
  refs.drawerBackdrop.classList.add('is-open');
}

function closeDrawer() {
  refs.drawer.classList.remove('is-open');
  refs.drawerBackdrop.classList.remove('is-open');
}

function openComposer() {
  const isTripMode = state.currentFeed === 'driver-trips';
  refs.composerTitle.textContent = isTripMode ? 'Создать поездку' : 'Создать заявку пассажира';
  refs.composerSubtitle.textContent = isTripMode
    ? 'Поездка сразу появится в ленте.'
    : 'Заявка сразу появится в ленте.';
  refs.composerSeatsLabel.textContent = isTripMode ? 'Свободных мест' : 'Нужно мест';
  refs.composerPriceLabel.textContent = isTripMode ? 'Цена за место' : 'Бюджет за место';
  refs.composerSubmit.textContent = isTripMode ? 'Создать поездку' : 'Создать заявку';
  refs.sheetBackdrop.classList.add('is-open');
}

function closeComposer() {
  refs.sheetBackdrop.classList.remove('is-open');
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function renderDriverTripCard(trip, options = {}) {
  const seatsSelected = state.seatSelection.get(trip.id) || 1;
  const personName = formatName(trip.first_name, trip.last_name, trip.username);
  const carParts = [trip.car_color, trip.car_make].filter(Boolean).join(' ');
  const carLine = trip.car_plate ? `${carParts} (${trip.car_plate})`.trim() : carParts;
  const canCancel = options.allowCancel && Number(trip.bookings_count || 0) === 0 && isUpcoming(trip.departure_time, 0);

  return `
    <article class="ride-card" data-trip-id="${trip.id}">
      <div class="feed-topline">
        <div class="person-chip">
          <div class="avatar">${escapeHtml(getInitials(trip.first_name, trip.last_name, trip.username))}</div>
          <div>
            <div class="person-name">${escapeHtml(personName)}</div>
            <div class="person-meta">${escapeHtml(carLine || 'Поездка без указания авто')}</div>
          </div>
        </div>
        <div class="price-pill">${escapeHtml(formatMoney(trip.price_per_seat))}</div>
      </div>
      <div class="route-line">${escapeHtml(trip.from_city)} <span>→</span> ${escapeHtml(trip.to_city)}</div>
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-label">Время</div><div class="meta-value">${escapeHtml(formatDateTime(trip.departure_time))}</div></div>
        <div class="meta-item"><div class="meta-label">Свободно мест</div><div class="meta-value">${escapeHtml(String(trip.seats_available))}</div></div>
      </div>
      ${trip.note ? `<div class="section-note">${escapeHtml(trip.note)}</div>` : ''}
      <div class="card-actions">
        ${options.booking ? `
          <div class="stepper">
            <button type="button" data-action="seat-down" data-trip-id="${trip.id}">−</button>
            <span>${escapeHtml(String(seatsSelected))} мест</span>
            <button type="button" data-action="seat-up" data-trip-id="${trip.id}" data-max="${trip.seats_available}">+</button>
          </div>
          <button class="button" type="button" data-action="book-trip" data-trip-id="${trip.id}">Забронировать</button>
        ` : ''}
        ${canCancel ? `<button class="danger-button" type="button" data-action="cancel-trip" data-trip-id="${trip.id}">Отменить поездку</button>` : ''}
      </div>
    </article>
  `;
}

function renderPlanCard(plan, options = {}) {
  const passengerName = formatName(plan.passenger_first_name, plan.passenger_last_name, plan.passenger_username);
  const badge = statusBadge(plan.status);
  const chatAction = options.chatAction || 'chat-plan-passenger';
  const chatLabel = options.chatLabel || 'Чат';
  return `
    <article class="ride-card" data-plan-id="${plan.id}">
      <div class="feed-topline">
        <div class="person-chip">
          <div class="avatar">${escapeHtml(getInitials(plan.passenger_first_name, plan.passenger_last_name, plan.passenger_username))}</div>
          <div>
            <div class="person-name">${escapeHtml(passengerName)}</div>
            <div class="person-meta">${escapeHtml(plan.passenger_username ? '@' + plan.passenger_username.replace('@', '') : 'Пассажир')}</div>
          </div>
        </div>
        <span class="badge ${badge.tone}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="route-line">${escapeHtml(plan.from_city)} <span>→</span> ${escapeHtml(plan.to_city)}</div>
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-label">Когда</div><div class="meta-value">${escapeHtml(formatDateTime(plan.desired_time))}</div></div>
        <div class="meta-item"><div class="meta-label">Нужно мест</div><div class="meta-value">${escapeHtml(String(plan.seats_needed))}</div></div>
        <div class="meta-item"><div class="meta-label">Бюджет</div><div class="meta-value">${escapeHtml(formatMoney(plan.price_per_seat || 0))}</div></div>
        <div class="meta-item"><div class="meta-label">Статус</div><div class="meta-value">${escapeHtml(badge.label)}</div></div>
      </div>
      ${plan.note ? `<div class="section-note">${escapeHtml(plan.note)}</div>` : ''}
      <div class="card-actions">
        ${options.take ? `<button class="button" type="button" data-action="take-plan" data-plan-id="${plan.id}">Забрать</button>` : ''}
        ${options.chat ? `<button class="ghost-button" type="button" data-action="${chatAction}" data-plan-id="${plan.id}">${chatLabel}</button>` : ''}
        ${options.cancel ? `<button class="danger-button" type="button" data-action="cancel-plan" data-plan-id="${plan.id}">Отменить заявку</button>` : ''}
      </div>
    </article>
  `;
}

function renderBookingCard(booking, options = {}) {
  const badge = statusBadge(booking.status);
  const driverName = formatName(booking.driver_first_name, booking.driver_last_name, booking.driver_username);
  return `
    <article class="ride-card" data-booking-id="${booking.id}">
      <div class="feed-topline">
        <div class="person-chip">
          <div class="avatar">${escapeHtml(getInitials(booking.driver_first_name, booking.driver_last_name, booking.driver_username))}</div>
          <div>
            <div class="person-name">${escapeHtml(driverName)}</div>
            <div class="person-meta">${escapeHtml(booking.driver_car_make || 'Водитель')}</div>
          </div>
        </div>
        <span class="badge ${badge.tone}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="route-line">${escapeHtml(booking.from_city)} <span>→</span> ${escapeHtml(booking.to_city)}</div>
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-label">Выезд</div><div class="meta-value">${escapeHtml(formatDateTime(booking.departure_time))}</div></div>
        <div class="meta-item"><div class="meta-label">Мест</div><div class="meta-value">${escapeHtml(String(booking.seats_booked))}</div></div>
        <div class="meta-item"><div class="meta-label">Стоимость</div><div class="meta-value">${escapeHtml(formatMoney(booking.amount_total))}</div></div>
        <div class="meta-item"><div class="meta-label">Статус</div><div class="meta-value">${escapeHtml(badge.label)}</div></div>
      </div>
      <div class="card-actions">
        <button class="ghost-button" type="button" data-action="chat-booking-driver" data-booking-id="${booking.id}">Чат</button>
        ${options.cancel ? `<button class="danger-button" type="button" data-action="cancel-booking" data-booking-id="${booking.id}">Отменить бронь</button>` : ''}
      </div>
    </article>
  `;
}

function renderDriverPassengerCard(booking) {
  return `
    <div class="mini-card" data-driver-booking-id="${booking.id}">
      <div class="mini-card__head">
        <div class="mini-card__title">${escapeHtml(formatName(booking.passenger_first_name, booking.passenger_last_name, booking.passenger_username))}</div>
        <span class="badge success">${escapeHtml(String(booking.seats_booked))} мест</span>
      </div>
      <div class="mini-card__meta">Неявок у пассажира: ${escapeHtml(String(booking.passenger_no_show_count || 0))}</div>
      <div class="block-actions">
        <button class="ghost-button" type="button" data-action="chat-driver-passenger" data-booking-id="${booking.id}">Чат</button>
        <button class="danger-button" type="button" data-action="mark-no-show" data-booking-id="${booking.id}">Не приехал</button>
      </div>
    </div>
  `;
}
function findTripById(tripId) {
  return [...state.data.feedTrips, ...state.data.historyDriverTrips].find((trip) => Number(trip.id) === Number(tripId));
}

function findPlanById(planId) {
  return [...state.data.feedPlans, ...state.data.historyPassengerPlans, ...state.data.historyTakenPlans, ...state.data.activeTakenPlans].find((plan) => Number(plan.id) === Number(planId));
}

function findBookingById(bookingId) {
  return [...state.data.activePassengerBookings, ...state.data.historyPassengerBookings].find((booking) => Number(booking.id) === Number(bookingId));
}

function renderFeed() {
  if (state.currentFeed === 'driver-trips') {
    refs.feedList.innerHTML = state.data.feedTrips.length
      ? state.data.feedTrips.map((trip) => renderDriverTripCard(trip, { booking: true })).join('')
      : emptyState('Сейчас нет доступных поездок. Создайте новую поездку или загляните чуть позже.');
  } else {
    refs.feedList.innerHTML = state.data.feedPlans.length
      ? state.data.feedPlans.map((plan) => renderPlanCard(plan, { take: true })).join('')
      : emptyState('Пассажирских заявок пока нет. Смените вкладку или создайте новую заявку через кнопку +.');
  }

  updateTabs();
  maybeHighlightPendingCard();
}

function renderActiveView() {
  refs.activeDriverTripList.innerHTML = state.data.activeDriverTrip
    ? renderDriverTripCard(state.data.activeDriverTrip, { allowCancel: true })
    : emptyState('У вас нет активной поездки как у водителя.');

  refs.activeDriverBookingsList.innerHTML = state.data.activeDriverBookings.length
    ? state.data.activeDriverBookings.map(renderDriverPassengerCard).join('')
    : emptyState('По активной поездке пока нет пассажиров.');

  refs.activePassengerBookingsList.innerHTML = state.data.activePassengerBookings.length
    ? state.data.activePassengerBookings.map((booking) => renderBookingCard(booking, { cancel: true })).join('')
    : emptyState('У вас нет активных бронирований как у пассажира.');

  refs.activeTakenPlansList.innerHTML = state.data.activeTakenPlans.length
    ? state.data.activeTakenPlans.map((plan) => renderPlanCard(plan, { chat: true, chatAction: 'chat-plan-passenger' })).join('')
    : emptyState('Вы пока не забирали заявки пассажиров.');
}

function renderHistoryView() {
  refs.historyDriverTripsList.innerHTML = state.data.historyDriverTrips.length
    ? state.data.historyDriverTrips.map((trip) => renderDriverTripCard(trip, { allowCancel: true })).join('')
    : emptyState('История поездок водителя пока пуста.');

  refs.historyPassengerBookingsList.innerHTML = state.data.historyPassengerBookings.length
    ? state.data.historyPassengerBookings.map((booking) => renderBookingCard(booking, { cancel: booking.status === 'booked' && isUpcoming(booking.departure_time) })).join('')
    : emptyState('История бронирований пассажира пока пуста.');

  refs.historyPassengerPlansList.innerHTML = state.data.historyPassengerPlans.length
    ? state.data.historyPassengerPlans.map((plan) => renderPlanCard(plan, { cancel: plan.status === 'active' && isUpcoming(plan.desired_time, 0), chat: !!plan.driver_username, chatAction: 'chat-plan-driver' })).join('')
    : emptyState('Вы ещё не создавали заявки пассажира.');

  refs.historyTakenPlansList.innerHTML = state.data.historyTakenPlans.length
    ? state.data.historyTakenPlans.map((plan) => renderPlanCard(plan, { chat: true, chatAction: 'chat-plan-passenger' })).join('')
    : emptyState('Вы ещё не забирали заявки пассажиров.');
}

async function loadFeed() {
  try {
    setStatus('');
    if (state.currentFeed === 'driver-trips') {
      const data = await apiRequest('/api/trips');
      state.data.feedTrips = data.trips || [];
    } else {
      if (!state.user) {
        state.data.feedPlans = [];
      } else {
        const data = await apiRequest(`/api/driver/passenger-plans?telegram_id=${encodeURIComponent(String(state.user.id))}`);
        state.data.feedPlans = data.plans || [];
      }
    }
    renderFeed();
  } catch (error) {
    refs.feedList.innerHTML = emptyState(error.message || 'Не удалось загрузить ленту.');
    setStatus(error.message || 'Не удалось загрузить ленту.', 'error');
  }
}

async function loadActiveView() {
  if (!state.user) {
    renderActiveView();
    return;
  }

  try {
    const [driverTripData, passengerBookingsData, takenPlansData] = await Promise.all([
      apiRequest(`/api/driver/active-trip?telegram_id=${encodeURIComponent(String(state.user.id))}`),
      apiRequest(`/api/passenger/active-bookings?telegram_id=${encodeURIComponent(String(state.user.id))}`),
      apiRequest(`/api/driver/taken-plans?telegram_id=${encodeURIComponent(String(state.user.id))}`),
    ]);

    state.data.activeDriverTrip = driverTripData.trip || null;
    state.data.activePassengerBookings = passengerBookingsData.bookings || [];
    state.data.activeTakenPlans = (takenPlansData.plans || []).filter((plan) => isUpcoming(plan.desired_time, 20));

    if (state.data.activeDriverTrip) {
      const driverBookingsData = await apiRequest(
        `/api/driver/trip-bookings?telegram_id=${encodeURIComponent(String(state.user.id))}&trip_id=${encodeURIComponent(String(state.data.activeDriverTrip.id))}`
      );
      state.data.activeDriverBookings = driverBookingsData.bookings || [];
    } else {
      state.data.activeDriverBookings = [];
    }

    renderActiveView();
  } catch (error) {
    setStatus(error.message || 'Не удалось загрузить активные поездки.', 'error');
  }
}

async function loadHistoryView() {
  if (!state.user) {
    renderHistoryView();
    return;
  }

  try {
    const [driverTripsData, passengerBookingsData, passengerPlansData, takenPlansData] = await Promise.all([
      apiRequest(`/api/driver/trips?telegram_id=${encodeURIComponent(String(state.user.id))}`),
      apiRequest(`/api/passenger/bookings?telegram_id=${encodeURIComponent(String(state.user.id))}`),
      apiRequest(`/api/passenger/plans?telegram_id=${encodeURIComponent(String(state.user.id))}`),
      apiRequest(`/api/driver/taken-plans?telegram_id=${encodeURIComponent(String(state.user.id))}`),
    ]);

    state.data.historyDriverTrips = driverTripsData.trips || [];
    state.data.historyPassengerBookings = passengerBookingsData.bookings || [];
    state.data.historyPassengerPlans = passengerPlansData.plans || [];
    state.data.historyTakenPlans = takenPlansData.plans || [];

    renderHistoryView();
  } catch (error) {
    setStatus(error.message || 'Не удалось загрузить историю.', 'error');
  }
}

async function refreshCurrentView() {
  if (state.currentView === 'feed') return loadFeed();
  if (state.currentView === 'active') return loadActiveView();
  return loadHistoryView();
}

function maybeHighlightPendingCard() {
  if (!state.pendingHighlight || state.currentView !== 'feed') return;

  const selector = state.pendingHighlight.type === 'trip'
    ? `[data-trip-id="${state.pendingHighlight.id}"]`
    : `[data-plan-id="${state.pendingHighlight.id}"]`;
  const element = document.querySelector(selector);
  if (!element) return;

  state.pendingHighlight = null;
  element.style.boxShadow = '0 0 0 4px rgba(31, 102, 214, 0.18), 0 14px 26px rgba(31, 102, 214, 0.16)';
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    element.style.boxShadow = '';
  }, 2400);
}

async function setFeed(feed, forceFeedView = true) {
  state.currentFeed = feed;
  if (forceFeedView) {
    state.currentView = 'feed';
    updateViews();
  }
  updateTabs();
  await loadFeed();
}

async function setView(view) {
  state.currentView = view;
  updateViews();
  closeDrawer();
  if (view === 'feed') await loadFeed();
  if (view === 'active') await loadActiveView();
  if (view === 'history') await loadHistoryView();
}

async function submitComposer(event) {
  event.preventDefault();

  if (!state.user) {
    showAlert('Откройте мини-приложение через Telegram.');
    return;
  }

  const payload = {
    from_city: refs.composerFrom.value.trim(),
    to_city: refs.composerTo.value.trim(),
    note: refs.composerNote.value.trim(),
  };

  if (state.currentFeed === 'driver-trips') {
    payload.departure_time = refs.composerDatetime.value;
    payload.seats_total = refs.composerSeats.value;
    payload.price_per_seat = refs.composerPrice.value;
  } else {
    payload.desired_time = refs.composerDatetime.value;
    payload.seats_needed = refs.composerSeats.value;
    payload.price_per_seat = refs.composerPrice.value;
  }

  try {
    refs.composerSubmit.disabled = true;
    await apiRequest(state.currentFeed === 'driver-trips' ? '/api/trips' : '/api/passenger/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    refs.composerForm.reset();
    closeComposer();
    setStatus(state.currentFeed === 'driver-trips' ? 'Поездка создана и уже появилась в ленте.' : 'Заявка создана и уже видна водителям.');
    await refreshCurrentView();
  } catch (error) {
    setStatus(error.message || 'Не удалось сохранить запись.', 'error');
  } finally {
    refs.composerSubmit.disabled = false;
  }
}

async function bookTrip(tripId) {
  const seats = state.seatSelection.get(Number(tripId)) || 1;
  await apiRequest('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip_id: Number(tripId), seats }),
  });
  setStatus('Бронь создана. Проверьте раздел «Мои активные поездки».');
  await Promise.all([loadFeed(), loadActiveView()]);
}

async function takePlan(planId) {
  await apiRequest('/api/driver/passenger-plans/take', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: Number(planId) }),
  });
  setStatus('Заявка забрана. Пассажир уже получил уведомление.');
  await Promise.all([loadFeed(), loadActiveView(), loadHistoryView()]);
}

async function cancelBooking(bookingId) {
  await apiRequest('/api/bookings/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: Number(bookingId) }),
  });
  setStatus('Бронь отменена.');
  await Promise.all([loadActiveView(), loadHistoryView(), loadFeed()]);
}

async function cancelTrip(tripId) {
  await apiRequest('/api/driver/delete-trip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip_id: Number(tripId) }),
  });
  setStatus('Поездка отменена.');
  await Promise.all([loadFeed(), loadActiveView(), loadHistoryView()]);
}

async function cancelPlan(planId) {
  await apiRequest('/api/passenger/plans/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: Number(planId) }),
  });
  setStatus('Заявка отменена.');
  await Promise.all([loadHistoryView(), loadFeed()]);
}

async function markNoShow(bookingId) {
  await apiRequest('/api/bookings/no-show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: Number(bookingId) }),
  });
  setStatus('Пассажир отмечен как не приехавший.');
  await loadActiveView();
}
function handleActionClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action } = target.dataset;

  if (action === 'seat-down' || action === 'seat-up') {
    const tripId = Number(target.dataset.tripId);
    const trip = findTripById(tripId);
    const current = state.seatSelection.get(tripId) || 1;
    const max = Number(target.dataset.max || trip?.seats_available || 1);
    const next = action === 'seat-up' ? Math.min(max, current + 1) : Math.max(1, current - 1);
    state.seatSelection.set(tripId, next);
    renderFeed();
    return;
  }

  Promise.resolve()
    .then(async () => {
      if (action === 'book-trip') return bookTrip(target.dataset.tripId);
      if (action === 'take-plan') return takePlan(target.dataset.planId);
      if (action === 'cancel-booking') return cancelBooking(target.dataset.bookingId);
      if (action === 'cancel-trip') return cancelTrip(target.dataset.tripId);
      if (action === 'cancel-plan') return cancelPlan(target.dataset.planId);
      if (action === 'mark-no-show') return markNoShow(target.dataset.bookingId);

      if (action === 'chat-plan-passenger') {
        const plan = findPlanById(target.dataset.planId);
        if (plan) openChat(plan.passenger_username, plan.passenger_telegram_id);
      }

      if (action === 'chat-plan-driver') {
        const plan = findPlanById(target.dataset.planId);
        if (plan) openChat(plan.driver_username, plan.driver_telegram_id);
      }

      if (action === 'chat-booking-driver') {
        const booking = findBookingById(target.dataset.bookingId);
        if (booking) openChat(booking.driver_username, booking.driver_telegram_id);
      }

      if (action === 'chat-driver-passenger') {
        const bookingId = Number(target.dataset.bookingId);
        const booking = state.data.activeDriverBookings.find((item) => Number(item.id) === bookingId);
        if (booking) openChat(booking.passenger_username, booking.passenger_telegram_id);
      }
    })
    .catch((error) => setStatus(error.message || 'Не удалось выполнить действие.', 'error'));
}

async function bootstrap() {
  state.pendingHighlight = parseStartAction(getStartParam());

  try {
    const initData = await initUser();
    state.user = initData.user || getTelegramUser();
    state.isOwner = !!initData.is_owner;
  } catch (error) {
    state.user = getTelegramUser();
    setStatus(error.message || 'Не удалось определить пользователя.', 'error');
  }

  updateUserCard();
  updateViews();

  const initialFeed = state.pendingHighlight?.feed || 'driver-trips';
  await setFeed(initialFeed, true);
}

refs.menuBtn.addEventListener('click', openDrawer);
refs.drawerBackdrop.addEventListener('click', closeDrawer);
refs.createBtn.addEventListener('click', openComposer);
refs.closeComposerBtn.addEventListener('click', closeComposer);
refs.sheetBackdrop.addEventListener('click', (event) => {
  if (event.target === refs.sheetBackdrop) closeComposer();
});
refs.feedDriverBtn.addEventListener('click', () => setFeed('driver-trips', true));
refs.feedPlansBtn.addEventListener('click', () => setFeed('passenger-requests', true));
refs.bottomSearchBtn.addEventListener('click', () => setView('feed'));
refs.bottomActiveBtn.addEventListener('click', () => setView('active'));
refs.composerForm.addEventListener('submit', submitComposer);
document.addEventListener('click', handleActionClick);

document.querySelectorAll('.drawer-link[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

refs.ownerDrawerItem?.addEventListener('click', () => {
  window.location.href = '/owner.html';
});

bootstrap();
