import { apiRequest, getTelegramUser, initUser } from './shared/api.js';
import { escapeHtml, formatDateTime, formatName } from './shared/format.js';

const OWNER_STORAGE_KEY = 'poputchiki.owner.telegram_id';

const refs = {
  statusBanner: document.getElementById('ownerStatusBanner'),
  desktopAccessPanel: document.getElementById('desktopAccessPanel'),
  desktopAccessForm: document.getElementById('desktopAccessForm'),
  ownerTelegramIdInput: document.getElementById('ownerTelegramIdInput'),
  clearDesktopAccessBtn: document.getElementById('clearDesktopAccessBtn'),
  accessCard: document.getElementById('accessCard'),
  ownerContent: document.getElementById('ownerContent'),
  ownerName: document.getElementById('ownerName'),
  metricsGrid: document.getElementById('metricsGrid'),
  recentTripsList: document.getElementById('recentTripsList'),
  recentPlansList: document.getElementById('recentPlansList'),
  driversDate: document.getElementById('driversDate'),
  driversList: document.getElementById('driversList'),
  reloadDriversBtn: document.getElementById('reloadDriversBtn'),
};

const state = {
  user: null,
  isOwner: false,
  ownerTelegramId: '',
};

function setStatus(message = '', tone = '') {
  refs.statusBanner.textContent = message;
  refs.statusBanner.classList.toggle('hidden', !message);
  refs.statusBanner.classList.toggle('is-error', tone === 'error');
}

