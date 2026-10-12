// Headless campaign harness for A Broken Boot On The Brave.
//
// Plays a scripted match through the game's own per-frame step in a real
// browser, then reports wave times, boot-tier timing and any errors, so a
// pacing change can be checked instead of played by hand.
//
//   node test/campaign.mjs                 full ten-wave run
//   node test/campaign.mjs --waves=3       quick pacing check
//   node test/campaign.mjs --headed        watch it play (debugging)
//   node test/campaign.mjs --check-forest  audit many forests without playing them
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
const fuzzPath = path.join(here, 'campaign-fuzz.json');
const forestPath = path.join(here, 'campaign-forest.json');
const forestBaselinePath = path.join(here, 'campaign-forest-baseline.json');

/** A 32-bit layout hash, as the report writes it. */
const hex32 = (h) => (Number(h) >>> 0).toString(16).padStart(8, '0');

// ----------------------------------------------------------------- forest drift
// The floors answer "can a wave be fought in this forest at all?". They say
// nothing about a forest that is still above every one of them but has become
// noticeably tighter, which is exactly what a generator change looks like on the
// way to a forest that is no longer fair. So the metrics themselves are recorded,
// and a later sweep says what moved.
//
// The audit is deterministic, so two sweeps of the same generator agree to the
// cell and any movement is real. Ten percent is the noise floor: the 25 cm grid
// and the seed-to-seed spread move a healthy forest by a couple of points, while
// a change of density moves it by tens.
const FOREST_DRIFT_TOLERANCE = 0.10;

/**
 * What the drift check compares, and which way is worse. Every one of these reads
 * "bigger is better": less connected ground, less clear space to fight in, a
 * smaller standable share of the clearing, a less reachable spawn ring or a
 * narrower clear circle all mean a forest that has got tighter.
 *
 * `scale` is the arithmetic the table uses (fractions as percentages, a radius as
 * the diameter it is reported as), so a baseline is readable without decoding it.
 */
const FOREST_DRIFT_METRICS = [
  { key: 'reachableArea', label: 'connected ground', unit: ' m²', digits: 0, scale: 1 },
  { key: 'fieldRoom', label: 'elbow room', unit: ' m', digits: 2, scale: 1 },
  { key: 'clearingOpenFraction', label: 'clearing standable', unit: '%', digits: 0, scale: 100 },
  { key: 'bandReachFraction', label: 'spawn ring reachable', unit: '%', digits: 0, scale: 100 },
  { key: 'openRadius', label: 'widest clear circle', unit: ' m', digits: 2, scale: 2 },
];

const driftValue = (metric, forest) => Number(forest[metric.key]) * metric.scale;

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
    fuzz: 0,
    worldSeed: 0,
    checkForest: 0,
    recordForest: false,
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
      case '--world-seed': opts.worldSeed = num; break;
      case '--baseline': opts.baseline = true; break;
      case '--record': opts.record = true; break;
      case '--honest': opts.honest = true; break;
      case '--check-lock': opts.checkLock = true; break;
      case '--check-kick': opts.checkKick = true; break;
      case '--check-dry': opts.checkDry = true; break;
      case '--check-character': opts.checkCharacter = true; break;
      case '--check-fatality': opts.checkFatality = true; break;
      // Bare `--fuzz` is five campaigns; `--fuzz=12` is twelve.
      case '--fuzz': opts.fuzz = Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 5; break;
      // Bare `--check-forest` is fifteen forests, plus the one the page plays.
      case '--check-forest': opts.checkForest = Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 15; break;
      case '--record-forest': opts.recordForest = true; break;
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
  --world-seed=N   build the forest from this seed instead of the configured layout
  --fuzz[=N]       play N campaigns with different seeds and name every one that
cannot finish a wave (default 5, each with its own forest)
  --check-forest[=N]
                   rebuild N forests (plus the one the page plays) and audit each
one instead of playing: is the clearing reachable, and is there open ground to
fight in? Combine with --world-seed=N to audit that one forest only
  --baseline       compare wave and tier timings against test/campaign-baseline.json
  --record         write the timings from this run to that baseline
  --record-forest  after --check-forest, write the metrics it measured to
                   test/campaign-forest-baseline.json, the spread later sweeps are
                   compared against for having got tighter
  (with a forest baseline recorded, every --check-forest sweep reports what moved
   since it, and by how much, even where every forest is still above the floors)
  --honest         play the match for real: the officer can die, and the report says where
  --check-lock     assert the aim trigger rule (fresh press retargets, held keeps its
target) instead of playing the campaign
  --check-kick     assert the three kicks, the scenery they move and the swing they
draw (also instead of the campaign; pass both to run both probes)
  --check-dry      play a whole wave with the officer's ammunition taken away, and
assert the boot alone can still end it
  --check-character audit the officer's own mesh file and how he is drawn instead: where
                    he stands on the ground in each state, and every skinned vertex
