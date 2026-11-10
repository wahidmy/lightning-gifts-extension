// Lightning Gifts — service worker (MV3). The watcher that SURVIVES the popup closing.
//
// WHY THIS EXISTS: browser-action popups close the instant they lose focus — exactly the
// moment the user switches to their wallet to pay. Every "stuck" incident through v1.0.4
// traces to watching from inside a popup that was already dead. So the funding watch and
// the claim-link mint live HERE, woken by chrome.alarms, sharing the "gifts" map the
// popup keeps in chrome.storage.local. The popup renders whatever this writes.
const APP = "https://lightning.gifts";
const UA = "lightning-gifts-extension/1.0 (chrome)";
const GIFT_TTL_MS = 7 * 864e5;
const ALARM = "lgift-watch";

const claimUrlReady = (g) => g.claimUrl && g.status !== "DELETED";

async function upsertGift(id, patch) {
  const { gifts } = await chrome.storage.local.get(["gifts"]);
  const next = Object.assign({}, gifts, { [id]: Object.assign({}, gifts?.[id], patch) });
  await chrome.storage.local.set({ gifts: next });
  return next[id];
}

async function api(method, path, body) {
  const { key } = await chrome.storage.local.get(["key"]);
  if (!key) return { status: 0, json: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(APP + path, {
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text-only statuses */ }
    return { status: res.status, json, text: undefined };
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function liveGifts() {
  const { gifts } = await chrome.storage.local.get(["gifts"]);
  const now = Date.now();
  return Object.values(gifts ?? {}).filter((g) =>
    g && g.id && (now - Date.parse(g.createdAt || 0)) < GIFT_TTL_MS &&
    (g.status === "UNFUNDED" || (g.status === "UNSEEN" && !g.claimUrl)));
}

// one notification per minted link — registered ONCE at top level (never inside a loop)
chrome.notifications.onClicked.addListener(() => chrome.action.openPopup());

function notifyLink(gift, url) {
  try {
    chrome.notifications.create("link-" + gift.id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Your " + gift.amount + "-sat gift is ready",
      message: "The claim link for " + (gift.note ? '"' + gift.note + '"' : "your gift") + " is in the Lightning Gifts popup.",
      priority: 2,
    });
  } catch {
    // permission revoked or notifications unavailable: badge + popup still carry the link
  }
}

async function readyCount() {
  const { gifts } = await chrome.storage.local.get(["gifts"]);
  const now = Date.now();
  return Object.values(gifts ?? {}).filter((g) =>
    g && claimUrlReady(g) && (now - Date.parse(g.createdAt || 0)) < GIFT_TTL_MS).length;
}

async function pollTick() {
  const { key } = await chrome.storage.local.get(["key"]);
  if (!key) return; // not connected — the alarm keeps firing cheaply

  const live = await liveGifts();
  if (!live.length) {
    await chrome.alarms.clear(ALARM); // nothing to watch — save the wakeups
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  for (const g of live) {
    if (g.status === "UNFUNDED") {
      // one GET per live UNFUNDED gift per tick: the route's pollFundingStatus does the
      // UNFUNDED->UNSEEN flip as a side effect, same scale the app calls "fine".
      const fresh = await api("GET", `/api/gifts/${g.id}`);
      const status = fresh.json?.status;
      if (status && status !== g.status) await upsertGift(g.id, { status });
      if (status === "UNSEEN") g.status = "UNSEEN";
    }
    if (g.status === "UNSEEN" && !g.claimUrl) {
      const mint = await api("POST", `/api/gifts/${g.id}/claimToken`, {});
      if (mint.status === 200 && mint.json?.claimUrl) {
        await upsertGift(g.id, { claimUrl: mint.json.claimUrl, mintedAt: new Date().toISOString() });
        notifyLink(g, mint.json.claimUrl);
      }
      // a failed mint just stays UNSEEN-without-link; the next tick retries
      // (claimToken rate limit is 30/min per key — a 30s retry cannot hit it)
    }
  }

  const badge = await readyCount();
  await chrome.action.setBadgeText({ text: badge > 0 ? String(badge) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#ff8000" });

  if (!(await liveGifts()).length) await chrome.alarms.clear(ALARM);
}

// the alarm exists for the lifetime of any watchable gift; recreated on demand
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) pollTick();
});
