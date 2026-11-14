// Starting a chromium the gateway talks to over its DevTools pipe — the
// main browser (main-browser.mjs) and every context's (contexts.mjs) alike.

import { spawn } from 'node:child_process';
import { BROWSER_LANGUAGE, CHROME_BIN } from './config.mjs';
import { CdpPipe } from './pipe.mjs';
import { prepareLanguage } from './profile.mjs';
import { rememberVersion } from './version.mjs';

const HIDE_WEBDRIVER = 'AutomationControlled';

// The command line: the flags as given, plus the pipe (pipe.mjs). Chromium
// counts a pipe-driven browser as automated and reports
// navigator.webdriver=true, which the browsers never did on their DevTools
// port — sites' risk control notices. Disabling the AutomationControlled
// blink feature keeps it false; merged into a --disable-blink-features the
// flags already carry (CHROMIUM_EXTRA_ARGS), since chromium honors only the
// last occurrence of a switch.
export function pipeArgs(flags) {
  const args = [...flags];
  const prefix = '--disable-blink-features=';
  let last = -1;
  args.forEach((arg, i) => { if (arg.startsWith(prefix)) last = i; });
  if (last < 0) {
    args.push(`${prefix}${HIDE_WEBDRIVER}`);
  } else {
    const features = args[last].slice(prefix.length).split(',').filter(Boolean);
    if (!features.includes(HIDE_WEBDRIVER)) args[last] = `${prefix}${[...features, HIDE_WEBDRIVER].join(',')}`;
  }
  args.push('--remote-debugging-pipe');
  return args;
}

// Spawns chromium with its DevTools pipe on fds 3 and 4; output (an open
// file stream) gets its stdout and stderr. Its own process group, so a kill
// of the group takes the renderers down too.
export function launchChromium(flags, output, label, env) {
  const proc = spawn(CHROME_BIN, pipeArgs(flags), {
    env,
    detached: true,
    stdio: ['ignore', output, output, 'pipe', 'pipe'],
  });
  const pipe = new CdpPipe(proc.stdio[3], proc.stdio[4], label);
  proc.once('exit', () => pipe.close());
  return { proc, pipe };
}

// Capture one language for both the profile and child environment. The gateway
// keeps its environment; each new browser process adopts the current setting.
export async function prepareBrowserLaunch(profile) {
  const language = BROWSER_LANGUAGE;
  await prepareLanguage(profile, language);
  const locale = `${language.replaceAll('-', '_')}.UTF-8`;
  return { ...process.env, LANG: locale, LC_ALL: locale };
}

// Resolves with Browser.getVersion (kept as pipe.version too) once chromium
// answers on its pipe; rejects when it exits, cannot be started, or does
// not answer in time.
export function browserReady(proc, pipe, timeout, logPath) {
  return new Promise((resolve, reject) => {
    const onExit = () => reject(new Error(`chromium exited during startup, see ${logPath}`));
    const onError = (err) => reject(new Error(`chromium could not be started: ${err.message}`));
    proc.once('exit', onExit);
    proc.once('error', onError);
    pipe.call('Browser.getVersion', {}, { timeout }).then((version) => {
      pipe.version = version;
      rememberVersion(version);
      resolve(version);
    }, (err) => {
      reject(new Error(`chromium did not answer on its DevTools pipe within ${timeout / 1000}s (${err.message}), see ${logPath}`));
    }).finally(() => {
      proc.off('exit', onExit);
      proc.off('error', onError);
    });
  });
}
