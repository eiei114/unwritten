# UNWRITTEN

This world doesn't exist until you walk into it.

UNWRITTEN is an open-world 3D exploration game with no level files and no audio files. As you walk toward the edge of the map, an OpenClaw agent running **Kimi K3.1 Pro on Cerebras** designs the next 40 m region: its terrain, landmarks, characters and what they say, fragments of lore, a quest, and the region's own music and soundscape. The engine builds it in front of you while the design is still streaming in. Every region is saved, so the world keeps growing.

Built for the Cerebras × Kimi K3.1 Pro × OpenClaw Weekend Hackathon. #KimiOnCerebras

## Demo and posts

The demo video (55 s, real time; only the waits in the Cerebras queue are trimmed) is attached to these posts:

- X (official submission): https://x.com/KEisuke62350514/status/2124533427999486057
- Reddit, r/Cerebras: https://www.reddit.com/r/Cerebras/comments/1y2srr7/tried_realtime_open_world_generation_with_kimi/
- Discord, Cerebras server: https://discord.com/channels/1085960591052644463/1574094046517792868

## What you see

- **The edge of the written world.** Beyond the regions Kimi has written there is only a void. Where Kimi is writing right now, a glowing blueprint grid and beams of light appear with "Kimi is writing this region…", then the ground rises out of the void and landmarks drop from the sky.
- **KIMI IS WRITING THIS WORLD.** The panel at the top shows the generation speed of the latest region: tokens per second, tokens, and seconds.
- **World log.** The panel on the right streams Kimi's reasoning and every line it writes, as it writes it.
- **Things to do.** Collect memory shards (each holds a line of lore), talk to the characters, follow the compass to each region's quest, and keep walking. The characters and lore all hint at one mystery: someone is writing this world as you explore it.

## How it works

```
browser ──SSE── server.mjs ──/v1/chat/completions (stream)── OpenClaw Gateway ── worldwriter agent ── Kimi K3.1 Pro on Cerebras
```

1. The client keeps the regions around the explorer, and two steps ahead in the walking direction, requested (up to two at a time; three in film mode).
2. For each region the `worldwriter` OpenClaw agent writes a short design in a line format:

   ```
   REGION|Typewriter Monsoon|teal|terraces|4|🐌
   SOUND|108|phrygian|Eb|pluck|rain|open
   MELODY|Eb4 E4 Gb4 Ab4 Bb4 Db5 B4 Ab4 Gb4 E4 Eb4 - Bb4 Db5 Ab4 -
   QUEST|Recover the sentence causing this endless inkstorm|📜|30|8
   LANDMARK|tower|6|6|3|Clattering Clerestory
   NPC|🕯️|Proofreader Wren|29|18|Your map was blank this morning; someone added my name.
   SHARD|7|35|Every erased path still remembers the weight of walking.
   CREATURE|15|6
   SIGN|11|19|Wet ink: do not finish these sentences
   ```

   The prompt passes the region's coordinates, its neighbours' names (so the world stays continuous) and the names already used.
3. The browser builds each line as it arrives: a low-poly heightfield from the terrain type and hilliness (seeded noise, edges blended so regions join seamlessly), scattered grass, flowers, rocks and bushes, procedural landmark models, emoji characters with speech bubbles, glowing shards, and a quest beam.
4. Every region is appended to `.runtime/worlds/<world id>.jsonl`. Reloading continues the same world from its edges; `?fresh=1` starts a new one.

The `worldwriter` agent uses the minimal tool profile, no skills and no workspace file injection, so each request carries far fewer prompt tokens than a default agent.

### Sound without audio files

