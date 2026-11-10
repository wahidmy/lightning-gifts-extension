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

async function api(method, path, body) {
  const { key } = await storage.get(["key"]);
  const res = await fetch(APP + path, {
    method,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text-only statuses */ }
  return { status: res.status, json, text };
}

async function copy(text, doneId) {
  await navigator.clipboard.writeText(text);
  show(doneId);
  setTimeout(() => show(doneId, false), 2400);
}

// --- setup vs create screen ---
async function boot() {
  const { key } = await storage.get(["key"]);
  if (!key) { show("setup"); show("create-screen", false); return; }
  show("setup", false); show("create-screen");
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
  const note = ($("note").value || "").trim();
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
  setStatus("Gift ", bold(gift.id.slice(0, 8) + "…"), " created for ",
    bold(gift.amount + " sats"), " (total ", bold(gift.amount + gift.fee + " sats"),
    ") — ", bold("waiting for your payment"));
  $("copy-invoice").onclick = () => copy(gift.invoice, "copied-invoice");

  // poll while the popup is open: UNFUNDED -> UNSEEN happens when LNbits settles
  const deadline = Date.now() + 25_000;
  const poll = setInterval(async () => {
    const g = await api("GET", `/api/gifts/${gift.id}`);
    const status = g.json?.status;
    if (status === "UNSEEN") {
      clearInterval(poll);
      setStatus("Funded — ", bold("minting your one-time claim link…"));
      const mint = await api("POST", `/api/gifts/${gift.id}/claimToken`, {});
      $("create").disabled = false;
      if (mint.status === 200 && mint.json?.claimUrl) {
        $("claim").textContent = mint.json.claimUrl;
        show("claim-box");
        $("copy-link").onclick = () => copy(mint.json.claimUrl, "copied-link");
        setStatus("Done — hand over the ", bold("claim link"), " below.");
      } else {
        setStatus("Funded — but minting failed (HTTP ", String(mint.status),
          "). Re-open the popup to mint again; the gift exists.");
      }
    } else if (status === "UNFUNDED" && Date.now() > deadline) {
      clearInterval(poll);
      $("create").disabled = false;
      setStatus("Still ", bold("UNFUNDED"), " — the invoice isn't paid yet. Check your wallet, then re-open the popup and mint once you've paid it. ",
        bold("Never pay the same invoice twice."));
    }
  }, 2000);
});

function totalStr(gift) { return `${gift.amount + gift.fee} sats`; }

$("copy-invoice").onclick = () => copy($("invoice").textContent, "copied-invoice");
$("copy-link").onclick = () => copy($("claim").textContent, "copied-link");

boot();
