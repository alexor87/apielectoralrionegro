/* ============================================================
   Portal config
   Edit PROXY_URL with the URL of your Cloudflare Worker after
   running `wrangler deploy` (see worker/README.md).
   ============================================================ */

window.PORTAL_CONFIG = {
  // URL del Cloudflare Worker que mantiene la API key oculta.
  // Ejemplo: 'https://electoral-proxy-rionegro.tu-cuenta.workers.dev'
  PROXY_URL: 'https://electoral-proxy-rionegro.alexor87.workers.dev',
};
