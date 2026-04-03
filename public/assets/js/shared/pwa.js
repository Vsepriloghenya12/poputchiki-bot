import { apiRequest } from './api.js';

const state = {
  registration: null,
  installPromptEvent: null,
  installAvailable: false,
  pushSupported: false,
  pushEnabled: false,
  standalone: false,
};

const listeners = {
  install: new Set(),
  push: new Set(),
};

function emit(type) {
  const snapshot = { ...state };
  listeners[type].forEach((listener) => {
    try {
      listener(snapshot);
    } catch (_) {}
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(normalized);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

function detectStandaloneMode() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);
}

async function ensureRegistration() {
  if (!window.isSecureContext) {
    throw new Error('Для установки и push нужен HTTPS-домен или localhost');
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker не поддерживается в этом браузере');
  }

  if (state.registration) return state.registration;

  state.registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return state.registration;
}

async function refreshPushState() {
  state.standalone = detectStandaloneMode();
  state.pushSupported = Boolean(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);

  if (!state.pushSupported) {
    state.pushEnabled = false;
    emit('push');
    return state;
  }

  const registration = await ensureRegistration();
  const subscription = await registration.pushManager.getSubscription();
  state.pushEnabled = Boolean(subscription && Notification.permission === 'granted');
  emit('push');
  return state;
}

export async function initPwa({
  onInstallAvailabilityChange = null,
  onPushStateChange = null,
} = {}) {
  if (typeof onInstallAvailabilityChange === 'function') {
    listeners.install.add(onInstallAvailabilityChange);
  }
  if (typeof onPushStateChange === 'function') {
    listeners.push.add(onPushStateChange);
  }

  state.standalone = detectStandaloneMode();
  state.pushSupported = Boolean(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);

  if ('serviceWorker' in navigator) {
    await ensureRegistration().catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPromptEvent = event;
    state.installAvailable = true;
    state.standalone = detectStandaloneMode();
    emit('install');
  });

  window.addEventListener('appinstalled', () => {
    state.installPromptEvent = null;
    state.installAvailable = false;
    state.standalone = true;
    emit('install');
  });

  if (window.matchMedia) {
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const syncStandaloneState = () => {
      state.standalone = detectStandaloneMode();
      emit('install');
      emit('push');
    };

    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', syncStandaloneState);
    else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(syncStandaloneState);
  }

  emit('install');
  await refreshPushState().catch(() => {});
  return { ...state };
}

export async function promptInstall() {
  state.standalone = detectStandaloneMode();
  if (state.standalone) {
    emit('install');
    return { outcome: 'already-installed' };
  }

  if (!state.installPromptEvent) {
    return { outcome: 'manual' };
  }

  const event = state.installPromptEvent;
  state.installPromptEvent = null;
  state.installAvailable = false;
  emit('install');

  await event.prompt();
  const choice = await event.userChoice.catch(() => ({ outcome: 'dismissed' }));
  state.standalone = detectStandaloneMode();
  return choice || { outcome: 'dismissed' };
}

export async function enablePushNotifications() {
  const config = await apiRequest('/api/push/public-key');
  if (!config.enabled || !config.public_key) {
    throw new Error('Push-уведомления ещё не настроены на сервере');
  }

  state.pushSupported = Boolean(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  if (!state.pushSupported) {
    throw new Error('В этом браузере push-уведомления недоступны');
  }

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();

  if (permission !== 'granted') {
    throw new Error('Браузер не дал разрешение на уведомления');
  }

  const registration = await ensureRegistration();
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.public_key),
    });
  }

  await apiRequest('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      platform: navigator.userAgentData?.platform || navigator.platform || '',
    }),
  });

  state.pushEnabled = true;
  emit('push');
  return subscription;
}

export async function disablePushNotifications() {
  if (!('serviceWorker' in navigator)) {
    state.pushEnabled = false;
    emit('push');
    return;
  }

  const registration = await ensureRegistration();
  const subscription = await registration.pushManager.getSubscription();

  if (subscription?.endpoint) {
    await apiRequest('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => {});
  }

  if (subscription) {
    await subscription.unsubscribe().catch(() => {});
  }

  state.pushEnabled = false;
  emit('push');
}

export async function syncPwaState() {
  await refreshPushState();
  state.standalone = detectStandaloneMode();
  state.installAvailable = Boolean(state.installPromptEvent);
  emit('install');
  return { ...state };
}

export function getPwaState() {
  return { ...state };
}
