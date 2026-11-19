#!/usr/bin/env python3
"""Verify bridge port mappings and host listeners use the three access ports."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
PORT_NAMES = ("HTTP_PORT", "HTTPS_PORT", "CDP_PORT")
DEFAULT_ACCESS = (8080, 8443, 9222)
BRIDGE_LISTENERS = (80, 443, 9222)
CUSTOM_ACCESS = (18080, 18443, 19222)
PORTS = dict(zip(PORT_NAMES, map(str, CUSTOM_ACCESS)))
CASES = [
    # label, .env values, shell values, expected access ports
    ("defaults", None, {}, DEFAULT_ACCESS),
    ("env file", PORTS, {}, CUSTOM_ACCESS),
    ("shell", None, PORTS, CUSTOM_ACCESS),
    ("empty env values", dict.fromkeys(PORT_NAMES, ""), {}, DEFAULT_ACCESS),
    ("empty shell overrides env file", PORTS, dict.fromkeys(PORT_NAMES, ""), DEFAULT_ACCESS),
    ("shell overrides one port", PORTS, {"CDP_PORT": "39222"}, (18080, 18443, 39222)),
    ("only HTTP configured", {"HTTP_PORT": "18080"}, {}, (18080, 8443, 9222)),
    ("HTTPS enabled without publishing overlay", {**PORTS, "ENABLE_HTTPS": "true"}, {},
     CUSTOM_ACCESS),
]


def main():
    variables = PORT_NAMES + ("ENABLE_HTTPS", "LISTEN_ADDR")
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
                for label, file_values, shell_values, access in CASES:
                    env_file = directory / ".env"
                    env_file.unlink(missing_ok=True)
                    if file_values is not None:
                        env_file.write_text("".join(f"{key}={value}\n" for key, value in file_values.items()))
                    configuration = json.loads(subprocess.check_output(
                        command, cwd=directory, env={**environment, **shell_values}, text=True))
                    service = configuration["services"]["browser"]
                    listeners = access if host else BRIDGE_LISTENERS
                    actual = tuple(int(service["environment"][key]) for key in PORT_NAMES)
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
    print(f"Compose ports OK: {4 * len(CASES)} cases (bridge/host, HTTP/HTTPS)", flush=True)


if __name__ == "__main__":
    main()