The sound follows the approach of [earshot](https://github.com/Leonxlnx/earshot)'s forge recipes: everything is synthesized from small recipes rather than recordings. `public/audio.js` plays each region's music from its SOUND and MELODY lines (scale, root, tempo, lead instrument, a 16-step melody, plus a generated bass, drums and chords), its ambience (wind, rain, bubbles, crickets, machines, fire or crowd, in a computed room), and every effect (footsteps, jumps, shards, quests, landmark impacts) from modal resonators, contact noise and filtered noise.

### What the speed numbers mean

- **tok/s** is model time only: completion tokens divided by the time from the first to the last token of that region, as timestamped by the OpenClaw Gateway's raw stream log (`openclaw gateway --raw-stream --raw-stream-path .runtime/raw-stream.jsonl`). Waiting in the Cerebras queue is excluded and shown separately ("queue Ns, not counted").
- While a region is streaming, and whenever the Gateway does not report usage, the value is an estimate marked `≈` (streamed deltas × the tokens-per-delta ratio measured on earlier runs).
- During the hackathon we measured about 250–350 tok/s for region designs, consistent with Cerebras' own server-side `time_info` for the same prompt.

## Run it

Requirements: Node 22+, [OpenClaw](https://docs.openclaw.ai) 2026.11 with the Cerebras provider plugin, and access to `moonshotai-kimi-k3.1-pro-trial`.

1. Install OpenClaw and the Cerebras plugin, then onboard with your Cerebras key:

   ```bash
   npm install -g openclaw@latest
   openclaw plugins install @openclaw/cerebras-provider
   openclaw onboard --auth-choice cerebras-api-key
   ```

2. Merge this into `~/.openclaw/openclaw.json`. It declares the Kimi model (the built-in Cerebras catalog does not list it), makes it the default, and enables the Gateway's chat completions endpoint:

   ```json
   {
     "agents": {
       "defaults": {
         "model": { "primary": "cerebras/moonshotai-kimi-k3.1-pro-trial" },
         "thinkingDefault": "low"
       }
     },
     "gateway": {
       "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
     },
     "models": {
       "mode": "merge",
       "providers": {
         "cerebras": {
           "baseUrl": "https://api.cerebras.ai/v1",
           "api": "openai-completions",
           "models": [
             {
               "id": "moonshotai-kimi-k3.1-pro-trial",
               "name": "Kimi K3.1 Pro (Cerebras trial)",
               "reasoning": true,
               "input": ["text", "image"],
               "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
               "compat": {
                 "supportsTools": true,
                 "supportsStrictMode": false,
                 "supportsReasoningEffort": true,
                 "supportedReasoningEfforts": ["low", "high", "max"]
               }
             }
           ]
         }
       }
     }
   }
   ```

3. Add the lean world-design agent:

   ```bash
   openclaw agents add worldwriter --non-interactive --workspace ~/.openclaw/workspace-worldwriter --model cerebras/moonshotai-kimi-k3.1-pro-trial
   ```

   Then, in `~/.openclaw/openclaw.json` under `agents.entries.worldwriter`, add `"tools": { "profile": "minimal" }`, `"skills": []` and `"contextInjection": "never"`.

4. Start the Gateway with its raw stream log, then the app:

   ```bash
   openclaw gateway --raw-stream --raw-stream-path .runtime/raw-stream.jsonl
   npm start
   ```

5. Open <http://localhost:5173>. Kimi starts writing the place where you wake up; click or press Space when it is ready.

`server.mjs` is a dependency-free Node relay that keeps the Gateway token on the server (it reads it from `~/.openclaw/openclaw.json`). Override with `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_AGENT`, `OPENCLAW_WORLD_AGENT`, `OPENCLAW_RAW_STREAM_PATH` or `PORT`. Keep the Gateway on loopback: its HTTP endpoint is operator-level access to your OpenClaw instance. The server also still carries the modes of earlier experiments from the same weekend (an ogiri joke generator, a prompt-built shooter level and a side-scrolling runner).

## Controls

| Input | Action |
| --- | --- |
| W A S D / arrow keys | move |
| mouse (click to lock) or drag, Q / E | look around |
| Space | jump |
| Shift | run |
| M | sound on / off |

URL options: `?fresh=1` new world, `?autopilot=1` let the explorer walk on its own (shown as AUTO), `?film=1` recording mode (no title card, cutaway camera onto the region being written).

## License

MIT
