const path = require('path');
const asyncHandler = require('../middlewares/asyncHandler');
const { MemoryCache } = require('../core/cache/cache');
const Fuse = require('fuse.js');

const {
    readDramaList,
    getDramaByUnitId,
    getJSONPath,
    readDramaRawJson
} = require('../services/jsonService');

const {
    getEpisodes,
    getDescription
} = require('../utils/helpers');

// Define los mirrors soportados para dramas según tu infraestructura de scraping/fuentes
const MIRRORS = ['dorlat', 'dormp4'];
const PER_PAGE = 24;

// ─────────────────────────────────────────────
// NORMALIZE
// ─────────────────────────────────────────────

const normalize = (str = '') =>
    str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

// ─────────────────────────────────────────────
// GET /drama/list?p={page|all}
// ─────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
    const p = req.query.p;

    if (p === 'all') {
        return res.json(readDramaRawJson());
    }

    const page = Math.max(1, parseInt(p) || 1);
    const all = readDramaList();
    const total = all.length;
    const start = (page - 1) * PER_PAGE;

    const items = all
        .slice(start, start + PER_PAGE)
        .map(d => ({
            title: d.title,
            slug: d.slug,
            unit_id: d.unit_id,
            image: d.image
        }));

    res.json({
        page,
        total,
        totalpages: Math.ceil(total / PER_PAGE),
        items,
    });
});

// ─────────────────────────────────────────────
// GET /api/drama/info?uid=
// ─────────────────────────────────────────────

exports.info = asyncHandler(async (req, res) => {
    const uid = parseInt(req.query.uid);

    if (!uid) {
        return res.status(400).json({ error: 'Falta parámetro uid' });
    }

    const drama = getDramaByUnitId(uid);

    if (drama.error === true) {
        return res.status(404).json({
            error: `No se encontró drama con uid ${uid}, ¿quiso decir ${drama.recommendedId}?`,
            recommendedId: drama.recommendedId
        });
    }

    let bestResult = {
        episodes: [],
        status: 'Desconocido',
        source: null,
        tags: []
    };

    const validMirrors = MIRRORS.filter(m => drama.sources?.[m]);

    if (validMirrors.length === 0) {
        return res.status(404).json({ error: 'No hay mirrors disponibles para este drama' });
    }

    const promises = validMirrors.map(async (mirrorKey) => {
        const sourceUrl = drama.sources[mirrorKey];
        const raw = await getEpisodes(sourceUrl);

        // Adaptar si getEpisodes retorna "chapters" en lugar de "episodes"
        if (raw && !raw.episodes && raw.chapters) {
            raw.episodes = raw.chapters;
        }

        if (!raw?.episodes?.length) {
            throw new Error(`Sin episodios en ${mirrorKey}`);
        }

        return { raw, mirrorKey };
    });

    let bestResultData = null;
    try {
        // Tomará el PRIMER mirror que termine exitosamente y devuelva episodios
        bestResultData = await Promise.any(promises);
    } catch (err) {
        return res.status(404).json({ error: 'No se pudieron obtener episodios de ningún mirror' });
    }

    const { raw, mirrorKey } = bestResultData;

    bestResult = {
        episodes: raw.episodes.map(ep => {
            const epNum = Number(ep.num || ep.number);
            return {
                num: epNum,
                url: `/player/${uid}/${epNum}`
            };
        }),
        status: Boolean(raw.isEnd) ? 'Finalizado' : 'En emisión',
        source: mirrorKey,
        tags: raw.tags || []
    };

    const desc = await getDescription(drama.sources[bestResult.source])

    res.json({
        type: 'drama',
        title: drama.title,
        slug: drama.slug,
        category: 'drama',
        tags: bestResult.tags,
        episodes_count: bestResult.episodes.length,
        desc,
        langs: bestResultData.raw.langs,
        subtitles: bestResultData.raw.sub,
        status: bestResult.status,
        episodes: bestResult.episodes,
        uid,
        image: drama.image || '',
        source: bestResult.source || '',
    });
});