#!/usr/bin/env node
/**
 * Post-install smoke test — exercises every major tool category through the
 * full MCP server stack (spawn → initialize → tools/call → validate response).
 *
 * Requirements:
 *   - pob-mcp built:   npm run build  (in pob-mcp/)
 *   - PoB running via: LaunchPoBWithAPI.bat (for Tier 4 live-build tests)
 *
 * Usage:
 *   # All tiers (requires PoB running):
 *   POB_API_TCP=true node tests/smoke/mcp-tool-smoke.mjs
 *
 *   # Skip live PoB tests (Tiers 1-2 only):
 *   node tests/smoke/mcp-tool-smoke.mjs
 *
 * Exit code: 0 = all non-skipped tiers passed, 1 = any failure.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '../../build/index.js');
const TCP_MODE = process.env.POB_API_TCP === 'true' || process.env.POB_API_TCP === '1';

// ── Colour helpers ─────────────────────────────────────────────────────────────
const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

// ── MCP stdio client ──────────────────────────────────────────────────────────

class McpClient {
  constructor() {
    this.proc = null;
    this.msgId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    const env = {
      ...process.env,
      POB_LUA_ENABLED: 'true',
      POB_API_TCP: process.env.POB_API_TCP || 'false',
      POB_API_TCP_PORT: process.env.POB_API_TCP_PORT || '31337',
      POE_TRADE_ENABLED: 'false',       // don't need trade for smoke
      POB_RECONNECT_TIMEOUT_MS: '5000', // fail fast
      POB_TIMEOUT_MS: '10000',
      // POB_DIRECTORY is required — use env or a safe fallback
      POB_DIRECTORY: process.env.POB_DIRECTORY || process.env.USERPROFILE
        ? `${process.env.USERPROFILE}\\Documents\\Path of Building`
        : '/tmp/pob-builds',
    };

    this.proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.proc.stderr.on('data', () => {}); // suppress startup noise

    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch { /* ignore non-JSON lines */ }
    });

    // MCP initialize handshake
    await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    });
    await this._send('notifications/initialized', {}, true);
  }

  async call(toolName, args = {}) {
    const result = await this._send('tools/call', { name: toolName, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    return { result, text };
  }

  async listTools() {
    return this._send('tools/list', {});
  }

  async stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  _send(method, params, notification = false) {
    const id = notification ? undefined : this.msgId++;
    const msg = { jsonrpc: '2.0', method, params, ...(id != null ? { id } : {}) };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    if (notification) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 12000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject:  e => { clearTimeout(t); reject(e); },
      });
    });
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const results = []; // { tier, name, status, note }

async function test(tier, name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const note = await fn();
    console.log(GREEN('PASS') + (note ? '  ' + note : ''));
    passed++;
    results.push({ tier, name, status: 'pass', note: note || '' });
  } catch (e) {
    console.log(RED('FAIL') + '  ' + e.message);
    failed++;
    results.push({ tier, name, status: 'fail', note: e.message });
  }
}

