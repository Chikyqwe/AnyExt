// src/services/lastService.js
const cheerio = require('cheerio');
const axios = require('axios');
const { getAllContentLists } = require('./jsonService');
const { KeyCache } = require('../core/cache/cache');
const lastCache = new KeyCache({ ttlMs: 5 * 60 * 2000 });
/**
 * Extrae los últimos episodios de TioAnime y los enriquece con datos de la base de datos
 * @returns {Promise<Array>} - Array de objetos con formato similar a lastep.json
 */
async function getLast() {
    try {
        const cacheKey = 'last_episodes';

        // Intentar cargar desde caché
        const cached = lastCache.load(cacheKey);
        if (cached) {
            return cached;
        }
        // 1. Obtener HTML de TioAnime
        const response = await axios.get('https://tioanime.com', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            },
            timeout: 15000
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // 2. Obtener todos los contenidos de la base de datos
        const allContent = getAllContentLists();
        const allAnimes = allContent.animes || [];

        // 3. Crear mapa de búsqueda por slug y por URL
        const searchMap = new Map();
        const urlMap = new Map();

        allAnimes.forEach(anime => {
            // Guardar por slug
            if (anime.slug) {
                const slugKey = anime.slug.toLowerCase();
                searchMap.set(slugKey, anime);
            }

            // Guardar por URL de TIO si existe
            if (anime.sources && anime.sources.TIO) {
                const urlKey = anime.sources.TIO.toLowerCase();
                urlMap.set(urlKey, anime);
            }

            // También guardar por título normalizado para búsqueda flexible
            if (anime.title) {
                const titleKey = normalizeTitle(anime.title);
                searchMap.set(titleKey, anime);
            }
        });

        // 4. Extraer episodios del HTML
        const episodes = [];

        $('.episodes .episode').each((index, element) => {
            const $ep = $(element);
            const $link = $ep.find('a');
            const $img = $ep.find('img');
            const $title = $ep.find('.title');

            // Obtener datos del episodio
            let href = $link.attr('href') || '';
            let imgSrc = $img.attr('src') || '';
            let title = $title.text().trim() || '';
            let alt = $img.attr('alt') || '';

            // Construir URL completa
            const fullUrl = href.startsWith('http') ? href : `https://tioanime.com${href}`;

            // Extraer número del episodio del título o alt
            const episodeNum = extractEpisodeNumber(title || alt);

            // Extraer el slug base (sin el número al final)
            const baseSlug = extractBaseSlug(href);

            // 5. Buscar el anime en la base de datos
            let animeData = null;

            // Buscar por URL exacta
            const urlKey = fullUrl.toLowerCase();
            if (urlMap.has(urlKey)) {
                animeData = urlMap.get(urlKey);
            }

            // Buscar por slug base
            if (!animeData && baseSlug) {
                const slugKey = baseSlug.toLowerCase();
                if (searchMap.has(slugKey)) {
                    animeData = searchMap.get(slugKey);
                }
            }

            // Buscar por título normalizado (búsqueda flexible)
            if (!animeData && title) {
                const normalizedTitle = normalizeTitle(title);
                // Intentar encontrar por coincidencia parcial
                for (const [key, anime] of searchMap) {
                    const animeTitle = normalizeTitle(anime.title);
                    if (animeTitle.includes(normalizedTitle) || normalizedTitle.includes(animeTitle)) {
                        animeData = anime;
                        break;
                    }
                }
            }

            // Si aún no se encontró, buscar por coincidencia del título sin el número
            if (!animeData && title) {
                const cleanTitle = title.replace(/\s+\d+$/, '').trim().toLowerCase();
                for (const [key, anime] of searchMap) {
                    const animeTitle = anime.title.toLowerCase();
                    if (animeTitle === cleanTitle || animeTitle.includes(cleanTitle) || cleanTitle.includes(animeTitle)) {
                        animeData = anime;
                        break;
                    }
                }
            }

            // Construir objeto de respuesta en formato lastep.json
            let id = null;
            if (animeData) {
                id = animeData.unit_id;
                if (!id && animeData.unit_id) {
                    id = animeData.unit_id;
                }
            }

            const episodeData = {
                titulo: title || alt,
                episodio: `Episodio ${episodeNum}`,
                episodioNum: episodeNum,
                url: fullUrl,
                imagen: imgSrc.startsWith('http') ? imgSrc : `https://tioanime.com${imgSrc}`,
                id: id
            };

            // Solo agregar si tiene ID (para mantener formato consistente)
            if (id) {
                episodes.push(episodeData);
            }
        });
        lastCache.save(cacheKey, episodes);
        return episodes;

    } catch (error) {
        console.error('[getLast ERROR]', error.message);
        return [];
    }
}

/**
 * Extrae el número del episodio del texto
 */
function extractEpisodeNumber(text) {
    if (!text) return 0;
    // Busca números al final del texto o en formato "Episodio X"
    const match = text.match(/(?:Episodio\s*|ep\s*|#)\s*(\d+)/i) ||
        text.match(/\b(\d+)\s*$/) ||
        text.match(/(\d+)(?:\s*-\s*|\s+)?$/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extrae el slug base de la URL (sin el número al final)
 * Ejemplo: /ver/one-piece-tv-1173 -> one-piece-tv
 */
function extractBaseSlug(href) {
    if (!href) return '';

    // Eliminar el prefijo /ver/ y el número al final
    let slug = href.replace(/^\/ver\//, '');

    // Intentar eliminar el número al final (formato: nombre-123)
    const match = slug.match(/^(.*?)(?:-(\d+))?$/);
    if (match) {
        // Si tiene un número al final, lo quitamos
        if (match[2]) {
            slug = match[1];
        }
    }

    return slug;
}

/**
 * Normaliza un título para búsqueda flexible
 */
function normalizeTitle(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
        .replace(/[^a-z0-9\s]/g, '') // Quitar caracteres especiales
        .replace(/\s+/g, ' ') // Espacios simples
        .trim();
}

module.exports = {
    getLast,
    extractEpisodeNumber,
    extractBaseSlug,
    normalizeTitle
};