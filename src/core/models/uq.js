const { axiosGet } = require('../helpersCore');
const { unpack, detect } = require('unpacker');
const { HTTPS } = require('../../config');
function rewriteM3U8(m3u8, playlistUrl, referer) {
    const result = m3u8
        .split('\n')
        .map(line => {
            const l = line.trim();

            if (!l || l.startsWith('#')) return line;

            let absoluteUrl;

            if (/^https?:\/\//i.test(l)) {
                absoluteUrl = l;
            } else {
                try {
                    absoluteUrl = new URL(l, playlistUrl).href;
                } catch (e) {
                    return line;
                }
            }

            const gid = Buffer.from(absoluteUrl).toString('base64url');
            const f = Buffer.from(referer).toString('base64url');
            return `${HTTPS ? 'https' : 'http'}://${HTTPS ? 'anyext.onrender.com' : 'localhost:2022'}/api/hls?gid=${gid}&f=${f}&Did=1`;
        })
        .join('\n');

    return result;
}

function best(master, base) {
    const lines = master.split('\n');
    let bestUrl = null;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
        const m = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
        if (!m) continue;

        const next = lines[i + 1];
        if (!next || next.startsWith('#')) continue;

        const score = m[1] * m[2];
        if (score > bestScore) {
            bestScore = score;
            bestUrl = new URL(next, base).href;
        }
    }
    return bestUrl;
}

module.exports = async function uq(pageUrl) {
    try {
        const axios = require('axios');
        const origin = new URL(pageUrl).origin;

        // Cloudflare responde 403 pero incluye el HTML completo en el body.
        // validateStatus: () => true evita que axios lance excepción y permite leer el body.
        const { data: html } = await axios.get(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': origin + '/',
                'Origin': origin,
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
            timeout: 15000,
            validateStatus: () => true,   // ← ignora 403, lee el body igual
            maxRedirects: 5,
        });

        const scriptMatch = html.match(
            /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)<\/script>|eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)\s*)/i
        );

        if (!scriptMatch) return { status: 706, mjs: 'Script packed no encontrado', server: 'uq' };

        const packedJs = scriptMatch[1] || scriptMatch[0];
        const unpacked = unpack(packedJs);

        // Busca estrictamente URLs que terminen o contengan la extensión .m3u8
        const videoMatch = unpacked.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
            unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);

        if (!videoMatch) {
            return { status: 706, mjs: 'No se encontró una URL de transmisión m3u8', server: 'uq' };
        }

        const streamUrl = videoMatch[1] || videoMatch[0];
        const playlist = (
            await axiosGet(streamUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': '*/*',
                    'Referer': streamUrl
                }
            })
        ).data;
        const bestUrl = best(playlist, streamUrl) || streamUrl;
        const bestPlaylistRaw = (
            await axiosGet(bestUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': '*/*',
                    'Referer': streamUrl
                }
            })
        ).data;
        const bestPlaylist = rewriteM3U8(bestPlaylistRaw, bestUrl, pageUrl);
        console.log(`[uq] Mejor URL seleccionada: ${bestUrl}`);
        return {
            status: 200,
            url: pageUrl,
            content: bestPlaylist
        };

    } catch (err) {
        console.error('[uq] Error:', err && err.message ? err.message : err);
        return { status: 706, mjs: err.message, server: 'uq' };
    }
};