function skip(tier, name, reason) {
  console.log(`  ${name} ... ${YELLOW('SKIP')}  ${reason}`);
  skipped++;
  results.push({ tier, name, status: 'skip', note: reason });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertText(text, pattern, msg) {
  const ok = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  if (!ok) throw new Error(msg || `Expected "${pattern}" in:\n${text.slice(0, 200)}`);
}

// ── Tier 1: Tool schema validation (no PoB) ───────────────────────────────────

async function runTier1(client) {
  console.log(BOLD('\nTier 1 — Tool registry (no PoB needed)'));

  await test('tier1', 'tools/list returns non-empty list', async () => {
    const r = await client.listTools();
    assert(Array.isArray(r?.tools) && r.tools.length > 0, 'no tools returned');
    return `${r.tools.length} tools registered`;
  });

  await test('tier1', 'plan_tree_paths is registered', async () => {
    const r = await client.listTools();
    const tool = r.tools.find(t => t.name === 'plan_tree_paths');
    assert(tool, 'plan_tree_paths not found');
    assert(tool.inputSchema?.properties?.target_node_ids, 'missing target_node_ids param');
    return 'schema OK';
  });

  await test('tier1', 'find_path_to_node is registered', async () => {
    const r = await client.listTools();
    assert(r.tools.find(t => t.name === 'find_path_to_node'), 'not found');
    return 'OK';
  });

  await test('tier1', 'get_nearby_nodes is registered', async () => {
    const r = await client.listTools();
    assert(r.tools.find(t => t.name === 'get_nearby_nodes'), 'not found');
    return 'OK';
  });

  await test('tier1', 'plan_leveling is registered', async () => {
    const r = await client.listTools();
    assert(r.tools.find(t => t.name === 'plan_leveling'), 'not found');
    return 'OK';
  });

  await test('tier1', 'validate_build is registered', async () => {
    const r = await client.listTools();
    assert(r.tools.find(t => t.name === 'validate_build'), 'not found');
    return 'OK';
  });
}

// ── Tier 2: Handlers that work without PoB ────────────────────────────────────

async function runTier2(client) {
  console.log(BOLD('\nTier 2 — Handlers (no PoB needed)'));

  await test('tier2', 'list_builds — returns build list or empty message', async () => {
    const { text } = await client.call('list_builds');
    assertText(text, /builds|No builds/i, 'unexpected output');
    return 'OK';
  });

  await test('tier2', 'plan_leveling (Witch, no Lua) — returns act milestones', async () => {
    const { text } = await client.call('plan_leveling', { class_name: 'Witch', main_skill: 'Arc' });
    assertText(text, 'Act 1');
    assertText(text, 'Act 10');
    assertText(text, 'Arc');
    return 'all 10 acts present';
  });

  await test('tier2', 'plan_leveling (Ranger, Deadeye) — class-specific starter skill', async () => {
    const { text } = await client.call('plan_leveling', { class_name: 'Ranger', ascendancy: 'Deadeye' });
    assertText(text, 'Ranger');
    assertText(text, 'Deadeye');
    assertText(text, /Splitting Steel|Burning Arrow/);
    return 'OK';
  });

  await test('tier2', 'watch_status — returns status without crash', async () => {
    const { text } = await client.call('watch_status');
    assertText(text, /Status:|ENABLED|DISABLED/i);
    return 'OK';
  });

  await test('tier2', 'start_watching — reports directory', async () => {
    const { text } = await client.call('start_watching');
    // Either starts successfully or reports already enabled
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier2', 'stop_watching — stops or reports not active', async () => {
    const { text } = await client.call('stop_watching');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier2', 'get_recent_changes — returns message or list', async () => {
    const { text } = await client.call('get_recent_changes');
    assertText(text, /change|recent|watching/i);
    return 'OK';
  });

  await test('tier2', 'get_context_usage — returns usage stats', async () => {
    const { text } = await client.call('get_context_usage');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });
}

// ── Tier 3: Live PoB build tests (requires TCP connection) ────────────────────

async function runTier3(client) {
  console.log(BOLD('\nTier 3 — Live PoB (requires LaunchPoBWithAPI.bat)'));

  await test('tier3', 'lua_start — connects to PoB GUI', async () => {
    const { text } = await client.call('lua_start');
    assertText(text, /started successfully/i);
    return 'connected';
  });

  await test('tier3', 'lua_get_build_info — returns build name and level', async () => {
    const { text } = await client.call('lua_get_build_info');
    assertText(text, 'Name:');
    assertText(text, 'Level:');
    return 'OK';
  });

  await test('tier3', 'lua_get_stats (offense) — returns DPS-related stats', async () => {
    const { text } = await client.call('lua_get_stats', { category: 'offense' });
    assertText(text, /DPS|Damage|Speed/i);
    return 'OK';
  });

  await test('tier3', 'lua_get_stats (defense) — returns Life/ES/Resist', async () => {
    const { text } = await client.call('lua_get_stats', { category: 'defense' });
    assertText(text, /Life|Energy|Resist/i);
    return 'OK';
  });

  await test('tier3', 'lua_get_tree — returns node list', async () => {
    const { text } = await client.call('lua_get_tree', { include_node_ids: true });
    assertText(text, /allocated|node/i);
    return 'OK';
  });

  await test('tier3', 'get_build_stats — returns stat object', async () => {
    const { text } = await client.call('get_build_stats');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier3', 'list_specs — returns spec list', async () => {
    const { text } = await client.call('list_specs');
    assertText(text, /spec/i);
    return 'OK';
  });

  await test('tier3', 'get_skill_setup — returns socket groups', async () => {
    const { text } = await client.call('get_skill_setup');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier3', 'get_config — returns config object', async () => {
    const { text } = await client.call('get_config');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier3', 'get_nearby_nodes — returns notables within range', async () => {
    const { text } = await client.call('get_nearby_nodes', { max_distance: 3 });
    assertText(text, /Nearby Nodes|No notable|No allocated/i);
    return 'OK';
  });

  await test('tier3', 'search_tree_nodes — finds nodes by keyword', async () => {
    const { text } = await client.call('search_tree_nodes', { query: 'life', node_type: 'notable' });
    assertText(text, /node|found|search/i);
    return 'OK';
  });

  await test('tier3', 'validate_build — runs without crash', async () => {
    const { text } = await client.call('validate_build');
    assertText(text, /Validation|validation|build/i);
    return 'OK';
  });

  await test('tier3', 'plan_leveling (from loaded build) — reads class from Lua', async () => {
    const { text } = await client.call('plan_leveling', {});
    assertText(text, 'Act 1');
    assertText(text, 'Gem Link Progression');
    return 'OK';
  });

  await test('tier3', 'get_equipped_items — returns gear slots', async () => {
    const { text } = await client.call('get_equipped_items');
    assert(text.length > 0, 'empty response');
    return 'OK';
  });

  await test('tier3', 'export_build_summary — returns markdown summary', async () => {
    const { text } = await client.call('export_build_summary');
    assert(text.length > 10, 'suspiciously short summary');
    return `${text.length} chars`;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(BOLD('\n=== pob-mcp Post-Install Smoke Test ==='));
  console.log(`Mode: ${TCP_MODE ? 'TCP (live PoB)' : 'No TCP (Tiers 1-2 only)'}`);
  console.log(`Server: ${SERVER_PATH}\n`);

  const client = new McpClient();
  try {
    await client.start();
  } catch (e) {
    console.error(RED(`Failed to start MCP server: ${e.message}`));
    console.error('Make sure pob-mcp is built: npm run build');
    process.exit(1);
  }

  try {
    await runTier1(client);
    await runTier2(client);

    if (TCP_MODE) {
      await runTier3(client);
    } else {
      console.log(BOLD('\nTier 3 — Live PoB'));
      console.log(`  ${YELLOW('SKIPPED')} — set POB_API_TCP=true and launch PoB via LaunchPoBWithAPI.bat to run Tier 3`);
      skipped += 15; // approximate tier 3 test count
    }
  } finally {
    await client.stop();
  }

  // ── Summary table ────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));

  const tier1Results = results.filter(r => r.tier === 'tier1');
  const tier2Results = results.filter(r => r.tier === 'tier2');
  const tier3Results = results.filter(r => r.tier === 'tier3');

  function tierSummary(label, tierResults, wasSkipped = false) {
    if (wasSkipped) {
      console.log(`${label.padEnd(35)} ${YELLOW('SKIPPED')}`);
      return;
    }
    const p = tierResults.filter(r => r.status === 'pass').length;
    const f = tierResults.filter(r => r.status === 'fail').length;
    const total = tierResults.length;
    const icon = f > 0 ? RED('✗') : GREEN('✓');
    const score = f > 0 ? RED(`${p}/${total}`) : GREEN(`${p}/${total}`);
    console.log(`${label.padEnd(35)} ${icon} ${score}`);
    if (f > 0) {
      for (const r of tierResults.filter(x => x.status === 'fail')) {
        console.log(`  ${RED('↳')} ${r.name}: ${r.note}`);
      }
    }
  }

  tierSummary('Tier 1 (Tool registry)', tier1Results);
  tierSummary('Tier 2 (Handlers, no PoB)', tier2Results);
  tierSummary('Tier 3 (Live PoB)', tier3Results, !TCP_MODE);

  console.log('─'.repeat(60));
  console.log(`Total: ${GREEN(passed + ' passed')}, ${failed > 0 ? RED(failed + ' failed') : failed + ' failed'}, ${skipped} skipped`);

  if (failed === 0 && !TCP_MODE) {
    console.log(YELLOW('\nNote: Tier 3 skipped. Run with POB_API_TCP=true to test live PoB tools.'));
  } else if (failed === 0) {
    console.log(GREEN('\nAll tiers passed — pob-mcp is healthy.'));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
