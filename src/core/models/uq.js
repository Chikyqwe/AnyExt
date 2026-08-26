const axios = require('axios');
const { unpack } = require('unpacker');
const vod = process.env.VOD

module.exports = async function uq(pageUrl) {
    try {
        const origin = new URL(pageUrl).origin;

        // 1. Obtiene el HTML de la página (soporta Cloudflare 403 con body)
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
            validateStatus: () => true,
            maxRedirects: 5,
        });

        // 2. Extrae el script empaquetado
        const scriptMatch = html.match(
            /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)<\/script>|eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)\s*)/i
        );

        if (!scriptMatch) return { status: 706, mjs: 'Script packed no encontrado', server: 'uq' };

        const packedJs = scriptMatch[1] || scriptMatch[0];
        const unpacked = unpack(packedJs);

        // 3. Verifica si existe la URL m3u8 sin hacer peticiones para descargarla
        const videoMatch = unpacked.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
            unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);

        if (!videoMatch) {
            return { status: 706, mjs: 'No se encontró una URL de transmisión m3u8', server: 'uq' };
        }

        // 4. Envia el POST directamente a la API externa
        const { data: apiResponse } = await axios.post(
            vod + '/api/play',
            {
                server: 'uq',
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
        console.error('[uq] Error:', err && err.message ? err.message : err);
        return { status: 706, mjs: err.message, server: 'uq' };
    }
};