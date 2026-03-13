#!/usr/bin/env python3
"""
build.py — single source of truth for bhavyamittall.netlify.app

USAGE
  python3 /mnt/user-data/outputs/build.py

OUTPUT
  /mnt/user-data/outputs/index.html  ← deploy this to Netlify

EDITING GUIDE
  - Make ALL content, style, and JS changes to template.html
  - Never edit index.html directly
  - Run this script after any change to regenerate index.html
  - Drag index.html to Netlify deploys tab to publish

FILES
  template.html  — full site HTML with DATA_URI_PLACEHOLDER for favicon
  build.py       — this script (reads template, injects favicon, writes output)
  index.html     — generated output (do not edit directly)
"""

import base64, os, sys

UPLOADS = '/mnt/user-data/uploads'
OUTPUTS = '/mnt/user-data/outputs'

FAV_PATH      = os.path.join(UPLOADS, 'Favicon.png')
TEMPLATE_PATH = os.path.join(OUTPUTS, 'template.html')
OUTPUT_PATH   = os.path.join(OUTPUTS, 'index.html')

# --- load favicon ---
if not os.path.exists(FAV_PATH):
    sys.exit("ERROR: Favicon not found at " + FAV_PATH)
fav = base64.b64encode(open(FAV_PATH, 'rb').read()).decode()

# --- load template ---
if not os.path.exists(TEMPLATE_PATH):
    sys.exit("ERROR: template.html not found at " + TEMPLATE_PATH)
template = open(TEMPLATE_PATH, 'r').read()

# --- inject favicon ---
if 'DATA_URI_PLACEHOLDER' not in template:
    sys.exit("ERROR: DATA_URI_PLACEHOLDER not found in template.html")
html = template.replace('DATA_URI_PLACEHOLDER', fav)

# --- write output ---
with open(OUTPUT_PATH, 'w') as f:
    f.write(html)

# --- integrity checks ---
checks = [
    ('</html>',           'missing </html>'),
    ('</script>',         'missing </script>'),
    ('initQR',            'missing initQR function'),
    ('Noto Serif',        'missing Noto Serif font'),
    ('bhavyamittall',     'missing site URL'),
]
failed = []
for needle, msg in checks:
    if needle not in html:
        failed.append(msg)
if 'font-style: italic' in html:
    failed.append('italic style found (should be removed)')

if failed:
    print("WARNINGS:")
    for w in failed:
        print("  -", w)
else:
    print("OK — all checks passed")

print("index.html written (" + str(len(html)) + " bytes)")
