// Lightning Gifts — popup logic. Plain MV3 extension code: no frameworks, no remote code,
// one remote host (https://lightning.gifts), one credential (the user's own API key, stored locally).
const APP = "https://lightning.gifts";
const UA = "lightning-gifts-extension/1.0 (chrome)";

const $ = (id) => document.getElementById(id);
// popup.html runs in the extension context (chrome.storage) — but ALSO loads fine as a plain
// file:// page for screenshots/documentation, where a tiny in-memory shim keeps it usable.
// ?__demo=1 pre-seeds a dummy key so docs shots can show the form without touching any account.
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

const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
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

async function api(method, path, body, timeoutMs = 15_000) {
  const { key } = await storage.get(["key"]);
  // abort-guard: an unfed response must NEVER strand the UI at a status line
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
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
// session gifts — every gift this popup created, persisted so a payment or a
// claim-link mint is never lost to a popup close or a second create.
// v1.0.0/1.0.1 stored NOTHING: closing the popup mid-mint stranded the user at
// "Funded — minting…" forever even though the service had minted the claim token
// (incident 2026-11-10: the 133-sat gift). Store everything; heal on boot.
// One key ("gifts") holds the whole map — works with both storage backends above.
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

// per-gift pollers: every UNFUNDED session gift is watched in parallel (2s), so
// create-A -> pay-A -> create-B never orphans A's status. Each gift polls at most
// 45 reads (~90s) — matches the service's "one LNbits read per second per open
// UNFUNDED gift page is fine at this scale" cost rationale.
const pollers = new Map();

function watchGift(id) {
  if (pollers.has(id)) return;
  const started = Date.now();
  const t = setInterval(async () => {
    if (Date.now() - started > 90_000) {
      clearInterval(t); pollers.delete(id);
      renderGifts();
      return;
    }
    const g = await api("GET", `/api/gifts/${id}`);
    const status = g.json?.status;
    if (!status) return;
    const prev = (await getGifts())[id];
    if (prev && prev.status === status) return;
    await upsertGift(id, { status });
    if (status === "UNSEEN") {
      clearInterval(t); pollers.delete(id);
      await mintFor(id);
    } else if (status !== "UNFUNDED") {
      clearInterval(t); pollers.delete(id);
    }
    renderGifts();
  }, 2000);
  pollers.set(id, t);
}

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
    // abort/network error: null -> the caller's message + the idempotent retry on
    // the next popup open carry the recovery; the token may already be minted
    // server-side, and re-minting is the safe path in that world too.
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
      note.textContent = "paid — minting next time you open this popup, or now:";
      body.append(note);
      const retry = document.createElement("button");
      retry.className = "ghost small";
      retry.textContent = "Mint link now";
      retry.onclick = async () => {
        retry.disabled = true;
        const url = await mintFor(g.id);
        retry.textContent = url ? "minted ✓" : "failed — reopen later";
        retry.disabled = false;
        renderGifts();
      };
      body.append(retry);
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

// --- setup vs create screen ---
async function boot() {
  const { key } = await storage.get(["key"]);
  if (!key) { show("setup"); show("create-screen", false); return; }
  show("setup", false); show("create-screen");
  await renderGifts();
  for (const g of Object.values(await getGifts())) {
    if (g.status === "UNFUNDED") watchGift(g.id);
    if (g.status === "UNSEEN" && !g.claimUrl) await mintFor(g.id);
  }
  await renderGifts();
}

$("save-key").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (!key) { setErr("paste the key first"); return; }
  await storage.set({ key });
  setErr("");
  await boot();
});

