// Sleep Pins
// Schließt man einen angepinnten Tab, öffnet die Erweiterung ihn sofort an
// derselben Stelle wieder und legt ihn schlafen. Schlafende angepinnte Tabs
// werden beim Weiterspringen übersprungen, und nach einem Neustart kommen
// fehlende angepinnte Tabs zurück. Wirklich schließen: erst lösen.

const UNPIN_GRACE_MS = 1000; // Helium löst den Tab kurz vor dem Schließen
const AFTER_CLOSE_MS = 1000; // so lange gilt ein Tabwechsel als Folge des Schließens
const WOKE_GRACE_MS = 1500; // so lange zählt ein aufgewachter Tab noch als schlafend

// Zustand der Sitzung (Helium löscht ihn beim Beenden):
// pinned:    Tab-ID -> { url, windowId, index, unpinnedAt? }
// sleeping:  Tab-ID -> true (schläft) oder Zeitpunkt des Aufwachens
// lastClose: Fenster-ID -> Zeitpunkt des letzten Schließens
// ready:     true, sobald nach dem Start alles wiederhergestellt ist
// Dauerhaft in storage.local: saved = Adressen aller angepinnten Tabs.

// Alles läuft nacheinander, jeder Ablauf lädt den Zustand und speichert ihn am Ende.
let queue = Promise.resolve();
const withState = (fn) =>
  (queue = queue
    .then(async () => {
      const { state } = await chrome.storage.session.get("state");
      const s = state || { pinned: {}, sleeping: {}, lastClose: {}, ready: false };
      try {
        await fn(s);
      } finally {
        await chrome.storage.session.set({ state: s });
      }
    })
    .catch(console.error));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const urlOf = (t) => t.url || t.pendingUrl || "";
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

function isSleeping(s, tabId) {
  const v = s.sleeping[tabId];
  return v === true || (typeof v === "number" && Date.now() - v < WOKE_GRACE_MS);
}

// Direkt nach dem Schließen sperrt Chromium Tab-Änderungen kurz. Darum mehrmals versuchen.
async function retry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 20) throw err;
      await wait(150);
    }
  }
}

// Merkt sich alle angepinnten Tabs und speichert ihre Adressen dauerhaft.
// Eine leere Liste nur, wenn du selbst gelöst hast. Sonst würde das Schließen
// des letzten Fensters auf dem Mac die Liste löschen.
async function snapshot(s, { allowEmpty = false } = {}) {
  const tabs = (await chrome.tabs.query({ pinned: true }))
    .filter(urlOf)
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  for (const t of tabs) {
    s.pinned[t.id] = { url: urlOf(t), windowId: t.windowId, index: t.index };
    if (t.discarded || t.status === "unloaded") s.sleeping[t.id] = true;
  }
  if (s.ready && (tabs.length || allowEmpty)) {
    await chrome.storage.local.set({ saved: tabs.map(urlOf) });
  }
}

// Erst laden lassen (damit Icon und Titel da sind), dann schlafen legen.
function sleepWhenLoaded(tabId) {
  const done = () => {
    chrome.tabs.onUpdated.removeListener(listener);
    clearTimeout(timer);
    chrome.tabs.discard(tabId).catch(() => {});
  };
  const listener = (id, change) => id === tabId && change.status === "complete" && done();
  const timer = setTimeout(done, 15000);
  chrome.tabs.onUpdated.addListener(listener);
}

// Öffnet einen angepinnten Tab im Hintergrund. Er gilt sofort als schlafend,
// damit er beim Weiterspringen übersprungen wird.
async function openSleeping(s, props) {
  const tab = await retry(() => chrome.tabs.create({ ...props, pinned: true, active: false }));
  s.sleeping[tab.id] = true;
  sleepWhenLoaded(tab.id);
}

// Ist kurz nach einem Schließen ein schlafender angepinnter Tab aktiv geworden,
// weiter zum nächsten wachen Tab (erst rechts, dann links).
async function skipSleeping(s, windowId) {
  if (Date.now() - (s.lastClose[windowId] || 0) > AFTER_CLOSE_MS) return;
  const tabs = await chrome.tabs.query({ windowId });
  const active = tabs.find((t) => t.active);
  if (!active?.pinned || !isSleeping(s, active.id)) return;

  const awake = tabs.filter((t) => !(t.pinned && isSleeping(s, t.id)));
  const target =
    awake.find((t) => t.index > active.index) || awake.findLast((t) => t.index < active.index);
  if (!target) return;

  await retry(() => chrome.tabs.update(target.id, { active: true }));
  await chrome.tabs.discard(active.id).catch(() => {});
  s.sleeping[active.id] = true;
}

// Nach dem Start: warten, bis Helium seine Sitzung wiederhergestellt hat
// (Anzahl der Tabs 2 Sekunden lang gleich, höchstens 10 Sekunden).
async function waitForSessionRestore() {
  let last = -1;
  let stable = 0;
  for (let t = 0; t < 10000 && stable < 2000; t += 250) {
    const count = (await chrome.tabs.query({})).length;
    stable = count === last ? stable + 250 : 0;
    last = count;
    await wait(250);
  }
}

