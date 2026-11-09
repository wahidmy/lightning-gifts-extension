#!/usr/bin/env python3
"""Smoke test: exercise the EXACT request sequence popup.js makes against production.
Uses the same endpoints, same payload shape, same headers (key from env). No money moves
until a funding invoice is paid by a human, so this run creates + deletes an UNFUNDED gift.
"""
import json, os, sys, time, urllib.request, urllib.error

APP = "https://lightning.gifts"
KEY = os.environ["LIGHTNING_GIFTS_API_KEY"]


def call(method, path, body=None):
    req = urllib.request.Request(
        APP + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "User-Agent": "lightning-gifts-extension/1.0 (smoke-test)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


steps = []

# 0. preflight capability (popup does this before every create)
status, cap = call("GET", "/api/payments-capability")
steps.append(("preflight capability", status, cap if isinstance(cap, dict) else str(cap)[:120]))
if isinstance(cap, dict) and cap.get("canReceive") is False:
    print(json.dumps(steps, indent=2))
    sys.exit("payments paused on prod — aborting smoke test")

# 1. create (SKIP flow — what the popup does for a claim-link-only gift)
amount = 1000
expiry = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 30 * 86400))
status, gift = call("POST", "/api/gifts", {
    "amount": amount,
    "currency": "USD",
    "expiry": expiry,
    "onboardingFlow": "SKIP",
    "tippeeLocale": "en",
    "anonymousTipper": False,
    "generatePassphrase": False,
    "passphraseLength": 4,
    "note": "extension smoke test — safe to discard",
})
steps.append(("create SKIP gift", status, gift if isinstance(gift, dict) else str(gift)[:200]))

gid = gift.get("id") if isinstance(gift, dict) else None
if not gid:
    print(json.dumps(steps, indent=2))
    sys.exit("create failed — aborting")
steps.append(("invoice present", None, f"bolt11 prefix {str(gift.get('invoice'))[:28]}…"))
steps.append(("fee math", None, f"amount={gift.get('amount')} fee={gift.get('fee')} total={gift.get('amount', 0) + gift.get('fee', 0)}"))

# 2. fetch gift (popup polls until UNSEEN — here it must still be UNFUNDED pre-payment)
status, got = call("GET", f"/api/gifts/{gid}")
steps.append(("poll status", status, got.get("status") if isinstance(got, dict) else str(got)[:120]))

# 3. minting BEFORE funding must be refused (popup only mints after UNSEEN)
status, early = call("POST", f"/api/gifts/{gid}/claimToken", {})
steps.append(("pre-fund claimToken must be refused", status, str(early)[:140]))

# 4. delete the UNFUNDED trash gift (operator hygiene — returns the sats path to clean)
status, deleted = call("DELETE", f"/api/gifts/{gid}")
steps.append(("delete gift", status, str(deleted)[:80] if deleted else "<empty 204>"))

print(json.dumps(steps, indent=2, default=str))