// --- create -> fund -> mint ---
$("create").addEventListener("click", async () => {
  setErr(""); show("invoice-box", false); show("link-box", false); show("status", false);

  const amount = Math.floor(Number($("amount").value));
  if (!Number.isFinite(amount) || amount <= 0) { setErr("enter a whole number of sats"); return; }

  // preflight: is this deployment accepting money right now?
  const cap = await fetch(APP + "/api/payments-capability", { headers: { "User-Agent": UA } })
    .then((r) => r.json()).catch(() => null);
  if (cap && cap.canReceive === false) {
    setErr("Payments are paused on lightning.gifts right now (reason: " + (cap.reason || "unknown") +
      "). Ask the operator before funding a gift you can't pay.");
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
  if (created.status !== 200 || !created.json || !created.json.id) {
    // surface the service's own validation sentences (ceiling, invoice cap, kill switches)
    setErr(created.text?.slice(0, 300) || `Create failed (HTTP ${created.status})`);
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
  await renderGifts(gift.id);

  setStatus("Gift ", bold(gift.id.slice(0, 8) + "…"), " created for ",
    bold(gift.amount + " sats"), " (total ", bold(gift.amount + gift.fee + " sats"),
    ") — ", bold("waiting for your payment"));
  $("copy-invoice").onclick = () => copy(gift.invoice, "copied-invoice");

  // poll THIS gift while the popup is open; the session-hearted siblings keep polling
  // via their own watchGift pollers (started in boot), so a second create never
  // orphans an earlier one.
  const deadline = Date.now() + 25_000;
  const poll = setInterval(async () => {
    const g = await api("GET", `/api/gifts/${gift.id}`);
    const status = g.json?.status;
    if (status === "UNSEEN") {
      clearInterval(poll);
      // Edge can freeze popup pages when they appear idle: the fetch resolution
      // then never renders. So the mint attempt runs under a VISIBLE 15s countdown,
      // and its result is ALSO written to storage + rendered in the Earlier-gifts
      // row, guaranteeing a recoverable result no later than the 15s guard
      // (v1.0.4: the 88-sat "stuck 45s+" report).
      let secs = 15;
      const tick = setInterval(() => {
        setStatus("Funded — ", bold(`minting your one-time claim link… ${Math.max(secs, 0)}s`));
        if (secs-- <= 0) clearInterval(tick);
      }, 1000);
      const url = await mintFor(gift.id);
      clearInterval(tick);
      if (url) {
        $("claim").textContent = url;
        show("claim-box");
        $("copy-link").onclick = () => copy(url, "copied-link");
        setStatus("Done — hand over the ", bold("claim link"), " below.");
      } else {
        // 15s came and went (or an error folded to 0): the server may ALREADY have
        // minted. Show the persistent recoverable state instead of a spinner.
        show("claim-box");
        $("claim").textContent = "Your claim link couldn't be fetched right now — it is already on the server.";
        setStatus("Paid — ", bold("result not shown yet. "), "Press ", bold("Retry mint"),
          " below, or re-open the popup; the gift keeps its funds either way.");
      }
      $("create").disabled = false;
      const preRetry = document.getElementById("claim-retry");
      if (preRetry) preRetry.parentElement?.remove(); // remove MY retry row, keep #copy-link
      const retry = document.createElement("button");
      retry.id = "claim-retry";
      retry.className = "ghost small";
      retry.textContent = url ? "Copy link again" : "Retry mint";
      const doneHint = document.createElement("span");
      doneHint.className = "copied hidden";
      doneHint.textContent = "copied ✓";
      retry.onclick = async () => {
        if (url) { $("claim").textContent = url; $("copy-link").onclick = () => copy(url, "copied-link"); return copy(url, doneHint); }
        retry.disabled = true; retry.textContent = "Minting…";
        const again = await mintFor(gift.id);
        retry.disabled = false;
        if (again) {
          retry.textContent = "Copy link again";
          $("claim").textContent = again;
          $("copy-link").onclick = () => copy(again, "copied-link");
          return copy(again, doneHint);
        }
        retry.textContent = "Failed — retry";
      };
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(retry, doneHint);
      $("claim-box").append(actions);
      renderGifts(gift.id);
    } else if (status === "UNFUNDED" && Date.now() > deadline) {
      clearInterval(poll);
      $("create").disabled = false;
      setStatus("Still ", bold("UNFUNDED"), " — the invoice isn't paid yet. Check your wallet, then re-open the popup and mint once you've paid it. ",
        bold("Never pay the same invoice twice."));
    }
  }, 2000);
  pollers.set(gift.id, poll);
});

$("copy-invoice").onclick = () => copy($("invoice").textContent, "copied-invoice");
$("copy-link").onclick = () => copy($("claim").textContent, "copied-link");

boot();
