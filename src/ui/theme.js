const STORAGE_KEY = 'arduino_theme_mode';

function readMode() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function createThemeController(button, onChange = () => {}, externalLabel = null) {
  let mode = readMode();

  function setMode(nextMode, persist = true, notify = true) {
    mode = nextMode === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.mode = mode;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // Private browsing can disable storage; the toggle still works in-memory.
      }
    }

    const dark = mode === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    const label = externalLabel || button.querySelector('.theme-toggle-text');
    if (label) label.textContent = dark ? 'Light theme' : 'Dark theme';
    if (notify) onChange(mode);
  }

  button.addEventListener('click', () => setMode(mode === 'dark' ? 'light' : 'dark'));
  setMode(mode, false, false);

  return {
    get mode() {
      return mode;
    },
    setMode,
  };
}
