// Danmaku Ogiri: a tiny relay between the browser and the OpenClaw Gateway.
// The browser never sees the Gateway token; every joke comes from an OpenClaw
// agent run (Kimi K3.1 Pro on Cerebras) through the Gateway's
// OpenAI-compatible /v1/chat/completions endpoint.
import { createServer } from 'node:http';
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 5173);
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789').replace(/\/$/, '');
const AGENT_MODEL = process.env.OPENCLAW_AGENT ?? 'openclaw/default';
// A lean agent for world generation: minimal tool profile, no skills, no workspace
// file injection, so each request carries far fewer prompt tokens.
const WORLD_AGENT = process.env.OPENCLAW_WORLD_AGENT ?? 'openclaw/worldwriter';
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayToken();
const PUBLIC_DIR = normalize(fileURLToPath(new URL('./public/', import.meta.url)));
// Written by `openclaw gateway --raw-stream --raw-stream-path <this file>`.
// Optional: without it the app still works, minus the thinking stream and speed meter.
const RAW_STREAM_PATH = process.env.OPENCLAW_RAW_STREAM_PATH ?? fileURLToPath(new URL('./.runtime/raw-stream.jsonl', import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;
// Every part Kimi writes is kept, so a world survives reloads and rate-limit gaps.
const WORLDS_DIR = fileURLToPath(new URL('./.runtime/worlds/', import.meta.url));
const WORLD_LINE = /^(RUN|GAP|ZONE|SIGN|SOUND|MELODY|REGION|QUEST|LANDMARK|NPC|SHARD|CREATURE)\|/i;
const cleanWorldId = (value) => String(value ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);

async function saveWorldPart(id, record) {
  await mkdir(WORLDS_DIR, { recursive: true });
  await appendFile(join(WORLDS_DIR, `${id}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
}

// Demo recordings (audio captured in the page) land in ./recordings for editing.
const RECORDINGS_DIR = fileURLToPath(new URL('./recordings/', import.meta.url));
async function handleRecording(req, res) {
  const name = cleanWorldId(new URL(req.url, 'http://localhost').searchParams.get('name')) || `rec-${Date.now()}`;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 60 * 1024 * 1024) return sendJson(res, 413, { error: 'recording too large' });
    chunks.push(chunk);
  }
  await mkdir(RECORDINGS_DIR, { recursive: true });
  const file = join(RECORDINGS_DIR, `${name}.webm`);
  await writeFile(file, Buffer.concat(chunks));
  sendJson(res, 200, { file, bytes: size });
}

async function handleWorld(req, res) {
  const id = cleanWorldId(new URL(req.url, 'http://localhost').searchParams.get('id'));
  if (!id) return sendJson(res, 400, { error: 'id is required' });
  let parts = [];
  try {
    const text = await readFile(join(WORLDS_DIR, `${id}.jsonl`), 'utf8');
    parts = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
  } catch {
    parts = [];
  }
  sendJson(res, 200, { id, parts });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readGatewayToken() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    return config.gateway?.auth?.token;
  } catch {
    return undefined;
  }
}

function answersPrompt(topic, count) {
  return [
    'あなたは大喜利の名人です。ツールは使わず、テキストだけで答えてください。',
    '',
    `お題：「${topic}」`,
    '',
    'ルール：',
    `- 回答を${count}個出す`,
    '- お題と同じ言語で答える（英語のお題なら英語で）',
    '- 1行に1個。日本語は30文字以内、英語は12語以内',
    '- 番号・記号・前置き・解説・まとめは一切書かない',
    '- 似た回答を避け、言葉遊び・あるある・シュール・皮肉など切り口を散らす',
  ].join('\n');
}

function levelPrompt(theme, count) {
  return [
    'You are the level designer of a horizontal bullet-hell shooter. Do not use tools; answer in plain text only.',
    '',
    `Theme: "${theme}"`,
    '',
    `Write exactly ${count} enemy lines, then one boss line. Output nothing else: no headings, no numbering, no blank lines, no explanations.`,
    '',
    'Enemy line format:',
    'E|<one emoji>|<short witty enemy name, max 4 words>|<move>|<attack>|<hp>',
    'Boss line format (the very last line):',
    'BOSS|<one emoji>|<boss name, max 5 words>|<taunt, max 10 words>',
    '',
    'move is one of: straight, wave, zigzag, dash, swoop',
    'attack is one of: none, aim, spread, ring',
    'hp is an integer from 1 to 5',
    '',
    'Rules:',
    '- Every enemy clearly fits the theme. Vary the emoji and make the names funny and specific.',
    '- Write names and the taunt in the language of the theme (English theme: English).',
    '- Ramp up the difficulty: early enemies are hp 1-2 with attack none or aim; later ones get spread, ring and hp 3-5.',
    '- Mix the moves so no two neighbouring lines look the same.',
  ].join('\n');
}

function worldPrompt(context, count) {
  const zone = String(context.zone ?? '').replace(/[|\n]/g, ' ').trim().slice(0, 40);
  const height = Math.min(6, Math.max(1, Math.round(Number(context.height)) || 2));
  const chunk = Math.max(1, Math.round(Number(context.chunk)) || 1);
  const used = Array.isArray(context.zones) ? context.zones.map((z) => String(z).replace(/[|\n]/g, ' ').slice(0, 40)).slice(-12) : [];
  return [
    'You are the world generator of an endless side-scrolling runner. The player runs to the right automatically and can only jump.',
    'Do not use tools. Answer in plain text only.',
    '',
    zone
      ? `Continue the world from where it ended: the current zone is "${zone}" and the ground height is ${height}. This is part ${chunk} of the journey.`
      : 'This is the very beginning of the world. Start with a ZONE line, then ease the player in.',
    used.length ? `Zone names already used (do not reuse): ${used.join(', ')}` : '',
    '',
    `Write exactly ${count} lines. Each line is one of:`,
    'RUN|<length 3-10>|<ground height 1-6>|<feature>',
    'GAP|<length 1-3>',
    'ZONE|<new zone name, max 4 words>|<color>|<one emoji for the creature that lives there>',
    'SOUND|<bpm 70-160>|<scale>|<root>|<lead>|<ambient>|<room>',
    'MELODY|<16 steps separated by spaces; each step is a note such as C4, F#4 or Bb3 (octaves 3 to 5), or - for a rest>',
    'SIGN|<a short sign the player reads, max 8 words>',
    '',
    'feature is one of: none, coins, high_coins, spikes, creature',
    'color is one of: red, orange, yellow, green, teal, blue, purple, pink, white',
    'scale is one of: major, minor, dorian, phrygian, lydian, pentatonic, blues',
    'root is one of: C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B',
    'lead is one of: bell, pluck, glass, square, pad, flute',
    'ambient is one of: wind, rain, bubbles, crickets, machines, fire, crowd, none',
    'room is one of: small, hall, cave, open',
    '',
    'Rules:',
    '- Right after every ZONE line, write one SOUND line and one MELODY line: the music and soundscape of that zone. The melody uses notes of the zone scale and fits its mood; the ambient and room fit the place.',
    '- Ground height changes by at most 2 between neighbouring RUN lines.',
    '- Never put two GAP lines next to each other, and put a RUN of length 4 or more after every GAP.',
    '- Start a new ZONE every 25 to 35 lines. Zones are surprising and vivid (for example "Candy Volcano" or "Server Room Jungle"), each with its own creature.',
    '- About one line in ten is a SIGN: a funny, slightly self-aware message from you, the author of this world, to the player.',
    '- Get harder as the journey goes on: more spikes, creatures and gaps in later parts.',
    '- Output nothing else: no headings, no numbering, no blank lines.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function regionPrompt(context) {
  const clean = (v, n = 40) => String(v ?? '').replace(/[|\n]/g, ' ').trim().slice(0, n);
  const rx = Math.round(Number(context.rx)) || 0;
  const rz = Math.round(Number(context.rz)) || 0;
  const neighbours = Object.entries(context.neighbours ?? {})
    .map(([side, name]) => `${clean(side, 6)}: "${clean(name)}"`)
    .slice(0, 4);
  const used = Array.isArray(context.used) ? context.used.map((n) => clean(n)).filter(Boolean).slice(-20) : [];
  const distance = Math.max(Math.abs(rx), Math.abs(rz));
  return [
    'You are the world designer of an open-world 3D exploration game. The world is a grid of square regions, each 40 by 40 meters. Inside a region, x runs east and z runs south, both from 0 to 39.',
    'Do not use tools. Answer in plain text only.',
    '',
    distance === 0
      ? 'Design region (0, 0): the place where the player wakes up. Make it gentle, inviting and full of curiosity.'
      : `Design region (${rx}, ${rz}), ${distance} regions away from where the player woke up. The further out, the stranger and more dramatic it gets.`,
    neighbours.length ? `Neighbouring regions that already exist (fit them so the world feels continuous): ${neighbours.join(', ')}` : '',
    used.length ? `Region names already used (do not reuse): ${used.join(', ')}` : '',
    '',
    'Write 22 to 30 lines, each one of:',
    'REGION|<name, max 4 words>|<color>|<terrain>|<hilliness 1-10>|<one emoji for the creatures that live here>',
    'SOUND|<bpm 70-160>|<scale>|<root>|<lead>|<ambient>|<room>',
    'MELODY|<16 steps separated by spaces; each step is a note such as C4, F#4 or Bb3 (octaves 3 to 5), or - for a rest>',
    'QUEST|<a one-line quest, max 10 words>|<one emoji for the thing to find>|<x>|<z>',
    'LANDMARK|<type>|<x>|<z>|<size 1-5>|<name, max 4 words>',
    'NPC|<one emoji>|<name, max 3 words>|<x>|<z>|<what they say to the player, max 14 words>',
    'SHARD|<x>|<z>|<a fragment of lore, max 12 words>',
    'CREATURE|<x>|<z>',
    'SIGN|<x>|<z>|<a short sign, max 8 words>',
    '',
    'The first three lines are REGION, SOUND and MELODY, in that order. Then write one QUEST, 3 to 5 LANDMARK, 2 or 3 NPC, 4 to 6 SHARD, 3 to 6 CREATURE and 1 or 2 SIGN lines.',
    'color is one of: red, orange, yellow, green, teal, blue, purple, pink, white',
    'terrain is one of: hills, plateaus, islands, canyon, dunes, crater, terraces, spires',
    'type is one of: tower, ruin, arch, statue, crystal, tree, house, obelisk, dome',
    'scale is one of: major, minor, dorian, phrygian, lydian, pentatonic, blues',
    'root is one of: C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B',
    'lead is one of: bell, pluck, glass, square, pad, flute',
    'ambient is one of: wind, rain, bubbles, crickets, machines, fire, crowd, none',
    'room is one of: small, hall, cave, open',
    '',
    'Rules:',
    '- Give the region a strong, surprising identity (for example "Clockwork Orchard" or "Sunken Library"); everything in it fits that identity, including the music.',
    '- NPC lines and shard lore hint at one shared mystery: someone is writing this world as the player explores it.',
    '- Keep every x and z between 3 and 36 and spread things out.',
    '- Output nothing else: no headings, no numbering, no blank lines.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function judgePrompt(topic, answers) {
  const list = answers.map((a, i) => `${i + 1}. ${a}`).join('\n');
  return [
    'あなたは大喜利の審査員です。ツールは使わず、テキストだけで答えてください。',
    `お題：「${topic}」`,
    '',
    '回答一覧：',
    list,
    '',
    '最も面白い回答を3つ選び、1位から順に、次の形のJSONだけを返してください。前置きやコードブロックは不要です。',
    'comment はお題と同じ言語の短い一言講評（日本語なら20文字以内、英語なら8語以内）。',
    '{"top":[{"n":回答番号,"comment":"講評"},{"n":回答番号,"comment":"講評"},{"n":回答番号,"comment":"講評"}]}',
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries while the Gateway reports it is still starting up.
async function callGateway(prompt, options) {
  for (let attempt = 1; ; attempt++) {
    const res = await callGatewayOnce(prompt, options);
    if (res.status !== 503 || attempt >= 10) return res;
    const text = await res.clone().text();
    if (!/starting/i.test(text)) return res;
    await sleep(1500);
  }
}

// Follows the Gateway's raw stream log for one agent run. Each model delta is
// logged with a millisecond timestamp, so the generation span excludes queueing.
class RawStreamFollower {
  constructor(onThink) {
    this.onThink = onThink;
    this.runId = null;
    this.pending = [];
    this.partial = '';
    this.offset = 0;
    this.firstTs = null;
    this.lastTs = null;
    this.thinkDeltas = 0;
    this.textDeltas = 0;
    this.timer = null;
    this.handle = null;
    this.reading = false;
  }

  async start() {
    try {
      this.offset = (await stat(RAW_STREAM_PATH)).size;
      this.handle = await open(RAW_STREAM_PATH, 'r');
    } catch {
      return false;
    }
    this.timer = setInterval(() => this.poll(), 40);
    return true;
  }

  setRunId(runId) {
    if (this.runId || !runId) return;
    this.runId = runId;
    for (const event of this.pending.splice(0)) this.consume(event);
  }

  async poll() {
    if (!this.handle || this.reading) return;
    this.reading = true;
    try {
      const { size } = await this.handle.stat();
      if (size <= this.offset) return;
      const length = Math.min(size - this.offset, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await this.handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      const lines = (this.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      this.partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!this.runId) this.pending.push(event);
        else this.consume(event);
      }
    } catch {
      // The log is best-effort; ignore read errors.
    } finally {
      this.reading = false;
    }
  }

  consume(event) {
    if (event.runId !== this.runId) return;
    if (event.evtType !== 'thinking_delta' && event.evtType !== 'text_delta') return;
    if (this.firstTs === null) this.firstTs = event.ts;
    this.lastTs = event.ts;
    if (event.evtType === 'thinking_delta') {
      this.thinkDeltas++;
      if (event.delta) this.onThink(event.delta);
    } else {
      this.textDeltas++;
    }
  }

  stats() {
    return {
      spanMs: this.firstTs === null ? 0 : this.lastTs - this.firstTs,
      thinkDeltas: this.thinkDeltas,
      textDeltas: this.textDeltas,
    };
  }

  async stop() {
    clearInterval(this.timer);
    while (this.reading) await sleep(10);
    await this.poll();
    await this.handle?.close();
    this.handle = null;
  }
}

function callGatewayOnce(prompt, { stream, signal, agent = AGENT_MODEL }) {
  return fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: agent,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function cleanTopic(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function handleOgiri(req, res) {
  const body = await readJson(req);
  const topic = cleanTopic(body.topic);
  const generative = body.mode === 'world' || body.mode === 'region';
  if (!topic && !generative) return sendJson(res, 400, { error: 'topic is required' });
  const count = Math.min(300, Math.max(10, Math.round(Number(body.count) || 100)));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let thinkBuffer = '';
  let lastMeter = '';
  const follower = new RawStreamFollower((delta) => {
    thinkBuffer += delta;
  });
  const following = await follower.start();
  const flush = () => {
    if (thinkBuffer) {
      send('think', { text: thinkBuffer });
      thinkBuffer = '';
    }
    const stats = follower.stats();
    const key = `${stats.spanMs}/${stats.thinkDeltas}/${stats.textDeltas}`;
    if (stats.spanMs && key !== lastMeter) {
      lastMeter = key;
      send('meter', stats);
    }
  };
  const flusher = following ? setInterval(flush, 60) : null;

  send('status', { phase: 'queued', agent: generative ? WORLD_AGENT : AGENT_MODEL, count, rawStream: following });
  let usage = null;
  let fullText = '';
  const worldId = generative ? cleanWorldId(body.worldId) : '';
  try {
    const prompt =
      body.mode === 'region'
        ? regionPrompt(body.context ?? {})
        : body.mode === 'world'
          ? worldPrompt(body.context ?? {}, count)
          : body.mode === 'level'
            ? levelPrompt(topic, count)
            : answersPrompt(topic, count);
    const agent = generative ? WORLD_AGENT : AGENT_MODEL;
    const upstream = await callGateway(prompt, { stream: true, signal: abort.signal, agent });
    if (!upstream.ok) {
      send('error', { message: `gateway ${upstream.status}: ${(await upstream.text()).slice(0, 300)}` });
    } else {
      for await (const data of sseData(upstream.body)) {
        if (data === '[DONE]') break;
        const event = JSON.parse(data);
        follower.setRunId(event.id);
        if (event.error) {
          send('error', { message: event.error.message ?? 'agent run failed' });
          continue;
        }
        const text = event.choices?.[0]?.delta?.content;
        if (text) {
          fullText += text;
          send('delta', { text });
        }
        if (event.usage) usage = event.usage;
      }
      if (following) {
        await sleep(150);
        await follower.stop();
        flush();
      }
      const stats = follower.stats();
      send('speed', {
        ...stats,
        completionTokens: usage?.completion_tokens ?? null,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      });
      send('done', {});
    }
  } catch (err) {
    if (!abort.signal.aborted) send('error', { message: String(err?.message ?? err) });
  } finally {
    clearInterval(flusher);
    await follower.stop();
    if (worldId) {
      const lines = fullText.split('\n').map((l) => l.trim()).filter((l) => WORLD_LINE.test(l));
      if (lines.length) {
        const stats = follower.stats();
        await saveWorldPart(worldId, {
          kind: body.mode,
          rx: body.mode === 'region' ? Math.round(Number(body.context?.rx)) || 0 : undefined,
          rz: body.mode === 'region' ? Math.round(Number(body.context?.rz)) || 0 : undefined,
          part: Math.max(1, Math.round(Number(body.context?.chunk)) || 1),
          at: new Date().toISOString(),
          lines,
          spanMs: stats.spanMs,
          completionTokens: usage?.completion_tokens ?? null,
        }).catch((err) => console.warn('could not save world part:', err.message));
      }
    }
  }
  res.end();
}

async function handleJudge(req, res) {
  const body = await readJson(req);
  const topic = cleanTopic(body.topic);
  const answers = Array.isArray(body.answers)
    ? body.answers.map((a) => String(a).trim().slice(0, 120)).filter(Boolean).slice(0, 300)
    : [];
  if (!topic || answers.length < 3) return sendJson(res, 400, { error: 'topic and at least 3 answers are required' });

  const upstream = await callGateway(judgePrompt(topic, answers), { stream: false });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return sendJson(res, 502, { error: payload.error?.message ?? `gateway ${upstream.status}` });

  const text = payload.choices?.[0]?.message?.content ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  let picks = [];
  try {
    picks = match ? JSON.parse(match[0]).top ?? [] : [];
  } catch {
    picks = [];
  }
  const seen = new Set();
  const top = picks
    .map((p) => ({ n: Number(p.n), comment: String(p.comment ?? '').slice(0, 80) }))
    .filter((p) => Number.isInteger(p.n) && p.n >= 1 && p.n <= answers.length && !seen.has(p.n) && seen.add(p.n))
    .slice(0, 3)
    .map((p) => ({ ...p, text: answers[p.n - 1] }));
  if (!top.length) return sendJson(res, 502, { error: 'judge returned no usable picks', raw: text.slice(0, 300) });
  sendJson(res, 200, { top });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/ogiri') return await handleOgiri(req, res);
    if (req.method === 'POST' && req.url === '/api/judge') return await handleJudge(req, res);
    if (req.method === 'GET' && req.url.startsWith('/api/world')) return await handleWorld(req, res);
    if (req.method === 'POST' && req.url.startsWith('/api/recordings')) return await handleRecording(req, res);
    if (req.method === 'GET') return await serveStatic(req, res);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Danmaku Ogiri: http://localhost:${PORT}`);
  console.log(`OpenClaw Gateway: ${GATEWAY_URL} (agent ${AGENT_MODEL})`);
  if (!TOKEN) console.warn('No Gateway token found. Set OPENCLAW_GATEWAY_TOKEN or configure ~/.openclaw/openclaw.json.');
});
