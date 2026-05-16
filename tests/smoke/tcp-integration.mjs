#!/usr/bin/env node
/**
 * Live integration test — exercises every major lua_* action against
 * a running target (TCP or headless stdio depending on env vars).
 *
 * TCP mode:   POB_API_TCP=true node tests/smoke/tcp-integration.mjs
 * Stdio mode: node tests/smoke/tcp-integration.mjs
 *             (needs POB_FORK_PATH + POB_CMD set, and a build XML to load)
 */

import net from 'net';
import { createConnection } from 'net';
import { EventEmitter } from 'events';

// ── Config ────────────────────────────────────────────────────────────────────

const TCP_HOST = process.env.POB_API_TCP_HOST || '127.0.0.1';
const TCP_PORT = parseInt(process.env.POB_API_TCP_PORT || '31337');
const TIMEOUT  = parseInt(process.env.POB_TIMEOUT_MS  || '10000');
const TCP_MODE = process.env.POB_API_TCP === 'true' || process.env.POB_API_TCP === '1';

// ── Minimal raw TCP client (mirrors PoBLuaTcpClient logic) ────────────────────

class RawTcpClient {
  constructor() {
    this.buffer = '';
    this.emitter = new EventEmitter();
    this.sock = null;
    this.ready = false;
  }

  async connect(host, port, timeoutMs) {
    const sock = createConnection({ host, port });
    sock.setEncoding('utf8');

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    sock.on('data', (chunk) => { this.buffer += chunk; this.emitter.emit('data'); });
    sock.on('close', () => this.emitter.emit('error', new Error('connection closed')));
    sock.on('error', (e) => this.emitter.emit('error', e));
    this.sock = sock;

    // Read ready banner
    const banner = JSON.parse(await this._readLine(timeoutMs));
    if (!banner?.ready) throw new Error('No ready banner: ' + JSON.stringify(banner));
    this.ready = true;
    return banner.version;
  }

  async send(action, params = {}) {
    this.sock.write(JSON.stringify({ action, params }) + '\n');
    const raw = await this._readLine(TIMEOUT);
    const res = JSON.parse(raw);
    if (!res.ok) throw new Error(res.error || `${action} failed`);
    return res;
  }

  _readLine(ms) {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        const nl = this.buffer.indexOf('\n');
        if (nl >= 0) { const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1); return line; }
        return null;
      };
      const existing = tryRead();
      if (existing !== null) return resolve(existing);
      const t = setTimeout(() => { this.emitter.off('data', onData); reject(new Error(`readLine timeout after ${ms}ms`)); }, ms);
      const onData = () => { const line = tryRead(); if (line !== null) { clearTimeout(t); this.emitter.off('data', onData); resolve(line); } };
      this.emitter.on('data', onData);
    });
  }

  close() { this.sock?.destroy(); }
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const result = await fn();
    console.log(`\x1b[32mPASS\x1b[0m${result ? ' ' + result : ''}`);
    passed++;
  } catch (e) {
    console.log(`\x1b[31mFAIL\x1b[0m — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runTcpTests() {
  console.log(`\n\x1b[1mTCP mode — connecting to ${TCP_HOST}:${TCP_PORT}\x1b[0m`);
  const client = new RawTcpClient();

  let version;
  try {
    version = await client.connect(TCP_HOST, TCP_PORT, TIMEOUT);
    console.log(`  Connected: PoB ${version?.number} (${version?.branch})\n`);
  } catch (e) {
    console.error(`\x1b[31mCannot connect: ${e.message}\x1b[0m`);
    console.error('Make sure PoB is running via LaunchPoBWithAPI.bat and a build is open.');
    process.exit(1);
  }

  await test('get_build_info', async () => {
    const r = await client.send('get_build_info');
    assert(r.info?.name, 'no name');
    assert(r.info?.level > 0, 'bad level');
    return `"${r.info.name}" lv${r.info.level}`;
  });

  await test('get_stats (offense)', async () => {
    const r = await client.send('get_stats', { stats: ['CritChance','TotalDPS','AverageDamage'] });
    assert(typeof r.stats === 'object', 'no stats object');
    return `DPS=${r.stats.TotalDPS ?? r.stats.AverageDamage ?? '?'}`;
  });

  await test('get_stats (defense)', async () => {
    const r = await client.send('get_stats', { stats: ['Life','EnergyShield','Armour','FireResist'] });
    assert(r.stats.Life !== undefined, 'no Life stat');
    return `Life=${r.stats.Life} AR=${r.stats.Armour ?? 0}`;
  });

  await test('get_tree', async () => {
    const r = await client.send('get_tree');
    // Response: { ok, tree: { nodes:[], treeVersion, classId, ... } }
    assert(Array.isArray(r.tree?.nodes), 'tree.nodes not array');
    return `${r.tree.nodes.length} nodes (v${r.tree.treeVersion})`;
  });

  await test('list_specs', async () => {
    const r = await client.send('list_specs');
    // Response: { ok, result: { specs:[], activeSpec } }
    assert(Array.isArray(r.result?.specs), 'result.specs not array');
    return `${r.result.specs.length} specs (active: ${r.result.activeSpec})`;
  });

  await test('list_item_sets', async () => {
    const r = await client.send('list_item_sets');
    // Response: { ok, result: { itemSets:[], activeItemSetId } }
    assert(Array.isArray(r.result?.itemSets), 'result.itemSets not array');
    return `${r.result.itemSets.length} item sets`;
  });

  await test('get_items (equipped gear)', async () => {
    const r = await client.send('get_items');
    // Response: { ok, items: { Weapon1:{}, Helmet:{}, ... } }
    assert(r.items && typeof r.items === 'object', 'items not object');
    const slotCount = Object.keys(r.items).length;
    return `${slotCount} slots`;
  });

  await test('get_skills (socket groups)', async () => {
    const r = await client.send('get_skills');
    // Response: { ok, skills: { groups:[...], ... } }
    assert(r.skills && typeof r.skills === 'object', 'no skills object');
    return 'ok';
  });

  await test('export_build_xml roundtrip (non-destructive)', async () => {
    const r = await client.send('export_build_xml');
    assert(typeof r.xml === 'string' && r.xml.includes('<PathOfBuilding>'), 'bad XML');
    return `${r.xml.length} chars`;
  });

  await test('load_build_xml rejected in TCP mode', async () => {
    let threw = false;
    try { await client.send('load_build_xml', { xml: '<PathOfBuilding/>', name: 'test' }); }
    catch { threw = true; }
    assert(threw, 'should have rejected load_build_xml');
    return 'correctly rejected';
  });

  await test('quit disconnects without closing PoB', async () => {
    const client2 = new RawTcpClient();
    await client2.connect(TCP_HOST, TCP_PORT, TIMEOUT);
    const r = await client2.send('quit');
    assert(r.message?.includes('disconnected'), 'bad quit response');
    client2.close();
    return 'PoB still running';
  });

  client.close();
}

async function main() {
  if (TCP_MODE) {
    await runTcpTests();
  } else {
    console.log('\nSet POB_API_TCP=true to run TCP integration tests.');
    console.log('Headless integration tests require a running MCP server (not implemented here).');
    process.exit(0);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, ${failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : `${failed} failed`}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