weighted, nothing welded to a bone it does not sit on, his own boot still a part
the tier system can replace, and his rifle held rather than worn — barrel on his
facing, muzzle ahead of his hand, magazine underneath. It sockets a tier's boot to
prove the boot clause, so it does not combine with --check-forest
  --check-fatality shoot an attacker down through the head and then through the chest,
                   and assert that only the head throws the body — and that the head
                   pays exactly what the chest pays for it (the same weighted credit,
                   one elimination, the same loot roll), because the boot is still the
                   way to the next tier
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
  if (opts.fuzz && (opts.checkLock || opts.checkKick || opts.checkDry || opts.checkCharacter
    || opts.checkFatality || opts.checkForest || opts.baseline || opts.record || opts.recordForest)) {
    console.error('--fuzz plays whole campaigns, so it does not combine with the mechanic probes, with --check-forest, or with --baseline/--record/--record-forest.');
    return 2;
  }
  if (opts.checkForest && (opts.baseline || opts.record)) {
    console.error('--check-forest audits terrain without playing a campaign, so it has no wave timings to compare or record.');
    return 2;
  }
  if (opts.checkCharacter && opts.checkForest) {
    console.error('--check-character sockets a boot model onto the officer in the page, so it does not combine with --check-forest, which spends the page on terrain.');
    return 2;
  }
  if (opts.recordForest && !opts.checkForest) {
    console.error('--record-forest records the metrics --check-forest measures, so it needs --check-forest as well.');
    return 2;
  }
  if (opts.recordForest && opts.worldSeed) {
    console.error('--record-forest records the whole spread of forests; --world-seed audits a single one, and a baseline of one is not what a later sweep should be judged against.');
    return 2;
  }

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

  /**
   * Wait for the game to reach its start screen. A fuzz run reloads the page
   * between seeds, so the wait has to be reusable rather than inline.
   */
  async function waitForBoot() {
    const bootDeadline = Date.now() + 180000;
    while (Date.now() < bootDeadline) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'Boolean(window.__brokenBoot && document.getElementById("screen-start") && !document.getElementById("screen-start").classList.contains("hidden"))',
        returnByValue: true,
      });
      if (result.value === true) return true;
      const ready = await cdp.send('Runtime.evaluate', {
        expression: 'document.getElementById("load-text") ? document.getElementById("load-text").textContent : ""',
        returnByValue: true,
      });
      if (!opts.quiet) process.stdout.write(`\rwaiting for the forest… ${ready.result.value}`.padEnd(60));
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error('\nThe game never reached the start screen.');
    for (const e of consoleErrors.slice(0, 10)) console.error(`  ${e}`);
    return false;
  }

  /** Hand the driver its options for one seed and bring back the report. */
  async function playSeed(seed) {
    const expression = `(async () => { ${driverSource}\n; return await runCampaign(${JSON.stringify({
      waves: opts.waves,
      waveLimitSeconds: opts.waveLimitSeconds,
      maxSteps: opts.maxSteps,
      seed,
      instrument: opts.honest ? 'none' : 'alive',
      checkLock: opts.checkLock || false,
      checkKick: opts.checkKick || false,
      checkDry: opts.checkDry || false,
      checkCharacter: opts.checkCharacter || false,
      checkFatality: opts.checkFatality || false,
      // An empty list is a sweep of the one forest the page is already playing.
      forestSeeds: opts.checkForest ? (opts.worldSeed ? [] : fuzzSeedList(opts.checkForest)) : null,
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
      return null;
    }
    const report = result.value;
    if (!report || report.fatal) {
      console.error(`\nCampaign could not run: ${report ? report.fatal : 'no report returned'}`);
      return null;
    }
    report.wallClockSeconds = +((Date.now() - startedAt) / 1000).toFixed(1);
    report.consoleErrors = consoleErrors.slice();
    report.consoleWarnings = consoleWarnings.slice();
    report.failedRequests = failedRequests.slice();
    return report;
  }

  /**
   * The seeds a fuzz run plays. The base seed first, then a spread of others, so
   * the campaigns are not neighbouring draws from one generator.
   */
  function fuzzSeedList(count) {
    const seeds = [];
    for (let i = 0; i < count; i++) seeds.push((((opts.seed + i * 7919) >>> 0) || 1));
    return seeds;
  }

  /** The page for a given layout seed: the forest seed rides in the query string. */
  const seedUrl = (seed) => {
    const u = new URL(url);
    u.searchParams.set('worldSeed', String(seed));
    return u.toString();
  };

  /** One fuzzed campaign, in the terms this check cares about. */
  function summariseSeed(seed, report) {
    const stalls = report.stalledWave || null;
    const errors = (report.consoleErrors || []).concat(report.failedRequests || []);
    return {
      seed,
      worldSeed: report.worldSeed,
      layoutHash: report.layoutHash,
      // Whether the terrain could be fought in at all. A fuzz names the seeds that
      // stalled; this says which of them had a forest that left no choice.
      fair: report.forest ? report.forest.pass : null,
      forestReasons: report.forest ? report.forest.reasons : [],
      outcome: report.outcome,
      seconds: report.gameSeconds,
      wavesReached: report.wavesReached,
      eliminations: report.eliminations,
      bootEliminations: report.bootEliminations,
      // A campaign that reached victory or death on its own finished; one that ran
      // into the frame cap, or left a wave unable to end, did not.
      finished: !stalls
        && (report.outcome === 'victory' || report.outcome === 'death')
        && errors.length === 0,
      quietestSeconds: +Math.max(0, ...(report.waves || []).map((w) => w.longestGapSeconds || 0)).toFixed(1),
      stalledWave: stalls && {
        wave: stalls.wave,
        stalledFor: stalls.stalledFor,
        hostiles: stalls.hostiles,
        playerAmmo: stalls.playerAmmo || null,
        leftovers: (stalls.leftovers || []).map((l) => `${l.distance}m, health ${l.health}, ${l.bleeding ? 'bleeding' : 'not bleeding'}, ${l.inCover ? 'in cover' : 'no cover'}, ${l.lineOfSightToPlayer ? 'sees the officer' : 'no line of sight'}`),
      },
      errors,
    };
  }

  /** A seed that never got as far as a report — the browser or the driver failed. */
  const unfinished = (seed, outcome) => ({
    seed, outcome, seconds: 0, wavesReached: null, eliminations: 0, bootEliminations: 0,
    finished: false, quietestSeconds: 0, stalledWave: null, errors: consoleErrors.slice(0, 3),
    worldSeed: seed, layoutHash: null, fair: null, forestReasons: [],
  });

  /**
   * Play the campaign once per seed and name every seed where a wave cannot
   * finish. This is the check that a pilot deadlock cannot hide behind: one seed
   * of the campaign can come out clean while the next ends in a wave that never
   * closes, and the difference between them is nothing but the draw.
   */
  async function fuzzSeeds() {
    const seeds = fuzzSeedList(opts.fuzz);
    log(`\nfuzzing ${seeds.length} seed(s), a whole campaign each, reloading between them`);
    const runs = [];
    for (let i = 0; i < seeds.length; i++) {
      if (i > 0) {
        // A clean slate. The game does not reset itself between campaigns, and a
        // fuzz that reused one page would be measuring the leftovers of the last —
        // and the world is built during that load, so each seed gets its own
        // forest by reloading with its own `?worldSeed`.
        consoleErrors.length = 0;
        consoleWarnings.length = 0;
        failedRequests.length = 0;
        seenErrors.clear();
        await cdp.send('Page.navigate', { url: seedUrl(seeds[i]) });
        if (!(await waitForBoot())) {
          runs.push(unfinished(seeds[i], 'never-loaded'));
          break;
        }
      }
      if (!opts.quiet) process.stdout.write(`\r  seed ${seeds[i]} playing…`.padEnd(60));
      const report = await playSeed(seeds[i]);
      runs.push(report ? summariseSeed(seeds[i], report) : unfinished(seeds[i], 'driver-failed'));
    }
    if (!opts.quiet) process.stdout.write(`\r${''.padEnd(60)}\r`);

    // The premise of a fuzz run is that each seed plays a different forest. If the
    // world seed stopped reaching the build, the campaigns would silently go back
    // to sharing one layout, and only this count would notice.
    const layouts = new Set(runs.map((r) => r.layoutHash).filter((h) => h !== null && h !== undefined));
    const layoutsDiffer = runs.length < 2 || layouts.size === runs.length;
    printFuzz(runs, layoutsDiffer);
    fs.writeFileSync(fuzzPath, `${JSON.stringify({ baseSeed: opts.seed, runs }, null, 2)}\n`);
    log(`\nfuzz report written to ${path.relative(process.cwd(), fuzzPath)}`);
    return (runs.some((r) => !r.finished) || !layoutsDiffer || runs.some((r) => r.fair === false)) ? 1 : 0;
  }

  // ---------------------------------------------------------------- boot the game
  // A single run plays the configured forest unless one is asked for with
  // `--world-seed`; a fuzz run gives every seed a forest of its own.
  const bootUrl = opts.fuzz
    ? seedUrl(fuzzSeedList(opts.fuzz)[0])
    : (opts.worldSeed ? seedUrl(opts.worldSeed) : url);
  log(`loading ${bootUrl}`);
  await cdp.send('Page.navigate', { url: bootUrl });
  if (!(await waitForBoot())) return 1;
  log(opts.fuzz
    ? '\ngame loaded, fuzzing the campaign'
    : opts.checkForest ? '\ngame loaded, auditing forests' : '\ngame loaded, playing the campaign');

  // -------------------------------------------------------------- fuzz the seeds
  if (opts.fuzz) return await fuzzSeeds();

  // ---------------------------------------------------------------- audit the terrain
  // `--check-forest` never plays the campaign: it boots the page for the layout it
  // plays — so the report can name a forest honestly — and then rebuilds a spread
  // of others inside that same page, asking of each whether a wave could be fought
  // in it. The one it is playing is audited too, and must rebuild to itself.
  if (opts.checkForest) {
    const seeds = opts.worldSeed ? [] : fuzzSeedList(opts.checkForest);
    log(`\nbuilding ${seeds.length + 1} forest(s) and auditing each`);
    const report = await playSeed(opts.seed);
    if (!report) return 1;
    const audit = report.forestSweep;
    if (audit && fs.existsSync(forestBaselinePath)) {
      try {
        const recorded = JSON.parse(fs.readFileSync(forestBaselinePath, 'utf8'));
        report.forestDrift = compareForests(recorded, audit);
        // Recording accepts this sweep as the new spread, so what moved is shown
        // as what is being accepted rather than as something wrong with it.
        if (opts.recordForest) report.forestDrift.accepted = true;
      } catch (err) {
        log(`\nthe forest baseline could not be read (${err.message}); this sweep is not compared against it`);
      }
    }
    const passed = assess(report);
    printReport(report, passed);
    if (audit) {
      fs.writeFileSync(forestPath, `${JSON.stringify({
        baseSeed: opts.seed,
        cell: audit.cell,
        limits: audit.limits || null,
        played: { seed: audit.playedSeed, layoutHash: hex32(audit.playedLayoutHash) },
        matchesPlayed: audit.matchesPlayed,
        control: audit.control,
        drift: report.forestDrift || null,
        forests: audit.seeds.map((f) => ({ ...f, layoutHash: hex32(f.layoutHash) })),
      }, null, 2)}\n`);
      log(`\nforest report written to ${path.relative(process.cwd(), forestPath)}`);
    }
    if (audit && opts.recordForest) {
      fs.writeFileSync(forestBaselinePath, `${JSON.stringify(forestBaselineRecord(audit), null, 2)}\n`);
      log(`forest baseline written to ${path.relative(process.cwd(), forestBaselinePath)}`);
    }
    return passed.ok ? 0 : 1;
  }

  // ---------------------------------------------------------------- play it
  const report = await playSeed(opts.seed);
  if (!report) return 1;

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

/**
 * What a sweep measures against the recorded baseline: per metric, the spread
 * across the whole sweep, and per forest, whatever moved by more than the
 * tolerance.
 *
 * Movement is reported rather than failed. A generator change is sometimes
 * deliberate, and a forest that is still inside every floor is still a forest a
 * wave can be fought in — but the numbers behind that verdict are what says
 * whether the next change will push it through one, so they are named.
 */
function compareForests(baseline, sweep) {
  const drift = {
    recordedAt: baseline.recordedAt || null,
    tolerance: FOREST_DRIFT_TOLERANCE,
    compared: 0,
    notes: [],
    metrics: [],
    forests: [],
  };
  if (!Array.isArray(baseline.forests) || !baseline.forests.length) {
    drift.notes.push('the recorded baseline holds no forests, so there is nothing to compare against');
    return drift;
  }
  if (baseline.cell !== sweep.cell) {
    drift.notes.push(`the baseline was measured on a ${baseline.cell} m grid and this sweep on ${sweep.cell} m, so the two are not comparable`);
    return drift;
  }
  if (JSON.stringify(baseline.limits) !== JSON.stringify(sweep.limits)) {
    drift.notes.push('the floors themselves have changed since the baseline, so its spread is no longer the one they were measured against');
  }

  const spread = (forests, metric) => {
    const values = forests.map((f) => driftValue(metric, f)).filter((v) => Number.isFinite(v));
    if (!values.length) return null;
    return { min: Math.min(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
  };

  for (const metric of FOREST_DRIFT_METRICS) {
    const was = spread(baseline.forests, metric);
    const now = spread(sweep.seeds, metric);
    if (!was || !now) continue;
    const change = (now.mean - was.mean) / (Math.abs(was.mean) || 1);
    drift.metrics.push({
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      wasMin: +was.min.toFixed(metric.digits),
      wasMean: +was.mean.toFixed(metric.digits),
      nowMin: +now.min.toFixed(metric.digits),
      nowMean: +now.mean.toFixed(metric.digits),
      changePercent: +(change * 100).toFixed(1),
      moved: Math.abs(change) >= FOREST_DRIFT_TOLERANCE,
      tightened: change <= -FOREST_DRIFT_TOLERANCE,
    });
  }

  for (const was of baseline.forests) {
    const now = sweep.seeds.find((s) => s.seed === was.seed);
    if (!now) {
      drift.forests.push({ seed: was.seed, missing: true });
      continue;
    }
    drift.compared += 1;
    const moved = [];
    for (const metric of FOREST_DRIFT_METRICS) {
      const before = driftValue(metric, was);
      const after = driftValue(metric, now);
      if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) continue;
      const change = (after - before) / before;
      if (Math.abs(change) < FOREST_DRIFT_TOLERANCE) continue;
      moved.push({
        key: metric.key,
        label: metric.label,
        unit: metric.unit,
        was: +before.toFixed(metric.digits),
        now: +after.toFixed(metric.digits),
        changePercent: +(change * 100).toFixed(1),
        tightened: change < 0,
      });
    }
    // The counts are context rather than a verdict: raising the tree count is the
    // usual way the ground gets tighter, and it is the first thing worth seeing.
    const counts = [];
    if (Number(was.trees) !== Number(now.trees)) counts.push(`trees ${was.trees} → ${now.trees}`);
    if (Number(was.props) !== Number(now.props)) counts.push(`props ${was.props} → ${now.props}`);
    // A layout hash that moved is the generator itself changing, which is worth
    // naming even when every metric lands where it did before.
    const layoutNow = hex32(now.layoutHash);
    const layoutMoved = was.layoutHash !== layoutNow;
    if (!moved.length && !counts.length && !layoutMoved) continue;
    drift.forests.push({ seed: was.seed, layoutWas: was.layoutHash, layoutNow, layoutMoved, moved, counts });
  }

  drift.metricsMoved = drift.metrics.filter((m) => m.moved).length;
  drift.metricsTighter = drift.metrics.filter((m) => m.tightened).length;
  drift.seedsMoved = drift.forests.filter((f) => !f.missing).length;
  drift.seedsTighter = drift.forests.filter((f) => (f.moved || []).some((m) => m.tightened)).length;
  return drift;
}

/**
 * One forest's drift as prose: the layout if it moved, then every metric that did.
 */
function driftSeedBits(forest) {
  const bits = [];
  if (forest.layoutMoved) bits.push(`layout ${forest.layoutWas} → ${forest.layoutNow}`);
  for (const m of forest.moved || []) {
    bits.push(`${m.label} ${m.was} → ${m.now}${m.unit} (${m.changePercent}%, ${m.tightened ? 'tighter' : 'looser'})`);
  }
  for (const c of forest.counts || []) bits.push(c);
  return bits;
}

/**
 * What a `--record-forest` run writes: each forest's metrics, the floors that
 * were in force, and the control's verdict — enough for a later sweep to say
 * whether the generator moved, not only whether the result still passes.
 */
function forestBaselineRecord(sweep) {
  return {
    recordedAt: new Date().toISOString(),
    baseSeed: opts.seed,
    cell: sweep.cell,
    limits: sweep.limits || null,
    matchesPlayed: sweep.matchesPlayed,
    control: sweep.control ? { pass: sweep.control.pass, sealedReasons: sweep.control.sealedReasons } : null,
    forests: sweep.seeds.map((f) => ({
      seed: f.seed,
      layoutHash: hex32(f.layoutHash),
      fair: f.pass,
      trees: f.trees,
      props: f.props,
      reachableArea: f.reachableArea,
      fieldRoom: f.fieldRoom,
      openRadius: f.openRadius,
      clearingOpenFraction: f.clearingOpenFraction,
      bandReachFraction: f.bandReachFraction,
      pockets: f.pockets ? f.pockets.count : null,
      largestPocketArea: f.pockets ? f.pockets.largestArea : null,
    })),
  };
}

/** Everything that makes a run a failure, rather than an interesting number. */
function assess(report) {
  const reasons = [];
  const findings = [];

  // The terrain the run happened in. A forest a wave cannot be fought in fails
  // here rather than being blamed on whoever played it — and in a sweep the
  // played forest is one of the audited seeds, so it is named there instead.
  if (report.forest && !report.forest.pass && !report.forestSweep) {
    reasons.push(`the forest this run was played in cannot be fought in (seed ${report.worldSeed}, layout ${hex32(report.layoutHash)}): ${report.forest.reasons.join('; ')}`);
  }

  // The probes are single assertions about one mechanic, not a campaign.
  if (report.lockCheck || report.kickCheck || report.dryCheck || report.characterCheck
    || report.fatalityCheck || report.forestSweep) {
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
      const sw = k.swish;
      if (sw) {
        if (!sw.silentAtRest) bits.push('the swish was on screen before any kick was thrown');
        for (const [wanted, r] of Object.entries(sw.profiles || {})) {
          if (!r.thrown) { bits.push(`the ${wanted} was never thrown, so nothing swung`); continue; }
          if (r.type !== wanted) bits.push(`the ${wanted} was thrown as a ${r.type}`);
          if (!r.drawn) bits.push(`the ${wanted} drew no arc at all`);
          if (r.offFoot > 0.1) bits.push(`the ${wanted}'s arc trails ${r.offFoot} m off the boot it was thrown with`);
          if (r.samples < 6) bits.push(`the ${wanted}'s swing was drawn from ${r.samples} point(s) of arc`);
          if (!(r.spread > 0.3)) bits.push(`the ${wanted}'s swish never travelled (${r.spread} m across the whole swing)`);
          if (r.colour !== r.bootColour) bits.push(`the ${wanted}'s swish is drawn in ${r.colour} instead of the boot's ${r.bootColour}`);
        }
        if (sw.shapesOrdered === false) bits.push('all four kicks draw the same width of arc, so the shapes do not differ');
        if (!sw.went) bits.push('the swish was still on screen after the swing had finished');
        if (!sw.reusedBuffer) bits.push('every kick builds itself a new ribbon');
        if (!(sw.offChest > 0.1)) bits.push('the chest control sits on the boot, so the clause would not name it');
        if (sw.typesThrown && sw.shapesOrdered && sw.went && sw.reusedBuffer) {
          findings.push('every kick draws its own swing from the foot it was thrown with: '
            + Object.entries(sw.profiles).map(([t, r]) => `${t} ${r.samples} points over ${r.spread} m, ${r.width} m of stroke`).join('; ')
            + `, one ribbon reused for all four, and a stroke from the middle of him (${sw.offChest} m off the boot) is what the clause names`);
        }
      }
      reasons.push(`kicks and scenery: ${bits.join('; ') || 'the probe did not pass'}`);
    }
    // The officer's own mesh file. Every clause names the part and the bone, so a
    // bad export says which edit broke it rather than only that something did.
    const cc = report.characterCheck;
    if (cc) {
      const limit = cc.limits ? cc.limits.weldShare : 0.02;
      if (cc.pass) {
        findings.push(`the officer's mesh file audits clean: ${cc.meshes.map((m) => `${m.name} (${m.sampled} sampled)`).join(', ')}, `
          + `nothing unweighted, no more than ${(cc.weldShare * 100).toFixed(1)}% of a mesh riding one distant bone, and `
          + `all ${(cc.boots || []).length} tiers wear a boot that covers his foot (${cc.footPoints} sampled vertices on his right foot) `
          + `with its sole on the ground at ${cc.boots.map((b) => b.sole).join(', ')} m`);
        findings.push(`every tier's boot sits centred on the foot rather than on the ankle bone, within ${Math.max(...cc.boots.map((b) => Math.abs(b.centreGap)))} m of its centre`);
        findings.push(`every tier's boot is seated on the foot it was socketed onto: its sole lies within ${Math.max(...cc.boots.map((b) => b.soleTilt))}\u00b0 of level `
          + `and its toe points within ${Math.max(...cc.boots.map((b) => b.toeDeg ?? 0))}\u00b0 of the rig's own toe bone, `
          + `where a boot rolled ${cc.seatControls.sole.rolledBy}\u00b0 reads ${cc.seatControls.sole.tilt}\u00b0 off level and one yawed ${cc.seatControls.toe.yawedBy}\u00b0 reads ${cc.seatControls.toe.toe}\u00b0 off the foot, both named`);
        if (cc.initialBoot && cc.initialBoot.socketed) {
          findings.push(`he starts the game already wearing a boot: ${cc.initialBoot.tier} (tier ${cc.initialBoot.index}), socketed with nothing moving the tier, `
            + `covering ${(cc.initialBoot.coveredShare * 100).toFixed(1)}% of his foot with its sole at ${cc.initialBoot.sole} m`);
        }
        if (cc.coversControl && cc.coversControl.measured && cc.coversControl.namesIt) {
          findings.push(`the coverage clause would name the failure it exists for: the same measurement on the ${cc.coversControl.tier} `
            + `shrunk to ${(cc.coversControl.shrink * 100).toFixed(0)}% leaves only ${(cc.coversControl.share * 100).toFixed(1)}% of his foot inside it`);
        }
        if (cc.control && cc.control.measured) {
          findings.push(`the audit would name the failure it exists for: ${(cc.control.beyondLimitShare * 100).toFixed(1)}% of the officer's own boot vertices sit `
            + `beyond ${cc.control.distanceLimit} m of ${cc.control.boneZero}, which is where an unweighted boot ends up`);
        }
        if (cc.states) {
          findings.push(`the officer stands on the ground in every state he is drawn in (${Object.keys(cc.states).length} of them), `
            + `the lowest drawn point between ${cc.worstSink} m and ${cc.worstFloat} m against a ${cc.stateLimits.sink}..${cc.stateLimits.float} m band`);
          findings.push(`the footing measurement follows the rig: lifting him a metre raised that floor by ${cc.footingControl.liftedBy} m`);
        }
        if (cc.rifleOk) {
          const held = Object.entries(cc.rifle.held).map(([state, h]) => `${state} ${h.degOff}\u00b0/${h.inFront} m`).join(', ');
          findings.push(`his shot leaves the barrel it was measured from: the muzzle flash lands ${cc.rifle.flash.toBarrel} m and the tracer starts `
            + `${cc.rifle.flash.tracerFromBarrel} m from the rifle's own tip, where the stand-in they replaced sat ${cc.rifle.flash.standInOffBarrel} m away`);
          findings.push(`he is holding his rifle rather than wearing it: in every pose he holds it in its ${cc.rifle.length} m barrel points `
            + `within ${Math.max(...Object.values(cc.rifle.held).map((h) => h.degOff))}\u00b0 of where he faces (${held}) with the magazine under it, `
            + `and the probe names an unrotated rifle at ${cc.rifle.control.degOff}\u00b0 off his aim as the failure it exists for`);
        }
      } else {
        const bits = [];
        if (cc.unweightedTotal > 0) {
          bits.push(`${cc.unweightedTotal} sampled skin vertex/vertices of the officer carry no weight at all`);
        }
        if (cc.weldShare > limit) {
          bits.push(`${(cc.weldShare * 100).toFixed(1)}% of ${cc.weldMesh} is welded to ${cc.weldBone}, up to ${cc.weldDistance} m off that bone `
            + `against a ${cc.limits.wrongBoneDistance} m limit`);
        }
        if (!cc.noMisboundParts) {
          bits.push(`${cc.misboundParts.map((m) => `${m.mesh} sits on the ground but is bound to ${m.bone}`).join('; ')}, `
            + 'so a tier\'s boot is worn over it instead of replacing it');
        }
        // The boot question moved when every tier started wearing a model: his mesh
        // no longer carries a boot of its own for a tier to hide, so what is worth
        // asserting is the thing a socket can get wrong — a boot that his foot
        // sticks out of, or one that digs into the ground (or floats above it).
        if (cc.initialBoot && !cc.initialBoot.socketed) {
          bits.push(`he starts the game barefoot: tier ${cc.initialBoot.index} (${cc.initialBoot.tier}) has no boot socketed, so the first boot a player sees is the second tier's`);
        } else if (cc.initialBoot && (!cc.initialBoot.coversFoot || !cc.initialBoot.soleOnGround)) {
          bits.push(`the boot he starts in (${cc.initialBoot.tier}) does not fit: ${(cc.initialBoot.coveredShare * 100).toFixed(1)}% of his foot inside it, sole at ${cc.initialBoot.sole} m`);
        }
        for (const b of cc.boots || []) {
          if (!b.socketed) { bits.push(`the ${b.tier} never socketed its ${b.model} onto the foot`); continue; }
          if (!b.coversFoot) {
            bits.push(`the ${b.tier} boot (${b.span} m) does not cover his foot: ${(b.coveredShare * 100).toFixed(1)}% of its ${cc.footPoints} sampled foot vertices are inside it`);
          }
          if (!(b.sole >= -0.06 && b.sole <= 0.1)) {
            bits.push(`the ${b.tier} boot's sole sits at ${b.sole} m — ${b.sole > 0.1 ? 'floating above the ground' : 'through it'}`);
          }
          if (!b.centred) {
            bits.push(`the ${b.tier} boot sits ${Math.abs(b.centreGap)} m ${b.centreGap > 0 ? 'too far forward' : 'too far back'} along the foot`);
          }
          if (!b.sitsRight) {
            const why = [];
            if (b.soleTilt > cc.seatLimits.soleTilt) why.push(`its sole is ${b.soleTilt}\u00b0 off the ground`);
            if (b.toeDeg !== null && b.toeDeg > cc.seatLimits.toe) why.push(`its toe points ${b.toeDeg}\u00b0 away from the foot's`);
            bits.push(`the ${b.tier} boot sits wrong on the foot: ${why.join(' and ')}`);
          }
        }
        if (cc.seatControls && cc.seatControls.sole.measured && !cc.seatControls.sole.namesIt) {
          bits.push('the level clause passes a boot rolled 30\u00b0 off the ground');
        }
        if (cc.seatControls && cc.seatControls.toe.measured && !cc.seatControls.toe.namesIt) {
          bits.push('the toe clause passes a boot yawed 45\u00b0 away from the foot');
        }
        if (cc.coversControl && cc.coversControl.measured && !cc.coversControl.namesIt) {
          bits.push('the coverage clause passes a boot too small to wear: the same measurement on one shrunk to '
            + `${(cc.coversControl.shrink * 100).toFixed(0)}% still leaves ${(cc.coversControl.share * 100).toFixed(1)}% of his foot inside it`);
        }
        if (!cc.rifleOk) {
          if (!cc.rifle || !cc.rifle.loaded) {
            bits.push('his rifle never loaded, so he fights empty-handed');
          } else {
            for (const [state, h] of Object.entries(cc.rifle.held || {})) {
              const why = [];
              if (h.degOff > cc.rifle.limits.coneDegrees) why.push(`its barrel points ${h.degOff}\u00b0 off his facing, not at what he is facing`);
              if (h.inFront < cc.rifle.limits.inFront) why.push(`its muzzle sits ${h.inFront} m from his hand instead of in front of it`);
              if (h.magazineY > cc.rifle.limits.magazineY) why.push('its magazine is not hanging underneath');
              if (why.length) bits.push(`${state}: ${why.join(' and ')}`);
            }
            if (!cc.rifle.flashOk) {
              if (!cc.rifle.flash.shown) bits.push('firing the rifle showed no muzzle flash at all');
              else {
                if (cc.rifle.flash.toBarrel > cc.rifle.limits.flashToBarrel) {
                  bits.push(`the muzzle flash lands ${cc.rifle.flash.toBarrel} m from the rifle's tip instead of on it`);
                }
                if (cc.rifle.flash.tracerFromBarrel === null || cc.rifle.flash.tracerFromBarrel > cc.rifle.limits.flashToBarrel) {
                  bits.push(cc.rifle.flash.tracerFromBarrel === null
                    ? 'firing the rifle drew no tracer'
                    : `the tracer starts ${cc.rifle.flash.tracerFromBarrel} m from the rifle's tip instead of at it`);
                }
              }
            }
            if (!cc.rifle.flashControlNamesIt) {
              bits.push(`the probe cannot tell the barrel from the stand-in it replaced: that sat only ${cc.rifle.flash.standInOffBarrel} m off the tip, `
                + `under the ${cc.rifle.limits.flashOffBarrel} m it has to be out by`);
            }
            if (cc.rifle.control && !cc.rifle.control.namesIt) {
              bits.push('the probe cannot even name a rifle left unrotated — the mount it exists for — ' +
                `measuring ${cc.rifle.control.degOff}\u00b0 off his aim and ${cc.rifle.control.inFront} m in front`);
            }
          }
        }
        // The control only speaks when there is a boot to measure it on: with the
        // boot missing altogether, the clause above already says the failure out
        // loud, and a control with nothing to measure would only add noise.
        if (cc.control && cc.control.measured && !cc.control.wouldNameIt) {
          bits.push(`the audit cannot even name the failure it exists for: only ${(cc.control.beyondLimitShare * 100).toFixed(1)}% of the officer's own boot would land `
            + `beyond ${cc.control.distanceLimit} m of ${cc.control.boneZero} if it were bound there, against a ${(cc.control.weldShareBudget * 100).toFixed(0)}% budget`);
        }
        // Where the officer is actually drawn. A clip whose baked travel is left
        // on the root bone throws the body out of the world the moment he walks,
        // and nothing else here sees it: the fight plays on and he is simply gone.
        if (cc.states && !cc.statesOnTheGround) {
          const off = Object.entries(cc.states)
            .filter(([, y]) => y < cc.stateLimits.sink || y > cc.stateLimits.float)
            .map(([state, y]) => `${state} draws him at ${y} m`);
          bits.push(`${off.join('; ')}, outside the ${cc.stateLimits.sink}..${cc.stateLimits.float} m band a standing officer stays in`);
        }
        if (cc.footingControl && !cc.footingControl.pass) {
          bits.push(`the footing measurement does not follow the rig at all (lifting the officer a metre moved its reading by ${cc.footingControl.liftedBy} m), so its verdict means nothing`);
        }
        if (cc.states && cc.statesOnTheGround && cc.states) {
          findings.push(`the officer stands on the ground in every state he is drawn in: ${Object.entries(cc.states).map(([k, v]) => `${k} ${v} m`).join(', ')}`);
        }
        reasons.push(`the officer's mesh file: ${bits.join('; ') || 'the probe did not pass'}`);
      }
    }
    // The fatality: the two halves are the one measurement taken twice, so the failure
    // names the number that went wrong rather than only that one did.
    const fc = report.fatalityCheck;
    if (fc && !fc.pass) {
      const bits = [];
      if (fc.detail) bits.push(fc.detail);
      for (const [label, h] of [['head', fc.head], ['chest', fc.control]]) {
        if (!h) { bits.push(`the ${label} half did not run`); continue; }
        if (h.note) { bits.push(`the ${label} half never finished an attacker: ${h.note}`); continue; }
        if (label === 'head') {
          if (!h.threwTheBody) bits.push('a finishing round through the head left the body where it stood');
          if (!(h.travelledMetres >= fc.limits.travelMin)) bits.push(`a thrown body travelled only ${h.travelledMetres} m`);
          if (!(h.roseMetres >= fc.limits.peakMin)) bits.push(`a thrown body rose only ${h.roseMetres} m`);
          if (!(h.turnedDegrees >= fc.limits.tumbleMin)) bits.push(`a thrown body turned over only ${h.turnedDegrees}°`);
          if (h.offShotDegrees === null || h.offShotDegrees > fc.limits.offShotMax) {
            bits.push(`the body was thrown ${h.offShotDegrees}° off the shot that sent it`);
          }
          if (h.spinFromTheShotsSide === false) bits.push('the tumble turned the wrong way for the side the round came from');
          if (!h.corpseIsNotATarget) bits.push('the round that felled him could still find his body in the air');
          if (!h.corpseWasATargetWhileAlive) {
            bits.push('the cast the corpse clause uses never found a living attacker on that line, so it names nothing');
          }
          if (!/FATALITY/.test(h.banner)) bits.push(`the head downing announced "${h.banner}" rather than a FATALITY`);
        } else {
          if (h.threwTheBody) bits.push('a finishing round through the chest threw the body too');
          if (!(h.travelledMetres <= fc.limits.stillMax)) {
            bits.push(`a chest downing moved the body ${h.travelledMetres} m, so the measurement does not name the throw`);
          }
          if (/FATALITY/.test(h.banner)) bits.push('a chest downing was announced as a FATALITY');
        }
        if (h.eliminations !== 1) bits.push(`the ${label} downing counted ${h.eliminations} elimination(s)`);
      }
      if (fc.head && fc.control && fc.head.creditPaid !== undefined
        && fc.head.creditPaid !== fc.control.creditPaid) {
        bits.push(`the head paid ${fc.head.creditPaid} of a tier point where the chest paid ${fc.control.creditPaid}`);
      } else if (fc.head && fc.head.creditPaid !== undefined && fc.head.creditPaid !== fc.weight) {
        bits.push(`a downing paid ${fc.head.creditPaid} of a tier point instead of the ${fc.weight} it is weighted at`);
      }
      reasons.push(`the fatality: ${bits.join('; ') || 'the probe did not pass'}`);
    }
    // The fatality's own findings, so a passing run says what the throw measured.
    const fcPass = report.fatalityCheck;
    if (fcPass && fcPass.pass) {
      const h = fcPass.head;
      findings.push(`a finishing round through the head throws the body: it rose ${h.roseMetres} m, travelled `
        + `${h.travelledMetres} m from where it died and turned over ${h.turnedDegrees}°, ${h.offShotDegrees}° off the shot that sent it `
        + `(landing facing the way the round was going)`);
      findings.push(`a finishing round through the chest does not: the same measurement on the same attacker in the same place `
        + `moved the body ${fcPass.control.travelledMetres} m and announced "${fcPass.control.banner}", which is what names the throw `
        + `as the thing measured rather than the death`);
      findings.push(`the fatality is only how the body goes down: both halves paid ${h.creditPaid} of a tier point `
        + `(the gunfire weight, ${fcPass.weight}) for ${h.eliminations} elimination(s) each, so the boot is still the way to the next tier`);
      findings.push(`the flung body is not cover: the cast that finds a living attacker on that line finds only the ground where this one is lying`);
    }
    if (report.failedRequests?.length) reasons.push(`${report.failedRequests.length} failed request(s): ${report.failedRequests[0]}`);
    // The forest sweep: every layout it rebuilt, and the two ways the sweep
    // itself could be lying — a rebuilt forest that is not the one being played,
    // or an audit that cannot tell a sealed clearing from an open field.
    const sweep = report.forestSweep;
    if (sweep) {
      if (!sweep.matchesPlayed) {
        const rebuilt = hex32(sweep.seeds.find((f) => f.seed === sweep.playedSeed)?.layoutHash ?? 0);
        reasons.push(`the forest rebuilt from seed ${sweep.playedSeed} hashes to ${rebuilt} while the page is playing ${hex32(sweep.playedLayoutHash)}, so this sweep is not auditing the forests the game builds`);
      }
      if (!sweep.control.pass) {
        reasons.push(`the audit cannot tell a fair forest from a sealed one (an empty field: ${sweep.control.openFair ? 'fair' : 'UNFAIR'}, a trunk wall round the clearing: ${sweep.control.sealedUnfair ? 'unfair' : 'FAIR'}), so its verdicts are worth nothing`);
      }
      for (const f of sweep.seeds) {
        if (!f.pass) reasons.push(`forest ${f.seed} (layout ${hex32(f.layoutHash)}) cannot be fought in: ${f.reasons.join('; ')}`);
      }
    }
    // Drift is a finding rather than a failure: the forests may still all be fair,
    // and a deliberate generator change has to be recordable. What it must not do
    // is pass unmentioned, since a spread that has got tighter is the state that
    // precedes a forest falling through a floor.
    const drift = report.forestDrift;
    if (drift) {
      // The headline only: the drift table above PASS names every forest and
      // metric, so the findings say what it amounts to rather than repeating it.
      for (const note of drift.notes || []) findings.push(`forest drift: ${note}`);
      if (drift.accepted) {
        findings.push(`the forest baseline was re-recorded from this sweep (${drift.compared} forest(s) compared against the old one)`);
      } else if (drift.metricsMoved) {
        findings.push(`forest drift since the recorded baseline: ${drift.metricsTighter} of ${drift.metrics.length} metric(s) measurably tighter and ${drift.metricsMoved - drift.metricsTighter} looser, ${drift.seedsTighter} of ${drift.compared} forest(s) tighter (tolerance ${Math.round(drift.tolerance * 100)}%)`);
      }
    }
    return { ok: reasons.length === 0, reasons, findings, good: [], baselineDelta: null, errors: [] };
  }
  const errors = [...(report.errors || []), ...(report.consoleErrors || [])];
  if (errors.length) reasons.push(`${errors.length} error(s): ${errors[0]}`);
  if (report.stalledWave) reasons.push(`wave ${report.stalledWave.wave} stalled for ${report.stalledWave.stalledFor}s with ${report.stalledWave.hostiles} attacker(s) left`);

  if (!(report.waves || []).length) reasons.push('no waves completed');
  if (report.outcome === 'step-cap') reasons.push('the frame cap was reached before the campaign ended');

  // Dying is a difficulty datapoint rather than a defect, unless the run was
  // asked to finish the campaign. Either way the unreached waves are noted.
  if (report.worldSeed) {
    findings.push(`the forest was built from seed ${report.worldSeed} (layout ${hex32(report.layoutHash)})`);
  }
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
  if (report.lockCheck || report.kickCheck || report.dryCheck || report.characterCheck
    || report.fatalityCheck || report.forestSweep) {
    const c = report.lockCheck;
    const k = report.kickCheck;
    const d = report.dryCheck;
    const cc = report.characterCheck;
    const fat = report.fatalityCheck;
    const sweep = report.forestSweep;
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
      if (k.swish) {
        const sw = k.swish;
        console.log('');
        console.log(`  ${pad('the swing is drawn', 22)}${pad('points', 8)}${pad('travel', 10)}${pad('stroke', 10)}colour and fit`);
        for (const [type, r] of Object.entries(sw.profiles || {})) {
          console.log(`  ${pad(type, 22)}${pad(r.samples, 8)}${pad(`${r.spread} m`, 10)}${pad(`${r.width} m`, 10)}`
            + `${r.colour}${r.colour === r.bootColour ? " (the boot's own)" : " NOT THE BOOT'S"}`
            + `${r.offFoot > 0.1 ? ` — ${r.offFoot} m off the boot, WRONG` : ' on the boot'}`);
        }
        console.log(`  control               a stroke from the middle of him sits ${sw.offChest} m off the boot`
          + `${sw.offChest > 0.1 ? ' — so the clause names it' : ' — SO IT WOULD NOT BE NAMED'}`);
        console.log(`  the shapes differ     ${sw.shapesOrdered ? 'high the narrowest, then the standing kick, the sweep and the stomp widest' : 'NO — all four draw the same width'}`
          + `; ${sw.reusedBuffer ? 'all four reuse the one ribbon' : 'EACH KICK BUILDS A NEW RIBBON'}, gone ${sw.went ? 'once the swing ended' : 'NEVER'}`);
        console.log(`  the legs themselves   ${Object.entries(sw.profiles || {}).map(([t, r]) => `${t} ${r.path} m of travel, ${r.rise} m of it rise`).join('; ')}`);
      }
      if (k.detail) console.log(`  ${k.detail}`);
    }
    if (cc) {
      if (c || k || d) console.log('');
      const weldBudget = cc.limits ? cc.limits.weldShare : 0.02;
      const boneLimit = cc.limits ? cc.limits.wrongBoneDistance : 0.6;
      console.log("The officer's own mesh file");
      console.log(`  ${pad('mesh', 12)}${pad('verts', 10)}${pad('sampled', 9)}${pad('unweighted', 12)}${pad('on one distant bone', 20)}verdict`);
      for (const m of cc.meshes) {
        const share = `${(m.farShare * 100).toFixed(1)}%`;
        const verdict = m.farShare > weldBudget
          ? `WRONG — ${(m.farShare * 100).toFixed(1)}% over the ${(weldBudget * 100).toFixed(0)}% budget, worst ${m.worstBone} at ${m.worst} m`
          : (m.worstBone
            ? `worst ${m.worstBone} at ${m.worst} m; ${(m.farShare * 100).toFixed(1)}% past the ${boneLimit} m limit, budget ${(weldBudget * 100).toFixed(0)}%`
            : 'no rigidly bound geometry');
        console.log(`  ${pad(m.name, 12)}${pad(m.verts, 10)}${pad(m.sampled, 9)}${pad(m.unweighted, 12)}${pad(share, 20)}${verdict}`);
      }
      if (cc.parts && cc.parts.length) {
        console.log(`  ${pad('bound parts', 22)}${cc.parts.map((m) => `${m.mesh} → ${m.bone} (${m.metres} m off, bottom ${m.bottom} m)`).join('; ')}`);
      }
      if (cc.misboundParts && cc.misboundParts.length) {
        console.log(`  ${pad('misbound', 22)}${cc.misboundParts.map((m) => `${m.mesh} on the ground but bound to ${m.bone}`).join('; ')} — WRONG`);
      }
      console.log(`  ${pad('his own boot', 22)}${cc.ownBoots.length
        ? cc.ownBoots.map((b) => `${b.mesh} on ${b.bone}, bottom ${b.bottom} m, ${b.size.join(' × ')} m`).join('; ')
        : `none in the mesh file, so the tier supplies it — the question is whether that boot covers his foot (${cc.footPoints} sampled vertices on his right foot)`}`);
      if (cc.initialBoot) {
        const b = cc.initialBoot;
        console.log(`  ${pad('boot he starts in', 22)}${b.socketed
          ? `${b.tier} (tier ${b.index}) from ${b.model}, ${b.span} m, worn without anything moving the tier — its sole ${b.sole} m, `
            + `${(b.coveredShare * 100).toFixed(1)}% of his foot inside it`
          : `NOTHING SOCKETED in ${b.tier} (tier ${b.index}) — he starts barefoot`}`);
      }
      if (cc.boots && cc.boots.length) {
        console.log(`  ${pad('boots, tier by tier', 22)}${pad('model', 18)}${pad('size', 8)}${pad('sole', 9)}${pad('level', 10)}${pad('toe', 10)}covers his foot`);
        for (const b of cc.boots) {
          const covers = b.coversFoot
            ? `yes — ${(b.coveredShare * 100).toFixed(1)}% of his foot vertices inside`
            : `NO — only ${(b.coveredShare * 100).toFixed(1)}% of his foot vertices inside`;
          const tiltLimit = cc.seatLimits ? cc.seatLimits.soleTilt : 8;
          const toeLimit = cc.seatLimits ? cc.seatLimits.toe : 25;
          const level = `${b.soleTilt}\u00b0${b.soleTilt > tiltLimit ? ' TILTED' : ' level'}`;
          const toe = b.toeDeg === null ? '—' : `${b.toeDeg}\u00b0${b.toeDeg > toeLimit ? ' AWAY' : ' on'}`;
          const along = b.centred ? '' : ` — ${b.centreGap > 0 ? 'too far forward' : 'hanging off the heel'} by ${Math.abs(b.centreGap)} m`;
          console.log(`  ${pad(b.tier, 22)}${pad(b.model || 'NONE', 18)}${pad(`${b.span} m`, 8)}${pad(`${b.sole} m`, 9)}${pad(level, 10)}${pad(toe, 10)}${b.socketed ? covers : 'NEVER SOCKETED'}${along}`);
        }
        if (cc.centreControl && cc.centreControl.measured) {
          console.log(`  ${pad('along control', 22)}the ${cc.centreControl.tier} slid ${cc.centreControl.movedBack} m back along the foot reads ${cc.centreControl.gap} m off centre — `
            + (cc.centreControl.namesIt ? 'named' : 'NOT NAMED'));
        }
        if (cc.seatControls && cc.seatControls.sole && cc.seatControls.sole.measured) {
          console.log(`  ${pad('seat control', 22)}rolled ${cc.seatControls.sole.rolledBy}\u00b0 the ${cc.seatControls.sole.tier} reads ${cc.seatControls.sole.tilt}\u00b0 off the ground — `
            + (cc.seatControls.sole.namesIt ? 'named' : 'NOT NAMED') + `; yawed ${cc.seatControls.toe.yawedBy}\u00b0 its toe reads ${cc.seatControls.toe.toe}\u00b0 off the foot's — `
            + (cc.seatControls.toe.namesIt ? 'named' : 'NOT NAMED'));
        }
        if (cc.coversControl && cc.coversControl.measured) {
          console.log(`  ${pad('control', 22)}the same measurement on the ${cc.coversControl.tier} shrunk to ${(cc.coversControl.shrink * 100).toFixed(0)}% `
            + `leaves ${(cc.coversControl.share * 100).toFixed(1)}% of his foot inside — `
            + (cc.coversControl.namesIt ? 'well short, so a boot too small would be named' : 'STILL INSIDE, so a boot too small would not be named'));
        }
      }
      if (cc.control) {
        console.log(`  ${pad('control', 22)}${cc.control.measured
          ? `${cc.control.beyondLimit}/${cc.control.bootSampled} of his own boot's vertices (${(cc.control.beyondLimitShare * 100).toFixed(1)}%) sit beyond `
            + `${cc.control.distanceLimit} m of ${cc.control.boneZero}, where an unweighted boot ends up — `
            + (cc.control.wouldNameIt
              ? `over the ${(cc.control.weldShareBudget * 100).toFixed(0)}% budget, so it would be named`
              : 'UNDER THE BUDGET, SO IT WOULD NOT BE NAMED')
          : 'nothing to measure it on: the officer has no own boot left to ask the question of'}`);
      }
      // Where he is actually drawn, state by state — the reading a player sees at
      // once and none of the campaign's own numbers can show.
      if (cc.states) {
        console.log('');
        console.log(`  ${pad('state he is drawn in', 26)}${pad('lowest point', 14)}verdict`);
        for (const [state, y] of Object.entries(cc.states)) {
          const under = y < cc.stateLimits.sink;
          const air = y > cc.stateLimits.float;
          const note = under ? 'UNDER THE GROUND' : air ? 'IN THE AIR' : 'standing';
          console.log(`  ${pad(state, 26)}${pad(`${y} m`, 14)}${note}`);
        }
        console.log(`  band: a standing officer's lowest drawn point stays between ${cc.stateLimits.sink} m and ${cc.stateLimits.float} m`);
        console.log(`  control: ${cc.footingControl.pass
          ? `lifting him a metre raised that floor by ${cc.footingControl.liftedBy} m — the measurement follows the rig`
          : `raising him a metre moved the reading by only ${cc.footingControl.liftedBy} m, so it is not measuring the body at all`}`);
      }
      // The rifle: welded into the hand, so it is only ever as right as the mount.
      if (cc.rifle) {
        console.log('');
        console.log(`  ${pad('rifle in his hand', 26)}${cc.rifle.loaded ? `${cc.rifle.length} m, on ${cc.rifle.hand}, muzzle at ${cc.rifle.muzzleEnd}` : 'NEVER LOADED'}`);
        console.log(`  ${pad('pose he holds it in', 26)}${pad('barrel off facing', 18)}${pad('muzzle ahead', 14)}magazine`);
        for (const [state, h] of Object.entries(cc.rifle.held || {})) {
          const cone = cc.rifle.limits ? cc.rifle.limits.coneDegrees : 35;
          const ahead = cc.rifle.limits ? cc.rifle.limits.inFront : 0.3;
          const down = cc.rifle.limits ? cc.rifle.limits.magazineY : -0.5;
          console.log(`  ${pad(state, 26)}${pad(`${h.degOff}\u00b0`, 18)}${pad(`${h.inFront} m`, 14)}${h.magazineY <= down ? 'under it' : 'NOT UNDER IT'}`
            + (h.degOff <= cone && h.inFront >= ahead && h.magazineY <= down ? '' : '  WRONG'));
        }
        console.log(`  limits: barrel within ${cc.rifle.limits ? cc.rifle.limits.coneDegrees : 35}\u00b0 of his facing, muzzle at least `
          + `${cc.rifle.limits ? cc.rifle.limits.inFront : 0.3} m ahead of his hand, magazine under him`);
        if (cc.rifle.control) {
          console.log(`  control: left as authored the rifle measures ${cc.rifle.control.degOff}\u00b0 off his aim and ${cc.rifle.control.inFront} m in front — `
            + (cc.rifle.control.namesIt ? 'the mount failure would be named' : 'SO IT WOULD NOT BE NAMED'));
        }
        if (cc.rifle.flash) {
          const on = cc.rifle.flash.toBarrel <= (cc.rifle.limits ? cc.rifle.limits.flashToBarrel : 0.15);
          console.log('');
          console.log(`  ${pad('where the round leaves', 26)}${cc.rifle.flash.shown ? 'flash fired' : 'NO FLASH'}, ${cc.rifle.flash.toBarrel} m from the rifle's own tip, `
            + `tracer from ${cc.rifle.flash.tracerFromBarrel === null ? 'NOWHERE' : `${cc.rifle.flash.tracerFromBarrel} m`} — ${on ? 'both on the barrel' : 'NOT ON THE BARREL'}`);
          console.log(`  ${pad('control', 26)}a point in front of his chest, which is what the flash used to be pinned to, sits `
            + `${cc.rifle.flash.standInOffBarrel} m off that tip — ${cc.rifle.flashControlNamesIt ? 'so the clause names it' : 'SO IT WOULD NOT BE NAMED'}`);
        }
      }
    }
    if (fat) {
      if (c || k || cc) console.log('');
      console.log('The fatality');
      if (fat.detail) console.log(`  ${fat.detail}`);
      console.log(`  the same attacker, held ${fat.distance} m up the aim line, shot down through each part in turn:`);
      console.log(`  ${pad('finishing round', 18)}${pad('the body', 16)}${pad('travelled', 11)}${pad('rose', 8)}${pad('turned', 9)}${pad('credit', 8)}verdict`);
      for (const [label, h] of [['through the head', fat.head], ['through the chest', fat.control]]) {
        if (!h) { console.log(`  ${pad(label, 18)}DID NOT RUN`); continue; }
        if (h.note) { console.log(`  ${pad(label, 18)}NEVER FINISHED HIM: ${h.note}`); continue; }
        const limit = fat.limits || {};
        const good = label === 'through the head'
          ? (h.threwTheBody && h.travelledMetres >= limit.travelMin && h.roseMetres >= limit.peakMin
            && h.turnedDegrees >= limit.tumbleMin && h.eliminations === 1)
          : (!h.threwTheBody && h.travelledMetres <= limit.stillMax && h.eliminations === 1);
        console.log(`  ${pad(label, 18)}${pad(h.threwTheBody ? 'thrown' : 'stayed put', 16)}`
          + `${pad(`${h.travelledMetres} m`, 11)}${pad(`${h.roseMetres} m`, 8)}${pad(`${h.turnedDegrees}\u00b0`, 9)}`
          + `${pad(h.creditPaid, 8)}${good ? 'as it should be' : 'WRONG'}`);
        if (label === 'through the head' && h.downingRound === 'head') {
          console.log(`  ${pad('', 18)}${h.shots} round(s) over ${h.secondsToDown}s to bleed him out, the last one through the head, `
            + `${h.offShotDegrees}\u00b0 off the shot that sent it${h.spinFromTheShotsSide ? ', tumbling away from the side the round came from' : ', TUMBLING THE WRONG WAY'}`);
        }
        console.log(`  ${pad('', 18)}${h.corpseWasATargetWhileAlive ? 'the line finds a living attacker' : 'THE LINE NEVER FOUND A LIVING ATTACKER'}, `
          + `${h.corpseIsNotATarget ? 'and finds only the ground once he is down' : 'AND STILL FINDS HIS FLUNG BODY'}`);
        console.log(`  ${pad('', 18)}announced "${h.banner}"`);
      }
      if (fat.weight !== undefined) {
        console.log(`  the weight both halves paid: ${fat.weight} of a tier point (the gunfire downing's), boot routs remain the full point`);
      }
    }
    if (d) {
      if (c || k || cc || fat) console.log('');
      console.log('A wave with no ammunition');
      console.log(`  ${pad('rounds', 26)}none in the magazine, none in the reserve, every frame`);
      console.log(`  ${pad('closed to boot range', 26)}${d.closedToBootRangeSeconds === null ? 'never' : `${d.closedToBootRangeSeconds}s`}`);
      console.log(`  ${pad('eliminations', 26)}${d.eliminations} (${d.bootEliminations} by boot)`);
      console.log(`  ${pad('wave ended', 26)}${d.cleared ? `after ${d.seconds}s` : 'NEVER'}`);
      if (!d.cleared && d.leftover.length) {
        console.log(`  left standing: ${JSON.stringify(d.leftover)}`);
      }
    }
    if (sweep) {
      if (c || k || d || cc || fat) console.log('');
      const control = sweep.control;
      console.log('Forest fairness');
      console.log(`  control: an empty field is ${control.openFair ? 'fair' : 'UNFAIR'}, and a trunk wall round the clearing is ${control.sealedUnfair ? 'unfair' : 'FAIR'} — ${control.pass ? 'the audit can tell them apart' : 'IT CANNOT TELL THEM APART'}`);
      console.log(`    the wall was rejected because: ${(control.sealedReasons || []).join('; ') || '(no reason given)'}`);
      console.log(`  ${pad('seed', 12)}${pad('layout', 11)}${pad('trees', 7)}${pad('props', 7)}${pad('ground', 9)}${pad('room', 7)}${pad('open', 8)}${pad('clearing', 10)}${pad('ring', 8)}${pad('pockets', 9)}verdict`);
      for (const f of sweep.seeds) {
        console.log(`  ${pad(f.seed, 12)}${pad(hex32(f.layoutHash), 11)}${pad(f.trees, 7)}${pad(f.props, 7)}`
          + `${pad(`${Math.round(f.reachableArea)}m²`, 9)}${pad(`${f.fieldRoom}m`, 7)}${pad(`${(f.openRadius * 2).toFixed(1)}m`, 8)}`
          + `${pad(`${Math.round(f.clearingOpenFraction * 100)}%`, 10)}${pad(`${Math.round(f.bandReachFraction * 100)}%`, 8)}`
          + `${pad(f.pockets.count, 9)}${f.pass ? 'fair' : 'NOT FAIR'}`);
      }
      console.log('  ground: m² of connected ground the officer and attackers can both stand on;');
      console.log('  room: mean clear space around a point on the fighting ground — the ring from the clearing edge out to the');
      console.log('  far side of the spawn ring; open: diameter of the widest clear circle there; clearing: share of the clearing');
      console.log('  that is standable; ring: share of the 26-38 m attacker spawn ring that can reach the officer; pockets: sealed-off ground.');
      for (const f of sweep.seeds) {
        for (const r of f.reasons) console.log(`  seed ${f.seed}: ${r}`);
      }
      if (!sweep.matchesPlayed) {
        console.log(`  the seed the page is playing (${sweep.playedSeed}) rebuilt to layout ${hex32(sweep.seeds.find((f) => f.seed === sweep.playedSeed)?.layoutHash ?? 0)} instead of ${hex32(sweep.playedLayoutHash)}`);
      }
      const drift = report.forestDrift;
      if (drift) {
        console.log('');
        const when = drift.recordedAt ? `, recorded ${drift.recordedAt}` : '';
        console.log(`  drift since ${path.basename(forestBaselinePath)}${when}, tolerance ${Math.round(drift.tolerance * 100)}%`
          + (drift.accepted ? ' — accepted, this sweep is the new baseline' : ''));
        for (const note of drift.notes || []) console.log(`    ${note}`);
        if (drift.metrics.length) {
          console.log(`    ${pad('metric', 24)}${pad('was (min / mean)', 22)}${pad('now (min / mean)', 22)}moved`);
          for (const m of drift.metrics) {
            const was = `${m.wasMin} / ${m.wasMean}${m.unit}`;
            const now = `${m.nowMin} / ${m.nowMean}${m.unit}`;
            const verdict = m.moved ? `${m.changePercent > 0 ? '+' : ''}${m.changePercent}% ${m.tightened ? 'TIGHTER' : 'looser'}` : '—';
            console.log(`    ${pad(m.label, 24)}${pad(was, 22)}${pad(now, 22)}${verdict}`);
          }
        }
        for (const f of drift.forests || []) {
          if (f.missing) console.log(`    seed ${f.seed}: in the baseline but not audited this run`);
          else console.log(`    seed ${f.seed}: ${driftSeedBits(f).join('; ')}`);
        }
        console.log(`    ${drift.compared} forest(s) compared, and ${drift.forests.length} moved by more than the tolerance.`);
      }
    }
    if (passed.ok) {
      console.log(`\nPASS — ${[c && 'a press retargets to the attacker nearest the crosshair and a held trigger keeps its target', k && 'the three kicks differ, the scenery they launch settles where it lands, and the impact feels as heavy as the mass it hit', cc && "the officer's own mesh file is fully weighted, nothing is welded to a bone it does not sit on, he is drawn standing on the ground in every state he can be posed in, and he is holding his rifle rather than wearing it", d && 'a wave can be won with no ammunition left, by closing and booting', sweep && 'every forest audited is one a wave can actually be fought in'].filter(Boolean).join('; ')}.`);
    } else {
      console.log('\nFAIL');
      for (const reason of passed.reasons) console.log(`  - ${reason}`);
    }
    // A probe can still have something worth knowing that is not a failure — a
    // forest that has got tighter, most of all — and the campaign path is not the
    // only one that should hear it.
    if (passed.findings?.length) {
      console.log('\nWorth knowing');
      for (const finding of passed.findings) console.log(`  - ${finding}`);
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

  if (report.forest) {
    const f = report.forest;
    console.log('');
    console.log(`Forest seed ${report.worldSeed} (layout ${hex32(report.layoutHash)}): ${f.trees} trees and ${f.props} props, `
      + `${Math.round(f.reachableArea)} m² of connected ground, `
      + `${f.fieldRoom} m of elbow room on the fighting ground, `
      + `${Math.round(f.clearingOpenFraction * 100)}% of the clearing standable, `
      + `${Math.round(f.bandReachFraction * 100)}% of the attacker spawn ring reachable — `
      + (f.pass ? 'fair to fight in.' : `NOT FAIR: ${f.reasons.join('; ')}.`));
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

/**
 * The fuzz summary: every seed it played, and every seed that could not finish a
 * wave. A stall is the failure this mode exists to find, so it is named with the
 * wave, what the officer had left to shoot with, and whoever was still standing.
 */
function printFuzz(runs, layoutsDiffer = true) {
  const pad = (s, n) => String(s).padEnd(n);
  const bad = runs.filter((r) => !r.finished);
  const unfair = runs.filter((r) => r.fair === false);
  const layouts = new Set(runs.map((r) => r.layoutHash).filter((h) => h !== null && h !== undefined));
  const quietest = runs.reduce((a, r) => Math.max(a, r.quietestSeconds || 0), 0);
  console.log('');
  console.log(`Fuzzing the campaign across ${runs.length} seed(s)`);
  console.log(`  ${pad('seed', 12)}${pad('forest', 18)}${pad('outcome', 13)}${pad('sim', 10)}${pad('wave', 7)}${pad('eliminations', 16)}${pad('quietest', 11)}${pad('terrain', 10)}verdict`);
  for (const r of runs) {
    const verdict = r.finished
      ? 'finished every wave'
      : (r.stalledWave ? `wave ${r.stalledWave.wave} stalled` : `did not finish (${r.outcome})`);
    const forest = r.layoutHash === null || r.layoutHash === undefined
      ? `${r.worldSeed ?? '-'}`
      : `${r.worldSeed}/${hex32(r.layoutHash)}`;
    console.log(`  ${pad(r.seed, 12)}${pad(forest, 18)}${pad(r.outcome || '-', 13)}${pad(`${r.seconds}s`, 10)}`
      + `${pad(r.wavesReached ?? '-', 7)}${pad(`${r.eliminations} (${r.bootEliminations} boot)`, 16)}`
      + `${pad(`${r.quietestSeconds}s`, 11)}${pad(r.fair === true ? 'fair' : r.fair === false ? 'NOT FAIR' : '-', 10)}${verdict}`);
  }
  console.log('');
  console.log(`  forests: ${layouts.size} distinct layout(s) across ${runs.length} seed(s)`);
  console.log('');
  if (!bad.length && !unfair.length && layoutsDiffer) {
    console.log(`PASS — all ${runs.length} seed(s) finished every wave, in ${layouts.size} different forest(s), every one of them fair to fight in. The quietest stretch of any wave was ${quietest}s.`);
    return;
  }
  if (!layoutsDiffer) {
    console.log(`FAIL — ${runs.length} seed(s) built only ${layouts.size} layout(s): the forest seed is not reaching the world, so this run was not fuzzing the terrain at all.`);
  }
  if (bad.length) console.log(`FAIL — ${bad.length} of ${runs.length} seed(s) could not finish a wave:`);
  for (const r of bad) {
    if (r.stalledWave) {
      const s = r.stalledWave;
      console.log(`  seed ${r.seed}: wave ${s.wave} stalled for ${s.stalledFor}s with ${s.hostiles} attacker(s) left`
        + `${s.playerAmmo ? `, officer's ammo [${s.playerAmmo[0]} in the mag, ${s.playerAmmo[1]} reserve]` : ''}`);
      for (const l of s.leftovers) console.log(`      left standing: ${l}`);
    } else {
      console.log(`  seed ${r.seed}: ${r.outcome} after ${r.seconds}s, reached wave ${r.wavesReached}`);
    }
    for (const e of r.errors.slice(0, 3)) console.log(`      ${e}`);
  }
  if (unfair.length) {
    console.log(`FAIL — ${unfair.length} of ${runs.length} seed(s) played a forest no wave could be fought in, so a stall there would not have been the pilot's fault:`);
    for (const r of unfair) {
      const forest = r.layoutHash === null || r.layoutHash === undefined ? `${r.seed}` : `${r.seed}/${hex32(r.layoutHash)}`;
      console.log(`  seed ${forest}: ${r.forestReasons.join('; ')}`);
    }
  }
}

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
