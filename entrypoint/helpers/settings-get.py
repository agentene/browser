"""settings-get.py <file> <section.key> <default> — print one of the settings
the CDP console persists (cdp-gateway/src/settings.mjs owns the file).

Booleans and numbers print as JSON (true/false), strings as they are. A
missing file or entry prints <default>; a file that is no JSON object warns
on stderr and prints <default> too. The caller validates the value.
"""
import json
import sys

path, key, default = sys.argv[1:4]
try:
    with open(path, encoding="utf-8") as f:
        value = json.load(f)
except FileNotFoundError:
    value = None
except (OSError, ValueError) as err:
    print(f"{path}: {err}; using the defaults", file=sys.stderr)
    value = None
for part in key.split("."):
    value = value.get(part) if isinstance(value, dict) else None
if value is None:
    print(default)
elif isinstance(value, str):
    print(value)
else:
    print(json.dumps(value))
