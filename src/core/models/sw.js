const { axiosGet } = require('../helpersCore');
const { unpack, detect } = require('unpacker');
const { URL } = require('url');
const axios = require('axios');
const vod = process.env.VOD

// ---------- getRedirectUrl----------
async function redir(pageUrl) {
  try {
    const dmca = ["playnixes.com", "niramirus.com", "medixiru.com", "hgplaycdn.com", "hglamioz.com"];
    const main = ["kravaxxa.com", "davioad.com", "haxloppd.com", "tryzendm.com", "dumbalag.com"];
    const rules = ["dhcplay.com", "hglink.to", "test.hglink.to", "wish-redirect.aiavh.com"];

    const url = new URL(pageUrl);
    const destination = rules.includes(url.hostname)
      ? main[Math.floor(Math.random() * main.length)]
      : dmca[Math.floor(Math.random() * dmca.length)];

    const finalURL = "https://" + destination + url.pathname + url.search;
    return finalURL;
  } catch (error) {
    console.error('Error al generar redirectUrl:', error && error.message ? error.message : error);
    return pageUrl;
  }
}

async function extractM3u8(pageUrl) {
  const fail = () => ({ status: 701, mjs: 'general error', server: 'sw' });

  try {
    const finalUrl = await redir(pageUrl);
    console.log(`[M3U8 EXTRACTOR] URL redirigida: ${finalUrl}`);

    const html = (await axiosGet(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': finalUrl
      }
    })).data;

    const scriptMatch = html.match(
      /<script[^>]*type=['"]text\/javascript['"][^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?)<\/script>/i
    );
    if (!scriptMatch) return fail();

    const packedJs = scriptMatch[1];
    if (!detect(packedJs)) return fail();

    const unpacked = unpack(packedJs);
    const linksMatch = unpacked.match(/var\s+links\s*=\s*(\{[\s\S]*?\});/i);
    if (!linksMatch) return fail();

    let links;
    try {
      links = JSON.parse(linksMatch[1]);
    } catch {
      return fail();
    }

    const link = links.hls4 || links.hls3 || links.hls1 || links.hls2;
    if (!link) return fail();

    // Confirmado que existe enlace M3U8, se envía el POST a la API externa con la URL redirigida
    const { data: apiResponse } = await axios.post(
      vod + '/api/play',
      {
        server: 'sw',
        url: finalUrl
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return apiResponse;

  } catch (err) {
    console.error('[M3U8 EXTRACTOR] Error:', err.message);
    return { status: 701, mjs: err.message, server: 'sw' };
  }
}

module.exports = { extractM3u8 };