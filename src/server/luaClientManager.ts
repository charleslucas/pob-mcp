/**
 * Lua Client Manager
 *
 * Manages the lifecycle of the PoB Lua bridge. Supports two modes:
 *
 *   Stdio mode (default): spawns a headless LuaJIT process.
 *     POB_LUA_ENABLED=true + POB_FORK_PATH + POB_CMD
 *
 *   TCP mode: connects to a running PoB GUI launched with POB_API_TCP=1.
 *     POB_LUA_ENABLED=true + POB_API_TCP=true
 *     Optional: POB_API_TCP_HOST (default 127.0.0.1), POB_API_TCP_PORT (default 31337)
 */

import { PoBLuaApiClient, PoBLuaTcpClient, type AnyLuaClient } from '../pobLuaBridge.js';

export class LuaClientManager {
  private client: AnyLuaClient | null = null;
  private enabled: boolean;
  private tcpMode: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.tcpMode = process.env.POB_API_TCP === 'true' || process.env.POB_API_TCP === '1';
  }

  getClient(): AnyLuaClient | null {
    return this.client;
  }

  /** Whether the manager is in TCP mode (connected to a running PoB GUI). */
  isTcpMode(): boolean {
    return this.tcpMode;
  }

  async ensureClient(): Promise<void> {
    if (!this.enabled) {
      throw new Error('PoB Lua Bridge is not enabled. Set POB_LUA_ENABLED=true to use lua_* tools.');
    }

    if (this.client) {
      if (this.client.isAlive()) return;
      if (this.tcpMode) {
        console.error('[Lua Bridge] PoB TCP connection lost — waiting for PoB to restart...');
      } else {
        console.error('[Lua Bridge] PoB headless process died — restarting...');
      }
      try { await this.client.stop(); } catch {}
      this.client = null;
    }

    if (this.tcpMode) {
      await this.startTcpClient();
    } else {
      await this.startStdioClient();
    }
  }

  private async startTcpClient(): Promise<void> {
    const host = process.env.POB_API_TCP_HOST || '127.0.0.1';
    const port = process.env.POB_API_TCP_PORT ? parseInt(process.env.POB_API_TCP_PORT) : 31337;
    // Per-attempt timeout: how long to wait for PoB to respond to a single connect + banner.
    const timeoutMs = process.env.POB_TIMEOUT_MS ? parseInt(process.env.POB_TIMEOUT_MS) : 10000;
    // Total reconnect window: how long to keep retrying before giving up.
    const reconnectMs = process.env.POB_RECONNECT_TIMEOUT_MS
      ? parseInt(process.env.POB_RECONNECT_TIMEOUT_MS)
      : 30000;
    const retryIntervalMs = 2000;

    const deadline = Date.now() + reconnectMs;
    let attempt = 0;

    while (true) {
      attempt++;
      const isRetry = attempt > 1;

      if (!isRetry) {
        console.error(`[Lua Bridge] Connecting to PoB GUI via TCP at ${host}:${port}...`);
      } else {
        const elapsed = Math.round((Date.now() - (deadline - reconnectMs)) / 1000);
        console.error(`[Lua Bridge] Retrying TCP connection (attempt ${attempt}, ${elapsed}s elapsed)...`);
      }

      try {
        const tcpClient = new PoBLuaTcpClient({ host, port, timeoutMs });
        await tcpClient.start();
        this.client = tcpClient;
        if (isRetry) {
          console.error(`[Lua Bridge] Reconnected to PoB GUI after ${attempt} attempts`);
        } else {
          console.error('[Lua Bridge] TCP connection established — working with build open in PoB GUI');
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes('ECONNREFUSED') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('timed out') ||
          msg.includes('Cannot connect') ||
          msg.includes('did not receive ready banner');

        if (!isTransient) {
          // Protocol or programming error — don't retry
          throw err;
        }

        const remaining = deadline - Date.now();
        if (remaining < retryIntervalMs) {
          const total = Math.round(reconnectMs / 1000);
          throw new Error(
            `Cannot connect to PoB GUI at ${host}:${port} after ${total}s (${attempt} attempts).\n` +
            `Make sure PoB is running via LaunchPoBWithAPI.bat with a build open.\n` +
            `Last error: ${msg.split('\n')[0]}\n\n` +
            `To increase the retry window, set POB_RECONNECT_TIMEOUT_MS (current: ${reconnectMs}ms).`
          );
        }

        console.error(`[Lua Bridge] PoB not ready (${msg.split('\n')[0]}), retrying in ${retryIntervalMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
      }
    }
  }

  private async startStdioClient(): Promise<void> {
    console.error('[Lua Bridge] Initializing headless stdio client...');

    const stdioClient = new PoBLuaApiClient({
      cwd: process.env.POB_FORK_PATH,
      cmd: process.env.POB_CMD,
      args: process.env.POB_ARGS ? [process.env.POB_ARGS] : undefined,
      timeoutMs: process.env.POB_TIMEOUT_MS ? parseInt(process.env.POB_TIMEOUT_MS) : undefined,
    });
    await stdioClient.start();
    this.client = stdioClient;

    console.error('[Lua Bridge] Client initialized — waiting for HeadlessWrapper to finish loading...');

    const testXml = '<?xml version="1.0" encoding="UTF-8"?><PathOfBuilding><Build level="1" targetVersion="3_0" className="Witch"/></PathOfBuilding>';
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      try {
        await this.client.loadBuildXml(testXml, 'Init Test');
        console.error('[Lua Bridge] HeadlessWrapper fully initialized');
        break;
      } catch (loadError) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(
            `HeadlessWrapper did not initialize after ${maxAttempts} attempts. ` +
            `Error: ${loadError instanceof Error ? loadError.message : String(loadError)}`
          );
        }
        console.error(`[Lua Bridge] HeadlessWrapper not ready (attempt ${attempts}/${maxAttempts}), waiting 2 s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async stopClient(): Promise<void> {
    if (this.client) {
      console.error('[Lua Bridge] Stopping client...');
      try { await this.client.stop(); } catch (error) {
        console.error('[Lua Bridge] Error stopping client:', error);
      }
      this.client = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
