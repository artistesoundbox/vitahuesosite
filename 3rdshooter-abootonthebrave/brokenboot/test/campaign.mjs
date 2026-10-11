// Headless campaign harness for A Broken Boot On The Brave.
//
// Plays a scripted match through the game's own per-frame step in a real
// browser, then reports wave times, boot-tier timing and any errors, so a
// pacing change can be checked instead of played by hand.
//
//   node test/campaign.mjs                 full ten-wave run
//   node test/campaign.mjs --waves=3       quick pacing check
//   node test/campaign.mjs --headed        watch it play (debugging)
//   node test/campaign.mjs --baseline      compare against test/campaign-baseline.json
//   node test/campaign.mjs --record        write that baseline
//
// Needs a Chromium-based browser: $CHROME_PATH, or Chrome/Edge in the usual
// places. No npm dependencies — it talks to the browser over the DevTools
// protocol with Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');           // brokenboot/
const repoRoot = path.resolve(projectRoot, '..');       // the served root
const driverSource = fs.readFileSync(path.join(here, 'driver.js'), 'utf8');
const baselinePath = path.join(here, 'campaign-baseline.json');
const reportPath = path.join(here, 'campaign-report.json');

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const opts = {
    waves: 10,
    waveLimitSeconds: 150,
    maxSteps: 60000,
    timeoutSeconds: 420,
    seed: 20260411,
    baseline: false,
    record: false,
    honest: false,
    requireFinish: false,
    headed: false,
    keepOpen: false,
    quiet: false,
    url: null,
    port: null,
    noServer: false,
  };
  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    const num = Number(value);
    switch (flag) {
      case '--waves': opts.waves = num; break;
      case '--wave-limit': opts.waveLimitSeconds = num; break;
      case '--max-steps': opts.maxSteps = num; break;
      case '--timeout': opts.timeoutSeconds = num; break;
      case '--seed': opts.seed = num; break;
      case '--baseline': opts.baseline = true; break;
      case '--record': opts.record = true; break;
      case '--honest': opts.honest = true; break;
      case '--check-lock': opts.checkLock = true; break;
      case '--check-kick': opts.checkKick = true; break;
      case '--check-dry': opts.checkDry = true; break;
      case '--require-finish': opts.requireFinish = true; break;
      case '--headed': opts.headed = true; break;
      case '--keep-open': opts.keepOpen = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--url': opts.url = value; break;
      case '--port': opts.port = num; break;
      case '--no-server': opts.noServer = true; break;
      case '--help': case '-h': printUsage(); process.exit(0); break;
      default: console.error(`Unknown option: ${arg}`); printUsage(); process.exit(2);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node test/campaign.mjs [options]

  --waves=N        stop after N waves (default 10, the full campaign)
  --wave-limit=S   seconds without an elimination before a wave counts as stalled (default 150)
  --max-steps=N    hard cap on simulated frames (default 60000)
  --timeout=S      whole-run wall-clock budget (default 420)
  --seed=N         RNG seed, for a repeatable campaign (default 20260411, 0 = real random)
  --baseline       compare wave and tier timings against test/campaign-baseline.json
  --record         write the timings from this run to that baseline
  --honest         play the match for real: the officer can die, and the report says where
  --check-lock     assert the aim trigger rule (fresh press retargets, held keeps its
target) instead of playing the campaign
  --check-kick     assert the three kicks and the scenery they move (also instead of
the campaign; pass both to run both probes)
  --check-dry      play a whole wave with the officer's ammunition taken away, and
assert the boot alone can still end it
  --require-finish fail the run if the campaign did not reach the last wave
  --url=URL        page to load (default: served from this repo)
  --port=N         port for the bundled static server
  --no-server      use a server that is already running
  --headed         run the browser with a visible window
  --keep-open      leave the browser open when the run finishes
  --quiet          print the report only, not progress`);
}

const opts = parseArgs(process.argv.slice(2));
const log = (...args) => { if (!opts.quiet) console.log(...args); };

// ------------------------------------------------------------------ helpers

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROKENBOOT_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timed out';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never answered ${url}: ${lastError}`);
}

