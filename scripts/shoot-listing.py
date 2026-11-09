#!/home/wahid/estateranger-book/venv/bin/python
"""Render popup.html states to CWS-sized screenshots (1280x800) via the venv's Playwright.
Runs the popup as a plain file:// page (chrome APIs absent -> the storage shim engages)."""
import sys, pathlib
from playwright.sync_api import sync_playwright

BASE = pathlib.Path("/home/wahid/lightning-gifts-extension")
SHOTS = BASE / "shots"
SHOTS.mkdir(exist_ok=True)

# simple centered-shell document for the CWS shot frame
shell = """<!doctype html><html><head><meta charset=utf-8><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:linear-gradient(160deg,#fffaf2 0%,#fdeede 100%);}
iframe{width:372px;height:560px;border:0;border-radius:18px;
box-shadow:0 12px 40px rgba(120,80,20,.18);}
</style></head><body><iframe id=f></iframe></body></html>"""
(BASE / "shots" / "shell.html").write_text(shell)

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path="/usr/bin/chromium",
        args=["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto("file://" + str(BASE / "shots" / "shell.html"))

    def load_popup(suffix, shot_name):
        page.evaluate(
            "s => document.getElementById('f').src = s",
            f"file://{BASE}/popup.html{suffix}",
        )
        page.wait_for_timeout(700)
        # hug content: measure the inner document height and size the iframe to it
        page.evaluate("""() => {
            const f = document.getElementById('f');
            const d = f.contentDocument;
            const h = Math.max(d.body.scrollHeight, 416);
            f.style.height = (h + 4) + 'px';
        }""")
        page.wait_for_timeout(150)
        page.screenshot(path=str(SHOTS / shot_name))
        print(f"{shot_name} rendered")

    load_popup("?__demo=0", "shot-1-connect.png")          # setup panel (no key)
    load_popup("?__demo=1", "shot-2-create-gift.png")      # filled form (demo key)
    browser.close()
print("sizes:", [(f.name, f.stat().st_size) for f in sorted(SHOTS.glob('shot-*.png'))])
