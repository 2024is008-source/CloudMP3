// PM2 process definition for cloudmp3.site on the Contabo VPS.
//
//   cd /srv/cloudmp3
//   export CLOUDMP3_SERVICE_URL=... CLOUDMP3_SERVICE_KEY=...   # optional, see below
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup          # survives a reboot
//
// .cjs on purpose: package.json sets "type": "module", so a plain .js file here
// would be loaded as ESM and PM2 would not read it.
//
// Adjust cwd if the repository does not live at /srv/cloudmp3, and keep PORT in
// sync with the proxy_pass address in deploy/nginx/snippet-cloudmp3-site.conf.
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "cloudmp3",
      cwd: "/srv/cloudmp3",
      script: ".output/server/index.mjs",

      // One forked process, on purpose. The server keeps in-memory state that
      // must not be duplicated or lost on a scale-up: the scraped SoundCloud
      // client id (30 min), the preview audio cache (up to 24 MB) and the
      // resolved-format cache. Cluster mode would also multiply the outbound
      // request pressure on SoundCloud.
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        // Loopback only: Nginx and Cloudflare are the only things that should
        // reach this port. Never bind 0.0.0.0 on a VPS with a public IP.
        HOST: "127.0.0.1",
        PORT: 3000,

        // Optional original-audio service (backend/). Unset is a supported
        // state: the app then reports originals as unavailable instead of
        // pretending. Values come from the shell so no secret is committed;
        // PM2 snapshots them at start time, so re-run `pm2 restart cloudmp3
        // --update-env` after changing them.
        CLOUDMP3_SERVICE_URL: process.env.CLOUDMP3_SERVICE_URL || "",
        CLOUDMP3_SERVICE_KEY: process.env.CLOUDMP3_SERVICE_KEY || "",
      },

      // A restart mid-download drops that user's stream; give handlers time to
      // drain, and let a crash loop surface instead of silently spinning.
      kill_timeout: 8000,
      wait_ready: false,
      min_uptime: "15s",
      max_restarts: 10,
      restart_delay: 2000,
      // The preview cache is bounded at 24 MB; anything far above the baseline
      // means a leak, and a restart is cheaper than an OOM kill.
      max_memory_restart: "600M",

      time: true,
      out_file: path.join(__dirname, "..", "logs", "cloudmp3.out.log"),
      error_file: path.join(__dirname, "..", "logs", "cloudmp3.error.log"),
      merge_logs: true,
    },
  ],
};
