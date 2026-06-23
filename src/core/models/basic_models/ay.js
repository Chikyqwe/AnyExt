const cheerio = require('cheerio');
function decodeBase64(str) {
  try {
    return Buffer.from(str, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}
function getServerInfo(url) {
  try {
    const hostname = new URL(url).hostname;
    const clean = hostname.replace('www.', '').split('.')[0];

    return {
      host: hostname,      // uqload.io
      servidor: clean      // uqload
    };
  } catch {
    return {
      host: null,
      servidor: 'unknown'
    };
  }
}
async function extractAniyae($) {
  const videos = [];

  try {
    const scripts = $('script').map((_, el) => $(el).html()).get();
    const targetScript = scripts.find(s => s && s.includes('episodeId'));

    if (!targetScript) {
      console.log('[ANIYAE] ❌ No se encontró episodeId');
      return videos;
    }

    const match = targetScript.match(/episodeId\s*=\s*(\d+)/i);

    if (!match) {
      console.log('[ANIYAE] ❌ No se pudo extraer episodeId');
      return videos;
    }

    const episodeId = match[1];

    const apiUrl = `https://open.aniyae.net/wp-json/kiranime/v1/episode/players?id=${episodeId}`;
    console.log(apiUrl)
    const res = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const players = res.data?.players;

    if (!Array.isArray(players)) {
      console.log('[ANIYAE] ⚠️ players inválido');
      return videos;
    }

    players.forEach(v => {
      if (!v?.url) return;

      const decodedUrl = decodeBase64(v.url);

      if (!decodedUrl || !decodedUrl.startsWith('http')) return;

      videos.push({
        servidor: getServerInfo(decodedUrl).servidor,
        url: decodedUrl
      });
    });

  } catch (e) {
    console.error('[ANIYAE] ❌ Error:', e.message);
  }

  return videos;
}

module.exports = { extractAniyae };