function getStoredOwnerTelegramId() {
  try {
    const params = new URL(window.location.href).searchParams;
    return params.get('telegram_id') || window.localStorage.getItem(OWNER_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function saveOwnerTelegramId(value) {
  try {
    if (value) {
      window.localStorage.setItem(OWNER_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(OWNER_STORAGE_KEY);
    }
  } catch (_) {}
}

function setOwnerLabel() {
  if (state.user) {
    refs.ownerName.textContent = formatName(state.user.first_name, state.user.last_name, state.user.username);
    return;
  }

  refs.ownerName.textContent = state.ownerTelegramId ? `ID ${state.ownerTelegramId}` : 'Владелец';
}

function setDesktopAccessVisible(visible) {
  refs.desktopAccessPanel.classList.toggle('hidden', !visible);
}

function setOwnerContentVisible(visible) {
  refs.ownerContent.classList.toggle('hidden', !visible);
}

function appendTelegramId(url, telegramId) {
  const nextUrl = new URL(url, window.location.origin);
  nextUrl.searchParams.set('telegram_id', telegramId);
  return nextUrl.pathname + nextUrl.search;
}

async function ownerRequest(url, options = {}) {
  const requestOptions = { ...options };
  const hasTelegramSession = !!window.Telegram?.WebApp?.initData;
  const desktopOwnerId = !hasTelegramSession ? String(state.ownerTelegramId || '').trim() : '';

  if (!desktopOwnerId) {
    return apiRequest(url, requestOptions);
  }

  const method = String(requestOptions.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return apiRequest(appendTelegramId(url, desktopOwnerId), requestOptions);
  }

  let body = {};
  if (requestOptions.body) {
    try {
      body = JSON.parse(requestOptions.body);
    } catch (_) {
      body = {};
    }
  }

  requestOptions.headers = { ...(requestOptions.headers || {}), 'Content-Type': 'application/json' };
  requestOptions.body = JSON.stringify({ ...body, telegram_id: desktopOwnerId });
  return apiRequest(url, requestOptions);
}

function metricCard(label, value, hint) {
  return `
    <article class="metric-card">
      <div class="metric-card__label">${escapeHtml(label)}</div>
      <div class="metric-card__value">${escapeHtml(String(value))}</div>
      <div class="metric-card__hint">${escapeHtml(hint)}</div>
    </article>
  `;
}

function renderOverview(stats) {
  refs.metricsGrid.innerHTML = [
    metricCard('Пользователи', stats.users_total || 0, `Заблокировано: ${stats.blocked_users_total || 0}`),
    metricCard('Всего поездок', stats.trips_total || 0, `Активных сейчас: ${stats.active_trips_total || 0}`),
    metricCard('Бронирования', stats.bookings_total || 0, `Активных сейчас: ${stats.active_bookings_total || 0}`),
    metricCard('Пассажирские заявки', stats.plans_total || 0, `Открытых: ${stats.active_plans_total || 0}`),
    metricCard('Сегодня поездок', stats.trips_today_total || 0, `Сегодня бронирований: ${stats.bookings_today_total || 0}`),
    metricCard('Сегодня заявок', stats.plans_today_total || 0, `Взято сегодня: ${stats.taken_plans_today_total || 0}`),
    metricCard('Водителей с поездками', stats.drivers_with_trips_total || 0, `Занятых мест: ${stats.booked_seats_total || 0}`),
    metricCard('Отзывы', stats.reviews_total || 0, `Взятых заявок: ${stats.taken_plans_total || 0}`),
  ].join('');
}

function renderRecentTrips(trips) {
  refs.recentTripsList.innerHTML = trips.length
    ? trips
        .map(
          (trip) => `
          <div class="owner-item">
            <div class="owner-item__title">${escapeHtml(trip.from_city)} → ${escapeHtml(trip.to_city)}</div>
            <div class="owner-item__meta">
              Время: ${escapeHtml(formatDateTime(trip.departure_time))}<br/>
              Водитель: ${escapeHtml(formatName(trip.driver_first_name, trip.driver_last_name, trip.driver_username))}<br/>
              Создано: ${escapeHtml(formatDateTime(trip.created_at))}
            </div>
          </div>
        `
        )
        .join('')
    : '<div class="empty-state">Свежих поездок пока нет.</div>';
}

function renderRecentPlans(plans) {
  refs.recentPlansList.innerHTML = plans.length
    ? plans
        .map(
          (plan) => `
          <div class="owner-item">
            <div class="owner-item__title">${escapeHtml(plan.from_city)} → ${escapeHtml(plan.to_city)}</div>
            <div class="owner-item__meta">
              Пассажир: ${escapeHtml(formatName(plan.passenger_first_name, plan.passenger_last_name, plan.passenger_username))}<br/>
              Время: ${escapeHtml(formatDateTime(plan.desired_time))}<br/>
              Статус: ${escapeHtml(plan.status || '—')}
            </div>
          </div>
        `
        )
        .join('')
    : '<div class="empty-state">Свежих заявок пока нет.</div>';
}

function renderDrivers(drivers) {
  refs.driversList.innerHTML = drivers.length
    ? drivers
        .map(
          (driver) => `
          <article class="report-row">
            <div class="report-row__head">
              <div>
                <div class="report-row__name">${escapeHtml(formatName(driver.first_name, driver.last_name, driver.username))}</div>
                <div class="muted small">${escapeHtml(driver.username ? '@' + driver.username.replace('@', '') : 'Без username')}</div>
              </div>
              <div class="filter-bar">
                <span class="badge ${driver.is_blocked ? 'danger' : 'success'}">${driver.is_blocked ? 'Заблокирован' : 'Активен'}</span>
                <button class="${driver.is_blocked ? 'ghost-button' : 'danger-button'}" type="button" data-action="toggle-driver-block" data-driver-tg="${escapeHtml(driver.telegram_id)}" data-block="${driver.is_blocked ? '0' : '1'}">
                  ${driver.is_blocked ? 'Разблокировать' : 'Заблокировать'}
                </button>
              </div>
            </div>
            <div class="report-row__stats">
              <div class="report-stat"><div class="report-stat__label">Создано поездок</div><div class="report-stat__value">${escapeHtml(String(driver.created_trips_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Предложено мест</div><div class="report-stat__value">${escapeHtml(String(driver.seats_offered_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Бронирований</div><div class="report-stat__value">${escapeHtml(String(driver.bookings_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Занято мест</div><div class="report-stat__value">${escapeHtml(String(driver.booked_seats_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Взято заявок</div><div class="report-stat__value">${escapeHtml(String(driver.taken_plans_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Мест в заявках</div><div class="report-stat__value">${escapeHtml(String(driver.taken_plan_seats_count || 0))}</div></div>
            </div>
          </article>
        `
        )
        .join('')
    : '<div class="empty-state">За выбранную дату активности водителей нет.</div>';
}

async function loadOverview() {
  const data = await ownerRequest('/api/owner/overview');
  renderOverview(data.stats || {});
  renderRecentTrips(data.recent_trips || []);
  renderRecentPlans(data.recent_plans || []);
}

async function loadDrivers() {
  const date = refs.driversDate.value;
  const url = date ? `/api/owner/drivers?date=${encodeURIComponent(date)}` : '/api/owner/drivers';
  const data = await ownerRequest(url);
  renderDrivers(data.drivers || []);
}

async function loadOwnerDashboard() {
  await Promise.all([loadOverview(), loadDrivers()]);
  setStatus('');
  refs.accessCard.classList.add('hidden');
  setDesktopAccessVisible(false);
  setOwnerContentVisible(true);
}

async function bootstrap() {
  refs.driversDate.value = new Date().toISOString().slice(0, 10);
  state.ownerTelegramId = getStoredOwnerTelegramId();
  refs.ownerTelegramIdInput.value = state.ownerTelegramId;

  try {
    const initData = await initUser();
    state.user = initData.user || getTelegramUser();
    state.isOwner = !!initData.is_owner;
  } catch (error) {
    state.user = getTelegramUser();
    if (state.user) {
      setStatus(error.message || 'Не удалось определить пользователя.', 'error');
    }
  }

  setOwnerLabel();

  if (state.isOwner) {
    setDesktopAccessVisible(false);
    setOwnerContentVisible(true);
    refs.accessCard.classList.add('hidden');
    try {
      await loadOwnerDashboard();
    } catch (error) {
      setStatus(error.message || 'Не удалось загрузить отчёты.', 'error');
    }
    return;
  }

  setOwnerContentVisible(false);
  setDesktopAccessVisible(true);

  if (state.user && !state.isOwner) {
    refs.accessCard.classList.remove('hidden');
  } else {
    refs.accessCard.classList.add('hidden');
  }

  if (state.ownerTelegramId) {
    try {
      await loadOwnerDashboard();
      state.isOwner = true;
    } catch (error) {
      refs.accessCard.classList.remove('hidden');
      setStatus(error.message || 'Не удалось открыть панель владельца.', 'error');
      setOwnerContentVisible(false);
      setDesktopAccessVisible(true);
    }
  }
}

refs.reloadDriversBtn.addEventListener('click', () => {
  loadDrivers().catch((error) => setStatus(error.message || 'Не удалось загрузить список водителей.', 'error'));
});

refs.desktopAccessForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.ownerTelegramId = refs.ownerTelegramIdInput.value.trim();
  saveOwnerTelegramId(state.ownerTelegramId);
  setOwnerLabel();
  loadOwnerDashboard()
    .then(() => {
      state.isOwner = true;
    })
    .catch((error) => {
      refs.accessCard.classList.remove('hidden');
      setStatus(error.message || 'Не удалось открыть панель владельца.', 'error');
      setOwnerContentVisible(false);
      setDesktopAccessVisible(true);
    });
});

refs.clearDesktopAccessBtn.addEventListener('click', () => {
  state.ownerTelegramId = '';
  refs.ownerTelegramIdInput.value = '';
  saveOwnerTelegramId('');
  setOwnerLabel();
  setOwnerContentVisible(false);
  setDesktopAccessVisible(true);
  refs.accessCard.classList.add('hidden');
  setStatus('');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="toggle-driver-block"]');
  if (!button) return;

  ownerRequest('/api/owner/block-driver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driver_telegram_id: button.dataset.driverTg,
      block: button.dataset.block === '1',
    }),
  })
    .then(() => {
      setStatus('Статус водителя обновлён.');
      return loadDrivers();
    })
    .catch((error) => setStatus(error.message || 'Не удалось обновить статус водителя.', 'error'));
});

bootstrap();
