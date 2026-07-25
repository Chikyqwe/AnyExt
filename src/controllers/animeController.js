// src/controllers/animeController.js

const path = require('path');
const asyncHandler = require('../middlewares/asyncHandler');
const { MemoryCache } = require('../core/cache/cache');
const Fuse = require('fuse.js');

const descriptionCache = new MemoryCache({
  maxEntries: 500,
  maxStringLength: 10000
});

const LRU_DESCRIPTION_TTL = 60_000 * 5;

const {
  getJSONPath,
  getAnimeByUnitId,
  readAnimeList,
  readRawJson
} = require('../services/jsonService');

const {
  getDescription,
  getEpisodes,
  proxyImage
} = require('../utils/helpers');

const MIRRORS = ['FLV', 'ONE', 'TIO', 'JK', 'ANIYAE', 'HENTAILA', 'TIOHENTAI'];
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
// GET /anime/list?p={page|all}
// ─────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;

  if (p === 'all') {
    return res.json(readRawJson());
  }

  const page = Math.max(1, parseInt(p) || 1);
  const all = readAnimeList();
  const total = all.length;
  const start = (page - 1) * PER_PAGE;

  const items = all
    .slice(start, start + PER_PAGE)
    .map(a => ({
      title: a.title,
      slug: a.slug,
      unit_id: a.unit_id,
    }));

  res.json({
    page,
    total,
    totalpages: Math.ceil(total / PER_PAGE),
    items,
  });
});

// ─────────────────────────────────────────────
// GET /anime/last
// ─────────────────────────────────────────────

exports.last = (req, res) => res.sendFile(getJSONPath('lastep.json'));

// ─────────────────────────────────────────────
// GET /api/info?uid=
// ─────────────────────────────────────────────

exports.info = asyncHandler(async (req, res) => {
  const uid = parseInt(req.query.uid);

  if (!uid) {
    return res.status(400).json({ error: 'Falta parámetro uid' });
  }

  const anime = getAnimeByUnitId(uid);

  if (anime.error == true) {
    return res.status(404).json({ error: `No se encontró anime con uid ${uid}, ¿quiso decir ${anime.recommendedId}?`, recommendedId: anime.recommendedId });
  }

  // ── DESCRIPTION CACHE ─────────────────────
  const cacheKey = `desc:${uid}`;
  let description = descriptionCache.load(cacheKey) || '';

  if (!description) {
    const sources = anime.sources || {};

    for (const url of Object.values(sources)) {
      if (!url) continue;
      try {
        description = await getDescription(url);
        if (description) break;
      } catch (err) {
        console.warn(`[info / desc] ${url}: ${err.message}`);
      }
    }

    if (description) {
      descriptionCache.save(cacheKey, description, LRU_DESCRIPTION_TTL);
    }
  }

  // ── EPISODES (Lógica mejorada para comparar mirrors) ──
  let bestResult = {
    episodes: [],
    status: 'Desconocido',
    source: null
  };

  const promises = MIRRORS.map(async (mirrorKey) => {
    const sourceUrl = anime.sources?.[mirrorKey];
    if (!sourceUrl) return null;

    try {
      const raw = await getEpisodes(sourceUrl);
      if (!raw?.episodes?.length) return null;
      return { raw, mirrorKey };
    } catch (err) {
      console.warn(`[info/eps] ${mirrorKey}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);

  for (const result of results) {
    if (!result) continue;
    const { raw, mirrorKey } = result;

    // Comparamos si este mirror tiene más episodios que el mejor encontrado hasta ahora
    if (raw.episodes.length > bestResult.episodes.length) {
      bestResult = {
        episodes: raw.episodes.map(ep => ({
          num: Number(ep.number),
          url: `/player/${uid}/${ep.number}`,
        })),
        status: Boolean(raw.isEnd) ? 'Finalizado' : 'En emisión',
        source: mirrorKey,
        tags: raw.tags
      };
    }
  }

  res.json({
    type: 'video',
    title: anime.title,
    slug: anime.slug,
    category: anime.btype === 'H' ? 'hentai' : (anime.btype === 'A' ? 'anime' : (anime.category || null)),
    tags: bestResult.tags,
    eps: bestResult.episodes.length,
    desc: description || '',
    status: bestResult.status,
    episodes: bestResult.episodes,
    uid,
    image: anime.image || '',
    source: bestResult.source || '',
  });
});

// ─────────────────────────────────────────────
// BASIC INFO
// ─────────────────────────────────────────────

exports.basicInfo = asyncHandler(async (req, res) => {
  const uid = parseInt(req.query.uid);
  const anime = getAnimeByUnitId(uid);

  if (!anime) {
    return res.status(404).json({ error: `No se encontró anime con uid=${uid}` });
  }

  res.json({
    type: 'anime',
    title: anime.title,
    slug: anime.slug,
    uid,
  });
});

// ─────────────────────────────────────────────
// IMAGE
// ─────────────────────────────────────────────

exports.img = asyncHandler(async (req, res) => {
  const { uid, type, ep } = req.body;

  if (!uid) return res.status(400).json({ error: 'Falta uid' });
  if (!type) return res.status(400).json({ error: 'Falta type' });

  const anime = getAnimeByUnitId(parseInt(uid));
  if (!anime) {
    return res.status(404).json({ error: `Anime uid=${uid} no encontrado` });
  }

  if (type === 'cover') {
    const imageUrl = anime.image || anime.cover;
    if (!imageUrl) {
      return res.status(404).json({ error: 'Sin imagen' });
    }
    return proxyImage(imageUrl, res);
  }

  if (type === 'ep') {
    const epNum = parseInt(ep);
    if (!epNum) return res.status(400).json({ error: 'Falta ep' });

    for (const mirrorKey of MIRRORS) {
      const sourceUrl = anime.sources?.[mirrorKey];
      if (!sourceUrl) continue;

      try {
        const raw = await getEpisodes(sourceUrl);
        const found = raw?.episodes?.find(e => Number(e.number) === epNum);

        if (found?.img) {
          return proxyImage(found.img, res);
        }
      } catch { }
    }

    const fallback = anime.image || anime.cover;
    if (fallback) {
      return proxyImage(fallback, res);
    }

    return res.status(404).json({ error: 'Imagen de episodio no encontrada' });
  }

  return res.status(400).json({ error: `type inválido: ${type}` });
});

exports.rokuimg = (req, res) => {
  const { uid } = req.query;
  const anime = getAnimeByUnitId(parseInt(uid));

  if (!anime) {
    return res.status(404).json({ error: `Anime uid=${uid} no encontrado` });
  }

  const imageUrl = anime.image || anime.cover;
  if (!imageUrl) {
    return res.status(404).json({ error: 'Sin imagen' });
  }

  return proxyImage(imageUrl, res);
};

exports.initmjs = asyncHandler(async (req, res) => {
  res.json({
    mjs: 'This is the AnyExt API, please return to the main page.',
    web: 'https://anyext.qzz.io/',
    date: new Date().toISOString()
  });
});