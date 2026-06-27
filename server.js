// KeyMux entry point — boots the proxy (7777) and the dashboard (7778) in a
// single process so they can share the key store + activity log.
import { createProxyApp } from "./src/proxy.js";
import { createDashboardApp } from "./src/dashboard.js";

const PROXY_PORT = Number(process.env.KEYMUX_PROXY_PORT) || 7777;
const DASH_PORT = Number(process.env.KEYMUX_DASH_PORT) || 7778;

createProxyApp().listen(PROXY_PORT, () => {
  createDashboardApp().listen(DASH_PORT, () => {
    printBanner();
  });
});

function printBanner() {
  const settings = {
    apiKeyHelper: "echo 'keymux-local'",
    env: {
      ANTHROPIC_API_KEY: "keymux-local",
      ANTHROPIC_BASE_URL: `http://localhost:${PROXY_PORT}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    permissions: { allow: [], deny: [] },
    model: "opus[1m]",
    skipDangerousModePermissionPrompt: true,
  };

  const line = "─".repeat(64);
  console.log(`
┌${line}┐
   🔑  KeyMux is running
└${line}┘

   Proxy      →  http://localhost:${PROXY_PORT}     (point Claude Code here)
   Dashboard  →  http://localhost:${DASH_PORT}     (manage keys in your browser)

   One-time setup — paste this into ~/.claude/settings.json, then you
   never touch that file again (manage keys from the dashboard instead):

${JSON.stringify(settings, null, 2)
  .split("\n")
  .map((l) => "   " + l)
  .join("\n")}

   Next:
     1. Open the dashboard and add your AeroLink / Freemodel keys.
     2. Update settings.json as above.
     3. Start Claude Code. All traffic now flows through KeyMux and
        rotates automatically on 429 / 401.
`);
}
