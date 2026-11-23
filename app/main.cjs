const { app, BrowserWindow, components, session } = require('electron');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const pipe = process.argv.find(arg => arg.startsWith('--sol-protected-media-pipe='))?.split('=').at(1);
const store = process.argv.find(arg => arg.startsWith('--sol-protected-media-data='))?.slice('--sol-protected-media-data='.length);
// Sol sends each tab's service definition with "open" (integrations/protected_media_host.cpp
// kServices), so new services need no new helper package or VMP signature.
const hostPattern = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const controlKeys = ['toggle', 'previous', 'next', 'shuffle', 'repeat', 'progress', 'position', 'duration', 'title'];
function parseService(value) {
  if (!value || typeof value !== 'object') return null;
  const hosts = list => Array.isArray(list) && list.length <= 40 && list.every(host => typeof host === 'string' && hostPattern.test(host));
  const { id, players, signIn, iconHost, iconPath, media, seek, controls } = value;
  if (typeof id !== 'string' || !/^[a-z0-9]{1,24}$/.test(id) || !hosts(players) || !players.length || !hosts(signIn) ||
      typeof iconHost !== 'string' || !hostPattern.test(iconHost) || typeof iconPath !== 'string' || !/^\/[A-Za-z0-9/._-]*$/.test(iconPath) ||
      !['audio', 'video', 'audio, video'].includes(media) || typeof seek !== 'boolean' || !controls || typeof controls !== 'object' ||
      !Object.entries(controls).every(([key, test]) => controlKeys.includes(key) && typeof test === 'string' && /^[a-z0-9-]{1,60}$/.test(test)))
    return null;
  return { id, players: players.map(host => 'https://' + host), signIn: signIn.map(host => 'https://' + host),
    iconOrigin: 'https://' + iconHost, iconPath, media, seek, controls: { ...controls } };
}
if (!/^\\\\\.\\pipe\\sol-protected-media-[0-9a-f]{32}$/.test(pipe ?? '') || !store || !path.isAbsolute(store)) app.exit(2);
else start();

function webUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch {}
  return null;
}

// Sol sends its current bindings (Settings → Shortcuts) for the window-level
// actions and checks each returned action again, so a changed shortcut needs
// no new helper package.
let solKeys = [];

function readShortcuts(keys) {
  if (!Array.isArray(keys) || keys.length > 128) return null;
  const result = [];
  for (const key of keys) {
    if (!key || typeof key !== 'object' || typeof key.action !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(key.action) ||
        typeof key.code !== 'string' || !/^[A-Za-z0-9]{1,24}$/.test(key.code) ||
        typeof key.control !== 'boolean' || typeof key.shift !== 'boolean' || typeof key.alt !== 'boolean') return null;
    result.push({ action: key.action, code: key.code, control: key.control, shift: key.shift, alt: key.alt });
  }
  return result;
}

function solShortcut(input) {
  if (input.meta) return '';
  const key = solKeys.find(item => item.code === input.code && item.control === !!input.control &&
    item.shift === !!input.shift && item.alt === !!input.alt);
  return key ? key.action : '';
}