/** Minimal DevTools-protocol client over the built-in WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

// ------------------------------------------------------------------ main

let server = null;
let browser = null;
let profileDir = null;
let exitCode = 0;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No Chromium-based browser found. Set CHROME_PATH to chrome/msedge/chromium.');
    return 2;
  }

  // ---------------------------------------------------------------- static server
  let url = opts.url;
  if (!opts.noServer) {
    const port = opts.port || await freePort();
    server = spawn(process.execPath, [path.join(projectRoot, 'serve.mjs'), String(port)], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => log(`[server] ${String(d).trim()}`));
    const base = `http://127.0.0.1:${port}`;
    url = url || `${base}/brokenboot/index.html`;
    await waitForHttp(url, 15000);
    log(`server ready on ${base}`);
  }
  if (!url) { console.error('--no-server needs --url'); return 2; }

  // ---------------------------------------------------------------- browser
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brokenboot-campaign-'));
  const args = [
    opts.headed ? '--window-size=1280,720' : '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',   // software WebGL, so the renderer can start
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  browser = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('browser never reported a debugging endpoint')), 30000);
    browser.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      if (/DevTools listening on/i.test(buffer)) {
        // The port is only known once the browser prints its endpoint.
        const port = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
        if (port) {
          clearTimeout(timer);
          resolve({ port: Number(port) });
        }
      }
    });
    browser.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited early (code ${code})`)); });
  });

  // Connect to the page target rather than the browser target: one session does
  // everything this harness needs.
  const list = await (await fetch(`http://127.0.0.1:${wsUrl.port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target in the browser');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('failed to open the DevTools socket')), { once: true });
  });
  const cdp = new Cdp(ws);

  // ---------------------------------------------------------------- error capture
  const consoleErrors = [];
  const consoleWarnings = [];
  const seenErrors = new Set();
  const addError = (text) => {
    if (seenErrors.has(text)) return;
    seenErrors.add(text);
    consoleErrors.push(text);
  };
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    addError(`exception: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const text = (args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (type === 'error') addError(`console.error: ${text}`);
    else if (type === 'warning') consoleWarnings.push(`console.warn: ${text}`);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') addError(`log: ${entry.text}${entry.url ? ` <${entry.url}>` : ''}`);
  });
  // A missing asset shows up as a console 404 with no URL attached, so track the
  // responses too — otherwise the failure report cannot say what is missing.
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response.status >= 400) addError(`HTTP ${response.status} for ${response.url}`);
  });
  const failedRequests = [];
  const meaningful = new Set(['Script', 'Fetch', 'XHR', 'Document', 'Stylesheet']);
  cdp.on('Network.loadingFailed', ({ errorText, type }) => {
    if (meaningful.has(type)) failedRequests.push(`${type}: ${errorText}`);
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  // ---------------------------------------------------------------- boot the game
  log(`loading ${url}`);
  await cdp.send('Page.navigate', { url });

  const bootDeadline = Date.now() + 180000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'Boolean(window.__brokenBoot && document.getElementById("screen-start") && !document.getElementById("screen-start").classList.contains("hidden"))',
      returnByValue: true,
    });
    if (result.value === true) { booted = true; break; }
    const ready = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("load-text") ? document.getElementById("load-text").textContent : ""',
      returnByValue: true,
    });
    if (!opts.quiet) process.stdout.write(`\rwaiting for the forest… ${ready.result.value}`.padEnd(60));
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!booted) {
    console.error('\nThe game never reached the start screen.');
    for (const e of consoleErrors.slice(0, 10)) console.error(`  ${e}`);
    return 1;
  }
  log('\ngame loaded, playing the campaign');

  // ---------------------------------------------------------------- play it
  const expression = `(async () => { ${driverSource}\n; return await runCampaign(${JSON.stringify({
    waves: opts.waves,
    waveLimitSeconds: opts.waveLimitSeconds,
    maxSteps: opts.maxSteps,
    seed: opts.seed,
    instrument: opts.honest ? 'none' : 'alive',
    checkLock: opts.checkLock || false,
    checkKick: opts.checkKick || false,
    checkDry: opts.checkDry || false,
  })}); })()`;

  const startedAt = Date.now();
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: opts.timeoutSeconds * 1000,
  }, opts.timeoutSeconds * 1000 + 10000);

  if (exceptionDetails) {
    console.error(`\nThe campaign driver threw: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    return 1;
  }
  const report = result.value;
  if (!report || report.fatal) {
    console.error(`\nCampaign could not run: ${report ? report.fatal : 'no report returned'}`);
    return 1;
  }
  report.wallClockSeconds = +((Date.now() - startedAt) / 1000).toFixed(1);
  report.consoleErrors = consoleErrors;
  report.consoleWarnings = consoleWarnings;
  report.failedRequests = failedRequests;

  // ---------------------------------------------------------------- report
  const passed = assess(report);
  printReport(report, passed);

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nreport written to ${path.relative(process.cwd(), reportPath)}`);

  if (opts.record) {
    fs.writeFileSync(baselinePath, `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      seed: opts.seed,
      waves: report.waves.map((w) => ({ wave: w.wave, durationSeconds: w.durationSeconds })),
      tiers: report.tiers.map((t) => ({ tier: t.tier, atSeconds: t.atSeconds })),
    }, null, 2)}\n`);
    log(`baseline written to ${path.relative(process.cwd(), baselinePath)}`);
  }

  return passed.ok ? 0 : 1;
}

/** Everything that makes a run a failure, rather than an interesting number. */
function assess(report) {
  const reasons = [];
  const findings = [];

  // The probes are single assertions about one mechanic, not a campaign.
  if (report.lockCheck || report.kickCheck || report.dryCheck) {
    const l = report.lockCheck;
    const k = report.kickCheck;
    const d = report.dryCheck;
    if (d && !d.pass) {
      const bits = [];
      if (!d.cleared) {
        bits.push(`the wave never ended (${d.seconds}s of a ${d.limitSeconds}s limit, `
          + `${d.leftover.length} attacker(s) left: ${JSON.stringify(d.leftover)})`);
      }
      if (d.closedToBootRangeSeconds === null) bits.push('the dry officer never closed to boot range');
      if (d.eliminations === 0) bits.push('the dry officer eliminated nobody');
      if (d.bootEliminations !== d.eliminations) {
        bits.push(`only ${d.bootEliminations} of ${d.eliminations} elimination(s) were the boot, with no rounds`);
      }
      reasons.push(`the dry officer: ${bits.join('; ') || 'the probe did not pass'}`);
    }
    if (l && !l.pass) {
      reasons.push(`the aim trigger picked ${l.firstPress} on the first press (wanted near), `
        + `kept ${l.heldDuringSwing} while held (wanted near), then picked ${l.freshPress} on a fresh press (wanted far)`);
    }
    if (k && !k.pass) {
      const bits = [];
      if (k.selection.crouched !== 'sweep') bits.push(`crouching gives ${k.selection.crouched} instead of the sweep`);
      if (k.selection.airborne !== 'high') bits.push(`being in the air gives ${k.selection.airborne} instead of the high kick`);
      if (k.selection.standingStandardBoot !== 'kick') bits.push(`the standard boot stands with ${k.selection.standingStandardBoot}`);
      if (k.selection.standingTopBoot !== 'stomp') bits.push(`the top boot stands with ${k.selection.standingTopBoot}`);
      if (!k.profilesDiffer) bits.push('the three kicks do not differ in reach, arc and power');
      if (!(k.scenery.movedMeters > 1)) bits.push(`the kicked ${k.scenery.kind} moved only ${k.scenery.movedMeters}m`);
      if (!k.scenery.tumbled) bits.push(`the kicked ${k.scenery.kind} never tumbled`);
      if (!k.scenery.settled) bits.push(`the kicked ${k.scenery.kind} never came to rest (${k.scenery.settleSeconds}s)`);
      if (!(k.scenery.boxFollowed > 0.5)) bits.push('the moved scenery left its collision box behind');
      const f = k.feel || {};
      if (f.whiff && !(f.whiff.shake > 0)) bits.push('a kick into empty air did not even move the frame');
      if (f.whiff && (f.whiff.kickback !== 0 || f.whiff.hitStop !== 0 || f.whiff.roll !== 0)) {
        bits.push('a kick into empty air was felt as a connect');
      }
      if (f.body && !(f.body.shake > 0 && f.body.kickback > 0 && f.body.hitStop > 0 && f.body.roll !== 0)) {
        bits.push('a boot into a body was not felt');
      }
      if (f.feelScaledByMass === false) bits.push('the impact feel did not scale with the mass that was hit');
      if (f.rollFollowsSide === false) bits.push('the frame roll did not lean away from the impact');
      if (f.openSightline === false) bits.push('no open sightline could be found to measure the kickback through');
      if (f.cameraPushBack !== undefined && !(f.cameraPushBack > 0.02)) bits.push(`the camera was not shoved back (${f.cameraPushBack}m)`);
      if (f.frameRollDegrees !== undefined && !(f.frameRollDegrees > 1)) bits.push(`the frame did not roll (${f.frameRollDegrees}°)`);
      if (f.stopFrames !== undefined && !(f.stopFrames >= 2 && f.stopFrames <= 12)) bits.push(`the hit-stop froze time for ${f.stopFrames} frame(s)`);
      if (f.edgeFlashOpacity !== undefined && !(f.edgeFlashOpacity > 0.5)) bits.push('the screen edge never lit up on a heavy connect');
      reasons.push(`kicks and scenery: ${bits.join('; ') || 'the probe did not pass'}`);
    }
    if (report.failedRequests?.length) reasons.push(`${report.failedRequests.length} failed request(s): ${report.failedRequests[0]}`);
    return { ok: reasons.length === 0, reasons, findings, good: [], baselineDelta: null, errors: [] };
  }
  const errors = [...(report.errors || []), ...(report.consoleErrors || [])];
  if (errors.length) reasons.push(`${errors.length} error(s): ${errors[0]}`);
  if (report.stalledWave) reasons.push(`wave ${report.stalledWave.wave} stalled for ${report.stalledWave.stalledFor}s with ${report.stalledWave.hostiles} attacker(s) left`);

  if (!(report.waves || []).length) reasons.push('no waves completed');
  if (report.outcome === 'step-cap') reasons.push('the frame cap was reached before the campaign ended');

  // Dying is a difficulty datapoint rather than a defect, unless the run was
  // asked to finish the campaign. Either way the unreached waves are noted.
  const killed = report.outcome === 'death';
  const victory = report.outcome === 'victory';
  if (victory) {
    findings.push(`the campaign was cleared in ${report.gameSeconds}s with ${report.eliminations} elimination(s)`);
  } else if (killed) {
    const line = `the officer was killed in wave ${report.wavesReached} after ${report.gameSeconds}s, with ${report.eliminations} elimination(s)`;
    if (opts.requireFinish) reasons.push(line); else findings.push(line);
  } else if (report.outcome === 'over') {
    reasons.push('the run ended without the game reporting a victory or a death');
  }

  // A wave row that closed with the harness still running never handed over.
  // A death or a victory explains the last one, so it is context there.
  for (const w of report.waves || []) {
    if (!w.closedByHarness) continue;
    const line = `wave ${w.wave} never finished (${w.durationSeconds}s, ${w.eliminations} elimination(s))`;
    if (killed || victory) findings.push(line); else reasons.push(line);
  }
  if (!killed && !victory && report.wavesReached <= opts.waves && !report.stalledWave) {
    findings.push(`stopped in wave ${report.wavesReached} (${report.outcome})`);
  }

  // A wave that sags — one attacker unreachable, or the line hiding too long —
  // shows up as a long quiet stretch rather than a hard stall.
  for (const w of report.waves || []) {
    if (!w.closedByHarness && w.longestGapSeconds > 60) {
      findings.push(`wave ${w.wave} went ${w.longestGapSeconds}s with no elimination (it took ${w.durationSeconds}s overall)`);
    }
  }

  if (report.failedRequests?.length) reasons.push(`${report.failedRequests.length} failed request(s): ${report.failedRequests[0]}`);

  // Optional pacing gate: only compare when a baseline has been recorded.
  let baselineDelta = null;
  if (opts.baseline && fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    baselineDelta = [];
    for (const w of report.waves || []) {
      const was = baseline.waves?.find((b) => b.wave === w.wave);
      if (!was) continue;
      const change = +(((w.durationSeconds - was.durationSeconds) / Math.max(1, was.durationSeconds)) * 100).toFixed(1);
      baselineDelta.push({ wave: w.wave, wasSeconds: was.durationSeconds, nowSeconds: w.durationSeconds, changePercent: change });
      if (Math.abs(change) > 40) reasons.push(`wave ${w.wave} pacing moved ${change}% (${was.durationSeconds}s → ${w.durationSeconds}s)`);
    }
  }

  return { ok: reasons.length === 0, reasons, findings, baselineDelta, errors };
}

