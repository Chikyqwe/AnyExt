// src/controllers/mangaController.js

const path = require('path');
const asyncHandler = require('../middlewares/asyncHandler');
const { MemoryCache } = require('../core/cache/cache');
const Fuse = require('fuse.js');

const {
  readMangaList,
  getMangaByUnitId,
  getJSONPath,
  readMangaRawJson
} = require('../services/jsonService');

const {
  getEpisodes
} = require('../utils/helpers');

const MIRRORS = ['tmo', 'oly', 'esp', 'tmonet'];
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
// GET /manga/list?p={page|all}
// ─────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;

  if (p === 'all') {
    return res.json(readMangaRawJson());
  }

  const page = Math.max(1, parseInt(p) || 1);
  const all = readMangaList();
  const total = all.length;
  const start = (page - 1) * PER_PAGE;

  const items = all
    .slice(start, start + PER_PAGE)
    .map(m => ({
      title: m.title,
      slug: m.slug,
      unit_id: m.unit_id,
      image: m.image
    }));

  res.json({
    page,
    total,
    totalpages: Math.ceil(total / PER_PAGE),
    items,
  });
});

// ─────────────────────────────────────────────
// GET /api/manga/info?uid=
// ─────────────────────────────────────────────

exports.info = asyncHandler(async (req, res) => {
  const uid = parseInt(req.query.uid);

  if (!uid) {
    return res.status(400).json({ error: 'Falta parámetro uid' });
  }

  const manga = getMangaByUnitId(uid);

  if (manga.error == true) {
    return res.status(404).json({ error: `No se encontró manga con uid ${uid}, ¿quiso decir ${manga.recommendedId}?`, recommendedId: manga.recommendedId });
  }

  let bestResult = {
    chapters: [],
    status: 'Desconocido',
    source: null,
    tags: []
  };

  const validMirrors = MIRRORS.filter(m => manga.sources?.[m]);

  if (validMirrors.length === 0) {
    return res.status(404).json({ error: 'No hay mirrors disponibles para este manga' });
  }

  const promises = validMirrors.map(async (mirrorKey) => {
    const sourceUrl = manga.sources[mirrorKey];
    const raw = await getEpisodes(sourceUrl);

    // Adaptar si getEpisodes retorna "episodes" en lugar de "chapters"
    if (raw && !raw.chapters && raw.episodes) {
      raw.chapters = raw.episodes;
    }

    if (!raw?.chapters?.length) {
      throw new Error(`Sin capítulos en ${mirrorKey}`);
    }

    return { raw, mirrorKey };
  });

  let bestResultData = null;
  try {
    // Tomará el PRIMER mirror que termine exitosamente y devuelva capítulos
    bestResultData = await Promise.any(promises);
  } catch (err) {
    return res.status(404).json({ error: 'No se pudieron obtener capítulos de ningún mirror' });
  }

  const { raw, mirrorKey } = bestResultData;

  bestResult = {
    chapters: raw.chapters.map(ch => {
      const chapterNum = Number(ch.num || ch.number);
      return {
        num: chapterNum,
        url: `/reader/${uid}/${chapterNum}`
      };
    }),
    status: Boolean(raw.isEnd) ? 'Finalizado' : 'En emisión',
    source: mirrorKey,
    tags: raw.tags || []
  };

  res.json({
    type: 'manga',
    title: manga.title,
    slug: manga.slug,
    category: manga.btype === 'M' ? 'manga' : (manga.btype === 'Mh' ? 'manhwa' : (manga.btype === 'Mha' ? 'manhua' : (manga.btype === 'C' ? 'comic' : 'novel'))),
    tags: bestResult.tags,
    chapters_count: bestResult.chapters.length,
    desc: manga.title || '',
    status: bestResult.status,
    chapters: bestResult.chapters,
    uid,
    image: manga.image || '',
    source: bestResult.source || '',
  });
});

