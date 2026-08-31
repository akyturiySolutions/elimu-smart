// js/install-prompt.js
//
// Handles "Add to Home Screen" for both platforms, which need genuinely
// different approaches:
//   - Android/Chrome/Edge: the browser fires 'beforeinstallprompt' and we
//     can trigger the native install dialog with one line of code.
//   - iOS Safari: Apple provides NO programmatic install API at all - there
//     is no event to listen for and no way to trigger it from JS. The only
//     option is a custom on-screen banner that tells the person to tap the
//     Share icon and choose "Add to Home Screen" themselves.
//
// Dismissal is remembered in localStorage for 14 days so the banner doesn't
// nag on every visit.

(function () {
  const DISMISS_KEY = 'elimuSmartInstallDismissedAt';
  const DISMISS_DAYS = 14;

  function wasDismissedRecently() {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const elapsedDays = (Date.now() - Number(raw)) / (1000 * 60 * 60 * 24);
    return elapsedDays < DISMISS_DAYS;
  }

  function markDismissed() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }

  function showBanner(message, buttonText, onButtonClick) {
    if (document.getElementById('installBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'installBanner';
    banner.innerHTML = `
      <span id="installBannerText">${message}</span>
      <span id="installBannerActions">
        ${buttonText ? `<button id="installBannerBtn">${buttonText}</button>` : ''}
        <button id="installBannerDismiss" aria-label="Dismiss">✕</button>
      </span>`;
    document.body.appendChild(banner);

    if (buttonText) {
      document.getElementById('installBannerBtn').addEventListener('click', onButtonClick);
    }
    document.getElementById('installBannerDismiss').addEventListener('click', () => {
      banner.remove();
      markDismissed();
    });
  }

  function init() {
    if (isStandalone() || wasDismissedRecently()) return;

    if (isIos()) {
      // No install event exists on iOS - show instructions directly.
      showBanner(
        'Install Elimu Smart: tap the Share icon, then "Add to Home Screen".',
        null,
        null
      );
      return;
    }

    // Android/Chrome/Edge path - wait for the browser to confirm the app
    // is actually installable before showing anything.
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      const deferredPrompt = event;
      showBanner('Install Elimu Smart on this device for quicker access.', 'Install', async () => {
        document.getElementById('installBanner')?.remove();
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
