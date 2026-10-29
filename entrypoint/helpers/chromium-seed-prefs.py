"""Seed a chromium profile's language (and HTTPS-First) prefs.

Usage: chromium-seed-prefs.py <profile>/Default/Preferences <lang>

navigator.language reads the languages from the profile, so a persisted
profile keeps the locale of its first run and the LANG env var alone cannot
retarget it (verified: seeding + LANG retargets a persisted profile to the
requested locale).
"""
import json, sys
path, lang = sys.argv[1], sys.argv[2]
langs = lang + "," + lang.split("-")[0]
try:
    prefs = json.load(open(path))
except Exception:
    prefs = {}
prefs.setdefault("intl", {})
prefs["intl"]["accept_languages"] = langs
prefs["intl"]["selected_languages"] = langs
# HTTPS-First balanced mode is switched by this PREF, not by the
# --disable-features switch: a profile that ran once without the flag
# persists "enabled": true, and every later start ignores the flag and
# hard-fails http navigations on hosts whose https is broken
# (net::ERR_BLOCKED_BY_CLIENT). Pin it off so an existing profile heals.
prefs["https_first_balanced_mode_enabled"] = False
prefs["https_only_mode_auto_enabled"] = False
json.dump(prefs, open(path, "w"))
