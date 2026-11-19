#!/usr/bin/env python3
"""Verify listener defaults, IPv4/IPv6 formatting and host bindings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
PROBE = '''set -uo pipefail
. "$1/entrypoint/lib/common.sh"
. "$1/entrypoint/lib/config.sh"
config_nginx
printf '%s\\n' "$LISTEN_ADDR" "$LISTEN_PREFIX"
'''
WILDCARD = ("0.0.0.0", "0.0.0.0:")
LOOPBACK = ("127.0.0.1", "127.0.0.1:")
OTHER_LOOPBACK = ("127.0.0.2", "127.0.0.2:")
IPV6 = ("::1", "[::1]:")
STARTUP_CASES = [
    ("unset", {}, LOOPBACK),
    ("empty", {"LISTEN_ADDR": ""}, LOOPBACK),
    ("IPv4", {"LISTEN_ADDR": "127.0.0.2"}, OTHER_LOOPBACK),
    ("explicit wildcard", {"LISTEN_ADDR": "0.0.0.0"}, WILDCARD),
    ("IPv6", {"LISTEN_ADDR": "::1"}, IPV6),
    ("bracketed IPv6", {"LISTEN_ADDR": "[::1]"}, ("[::1]", "[::1]:")),
    ("invalid address", {"LISTEN_ADDR": "localhost"}, None),
]
COMPOSE_CASES = [
    # label, .env values, shell values, effective address and listener prefix
    ("unset", None, {}, LOOPBACK),
    ("empty env value", {"LISTEN_ADDR": ""}, {}, LOOPBACK),
    ("env file", {"LISTEN_ADDR": "127.0.0.2"}, {}, OTHER_LOOPBACK),
    ("explicit wildcard", {"LISTEN_ADDR": "0.0.0.0"}, {}, WILDCARD),
    ("shell", None, {"LISTEN_ADDR": "127.0.0.2"}, OTHER_LOOPBACK),
    ("shell overrides env file", {"LISTEN_ADDR": "127.0.0.1"}, {"LISTEN_ADDR": "127.0.0.2"}, OTHER_LOOPBACK),
    ("empty shell overrides env file", {"LISTEN_ADDR": "0.0.0.0"}, {"LISTEN_ADDR": ""}, LOOPBACK),
    ("IPv6", {"LISTEN_ADDR": "::1"}, {}, IPV6),
]


def check_startup(environment, expected, label):
    result = subprocess.run(["bash", "-c", PROBE, "listen-address", str(ROOT)],
                            env=environment, capture_output=True, text=True, check=False)
    if expected is None:
        assert result.returncode != 0 and "LISTEN_ADDR=" in result.stdout + result.stderr, (label, result)
    else:
        assert result.returncode == 0, (label, result.stderr, result.stdout)
        assert tuple(result.stdout.splitlines()) == expected, (label, result.stdout, expected)


def main():
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("LISTEN_ADDR", "ALLOWED_HOSTS", "PORT_FORWARDS")
                   and not key.startswith("COMPOSE_")}
    for label, values, expected in STARTUP_CASES:
        check_startup({**environment, **values}, expected, label)
    with tempfile.TemporaryDirectory(prefix="listen-address-") as temporary:
        directory = Path(temporary)
        for filename in ("compose.yaml", "compose.https.yaml", "compose.host.yaml"):
            shutil.copyfile(ROOT / filename, directory / filename)
        for host in (False, True):
            for https in (False, True):
                command = ["docker", "compose", "-p", "listen-address", "-f", "compose.yaml"]
                if https:
                    command += ["-f", "compose.https.yaml"]
                if host:
                    command += ["-f", "compose.host.yaml"]
                command += ["config", "--format", "json"]
                for label, file_values, shell_values, expected in COMPOSE_CASES:
                    env_file = directory / ".env"
                    env_file.unlink(missing_ok=True)
                    if file_values is not None:
                        env_file.write_text("".join(f"{key}={value}\n" for key, value in file_values.items()))
                    configuration = json.loads(subprocess.check_output(
                        command, cwd=directory, env={**environment, **shell_values}, text=True))
                    service = configuration["services"]["browser"]
                    context = (label, host, https)
                    address = service["environment"]["LISTEN_ADDR"]
                    check_startup({**environment, "LISTEN_ADDR": address}, expected if host else WILDCARD, context)
                    ports = service.get("ports", [])
                    if host:
                        assert not ports, (context, ports)
                    else:
                        assert len(ports) == (3 if https else 2), (context, ports)
                        assert all(port.get("host_ip") == expected[0] for port in ports), (context, ports, expected)
    print(f"Listener addresses OK: {len(STARTUP_CASES)} startup + {4 * len(COMPOSE_CASES)} Compose cases", flush=True)


if __name__ == "__main__":
    main()
