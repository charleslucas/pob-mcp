# Path of Building MCP Server — Quick Start

Get Claude analyzing and modifying your Path of Exile builds in minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Desktop](https://claude.ai/download) or Claude Code
- Your Path of Building builds directory

## Step 1 — Install and build

```bash
git clone https://github.com/charleslucas/pob-mcp.git
cd pob-mcp
npm install
npm run build
```

## Step 2 — Configure Claude

Edit your Claude Desktop config file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

### XML-only mode (no Lua required)

```json
{
  "mcpServers": {
    "pob": {
      "command": "node",
      "args": ["C:/absolute/path/to/pob-mcp/build/index.js"],
      "env": {
        "POB_DIRECTORY": "C:/Users/YourName/OneDrive/Documents/Path of Building/Builds"
      }
    }
  }
}
```

This gives you build listing, analysis, tree comparison, and skill gem analysis from your `.xml` files — no extra setup needed.

### Full mode (with Lua bridge for live stats)

First install LuaJIT and clone the PoB API fork:

```bash
# Windows via scoop
scoop install luajit

# macOS
brew install luajit

# Clone the PathOfBuilding fork with the headless API
git clone https://github.com/charleslucas/PathOfBuilding.git
git checkout api-stdio
```

Then add to your config:

```json
{
  "mcpServers": {
    "pob": {
      "command": "node",
      "args": ["C:/absolute/path/to/pob-mcp/build/index.js"],
      "env": {
        "POB_DIRECTORY": "C:/Users/YourName/OneDrive/Documents/Path of Building/Builds",
        "POB_LUA_ENABLED": "true",
        "POB_FORK_PATH": "C:/path/to/PathOfBuilding/src",
        "POB_CMD": "C:/Users/YourName/scoop/shims/luajit.exe"
      }
    }
  }
}
```

## Step 3 — Restart Claude Desktop

Quit completely and reopen.

## Step 4 — Test it

Try these prompts:

**XML mode:**
- "List my Path of Building builds"
- "Analyze Elemental Cyclone Slayer.xml"
- "Compare two of my builds"

**Lua bridge:**
- "Start the Lua bridge and load my Cyclone build"
- "What are the defense stats on the loaded build?"
- "Validate the build and show me any issues"

---

## Common Workflows

### Import a live character from PoE

```
1. lua_start
2. lua_list_characters (account_name: "YourName#1234")
3. lua_new_build
4. lua_import_character (account_name: "YourName#1234", character_name: "MyChar")
5. lua_save_build (build_name: "MyChar.xml")
```

Set `POE_SESSION_ID` in your config for private profiles.

### Optimize passive tree

```
1. lua_load_build (build_name: "MyBuild.xml")
2. suggest_optimal_nodes (goal: "life", points_available: 5)
3. search_tree_nodes (query: "maximum life")
4. update_tree_delta (add_nodes: [12345, 67890])
5. lua_get_stats
6. lua_save_build
```

### Find the best anointment

```
1. lua_load_build (build_name: "MyBuild.xml")
2. find_best_anointment (slot: "Amulet", focus: "dps")
```

### Find best-in-slot upgrades

Requires `POE_TRADE_ENABLED=true` and `POE_SESSION_ID`:

```
1. lua_load_build (build_name: "MyBuild.xml")
2. find_weighted_trade_items (league: "Mirage", slot: "Belt")
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No builds found | Check `POB_DIRECTORY` — must point to the folder with `.xml` files |
| Server not starting | Use the absolute path to `build/index.js` |
| `luajit command not found` | Set `POB_CMD` to the full path of your luajit binary |
| `Failed to find valid ready banner` | Check `POB_FORK_PATH` — must contain `HeadlessWrapper.lua` |
| Bridge times out | The bridge auto-restarts; just retry. Or run `lua_stop` then `lua_start`. |
| 3.28 builds have wrong tree | Update your PoB fork: `git pull origin api-stdio` |

For more details see the full [README](../README.md).
