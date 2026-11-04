// agent.mjs - minimal Puppeteer + Ollama (gpt-oss:20b) browser agent
//
// Setup:
//   npm i puppeteer-core        (uses your installed Firefox; no Chrome download)
//   ollama pull gpt-oss:20b
// Run:
//   ALLOW_DOMAINS=wikipedia.org,duckduckgo.com node agent.mjs "Find when the Eiffel Tower was completed"
//
// Safety defaults: fresh disposable browser context (no saved passwords/cookies),
// asks you before visiting any domain not in ALLOW_DOMAINS, refuses to type into
// password fields, asks you before risky clicks or form submissions.

import puppeteer from 'puppeteer-core';
import readline from 'node:readline/promises';

const MODEL = process.env.MODEL ?? 'gpt-oss:20b';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 50);
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT ?? 45000); // ms to wait for a page to load
const THINK = process.env.THINK ?? 'medium'; // low | medium | high
const SHOW_THINKING = process.env.SHOW_THINKING !== '0'; // set SHOW_THINKING=0 to hide the monologue
// Always allowed. google.com also covers Google Maps (google.com/maps) and subdomains.
// ALLOW_DOMAINS adds to this list rather than replacing it.
const DEFAULT_ALLOW = ['duckduckgo.com', 'google.com', 'wikipedia.org'];
const ALLOW = [
  ...DEFAULT_ALLOW,
  ...(process.env.ALLOW_DOMAINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
];
const RISKY = /\b(buy|purchase|pay|checkout|order|submit|send|delete|remove|confirm|sign ?up|subscribe)\b/i;

const task = process.argv.slice(2).join(' ');
if (!task) {
  console.error('Usage: node agent.mjs "your task"');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Prompts are queued so two questions never overlap in the terminal.
let promptChain = Promise.resolve();
const confirm = q => {
  const run = promptChain.then(async () => (await rl.question(`${q} [y/N] `)).trim().toLowerCase() === 'y');
  promptChain = run.catch(() => {});
  return run;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Domains in ALLOW_DOMAINS pass automatically. Any other domain makes the script
// stop and ask you. Your answer is remembered for the rest of the run.
const approved = new Set();
const denied = new Set();
const pending = new Map(); // hosts currently being asked about, so each is asked only once

async function allowed(url) {
  if (url.startsWith('about:')) return true;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const matches = d => host === d || host.endsWith('.' + d);
  if (ALLOW.some(matches) || [...approved].some(matches)) return true;
  if ([...denied].some(matches)) return false;
  if (!pending.has(host)) {
    pending.set(
      host,
      confirm(`\nModel wants to visit ${host}. Allow?`).then(ok => {
        (ok ? approved : denied).add(host);
        pending.delete(host);
        return ok;
      }),
    );
  }
  return pending.get(host);
}

// ---- Tools exposed to the model -------------------------------------------
const tools = [
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Finish the task and report the answer or result.',
      parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    },
  },
];

const SYSTEM = `Your job is to take basic information on clients, as well as a provided recommendation, from the user, and fill in the appropriate areas on a the following template.
DO NOT alter any of the actual information, but DO rewrite it in a formal, nice, professional, and easily understandable way. Once you are done, respond with the finsished
filled template. Call the 'done' tool once you have finished. Use element ids from the current list only; ids change after every action.The template is as follows:
Dear [Client Name],

I hope this message finds you well. I wanted to take a moment to express my gratitude for your continued support and trust in our services. Your satisfaction is our top priority, and we are committed to providing you with the best experience possible.

[Recommendation]

We value your feedback and would love to hear your thoughts on how we can further improve our services. Please feel free to reach out to us at any time with any questions or concerns you may have.

Thank you once again for choosing us as your trusted partner. We look forward to serving you in the future.`;

// ---- Page snapshot: compact text instead of raw HTML -----------------------
async function snapshot(page) {
  const snap = await page.evaluate(() => {
    document.querySelectorAll('[data-agent-id]').forEach(e => e.removeAttribute('data-agent-id'));
    const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[onclick]';
    const elements = [];
    let id = 1;
    for (const el of document.querySelectorAll(sel)) {
      if (elements.length >= 40) break;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
      if (r.bottom < 0 || r.top > innerHeight) continue; // visible viewport only
      if (el.tagName === 'A') el.removeAttribute('target'); // keep navigation in one tab
      const label = (
        el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || el.title || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 60);
      el.setAttribute('data-agent-id', String(id));
      elements.push({
        id,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        label,
        href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 80) : '',
        url: el.tagName === 'A' ? el.href : '', // full absolute destination, used for the pre-click domain check
      });
      id++;
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      elements,
    };
  });
  const els = new Map(snap.elements.map(e => [e.id, e]));
  const list = snap.elements
    .map(e => `[${e.id}] ${e.tag}${e.type ? `(${e.type})` : ''} "${e.label}"${e.href ? ` -> ${e.href}` : ''}`)
    .join('\n');
  const text = `URL: ${snap.url}\nTITLE: ${snap.title}\nTEXT: ${snap.text}\nELEMENTS:\n${list || '(none visible)'}`;
  return { text, els };
}

