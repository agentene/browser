#!/usr/bin/env python3
"""Verify Compose access ports, legacy aliases and listener overrides."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
ACCESS = ("HTTP_PORT", "HTTPS_PORT", "CDP_PORT")
LEGACY = ("NGINX_HTTP_PORT", "NGINX_HTTPS_PORT")
LISTENERS = ("NGINX_LISTEN_HTTP_PORT", "NGINX_LISTEN_HTTPS_PORT", "CDP_LISTEN_PORT")
DEFAULT_ACCESS = (8080, 8443, 9222)
DEFAULT_LISTENERS = (80, 443, 9222)
CUSTOM_ACCESS = (18080, 18443, 19222)
CUSTOM_LISTENERS = (38080, 38443, 39222)
PORTS = dict(zip(ACCESS, map(str, CUSTOM_ACCESS)))
OLD_PORTS = dict(zip(LEGACY, ("28080", "28443")))
OVERRIDES = dict(zip(LISTENERS, map(str, CUSTOM_LISTENERS)))
CASES = [
    # label, .env values, shell values, expected access ports, listener overrides
    ("defaults", None, {}, DEFAULT_ACCESS, None),
    ("new names in env file", PORTS, {}, CUSTOM_ACCESS, None),
    ("new names in shell", None, PORTS, CUSTOM_ACCESS, None),
    ("legacy names in env file", OLD_PORTS, {}, (28080, 28443, 9222), None),
    ("legacy names in shell", None, OLD_PORTS, (28080, 28443, 9222), None),
    ("new names win", {**OLD_PORTS, **PORTS}, {}, CUSTOM_ACCESS, None),
    ("new env names beat legacy shell names", PORTS, OLD_PORTS, CUSTOM_ACCESS, None),
    ("shell overrides env file", PORTS, dict(zip(ACCESS, ("48080", "48443", "49222"))),
     (48080, 48443, 49222), None),
    ("empty new names use legacy", {**OLD_PORTS, **dict.fromkeys(ACCESS, "")}, {},
     (28080, 28443, 9222), None),
    ("empty names use defaults", dict.fromkeys(ACCESS + LEGACY, ""), {}, DEFAULT_ACCESS, None),
    ("mixed new and legacy names", {"HTTP_PORT": "18080", "NGINX_HTTPS_PORT": "28443"}, {},
     (18080, 28443, 9222), None),
    ("explicit listeners win", {**PORTS, **OLD_PORTS, **OVERRIDES}, {},
     CUSTOM_ACCESS, CUSTOM_LISTENERS),
    ("empty listeners use defaults", {**PORTS, **dict.fromkeys(LISTENERS, "")}, {},
     CUSTOM_ACCESS, None),
    ("HTTPS enabled without publishing overlay", {**PORTS, "ENABLE_HTTPS": "true"}, {},
     CUSTOM_ACCESS, None),
]


def main():
    variables = ACCESS + LEGACY + LISTENERS + ("ENABLE_HTTPS",)
    environment = {key: value for key, value in os.environ.items()
                   if key not in variables and not key.startswith("COMPOSE_")}
    with tempfile.TemporaryDirectory(prefix="compose-ports-") as temporary:
        directory = Path(temporary)
        for filename in ("compose.yaml", "compose.https.yaml", "compose.host.yaml"):
            shutil.copyfile(ROOT / filename, directory / filename)
        for host in (False, True):
            for https in (False, True):
                command = ["docker", "compose", "-p", "compose-ports", "-f", "compose.yaml"]
                if https:
                    command += ["-f", "compose.https.yaml"]
                if host:
                    command += ["-f", "compose.host.yaml"]
                command += ["config", "--format", "json"]
                for label, file_values, shell_values, access, overrides in CASES:
                    env_file = directory / ".env"
                    env_file.unlink(missing_ok=True)
                    if file_values is not None:
                        env_file.write_text("".join(f"{key}={value}\n" for key, value in file_values.items()))
                    configuration = json.loads(subprocess.check_output(
                        command, cwd=directory, env={**environment, **shell_values}, text=True))
                    service = configuration["services"]["browser"]
                    listeners = overrides or (access if host else DEFAULT_LISTENERS)
                    actual = tuple(int(service["environment"][key]) for key in LISTENERS)
                    context = (label, host, https)
                    assert actual == listeners, (context, actual, listeners)

                    published = {(str(port["published"]), port["target"])
                                 for port in service.get("ports", [])}
                    if host:
                        assert service["network_mode"] == "host", context
                        assert not published, (context, published)
                    else:
                        expected = {(str(access[0]), listeners[0]), (str(access[2]), listeners[2])}
                        if https:
                            expected.add((str(access[1]), listeners[1]))
                        assert published == expected, (context, published, expected)

                    configured = {**(file_values or {}), **shell_values}
                    expected_https = "true" if https else configured.get("ENABLE_HTTPS", "false")
                    assert service["environment"]["ENABLE_HTTPS"] == expected_https, context
    print(f"Compose ports OK: {4 * len(CASES)} cases (bridge/host, HTTP/HTTPS, aliases/overrides)", flush=True)


if __name__ == "__main__":
    main()
