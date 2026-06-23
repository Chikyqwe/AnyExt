const cheerio = require('cheerio');

function getServerName(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    const parts = host.split('.');
    return parts[parts.length - 2] || host;
  } catch {
    return 'unknown';
  }
}
async function extractJK($) {
  const videos = [];

  try {
    // 1. Obtener todos los scripts
    const scripts = $('script').map((_, el) => $(el).html()).get();

    // 2. Buscar el script que contiene "var servers"
    const targetScript = scripts.find(s => s && s.includes('var servers'));

    if (!targetScript) {
      console.log('[JK] ❌ No se encontró el script');
      return videos;
    }

    // =========================
    // 🔹 EXTRAER SERVERS (BASE64)
    // =========================
    const serversMatch = targetScript.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);

    if (serversMatch) {
      let servers;

      try {
        servers = eval(serversMatch[1]);
      } catch (e) {
        console.log('[JK] ❌ Error parseando servers:', e.message);
        servers = [];
      }

      servers.forEach(s => {
        if (!s.remote) return;

        let url = '';

        try {
          url = Buffer.from(s.remote, 'base64').toString('utf-8').trim();
        } catch { }

        if (!url) return;

        videos.push({
          servidor: (s.server || 'unknown').toLowerCase(),
          url
        });
      });
    }

    // =========================
    // 🔹 EXTRAER IFRAMES (video[])
    // =========================
    const videoMatches = [...targetScript.matchAll(/video\[\d+\]\s*=\s*'(.*?)';/g)];

    videoMatches.forEach(match => {
      const iframe = match[1];

      const srcMatch = iframe.match(/src="(.*?)"/);

      if (!srcMatch) return;

      let url = srcMatch[1];

      // corregir rutas relativas
      if (url.startsWith('/')) {
        url = 'https://jkanime.net' + url;
      }

      videos.push({
        servidor: getServerName(url),
        url
      });
    });

  } catch (e) {
    console.error('[JK] ❌ Error general:', e.message);
  }

  return videos;
}

module.exports = { extractJK };