const { axiosGet, cheerio } = require('../helpersCore');
const axios = require('axios');
const vod = process.env.VOD

// Funciones de decodificación
function rot13(str) {
  return str.replace(/[A-Za-z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() < 'n' ? 13 : -13))
  );
}

function sanitizeSpecialChars(str) {
  const patterns = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
  patterns.forEach((p) => {
    const regex = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    str = str.replace(regex, '_');
  });
  return str;
}

function removeUnderscores(str) {
  return str.split('_').join('');
}

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

function shiftChars(str, shift) {
  return str
    .split('')
    .map((c) => String.fromCharCode(c.charCodeAt(0) - shift))
    .join('');
}

function reverseString(str) {
  return str.split('').reverse().join('');
}

function decodeObfuscatedData(obfuscated) {
  try {
    let step = rot13(obfuscated);
    step = sanitizeSpecialChars(step);
    step = removeUnderscores(step);
    step = decodeBase64(step);
    step = shiftChars(step, 3);
    step = reverseString(step);
    step = decodeBase64(step);
    return JSON.parse(step);
  } catch (err) {
    console.error('Error decoding data:', err);
    return null;
  }
}

// Función principal
async function extractVoe(pageUrl) {
  const fail = () => ({ status: 701, mjs: 'general error', server: 'voe' });
  console.log(`[VOE EXTRACTOR] Extrayendo video desde: ${pageUrl}`);

  try {
    let html;

    // Descargar página inicial
    try {
      const res = await axiosGet(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 8000
      });
      html = res.data;
    } catch (e) {
      console.error('[VOE EXTRACTOR] Error descargando página:', e.message);
      return fail();
    }

    // Detectar redirección JS
    if (html.includes('window.location.href')) {
      const match = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (!match?.[1]) return fail();

      const redirectUrl = match[1];
      console.log('[VOE EXTRACTOR] Redirección detectada a:', redirectUrl);

      try {
        const redirectRes = await axiosGet(redirectUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 8000
        });
        html = redirectRes.data;
      } catch (err) {
        console.error('[VOE EXTRACTOR] Error descargando URL redirigida:', err.message);
        return fail();
      }
    }

    const $ = cheerio.load(html);

    // Buscar JSON ofuscado
    const script = $('script[type="application/json"]').get().find(s => {
      try {
        const parsed = JSON.parse($(s).html());
        return Array.isArray(parsed) && typeof parsed[0] === 'string';
      } catch {
        return false;
      }
    });

    if (!script) return fail();

    const obfuscated = $(script).html();
    const data = decodeObfuscatedData(obfuscated);

    if (!data?.source) return fail();

    // Tras verificar la existencia de data.source, realiza la llamada a la API externa
    const { data: apiResponse } = await axios.post(
      vod + '/api/play',
      {
        server: 'voe',
        url: pageUrl
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return apiResponse;

  } catch (err) {
    console.error('[VOE EXTRACTOR] Error inesperado:', err.message);
    return { status: 703, mjs: err.message, server: 'voe' };
  }
}

module.exports = { extractVoe };