// Only the main process receives commands. This script runs in an isolated
// world of the one selected WebContents and receives a fixed action and number.
function media(origins, tag, controls, seek, nativePlaying, action, value) {
  if (!origins.includes(location.origin)) return null;
  const session = navigator.mediaSession;
  const metadata = session?.metadata;
  const candidates = Array.from(document.querySelectorAll(tag)).filter(item =>
    (item.currentSrc || item.srcObject) && !item.ended &&
    (!item.paused || (Number.isFinite(item.duration) && item.duration > 0)));
  const element = candidates.find(item => !item.paused) ?? candidates[0];
  const control = id => id && document.querySelector('[data-testid="' + id + '"]');
  const button = control(controls?.toggle);
  const enabled = target => target instanceof HTMLButtonElement && !target.disabled && target.getAttribute('aria-disabled') !== 'true';
  const previous = control(controls?.previous);
  const next = control(controls?.next);
  // Spotify's Smart Shuffle control can omit the test ID. It occupies the
  // button immediately before Previous in that same transport.
  const shuffleSlot = previous?.previousElementSibling;
  const shuffle = control(controls?.shuffle) ??
    (shuffleSlot?.matches('button') ? shuffleSlot : shuffleSlot?.querySelector('button'));
  const repeat = control(controls?.repeat);
  const progress = control(controls?.progress);
  const slider = progress?.querySelector('input[type="range"]');
  const sliderMax = Number(slider?.max);
  const canScrub = slider && !slider.disabled && slider.getAttribute('aria-disabled') !== 'true' &&
    Number.isFinite(sliderMax) && sliderMax > 0;
  const seconds = id => {
    const label = control(id)?.textContent?.trim();
    return /^\d+(?::\d{2}){1,2}$/.test(label ?? '')
      ? label.split(':').reduce((time, part) => time * 60 + Number(part), 0) : 0;
  };
  const playback = element ? !element.paused : session?.playbackState === 'playing' ||
    (session?.playbackState !== 'paused' && nativePlaying);
  const duration = sliderMax > 0 ? sliderMax / 1000 :
    element && Number.isFinite(element.duration) ? element.duration : seconds(controls?.duration);
  if (!element && (!button || button.disabled || (!playback && !metadata && !duration))) return null;
  const canSeek = seek && Boolean(progress ? canScrub : element?.seekable.length && duration > 0);
  const repeatState = () => {
    if (!enabled(repeat)) return undefined;
    const checked = repeat.getAttribute('aria-checked');
    return checked === 'mixed' ? 'one' : checked === 'true' ? 'all' : checked === 'false' ? 'off' : undefined;
  };
  const shuffleState = () => {
    if (!enabled(shuffle)) return undefined;
    const checked = shuffle.getAttribute('aria-checked') ?? shuffle.getAttribute('aria-pressed');
    return checked === null ? shuffle.classList.contains('encore-internal-color-text-bright-accent') : checked === 'true';
  };
  const state = () => ({
    title: String(metadata?.title?.trim() || control(controls?.title)?.textContent?.trim() || '').slice(0, 240),
    artist: String(metadata?.artist ?? '').slice(0, 240),
    playing: element ? !element.paused : playback,
    time: element?.currentTime ?? seconds(controls?.position), duration,
    seek: canSeek, previous: enabled(previous), next: enabled(next), shuffle: shuffleState(), repeat: repeatState()
  });
  const target = { previous, next, shuffle, repeat }[action];
  if (enabled(target)) {
    target.click();
    return state();
  }
  if (action === 'seek' && canSeek) {
    if (canScrub) {
      // Bypass React's value tracker and deliver the same input its accessible
      // range uses. Spotify commits the seek and enforces its own restrictions.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(slider, String(Math.min(sliderMax, Math.round(value * 1000))));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      element.currentTime = Math.min(value, duration);
    }
    return state();
  }
  if (!element) {
    if (action === 'toggle' || (action === 'pause' && playback)) button.click();
    return state();
  }
  if (action === 'toggle') {
    if (element.paused) return element.play().then(state);
    element.pause();
  } else if (action === 'pause') {
    element.pause();
  }
  return state();
}

