const axios = require('axios');
const cheerio = require('cheerio');

const AJAX_URL = 'https://doramaslat.com/wp-admin/admin-ajax.php';
const DOMAIN_REFERER = 'https://doramaslat.com/';

const customHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'es-ES,es;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': DOMAIN_REFERER
};

function getServerName(url) {
    try {
        const fullUrl = url.startsWith('//') ? `https:${url}` : url;
        const host = new URL(fullUrl).hostname.replace('www.', '');
        const parts = host.split('.');
        return parts[parts.length - 2] || host;
    } catch {
        return 'unknown';
    }
}

function parseEmbedUrl(embedData) {
    if (!embedData) return null;

    const data = typeof embedData === 'string' ? JSON.parse(embedData) : embedData;
    if (!data?.embed_url) return null;

    const $ = cheerio.load(data.embed_url);
    let src = $('iframe').attr('src') || $('iframe').attr('data-src');

    if (src) {
        src = src.trim();
        return src.startsWith('//') ? `https:${src}` : src;
    }

    return null;
}

/**
 * Función auxiliar para realizar la petición AJAX a DooPlay
 */
async function fetchPlayerOption(item) {
    try {
        const payload = new URLSearchParams();
        payload.append('action', 'doo_player_ajax');
        payload.append('post', item.post);
        payload.append('nume', item.nume);
        payload.append('type', item.type);

        const { data: ajaxData } = await axios.post(AJAX_URL, payload, {
            headers: {
                ...customHeaders,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            timeout: 8000
        });

        const iframeUrl = parseEmbedUrl(ajaxData);

        if (iframeUrl) {
            const cleanServer = getServerName(iframeUrl);
            return {
                servidor: cleanServer !== 'unknown' ? cleanServer : (item.server || 'desconocido').toLowerCase(),
                url: iframeUrl,
                title: item.title
            };
        }
    } catch (err) {
        console.error(`[DorLat] ❌ Error extrayendo opción (nume: ${item.nume}):`, err.message);
    }
    return null;
}

/**
 * Extrae enlaces dando prioridad a nume="1"
 */
async function extractDorLat(htmlContent) {
    try {
        if (!htmlContent) return [];

        const $ = typeof htmlContent === 'function' ? htmlContent : cheerio.load(htmlContent);

        // 1. Mapear todas las opciones disponibles
        const options = [];
        $('#playeroptionsul li.dooplay_player_option').each((_, el) => {
            const post = $(el).attr('data-post');
            const nume = $(el).attr('data-nume');
            const type = $(el).attr('data-type') || 'tv';
            const server = $(el).find('.server').text().trim();
            const title = $(el).find('.title').text().trim();

            if (post && nume) {
                options.push({ post, nume, type, server, title });
            }
        });

        if (options.length === 0) return [];

        // 2. Separar la Opción Prioritaria (nume === "1") de las de Respaldo
        const priorityOption = options.find(o => String(o.nume) === '1') || options[0];
        const fallbackOptions = options.filter(o => o !== priorityOption);

        // 3. INTENTO 1: Probar primero la opción prioritaria
        console.log(`[DorLat]  Probando servidor prioritario (nume: ${priorityOption.nume})...`);
        const primaryResult = await fetchPlayerOption(priorityOption);

        if (primaryResult) {
            console.log(`[DorLat] Servidor prioritario funcionó correctamente.`);
            return [primaryResult];
        }

        // 4. INTENTO 2: Si la prioritaria falló, intentar con las demás opciones en paralelo
        if (fallbackOptions.length > 0) {
            console.log(`[DorLat] Servidor prioritario falló. Intentando con ${fallbackOptions.length} opción(es) de respaldo...`);

            const fallbackPromises = fallbackOptions.map(opt => fetchPlayerOption(opt));
            const fallbackResults = await Promise.all(fallbackPromises);
            const validFallbacks = fallbackResults.filter(Boolean);

            if (validFallbacks.length > 0) {
                return validFallbacks;
            }
        }
        return [];

    } catch (error) {
        console.error(`[DorLat] ❌ Error en extractDorLat:`, error.message);
        return [];
    }
}

module.exports = {
    extractDorLat,
    getServerName
};