// ok.js
const { axiosGet } = require('../helpersCore');

module.exports = async function ok(pageUrl) {
    console.log(pageUrl)
    try {
        const { data: html } = await axiosGet(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://ok.ru/'
            },
            timeout: 10000
        });

        const matchOptions = html.match(/data-options="([^"]+)"/);
        if (matchOptions && matchOptions[1]) {
            // Decodificar comillas y entidades HTML comunes como &amp;
            const decodedAttr = matchOptions[1]
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&');

            const dataOptions = JSON.parse(decodedAttr);
            const metadataStr = dataOptions.flashvars?.metadata;

            if (metadataStr) {
                const metadata = JSON.parse(metadataStr);
                const videos = metadata.videos || [];

                // Priorizar calidad HD, luego SD, luego la primera disponible
                const preferredVideo = videos.find(v => v.name === 'hd') ||
                    videos.find(v => v.name === 'sd') ||
                    videos.find(v => v.name === 'low') ||
                    videos[0];

                if (preferredVideo && preferredVideo.url) {
                    // Decodificar por si acaso la URL interna también trae entidades escapadas
                    const videoUrl = preferredVideo.url.replace(/&amp;/g, '&');
                    console.log(videoUrl);
                    return { url: videoUrl };
                }
            }
        }

        throw new Error('No se encontró URL del archivo ok');
    } catch (err) {
        console.error('[ok] Error:', err && err.message ? err.message : err);
        return { status: 790, mjs: err.message, server: 'ok' };
    }
};