function start() {
  // Chromium's native occlusion tracking treated this window, a child of a Sol
  // tab, as hidden after another window covered it, until the Sol window moved:
  // the page then took no focus. Sol hides the window itself on tab switches.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // Without Chrome's passkey autofill, Amazon's sign-in page opened the
  // Windows Security passkey dialog by itself. These tabs have no password
  // manager either, so sites see no WebAuthn and offer their password sign-in.
  app.commandLine.appendSwitch('disable-blink-features', 'WebAuth');
  // Windows labels this helper's audio and media sessions with the app name.
  app.setName('Sol');
  app.setAppUserModelId('Sol.Browser');
  app.enableSandbox();
  fs.mkdirSync(store, { recursive: true });
  app.setPath('userData', store);
  if (!app.requestSingleInstanceLock()) { app.exit(3); return; }
  // The Sol connection owns this process. Reuse it for all protected tabs.
  app.on('window-all-closed', () => {});
  const socket = net.createConnection(pipe);
  const tabs = new Map();
  const stores = new Map();
  let pending = '';
  let stopping = false;
  function send(message) {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  }
  function isLive(tab) {
    return !tab.closing && !tab.win.isDestroyed() && !tab.wc.isDestroyed();
  }
  function stopTabEvents(tab) {
    if (tab.closing) return;
    tab.closing = true;
    clearInterval(tab.timer);
    if (!tab.wc.isDestroyed()) tab.wc.off('audio-state-changed', tab.audioChanged);
  }
  function closeTab(tab) {
    stopTabEvents(tab);
    if (!tab.win.isDestroyed()) tab.win.destroy();
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => app.exit(), 3000);
    for (const tab of tabs.values()) closeTab(tab);
    await Promise.allSettled([...stores.values()].map(s => {
      s.flushStorageData();
      return s.cookies.flushStore();
    }));
    clearTimeout(timer);
    app.exit();
  }
  socket.on('error', () => void stop());
  socket.on('close', () => void stop());
  const ready = app.whenReady();
  const opening = new Set();
  let widevine;
  function serviceSession(service, profile) {
    const key = service.id + '-' + profile;
    if (stores.has(key)) return stores.get(key);
    const s = session.fromPartition('persist:' + key);
    const allow = (wc, permission, origin) =>
      permission === 'mediaKeySystem' && service.players.includes(webUrl(origin)?.origin) &&
      service.players.includes(webUrl(wc?.getURL())?.origin);
    s.setPermissionCheckHandler(allow);
    s.setPermissionRequestHandler((wc, permission, reply, details) => reply(allow(wc, permission, details.requestingUrl)));
    s.on('will-download', event => event.preventDefault());
    stores.set(key, s);
    return s;
  }
  function publishNavigation(tab) {
    if (!isLive(tab)) return;
    const { wc } = tab;
    const url = webUrl(wc.getURL());
    if (!url || !tab.allowed(url.href)) return;
    const publicUrl = tab.service.players.includes(url.origin) ? url.origin + url.pathname : url.origin + '/';
    send({ event: 'navigation', id: tab.id, url: publicUrl.slice(0, 4096),
      back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward() });
  }
  function publishAudio(tab) {
    if (!isLive(tab)) return;
    const { wc } = tab;
    const audible = wc.isCurrentlyAudible();
    const muted = wc.isAudioMuted();
    if (tab.audible === audible && tab.muted === muted) return;
    tab.audible = audible;
    tab.muted = muted;
    send({ event: 'audio', id: tab.id, audible, muted });
  }
  async function sample(tab, action = '', value = 0) {
    if (!isLive(tab) || !tab.documentReady || (!action && tab.sampling)) return;
    const { wc } = tab;
    const generation = tab.generation;
    const { players, media: tag, controls, seek } = tab.service;
    const onPlayer = () => players.includes(webUrl(wc.getURL())?.origin);
    const push = summary => {
      if (!isLive(tab) || tab.generation !== generation || !onPlayer()) return;
      send({ event: 'media', id: tab.id, state: summary ? { ...summary, muted: wc.isAudioMuted() } : null });
    };
    if (!onPlayer()) return;
    if (!action) tab.sampling = true;
    try {
      const args = [players, tag, controls, seek, Boolean(tab.playing || tab.audible), action, value];
      const code = '(' + media.toString() + ')(...' + JSON.stringify(args) + ')';
      push(await wc.executeJavaScriptInIsolatedWorld(103, [{ code }], ['toggle', 'previous', 'next'].includes(action)));
    } catch {
      // A document may have changed, or autoplay may reject play().
      if (action && isLive(tab)) send({ event: 'refresh', id: tab.id });
    } finally {
      if (!action && tab.generation === generation) tab.sampling = false;
    }
  }
  async function load(tab) {
    const attempt = ++tab.loadAttempt;
    const current = () => isLive(tab) && tab.loadAttempt === attempt;
    send({ event: 'loading', id: tab.id, active: true });
    let timeout;
    try {
      widevine ??= components.whenReady();
      await Promise.race([widevine, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Widevine initialization timed out')), 75000);
      })]);
      if (current()) await tab.win.loadURL(tab.url);
    } catch (error) {
      if (current() && !String(error).includes('ERR_ABORTED')) send({ event: 'failed', id: tab.id });
    } finally {
      clearTimeout(timeout);
    }
  }
  async function open({ id, profile, url, service: definition }) {
    const service = parseService(definition);
    // Sol shows a failed tab instead of one that keeps loading.
    if (!service || !service.players.includes(webUrl(url)?.origin)) { send({ event: 'failed', id }); return; }
    if (tabs.has(id) || opening.has(id) || !/^(default|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(profile)) return;
    opening.add(id);
    await ready;
    if (!opening.delete(id) || stopping) return;
    const win = new BrowserWindow({ show: false, frame: false, thickFrame: false, resizable: false,
      fullscreenable: false, skipTaskbar: true,
      webPreferences: { session: serviceSession(service, profile), sandbox: true, nodeIntegration: false, backgroundThrottling: false,
        contextIsolation: true, webSecurity: true, devTools: false, navigateOnDragDrop: false } });
    const allowed = value => {
      const origin = webUrl(value)?.origin;
      return service.players.includes(origin) || service.signIn.includes(origin);
    };
    const wc = win.webContents;
    const tab = { id, win, wc, service, allowed, url, generation: 0, loadAttempt: 0 };
    tabs.set(id, tab);
    win.removeMenu();
    // Keep the real Chromium version and select the desktop web player.
    wc.setUserAgent(wc.getUserAgent().replace(/ Electron\/[^ ]+/g, ''));
    // Links and popups that leave the service open as ordinary Sol tabs (Sol
    // checks the address and limits the rate); nothing else navigates this window.
    const leave = target => {
      try {
        const link = new URL(target);
        if ((link.protocol === 'https:' || link.protocol === 'http:') && !link.username && !link.password)
          send({ event: 'external', id, url: link.href.slice(0, 4096) });
      } catch {}
    };
    wc.setWindowOpenHandler(({ url: target }) => { leave(target); return { action: 'deny' }; });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('will-navigate', event => { if (!allowed(event.url)) { event.preventDefault(); leave(event.url); } });
    wc.on('will-redirect', event => { if (event.isMainFrame && !allowed(event.url)) { event.preventDefault(); leave(event.url); } });
    wc.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) {
        ++tab.generation;
        tab.documentReady = tab.sampling = tab.playing = false;
        send({ event: 'media', id, state: null });
      }
    });
    wc.on('did-navigate', () => publishNavigation(tab));
    wc.on('did-navigate-in-page', (_, _url, main) => { if (main) publishNavigation(tab); });
    wc.on('did-start-loading', () => send({ event: 'loading', id, active: true }));
    wc.on('did-stop-loading', () => send({ event: 'loading', id, active: false }));
    wc.on('dom-ready', () => { tab.documentReady = true; void sample(tab); });
    tab.audioChanged = () => publishAudio(tab);
    wc.on('audio-state-changed', tab.audioChanged);
    wc.once('destroyed', () => stopTabEvents(tab));
    wc.on('media-started-playing', () => { tab.playing = true; void sample(tab); });
    wc.on('media-paused', () => { tab.playing = false; void sample(tab); });
    wc.on('page-favicon-updated', (_, icons) => {
      if (!isLive(tab) || !service.players.includes(webUrl(wc.getURL())?.origin)) return;
      const icon = icons.map(webUrl).find(candidate => candidate?.origin === service.iconOrigin &&
        candidate.pathname.startsWith(service.iconPath) && /\.(png|ico)$/.test(candidate.pathname));
      if (icon) send({ event: 'favicon', id, url: icon.origin + icon.pathname });
    });
    wc.on('render-process-gone', () => send({ event: 'failed', id }));
    wc.on('before-mouse-event', (_, mouse) => {
      if (mouse.type !== 'mouseDown' || !isLive(tab)) return;
      if (!wc.isFocused()) { win.focus(); wc.focus(); }
      send({ event: 'pointer_down', id, at: Date.now() });
    });
    let suppressed;
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyUp' && input.code === suppressed) { suppressed = undefined; event.preventDefault(); }
      else if (input.type === 'keyDown') {
        const action = solShortcut(input);
        if (action) {
          suppressed = input.code;
          event.preventDefault();
          if (!input.isAutoRepeat) send({ event: 'shortcut', id, action });
        }
      }
    });
    tab.timer = setInterval(() => void sample(tab), 1000);
    win.on('closed', () => {
      stopTabEvents(tab);
      tabs.delete(id);
      send({ event: 'closed', id });
    });
    send({ event: 'window', id, handle: win.getNativeWindowHandle().readBigUInt64LE().toString() });
    void load(tab);
  }
  function dispatch(command) {
    const { id, action, value } = command;
    if (action === 'shortcuts') { solKeys = readShortcuts(command.keys) ?? solKeys; return; }
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (action === 'open') { void open(command).catch(() => send({ event: 'failed', id })); return; }
    if (action === 'close') opening.delete(id);
    const tab = tabs.get(id);
    if (!tab) return;
    if (action === 'close') { closeTab(tab); return; }
    if (!isLive(tab)) return;
    const { wc } = tab;
    if (action === 'attach') tab.win.showInactive();
    else if (action === 'focus' && tab.win.isVisible()) { tab.win.focus(); wc.focus(); }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') {
      if (tab.allowed(wc.getURL())) wc.reload();
      else void load(tab);
    } else if (action === 'stop') {
      ++tab.loadAttempt;
      wc.stop();
      send({ event: 'loading', id, active: false });
    }
    else if (action === 'mute' || action === 'set-muted') {
      wc.setAudioMuted(action === 'mute' ? !wc.isAudioMuted() : value === 1);
      publishAudio(tab);
      void sample(tab);
    } else if (['toggle', 'pause', 'previous', 'next', 'shuffle', 'repeat'].includes(action)) void sample(tab, action);
    else if (action === 'seek' && Number.isFinite(value) && value >= 0 && value <= 1e7) void sample(tab, action, value);
  }
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    if (pending.length > 32768) { socket.destroy(); return; }
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      try { dispatch(JSON.parse(line)); } catch {}
    }
  });
}
