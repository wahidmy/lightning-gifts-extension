// Lightning Gifts — popup logic. Plain MV3 extension code: no frameworks, no remote code,
// one remote host (https://lightning.gifts), one credential (the user's own API key, stored locally).
//
// v1.0.5 ARCHITECTURE: the popup is a VIEWER. A browser-action popup dies the moment it
// loses focus — which is exactly when the user switches to their wallet to pay — so popup
// death cannot own a payment watch. The service worker (background.js) + chrome.alarms
// drive all GET/mint network work and write results into the same "gifts" storage map;
// the popup re-renders that map. This ends the entire "stuck at waiting/minting" class
// (reports: 133-sat, 88-sat, 77-sat gifts, 2026-11-10).
const APP = "https://lightning.gifts";
const UA = "lightning-gifts-extension/1.0 (chrome)";

const $ = (id) => document.getElementById(id);
// popup.html also loads as a plain file:// page for screenshots/docs (?__demo=1),
// where a tiny in-memory shim keeps the UI usable without chrome APIs.
const IS_DOC_RENDER = !chrome?.storage?.local &&
  new URLSearchParams(location.search).get("__demo") === "1";
window.__demoKey = IS_DOC_RENDER;
const storage = chrome?.storage?.local ?? (IS_DOC_RENDER ? {
  data: { key: "demo-key-for-documentation-shots" },
  get: async (keys) => Object.fromEntries(keys.map((k) => [k, storage.data[k] ?? null])),
  set: async (obj) => { Object.assign(storage.data, obj); },
} : {
  data: {},
  get: async (keys) => Object.fromEntries(keys.map((k) => [k, storage.data[k] ?? null])),
  set: async (obj) => { Object.assign(storage.data, obj); },
});
if (IS_DOC_RENDER) {
  document.title = "Lightning Gifts (demo render)";
  addEventListener("DOMContentLoaded", () => {
    $("amount").value = "1000";
    $("note").value = "Happy birthday! Spend it well.";
    $("fee-line").textContent = "Fee ≈ 100 sats · total invoiced ≈ 1100 sats";
  });
}

const show = (id, on = true) => {
  // null-safe: a wrong id must degrade to "no-op", never throw mid-render and
  // freeze the rest of the branch (the v1.0.5 claim-box/link-box class of bug)
  const el = $(id);
  if (el) el.classList.toggle("hidden", !on);
};
const setErr = (msg) => { $("err").textContent = msg || ""; show("err", !!msg); };
// DOM-built, not innerHTML: parts are plain strings or {b:"bold text"}.
// (AMO linter rule: dynamic innerHTML = unsupported sanitized-value warning.)
const bold = (t) => ({ b: t });
const setStatus = (...parts) => {
  const holder = $("status");
  holder.replaceChildren(...parts.map((p) => {
    if (p && p.b) {
      const el = document.createElement("span");
      el.className = "st";
      el.textContent = p.b;
      return el;
    }
    return document.createTextNode(p === undefined || p === null ? "" : String(p));
  }));
  show("status", true);
};

// --- fee preview (mirrors the service's own math: 1% with a 100-sat floor) ---
function feeFor(amount) {
  const a = Math.floor(Number(amount));
  if (!Number.isFinite(a) || a <= 0) return null;
  const floor = Math.max(100, Math.ceil(a / 100));
  return Math.max(100, Math.ceil((a + floor) / 100));
}

$("amount").addEventListener("input", (e) => {
  const fee = feeFor(e.target.value);
  if (fee) $("fee-line").textContent = `Fee ≈ ${fee} sats · total invoiced ≈ ${Number(e.target.value) + fee} sats`;
});