// ---- Model call ------------------------------------------------------------
async function askModel(prompt) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      think: THINK, // gpt-oss accepts low | medium | high; low keeps it fast
      tools,
      options: { num_ctx: 16384, temperature: 0 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

  // Ollama streams one JSON object per line. Each chunk can carry a bit of
  // thinking text, a bit of reply text, or the tool call.
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = false;
  const tool_calls = [];

  const handle = line => {
    if (!line.trim()) return;
    const m = JSON.parse(line).message ?? {};
    if (m.thinking && SHOW_THINKING) {
      if (!thinking) {
        process.stdout.write(`\n${DIM}Thinking...\n`);
        thinking = true;
      }
      process.stdout.write(m.thinking);
    }
    if (m.content) {
      if (thinking) {
        process.stdout.write(`${RESET}\n`);
        thinking = false;
      }
      content += m.content;
      process.stdout.write(m.content);
    }
    if (m.tool_calls) tool_calls.push(...m.tool_calls);
  };

  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep any incomplete line for the next chunk
    lines.forEach(handle);
  }
  if (buffer) handle(buffer);
  if (thinking) process.stdout.write(`${RESET}\n`);

  return { content, tool_calls };
}

// ---- Action executor -------------------------------------------------------
async function act(page, call, els) {
  const name = call.function.name;
  let a = call.function.arguments ?? {};
  if (typeof a === 'string') a = JSON.parse(a);

  switch (name) {
    case 'goto': {
      let url = String(a.url);
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (!(await allowed(url))) return `Blocked: the user did not allow ${url}.`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        return `Opened ${url}`;
      } catch (e) {
        // A slow page is often still usable, so carry on with whatever has loaded.
        if (/timeout/i.test(e.message)) {
          return `Opened ${url}, but it was slow to finish loading, so the page may be incomplete.`;
        }
        throw e;
      }
    }
    case 'click': {
      const meta = els.get(Number(a.id));
      if (!meta) return `No element with id ${a.id}.`;
      if (meta.url && /^https?:/i.test(meta.url) && !(await allowed(meta.url))) {
        return `Blocked: the user did not allow ${new URL(meta.url).hostname}.`;
      }
      if (RISKY.test(meta.label) && !(await confirm(`Model wants to click "${meta.label}". Allow?`))) {
        return 'The user denied this click.';
      }
      const h = await page.$(`[data-agent-id="${a.id}"]`);
      if (!h) return 'That element no longer exists.';
      await h.click();
      return `Clicked [${a.id}] "${meta.label}"`;
    }
    case 'type': {
      const meta = els.get(Number(a.id));
      if (!meta) return `No element with id ${a.id}.`;
      if (meta.type === 'password') return 'Refused: password fields are off limits.';
      if (a.submit && !(await confirm(`Model wants to type "${a.text}" into [${a.id}] and press Enter. Allow?`))) {
        return 'The user denied this submission.';
      }
      const h = await page.$(`[data-agent-id="${a.id}"]`);
      if (!h) return 'That element no longer exists.';
      await h.click({ clickCount: 3 }); // select existing text
      await h.type(String(a.text));
      if (a.submit) await page.keyboard.press('Enter');
      return `Typed into [${a.id}]${a.submit ? ' and pressed Enter' : ''}`;
    }
    case 'scroll': {
      await page.evaluate(d => window.scrollBy(0, (d === 'up' ? -1 : 1) * innerHeight * 0.8), a.direction);
      return `Scrolled ${a.direction}`;
    }
    case 'back': {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      return 'Went back';
    }
    default:
      return `Unknown tool ${name}`;
  }
}

async function settle(page) {
  await Promise.race([page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {}), sleep(4000)]);
}

// ---- Main loop -------------------------------------------------------------
// Firefox via WebDriver BiDi. No userDataDir is passed, so Puppeteer uses a fresh
// temporary profile (none of your saved passwords, cookies, or history).


const history = [];
try {
  for (let step = 1; step <= MAX_STEPS; step++) {

    const prompt =
      `TASK: ${task}`;

    const msg = await askModel(prompt);
    const call = msg.tool_calls?.[0];

    if (call.function.name === 'done') {
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
      console.log('\nRESULT:', args.result);
      break;
    }

    if (step === MAX_STEPS) console.log('\nStopped: reached MAX_STEPS.');
  }
} finally {
  rl.close();

}