function printReport(report, passed) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');

  // The mechanic probes: one assertion each, no campaign.
  if (report.lockCheck || report.kickCheck || report.dryCheck) {
    const c = report.lockCheck;
    const k = report.kickCheck;
    const d = report.dryCheck;
    if (c) {
      console.log('Aim trigger (left trigger / right mouse / Q)');
      console.log(`  lock cone ${c.cone} rad, probe attackers: near ${c.anglesRadians?.near} rad off the crosshair, far ${c.anglesRadians?.far}`);
      console.log(`  ${pad('fresh press', 18)}${pad(c.firstPress, 8)}${c.firstPress === 'near' ? 'the attacker nearest the crosshair' : 'WRONG'}`);
      console.log(`  ${pad('held, aim swung', 18)}${pad(c.heldDuringSwing, 8)}${c.heldDuringSwing === 'near' ? 'keeps its target, no flicking' : 'WRONG'}`);
      console.log(`  ${pad('fresh press again', 18)}${pad(c.freshPress, 8)}${c.freshPress === 'far' ? 'retargets to the new nearest' : 'WRONG'}`);
      if (c.detail) console.log(`  ${c.detail}`);
    }
    if (k) {
      if (c) console.log('');
      console.log('Kicks and scenery');
      console.log(`  ${pad('crouched', 22)}${pad(k.selection.crouched, 12)}${k.selection.crouched === 'sweep' ? 'low and wide, takes the legs' : 'WRONG'}`);
      console.log(`  ${pad('off the ground', 22)}${pad(k.selection.airborne, 12)}${k.selection.airborne === 'high' ? 'longest reach, hardest landing' : 'WRONG'}`);
      console.log(`  ${pad('standing, standard', 22)}${pad(k.selection.standingStandardBoot, 12)}`);
      console.log(`  ${pad('standing, silver', 22)}${pad(k.selection.standingSilverBoot, 12)}`);
      console.log(`  ${pad('standing, spiked +', 22)}${pad(k.selection.standingTopBoot, 12)}${k.selection.standingTopBoot === 'stomp' ? 'everything around, at once' : 'WRONG'}`);
      console.log('');
      console.log(`  ${pad('kick', 10)}${pad('reach', 8)}${pad('arc', 8)}${pad('damage', 8)}${pad('prop power', 10)}`);
      for (const [key, prof] of Object.entries(k.profiles)) {
        const arc = prof.arcDegrees >= 180 ? 'all round' : `${prof.arcDegrees}°`;
        console.log(`  ${pad(key, 10)}${pad(`${prof.range}m`, 8)}${pad(arc, 10)}${pad(`×${prof.damageScale}`, 8)}${pad(prof.propPower, 10)}`);
      }
      const s = k.scenery;
      console.log('');
      console.log(`  kicked ${s.kind} (mass ${s.mass}): ${s.speedAfterKick} m/s off the boot, ${s.movedMeters} m travelled, ` +
        `${s.tumbled ? 'tumbled' : 'did not tumble'}, ${s.settled ? `settled after ${s.settleSeconds}s` : 'never settled'}, collision box moved ${s.boxFollowed} m with it.`);
      const f = k.feel;
      if (f) {
        console.log('');
        console.log(`  ${pad('what it met', 16)}${pad('mass', 7)}${pad('shake', 8)}${pad('kickback', 10)}${pad('roll', 8)}${pad('hit-stop', 10)}`);
        const row = (label, v, mass) => console.log(`  ${pad(label, 16)}${pad(mass, 7)}${pad(v.shake, 8)}${pad(`${v.kickback}m`, 10)}${pad(`${v.roll}\u00b0`, 8)}${pad(v.hitStop > 0 ? `${v.hitStop}s` : 'none', 10)}`);
        row('empty air', f.whiff, '\u2014');
        row('a body', f.body, f.bodyMass);
        row('a car', f.car, s.mass);
        console.log(`  the camera was shoved back ${f.cameraPushBack} m and the frame rolled ${f.frameRollDegrees}\u00b0 (${f.rollFollowsSide ? 'away from the impact, both sides' : 'WRONG'})`);
        console.log(`  hit-stop: a body froze ${f.stopFrames} frame(s) at \u00d7${f.stopScale} world time, then the clock ran clean again; screen edge lit to ${f.edgeFlashOpacity}`);
      }
      if (k.detail) console.log(`  ${k.detail}`);
    }
    if (d) {
      if (c || k) console.log('');
      console.log('A wave with no ammunition');
      console.log(`  ${pad('rounds', 26)}none in the magazine, none in the reserve, every frame`);
      console.log(`  ${pad('closed to boot range', 26)}${d.closedToBootRangeSeconds === null ? 'never' : `${d.closedToBootRangeSeconds}s`}`);
      console.log(`  ${pad('eliminations', 26)}${d.eliminations} (${d.bootEliminations} by boot)`);
      console.log(`  ${pad('wave ended', 26)}${d.cleared ? `after ${d.seconds}s` : 'NEVER'}`);
      if (!d.cleared && d.leftover.length) {
        console.log(`  left standing: ${JSON.stringify(d.leftover)}`);
      }
    }
    if (passed.ok) {
      console.log(`\nPASS — ${[c && 'a press retargets to the attacker nearest the crosshair and a held trigger keeps its target', k && 'the three kicks differ, the scenery they launch settles where it lands, and the impact feels as heavy as the mass it hit', d && 'a wave can be won with no ammunition left, by closing and booting'].filter(Boolean).join('; ')}.`);
    } else {
      console.log('\nFAIL');
      for (const reason of passed.reasons) console.log(`  - ${reason}`);
    }
    return;
  }
  if (report.instrumented) {
    console.log('(instrumented: the officer is kept on their feet so every wave can be paced)');
  }
  console.log(`${pad('wave', 6)}${pad('starts', 9)}${pad('clears', 9)}${pad('duration', 10)}${pad('hostiles', 10)}${pad('kills', 7)}${pad('damage', 9)}${pad('dmg/s', 7)}${pad('quietest', 9)}`);
  for (const w of report.waves || []) {
    const flag = w.endedByVictory ? ' (cleared)' : (w.closedByHarness ? ' (unfinished)' : '');
    console.log(`${pad(w.wave, 6)}${pad(`${w.startSeconds}s`, 9)}${pad(`${w.clearSeconds}s`, 9)}${pad(`${w.durationSeconds}s${flag}`, 10)}${pad(w.hostilesAtStart, 10)}${pad(w.eliminations, 7)}${pad(`${w.damageTaken}`, 9)}${pad(`${w.damagePerSecond}`, 7)}${pad(`${w.longestGapSeconds}s`, 9)}`);
  }
  console.log('(quietest = the longest stretch of that wave with no elimination)');

  // The ramp, read straight off the table: late waves should press harder.
  const rows = (report.waves || []).filter((w) => !w.closedByHarness);
  if (rows.length >= 2) {
    const first = rows[0], last = rows[rows.length - 1];
    const ratio = (a, b) => (b === 0 ? 'n/a' : `${(a / b).toFixed(2)}×`);
    console.log('');
    console.log(`Ramp: wave ${last.wave} pushes ${ratio(last.damagePerSecond, first.damagePerSecond)} the damage per second of wave ${first.wave} ` +
      `(${last.damagePerSecond} vs ${first.damagePerSecond}), and takes ${ratio(last.durationSeconds, first.durationSeconds)} as long to clear.`);
  }
  console.log('');
  console.log('Boot tiers');
  if (!(report.tiers || []).length) console.log('  (none reached)');
  for (const t of report.tiers || []) console.log(`  ${pad(t.tier, 26)}${pad(`${t.atSeconds}s`, 10)}credit ${t.credit}`);

  console.log('');
  console.log(`Simulated ${report.gameSeconds}s over ${report.steps} frames (${report.wallClockSeconds}s wall clock).`);
  console.log(`Eliminations ${report.eliminations} (boot ${report.bootEliminations}), loot ${report.lootCollected}, outcome ${report.outcome}${report.endTitle ? ` ("${report.endTitle}")` : ''}${report.instrumented ? '' : `, health ${report.healthAtEnd}`}.`);

  if (passed.baselineDelta?.length) {
    console.log('\nAgainst the baseline');
    console.log(`  ${pad('wave', 6)}${pad('was', 10)}${pad('now', 10)}change`);
    for (const d of passed.baselineDelta) {
      console.log(`  ${pad(d.wave, 6)}${pad(`${d.wasSeconds}s`, 10)}${pad(`${d.nowSeconds}s`, 10)}${d.changePercent > 0 ? '+' : ''}${d.changePercent}%`);
    }
  }

  if (report.consoleWarnings?.length) {
    console.log(`\n${report.consoleWarnings.length} console warning(s), first: ${report.consoleWarnings[0]}`);
  }
  if (passed.ok) {
    console.log('\nPASS — every wave resolved, no errors.');
  } else {
    console.log('\nFAIL');
    for (const reason of passed.reasons) console.log(`  - ${reason}`);
  }
  if (passed.findings?.length) {
    console.log('\nWorth knowing');
    for (const finding of passed.findings) console.log(`  - ${finding}`);
  }
}

// ------------------------------------------------------------------ lifecycle

function cleanup() {
  try { if (browser && !opts.keepOpen) browser.kill(); } catch { /* already gone */ }
  try { if (server) server.kill(); } catch { /* already gone */ }
  if (profileDir && !opts.keepOpen) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  }
}

const timeout = setTimeout(() => {
  console.error(`\nTimed out after ${opts.timeoutSeconds}s.`);
  cleanup();
  process.exit(1);
}, opts.timeoutSeconds * 1000);

main()
  .then((code) => { exitCode = code ?? 0; })
  .catch((err) => { console.error(`\nHarness error: ${err.message}`); exitCode = 2; })
  .finally(() => {
    clearTimeout(timeout);
    cleanup();
    process.exit(exitCode);
  });