async function api(method, path, body) {
  const { key } = await storage.get(["key"]);
  // abort-guard: an unfed response must NEVER strand the UI at a status line
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
    return { status: res.status, json, text };
  } catch (err) {
    // abort/network error normalised: callers branch on status (0 = no response)
    // — no promise escapes this layer, so no UI can be stranded on a dead await.
    return { status: 0, json: null, text: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function copy(text, done) {
  await navigator.clipboard.writeText(text);
  // `done` is either a DOM element id ("copied-invoice") or an element itself
  const el = typeof done === "string" ? document.getElementById(done) : done;
  if (el) el.classList.remove("hidden");
  setTimeout(() => el && el.classList.add("hidden"), 2400);
}

// ---------------------------------------------------------------------------
// session gifts — persisted, shared with the service worker via the "gifts" map
// ---------------------------------------------------------------------------
const GIFT_TTL_MS = 7 * 864e5; // prune session records after a week

async function upsertGift(id, patch) {
  const { gifts } = await storage.get(["gifts"]);
  const next = Object.assign({}, gifts, { [id]: Object.assign({}, gifts?.[id], patch) });
  await storage.set({ gifts: next });
  return next[id];
}

async function getGifts() {
  const { gifts } = await storage.get(["gifts"]);
  const now = Date.now();
  return Object.fromEntries(Object.entries(gifts ?? {}).filter(([, g]) =>
    (now - Date.parse(g.createdAt || 0)) < GIFT_TTL_MS));
}

const STATUS_CHIP = {
  UNFUNDED: "waiting for payment",
  UNSEEN: "paid — link ready",
  SEEN: "seen by recipient",
  CLAIMED: "claimed",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
  DELETED: "deleted",
};

async function mintFor(id) {
  const g = (await getGifts())[id];
  if (g?.claimUrl) return g.claimUrl;
  try {
    const mint = await api("POST", `/api/gifts/${id}/claimToken`, {});
    if (mint.status === 200 && mint.json?.claimUrl) {
      await upsertGift(id, { claimUrl: mint.json.claimUrl, mintedAt: new Date().toISOString() });
      return mint.json.claimUrl;
    }
  } catch {
    // api() never rejects since v1.0.3 (abort-guard folds to status 0); this catch is a
    // belt for anything storage unexpectedly throws. Recovery: the SW retries per alarm.
  }
  return null;
}

// row builder — DOM only (no innerHTML), textContent for anything API-fed
function giftRow(g, isCurrent) {
  const row = document.createElement("div");
  row.className = "gift-row";

  const head = document.createElement("div");
  head.className = "gift-head";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = STATUS_CHIP[g.status] ?? g.status;
  const meta = document.createElement("span");
  meta.className = "gift-meta";
  meta.textContent = `${g.amount} sats · ${String(g.createdAt).slice(0, 16).replace("T", " ")}Z` +
    (g.note ? ` · "${g.note}"` : "");
  head.append(chip, meta);

  const body = document.createElement("div");
  body.className = "gift-body";
  if (isCurrent) {
    const cur = document.createElement("span");
    cur.className = "gift-current";
    cur.textContent = "shown above";
    body.append(cur);
    row.append(head, body);
    return row;
  }
  if (g.status === "UNSEEN") {
    if (g.claimUrl) {
      const link = document.createElement("div");
      link.className = "gift-link";
      link.textContent = g.claimUrl;
      const btn = document.createElement("button");
      btn.className = "ghost small";
      btn.textContent = "Copy link";
      const done = document.createElement("span");
      done.className = "copied hidden";
      done.textContent = "copied ✓";
      btn.onclick = () => copy(g.claimUrl, done);
      body.append(link, btn, done);
    } else {
      const note = document.createElement("span");
      note.textContent = "paid — the service worker is minting your link";
      body.append(note);
    }
  } else if (g.status === "UNFUNDED") {
    const note = document.createElement("span");
    note.textContent = "invoice unpaid — the link is minted the moment the payment settles";
    body.append(note);
  } else {
    const note = document.createElement("span");
    note.textContent = "single-use link no longer minted";
    body.append(note);
  }
  row.append(head, body);
  return row;
}

async function renderGifts(currentId) {
  const map = await getGifts();
  const entries = Object.values(map).filter((g) => g.id && g.status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const others = entries.filter((g) => g.id !== currentId);
  $("gifts-list").replaceChildren(...others.map((g) => giftRow(g, false)));
  show("gifts-section", others.length > 0);
}

async function currentGift() {
  const entries = Object.values(await getGifts())
    .filter((g) => g.id && g.status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return entries[0] ?? null;
}

// --- setup vs create screen ---
let currentShownId = null;
async function showCurrentGift() {
  const g = await currentGift();
  if (!g) { show("invoice-box", false); return; }
  if (g.id !== currentShownId) {
    currentShownId = g.id;
    currentShownClearButtons();
    $("invoice").textContent = g.invoice ?? "";
    $("copy-invoice").onclick = () => copy(g.invoice ?? "", "copied-invoice");
  }
  if (g.status === "UNSEEN" && g.claimUrl) {
    $("claim").textContent = g.claimUrl;
    $("copy-link").onclick = () => copy(g.claimUrl, "copied-link");
    show("link-box");
    setStatus("Done — hand over the ", bold("claim link"), " below.");
    $("create").disabled = false;
  } else if (g.status === "UNSEEN") {
    setStatus("Paid — ", bold("the service worker is minting your link"), "; it appears here (and as a notification) within a minute.");
    $("create").disabled = false;
    ensureCheckPaymentButton(g.id, "Paid — waiting for the link… press Check payment now to fetch it immediately.");
  } else if (g.status === "UNFUNDED") {
    // the one state where the button re-arms by DESIGN: the user may want another gift
    // while the first sits unfunded (it stays listed in Earlier gifts, and the SW keeps
    // watching it) — with an explicit "Check payment now" rescue button.
    $("create").disabled = false;
    setStatus("Gift ", bold((g.id || "").slice(0, 8) + "…"), " still ", bold("UNFUNDED"),
      " — the background watcher checks every 30s; press ", bold("Check payment now"),
      " after you've paid. ", bold("Never pay the same invoice twice."));
    ensureCheckPaymentButton(g.id);
  }
  await renderGifts(g.id);
}

// removes MY dynamic buttons but never #copy-link / #copy-invoice
function currentShownClearButtons() {
  for (const id of ["claim-retry"]) {
    const el = document.getElementById(id);
    if (el) el.parentElement?.remove();
  }
}

// explicit user-gesture rescue: checks the flip and mints on the spot
function ensureCheckPaymentButton(giftId, heading = "Not paid yet — after you've paid, press Check payment now.") {
  const box = $("link-box");
  if (document.getElementById("claim-retry")) return;
  show("link-box");
  $("claim").textContent = heading;
  $("copy-link").onclick = () => copy($("claim").textContent, "copied-link");
  const retry = document.createElement("button");
  retry.id = "claim-retry";
  retry.className = "ghost small";
  retry.textContent = "Check payment now";
  const doneHint = document.createElement("span");
  doneHint.className = "copied hidden";
  doneHint.textContent = "copied ✓";
  retry.onclick = async () => {
    retry.disabled = true; retry.textContent = "Checking…";
    const fresh = await api("GET", `/api/gifts/${giftId}`);
    const status = fresh.json?.status;
    if (status === "UNSEEN") await upsertGift(giftId, { status });
    retry.disabled = false;
    if (status === "UNSEEN") {
      const url = await mintFor(giftId);
      if (url) {
        $("claim").textContent = url;
        $("copy-link").onclick = () => copy(url, "copied-link");
        retry.textContent = "Copy link again";
        return copy(url, doneHint);
      }
      retry.textContent = "Minting ran on the background — reopen to see the link";
      return;
    }
    retry.textContent = "Not paid yet — checking every 30s in the background";
  };
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(retry, doneHint);
  box.append(actions);
}

async function boot() {
  const { key } = await storage.get(["key"]);
  if (!key) { show("setup"); show("create-screen", false); return; }
  show("setup", false); show("create-screen");
  // the alarm may have been cleared by the SW (nothing to watch): re-arm cheaply.
  try { chrome.alarms.create("lgift-watch", { delayInMinutes: 0.5, periodInMinutes: 0.5 }); } catch { /* plain page */ }
  // a heal for UNSEEN-without-link on open: one chance here, then the alarm carries it
  for (const g of Object.values(await getGifts())) {
    if (g.status === "UNSEEN" && !g.claimUrl) await mintFor(g.id);
  }
  await showCurrentGift();
  // storage-driven render: the SW's writes arrive here even while an unfocused popup's
  // timers are throttled to once-per-minute; the event is instant, the interval is the
  // backup. An unfocused popup may still display stale content for seconds — clicking
  // inside the popup (any click) forces an immediate refresh.
  setInterval(showCurrentGift, 2000); // backup only
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.gifts) showCurrentGift();
    });
  }
  document.addEventListener("click", () => showCurrentGift());
}

