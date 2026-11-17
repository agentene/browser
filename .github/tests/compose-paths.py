#!/usr/bin/env python3
"""Compose must preserve unset, empty and custom web path overrides."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
VARIABLES = ("BROWSER_SUBPATH", "CONSOLE_SUBPATH")
CASES = [
    ("unset", None, {}, (None, None)),
    ("env file", {"BROWSER_SUBPATH": "/desk", "CONSOLE_SUBPATH": "/admin"}, {}, ("/desk", "/admin")),
    ("empty desktop in env file", {"BROWSER_SUBPATH": ""}, {}, ("", None)),
    ("empty console in env file", {"CONSOLE_SUBPATH": ""}, {}, (None, "")),
    ("shell", None, {"BROWSER_SUBPATH": "tools/desk///", "CONSOLE_SUBPATH": "/tools/admin/"}, ("tools/desk///", "/tools/admin/")),
    ("empty desktop in shell", None, {"BROWSER_SUBPATH": ""}, ("", None)),
    ("empty console in shell", None, {"CONSOLE_SUBPATH": ""}, (None, "")),
    ("shell overrides env file", {"BROWSER_SUBPATH": "/desk", "CONSOLE_SUBPATH": "/admin"},
     {"BROWSER_SUBPATH": "/remote", "CONSOLE_SUBPATH": ""}, ("/remote", "")),
]


def main():
    environment = {key: value for key, value in os.environ.items()
                   if key not in VARIABLES and not key.startswith("COMPOSE_")}
    with tempfile.TemporaryDirectory(prefix="compose-paths-") as temporary:
        directory = Path(temporary)
        for filename in ("compose.yaml", "compose.host.yaml"):
            shutil.copyfile(ROOT / filename, directory / filename)
        for host in (False, True):
            command = ["docker", "compose", "-p", "compose-paths", "-f", "compose.yaml"]
            if host:
                command += ["-f", "compose.host.yaml"]
            command += ["config", "--format", "json"]
            for label, file_values, shell_values, expected in CASES:
                env_file = directory / ".env"
                env_file.unlink(missing_ok=True)
                if file_values is not None:
                    env_file.write_text("".join(f"{key}={value}\n" for key, value in file_values.items()))
                configuration = json.loads(subprocess.check_output(
                    command, cwd=directory, env={**environment, **shell_values}, text=True))
                values = configuration["services"]["browser"]["environment"]
                actual = tuple(values.get(key) for key in VARIABLES)
                assert actual == expected, (label, host, actual, expected)
    print(f"Compose optional paths OK: {2 * len(CASES)} cases (bridge and host)", flush=True)


if __name__ == "__main__":
    main()
