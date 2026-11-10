#!/usr/bin/env python3
"""Build the three store zips from the current tree.

Store divergence (established 2026-11-10, Edge Partner Center validation):
- Chrome CWS + Firefox AMO share ONE byte-identical zip: the dual background manifest
  (service_worker for Chromium, scripts fallback for Firefox) and the full short_name.
- Edge requires its OWN derived manifest: background.service_worker ONLY (Edge's MV3
  validator rejects background.scripts outright) and short_name <= 12 chars
  (Edge enforces the cap Chrome merely tolerates).

Usage: python3 scripts/build-zips.py            # builds dist/<store>-upload-<HEAD12>.zip
       python3 scripts/build-zips.py --head12 <12chars>   # pin the ledger suffix
"""
import json, os, shutil, subprocess, sys, tempfile, zipfile

REPO = os.path.dirname(os.path.abspath(__file__)) + "/.."
MEMBERS = ["manifest.json", "popup.html", "popup.js", "background.js",
           "icons/icon16.png", "icons/icon32.png", "icons/icon48.png",
           "icons/icon128.png", "LICENSE"]

EDGE_OVERRIDES = {
    "short_name": "Lightning",  # Edge: max 12 chars
    # background.scripts removed below (Edge MV3 validator rejects it)
}


def edge_manifest(base):
    m = json.loads(json.dumps(base))
    m.update(EDGE_OVERRIDES)
    m["background"] = {"service_worker": m["background"]["service_worker"]}
    return m


def build(store, manifest, out_dir):
    work = tempfile.mkdtemp(prefix=f"lgift-build-{store}-")
    try:
        for m in MEMBERS:
            dst = os.path.join(work, m)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(REPO, m), dst)
        json.dump(manifest, open(os.path.join(work, "manifest.json"), "w"), indent=2)
        out = os.path.join(REPO, "dist", f"{store}-upload-{HEAD12}.zip")
        if os.path.exists(out):
            os.remove(out)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for m in MEMBERS:
                z.write(os.path.join(work, m), m)
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    head12 = sys.argv[sys.argv.index("--head12") + 1] if "--head12" in sys.argv else \
        subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], cwd=REPO,
                       capture_output=True, text=True).stdout.strip()
    HEAD12 = head12
    base = json.load(open(os.path.join(REPO, "manifest.json")))
    outs = [
        build("cws", base, None),
        build("amo", base, None),
        build("edge", edge_manifest(base), None),
    ]
    print("built:")
    for o in outs:
        print(" ", o)