$("save-key").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (!key) { setErr("paste the key first"); return; }
  await storage.set({ key });
  setErr("");
  await boot();
});

// --- create (storage-first; the SW owns everything after the POST) ---
let creating = false;
$("create").addEventListener("click", async () => {
  if (creating) return;
  creating = true;
  setErr(""); show("invoice-box", false); show("link-box", false); show("status", false);
  currentShownClearButtons();

  const amount = Math.floor(Number($("amount").value));
  if (!Number.isFinite(amount) || amount <= 0) { setErr("enter a whole number of sats"); creating = false; return; }

  // preflight: is this deployment accepting money right now?
  const cap = await api("GET", "/api/payments-capability");
  if (cap.json && cap.json.canReceive === false) {
    setErr("Payments are paused on lightning.gifts right now (reason: " + (cap.json.reason || "unknown") +
      "). Ask the operator before funding a gift you can't pay.");
    creating = false;
    return;
  }

  const note = ($("note").value || "").trim();
  const body = {
    amount,                                  // sats, always — currency below is display metadata
    currency: "USD",
    expiry: new Date(Date.now() + Number($("expiry").value) * 864e5).toISOString(),
    onboardingFlow: $("flow").value,         // SKIP = one-time link, no recipient account; DEFAULT = claim then onboard
    tippeeLocale: "en",
    anonymousTipper: false,
    generatePassphrase: false,               // the claim link is the handoff; /redeem passphrases stay for humans
    passphraseLength: 4,
  };
  if (note) body.note = note;

  $("create").disabled = true;
  setStatus(bold("Creating…"));

  const created = await api("POST", "/api/gifts", body);
  creating = false;
  if (created.status !== 200 || !created.json || !created.json.id) {
    // surface the service's own validation sentences (ceiling, invoice cap, kill switches)
    setErr(created.json?.message || created.text?.slice(0, 300) || `Create failed (HTTP ${created.status})`);
    $("create").disabled = false;
    show("status", false);
    return;
  }

  const gift = created.json;
  $("invoice").textContent = gift.invoice;
  show("invoice-box");

  await upsertGift(gift.id, {
    id: gift.id,
    amount: gift.amount,
    fee: gift.fee,
    invoice: gift.invoice,
    note,
    flow: body.onboardingFlow,
    createdAt: new Date(gift.created ?? Date.now()).toISOString(),
    status: "UNFUNDED",
    claimUrl: null,
  });

  // hand the watch to the service worker immediately: the popup may now be closed
  // at any moment (the user is about to open their wallet) without losing either
  // the flip or the mint.
  try { chrome.alarms.create("lgift-watch", { delayInMinutes: 0.5, periodInMinutes: 0.5 }); } catch { /* plain page */ }

  setStatus("Gift ", bold(gift.id.slice(0, 8) + "…"), " created for ",
    bold(gift.amount + " sats"), " (total ", bold(gift.amount + gift.fee + " sats"),
    ") — ", bold("pay the invoice; the background watcher runs either way"),
    ". The claim link appears here once it settles (click inside this popup if you return to it later) — ",
    bold("this popup may be left open or closed; the watcher is independent of it."),
    " ", bold("Never pay the same invoice twice."));
  $("copy-invoice").onclick = () => copy(gift.invoice, "copied-invoice");

  // disabled while THIS gift is the newest and UNFUNDED (the state you asked to gray
  // out). It re-arms by reopen — "Check payment now" carries the payment sync, and the
  // Earlier-gifts list keeps every previous gift visible meanwhile.
  $("create").disabled = true;
  currentShownId = gift.id;
  await renderGifts(gift.id);

  // a small storage tick so a payment that settles within the open window shows up
  // quickly; freeze-safe (storage reads only).
  const notWatch = setInterval(async () => {
    const g = (await getGifts())[gift.id];
    if (g && g.status === "UNSEEN") {
      clearInterval(notWatch);
      await showCurrentGift();
    }
  }, 2000);
});

$("copy-invoice").onclick = () => copy($("invoice").textContent, "copied-invoice");
$("copy-link").onclick = () => copy($("claim").textContent, "copied-link");

boot();
