const cheerio = require('cheerio');
const axios = require('axios');

function hex2a(hex) {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
}

function getServerName(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    const parts = host.split('.');
    return parts[parts.length - 2] || host;
  } catch {
    return 'unknown';
  }
}
async function extractONE($, pageUrl) {
  console.log("extractONE", pageUrl);
  const videos = [];

  const enc = $('.opt').first().data('encrypt') || $('.opt').attr('data-encrypt');
  if (!enc) {
    console.log('[ONE] ❌ No se encontró data-encrypt');
    return videos;
  }

  try {
    const origin = new URL(pageUrl).origin;
    const endpoint = `${origin}/flv`;

    const res = await axios.post(
      endpoint,
      new URLSearchParams({ acc: 'opt', i: enc }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': pageUrl,
          'Origin': origin,
          'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
          'Accept': '*/*',
          'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        responseType: 'text',
        timeout: 10000
      }
    );

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    if (!html || html.trim() === '') {
      console.log('[ONE] ⚠️ Respuesta vacía');
      return videos;
    }

    const $$ = cheerio.load(html);

    $$('li[encrypt]').each((_, el) => {
      const encrypt = $$(el).attr('encrypt');
      if (!encrypt) return;

      let url;
      try {
        url = hex2a(encrypt);
      } catch (e) {
        console.warn('[ONE] hex2a falló:', e.message);
        return;
      }

      if (!url || !url.startsWith('http')) {
        console.warn('[ONE] URL inválida:', url);
        return;
      }

      const servidor = $$(el).attr('title')?.replace('Opción ', '').toLowerCase()
        || getServerName(url);

      videos.push({ servidor, url });
    });

  } catch (e) {
    console.error('[ONE] ❌ Error:', e.message);
    if (e.response) {
      console.error('[ONE] Status:', e.response.status);
      console.error('[ONE] Body:', String(e.response.data).slice(0, 300));
    }
  }

  return videos;
}

module.exports = { extractONE };