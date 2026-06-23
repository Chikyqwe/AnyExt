const cheerio = require('cheerio');

function transformObeywish(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('obeywish.com')) {
      u.hostname = 'asnwish.com';
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

function extractGeneric($, pageUrl) {
  const videos = [];

  $('script').each((_, el) => {
    const scr = $(el).html();
    if (!scr) return;

    const match = scr.match(/var\s+videos\s*=\s*(\[.*?\]|\{[\s\S]*?\});/s);
    if (!match) return;

    try {
      const parsed = JSON.parse(match[1].replace(/\\\//g, '/'));

      // Formato tipo { SUB: [...] }
      if (parsed?.SUB) {
        parsed.SUB.forEach(v => {
          const url = transformObeywish(v.code || v[1]);
          if (!url) return;

          videos.push({
            servidor: (v.server || v[0] || '').toLowerCase(),
            url
          });
        });
      }

      // Formato array simple
      else if (Array.isArray(parsed)) {
        parsed.forEach(v => {
          if (!v[1]) return;

          videos.push({
            servidor: (v[0] || '').toLowerCase(),
            url: transformObeywish(v[1])
          });
        });
      }

    } catch (e) {
      console.error('[GENERIC] error:', e.message);
    }
  });

  return videos;
}

module.exports = { extractGeneric };