// Öffnet gespeicherte angepinnte Tabs, die fehlen. Offene werden nicht doppelt
// geöffnet: erst gleiche Adresse suchen, dann gleiche Seite (z. B. web.whatsapp.com).
async function restoreSaved(s, windowId) {
  const { saved = [] } = await chrome.storage.local.get("saved");
  if (!saved.length) return;
  if (windowId == null) {
    // Kein Fenster offen: windows.onCreated holt die Tabs, sobald eins aufgeht.
    if (!(await chrome.windows.getAll({ windowTypes: ["normal"] })).length) return;
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  }

  const tabs = await chrome.tabs.query({});
  const used = new Set();
  const take = (test) => {
    const tab = tabs.find((t) => !used.has(t.id) && test(t));
    if (tab) used.add(tab.id);
    return tab;
  };

  for (const url of saved) {
    if (
      take((t) => t.pinned && urlOf(t) === url) ||
      take((t) => t.pinned && originOf(urlOf(t)) === originOf(url))
    ) {
      continue;
    }
    try {
      // Helium stellt angepinnte Tabs manchmal als normale wieder her (#1013).
      const loose = take((t) => !t.pinned && t.windowId === windowId && urlOf(t) === url);
      if (loose) await retry(() => chrome.tabs.update(loose.id, { pinned: true }));
      else await openSleeping(s, { url, windowId });
    } catch (err) {
      console.error("Konnte nicht wiederherstellen:", url, err);
    }
  }
}

// Beim Start des Service Workers: Ist der Sitzungszustand leer, ist Helium gerade
// gestartet oder hat das Profil neu geladen. Letzteres passiert auf dem Mac, wenn
// man das letzte Fenster schließt und dann wieder eins öffnet. Dann kommt kein
// runtime.onStartup, und das neue Fenster ist schon offen, bevor die Erweiterung
// zuhört. Darum hier selbst wiederherstellen. Bereits offene Tabs werden nicht
// doppelt geöffnet, das gilt auch nach Installation oder Neuladen der Erweiterung.
withState(async (s) => {
  if (!s.ready) {
    await waitForSessionRestore();
    await restoreSaved(s);
    s.ready = true;
  }
  await snapshot(s);
});

// Neues Fenster, und nirgends ist ein angepinnter Tab offen (z. B. auf dem
// Mac nach dem Schließen des letzten Fensters): gespeicherte wieder öffnen.
chrome.windows.onCreated.addListener((win) => {
  if (win.type !== "normal") return;
  withState(async (s) => {
    if (!s.ready) return;
    await wait(500);
    if ((await chrome.tabs.query({ pinned: true })).length) return;
    await restoreSaved(s, win.id);
  });
});

chrome.tabs.onRemoved.addListener((tabId, info) =>
  withState(async (s) => {
    const entry = s.pinned[tabId];
    delete s.pinned[tabId];
    delete s.sleeping[tabId];
    if (info.isWindowClosing) return; // ganzes Fenster zu: nichts tun

    s.lastClose[info.windowId] = Date.now();
    await skipSleeping(s, info.windowId);

    // Von Hand gelöst und erst später geschlossen: nicht wiederherstellen.
    if (!entry || (entry.unpinnedAt && Date.now() - entry.unpinnedAt > UNPIN_GRACE_MS)) return;
    await openSleeping(s, { url: entry.url, windowId: entry.windowId, index: entry.index });
  })
);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  withState(async (s) => {
    await skipSleeping(s, windowId);
    // Bleibt der Tab aktiv, ist er jetzt wach.
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id === tabId && s.sleeping[tabId] === true) s.sleeping[tabId] = Date.now();
  })
);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.discarded === undefined && change.pinned === undefined && !change.url) return;
  withState(async (s) => {
    if (change.discarded !== undefined) s.sleeping[tabId] = change.discarded || Date.now();
    if (change.pinned === false) {
      // Nicht sofort vergessen, sondern die Zeit merken (siehe UNPIN_GRACE_MS).
      if (s.pinned[tabId]) s.pinned[tabId].unpinnedAt = Date.now();
      await snapshot(s, { allowEmpty: true });
    } else if (change.pinned || change.url) {
      await snapshot(s);
    }
  });
});

// Schlafen legen kann einem Tab eine neue ID geben.
chrome.tabs.onReplaced.addListener((addedId, removedId) =>
  withState(async (s) => {
    for (const map of [s.pinned, s.sleeping]) {
      if (removedId in map) {
        map[addedId] = map[removedId];
        delete map[removedId];
      }
    }
  })
);

for (const event of [chrome.tabs.onCreated, chrome.tabs.onMoved, chrome.tabs.onAttached]) {
  event.addListener(() => withState(snapshot));
}
