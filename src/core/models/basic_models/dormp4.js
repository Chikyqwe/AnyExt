const axios = require('axios');
const { getSR } = require('./helpers/sr');
const { getflix } = require('./helpers/flix');
const languagesMap = require('../../../utils/maps/map_2.json');

/**
 * Resuelve un alias/código de idioma al key numérico del languagesMap.
 * Ejemplos: '001' → '13110' (Japonés), '009' → '13109' (Coreano), '00.6' → '38' (Latino)
 * También acepta el key directo (ej. '13110') o el nombre (ej. 'Japones').
 * @param {string} input - Código alias, key numérico o nombre del idioma
 * @returns {string|null} Key numérico en languagesMap, o null si no se encontró
 */
function resolveLangId(input) {
    if (!input) return null;
    const normalized = String(input).trim().toLowerCase();

    // 1. Coincidencia directa por key numérico
    if (languagesMap[normalized] || languagesMap[input]) {
        return languagesMap[normalized] ? normalized : input;
    }

    // 2. Buscar por alias o nombre
    for (const [key, val] of Object.entries(languagesMap)) {
        const nameLower = (val.name || '').toLowerCase();
        const aliases = (val.alias || []).map(a => a.toLowerCase());

        if (nameLower === normalized || aliases.includes(normalized)) {
            return key;
        }
    }

    return null;
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
let lastWorkingDormp4ActionId = null;

async function getdormp4($, purl, langFilter = null) {
    try {
        const actionIds = await getSR(purl);

        if (!actionIds || actionIds.length === 0) {
            return [];
        }

        let sortedActionIds = [...actionIds];
        if (lastWorkingDormp4ActionId && sortedActionIds.includes(lastWorkingDormp4ActionId)) {
            sortedActionIds.sort((a, b) => (a === lastWorkingDormp4ActionId ? -1 : b === lastWorkingDormp4ActionId ? 1 : 0));
        }

        const htmlContent = $.html();
        const match = htmlContent.match(
            /episode\\?["']?\s*:\s*\\?\{\s*\\?"_id\\?"\s*:\s*\\?"([^"\\]+)/
        );

        if (!match || !match[1]) {
            return [];
        }

        const episodeId = match[1];
        const payload = [{ episode_id: episodeId }];
        const controller = new AbortController();

        const headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
        };

        const promises = sortedActionIds.map(async (actionId) => {
            const response = await axios.post(purl, payload, {
                headers: { ...headers, 'Next-Action': actionId },
                validateStatus: () => true,
                signal: controller.signal
            });

            const txt = typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data);

            const esValido = response.status === 200 && txt.includes('LinksOnline');
            const tieneCabecera = txt.startsWith('0:{"a":"$@1"');
            const tieneLinks = /1:\[\s*\{/.test(txt);

            const tieneErrores =
                txt.includes('1:"$undefined"') ||
                txt.includes('1:[]') ||
                txt.includes('1:{"ok":false') ||
                txt.includes('"digest":"') ||
                txt.includes('"error"') ||
                txt.includes('"message":"') ||
                txt.includes('NEXT_NOT_FOUND') ||
                txt.includes('Internal Server Error') ||
                txt.includes('Cannot read') ||
                txt.includes('Unhandled Runtime Error');

            const invalido = !esValido || !tieneCabecera || !tieneLinks || tieneErrores;

            if (invalido) {
                throw new Error('Invalid action');
            }

            lastWorkingDormp4ActionId = actionId;
            controller.abort();
            return response.data;
        });

        let rawData;
        try {
            rawData = await Promise.any(promises);
        } catch {
            lastWorkingDormp4ActionId = null;
            const freshActionIds = await getSR(purl, true);
            if (freshActionIds && freshActionIds.length > 0) {
                const freshPromises = freshActionIds.map(async (actionId) => {
                    const response = await axios.post(purl, payload, {
                        headers: { ...headers, 'Next-Action': actionId },
                        validateStatus: () => true,
                        signal: controller.signal
                    });

                    const txt = typeof response.data === 'string'
                        ? response.data
                        : JSON.stringify(response.data);

                    const esValido = response.status === 200 && txt.includes('LinksOnline');
                    const tieneCabecera = txt.startsWith('0:{"a":"$@1"');
                    const tieneLinks = /1:\[\s*\{/.test(txt);

                    const tieneErrores =
                        txt.includes('1:"$undefined"') ||
                        txt.includes('1:[]') ||
                        txt.includes('1:{"ok":false') ||
                        txt.includes('"digest":"') ||
                        txt.includes('"error"') ||
                        txt.includes('"message":"') ||
                        txt.includes('NEXT_NOT_FOUND') ||
                        txt.includes('Internal Server Error') ||
                        txt.includes('Cannot read') ||
                        txt.includes('Unhandled Runtime Error');

                    const invalido = !esValido || !tieneCabecera || !tieneLinks || tieneErrores;

                    if (invalido) {
                        throw new Error('Invalid action');
                    }

                    lastWorkingDormp4ActionId = actionId;
                    controller.abort();
                    return response.data;
                });

                try {
                    rawData = await Promise.any(freshPromises);
                } catch {
                    return [];
                }
            } else {
                return [];
            }
        }

        const textData = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
        const line = textData.split('\n').find(l => l.startsWith('1:'));

        if (!line) {
            return [];
        }

        const jsonString = line.slice(2).trim();
        let items = [];
        try {
            items = JSON.parse(jsonString);
        } catch {
            return [];
        }

        if (!Array.isArray(items)) {
            return [];
        }

        // Resolver el filtro de idioma a un key numérico del mapa
        const resolvedLangKey = resolveLangId(langFilter);

        // Si hay filtro, aplicarlo antes de procesar los iframes (ahorra peticiones)
        const filteredItems = resolvedLangKey
            ? items.filter(item => String(item.lang) === resolvedLangKey)
            : items;

        const parsedLinks = await Promise.all(
            filteredItems.map(async (item) => {
                const embedUrl = item.link;
                const iframeUrl = embedUrl ? await getflix(embedUrl).catch(() => null) : null;

                const langCode = String(item.lang);
                const langInfo = languagesMap[langCode] || { name: 'Desconocido' };

                let subtitleType = null;
                if (Array.isArray(item.subtitles) && item.subtitles.length > 0) {
                    subtitleType = item.subtitles[0].type || null;
                }

                return {
                    servidor: getServerName(iframeUrl),
                    url: iframeUrl,
                    lang: langInfo.name,
                    langId: langCode,
                };
            })
        );

        // Si el filtro no devolvió resultados, retornar todos (fallback)
        if (resolvedLangKey && parsedLinks.length === 0) {
            console.warn(`[dormp4] No se encontraron links para lang='${langFilter}' (key: ${resolvedLangKey}). Retornando todos.`);
            return getdormp4($, purl, null);
        }

        return parsedLinks;

    } catch (error) {
        return {
            status: 500,
            mjs: error.message
        };
    }
}

module.exports = {
    getdormp4
};