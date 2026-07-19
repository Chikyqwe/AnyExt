// src/controllers/contentController.js

const path = require('path');
const asyncHandler = require('../middlewares/asyncHandler');
const { readAnimeList, readMangaList, getAnimeByUnitId, getMangaByUnitId, getJSONPath } = require('../services/jsonService');
const animeController = require('./animeController');
const mangaController = require('./mangaController');
const Fuse = require('fuse.js');

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


let searchable = [];
let fuse = null;

function buildSearchIndex() {
  const animes = readAnimeList().map(a => ({ ...a, contentType: 'anime' }));
  const mangas = readMangaList().map(m => ({ ...m, contentType: 'manga' }));

  const all = [...animes, ...mangas];

  searchable = all.map(item => ({
    ...item,
    normalizedTitle: normalize(item.title),
  }));

  fuse = new Fuse(searchable, {
    includeScore: true,
    threshold: 0.2,
    ignoreLocation: true,
    minMatchCharLength: 2,
    shouldSort: true,
    findAllMatches: true,
    useExtendedSearch: true,
    keys: [
      { name: 'normalizedTitle', weight: 1 },
      { name: 'title', weight: 0.8 }
    ]
  });

  console.log(`[SEARCH] Indexed ${searchable.length} contents`);
}

buildSearchIndex();

// ─────────────────────────────────────────────
// GET /cont/list?p={page|all}
// ─────────────────────────────────────────────
exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;

  const animes = readAnimeList().map(a => ({ ...a, contentType: 'anime' }));
  const mangas = readMangaList().map(m => ({ ...m, contentType: 'manga' }));

  // Combine both arrays. We can interleave them or just concatenate.
  const all = [...animes, ...mangas];

  if (p === 'all') {
    return res.json({ items: all });
  }

  const page = Math.max(1, parseInt(p) || 1);
  const total = all.length;
  const start = (page - 1) * PER_PAGE;

  const items = all
    .slice(start, start + PER_PAGE)
    .map(item => ({
      title: item.title,
      slug: item.slug,
      unit_id: item.unit_id,
      image: item.image || item.cover,
      type: item.contentType
    }));

  res.json({
    page,
    total,
    totalpages: Math.ceil(total / PER_PAGE),
    items,
  });
});

// ─────────────────────────────────────────────
// GET /api/info?uid=
// ─────────────────────────────────────────────
exports.info = asyncHandler(async (req, res, next) => {
  const uid = parseInt(req.query.uid);

  if (!uid) {
    return res.status(400).json({ error: 'Falta parámetro uid' });
  }

  // Comprobar si es anime
  const anime = getAnimeByUnitId(uid);
  if (!anime.error) {
    // Si es anime, delegar al controller de anime
    return animeController.info(req, res, next);
  }

  // Si no es anime, comprobar si es manga
  const manga = getMangaByUnitId(uid);
  if (!manga.error) {
    // Si es manga, delegar al controller de manga
    return mangaController.info(req, res, next);
  }

  // Si no se encuentra en ninguno, devolvemos error. Usamos las recomendaciones del anime (podría combinarse)
  return res.status(404).json({
    error: `No se encontró contenido con uid ${uid}`,
    recommendedAnimeId: anime.recommendedId,
    recommendedMangaId: manga.recommendedId
  });
});

// ─────────────────────────────────────────────
// POST /api/img
// ─────────────────────────────────────────────
exports.img = asyncHandler(async (req, res) => {
  const { uid, type, ep } = req.body;

  if (!uid) return res.status(400).json({ error: 'Falta uid' });
  if (!type) return res.status(400).json({ error: 'Falta type' });

  let item = getAnimeByUnitId(parseInt(uid));
  let isAnime = true;

  if (item.error) {
    item = getMangaByUnitId(parseInt(uid));
    isAnime = false;
  }

  if (item.error) {
    return res.status(404).json({ error: `Contenido uid=${uid} no encontrado` });
  }

  const { proxyImage, getEpisodes } = require('../utils/helpers');

  if (type === 'cover') {
    const imageUrl = item.image || item.cover;
    if (!imageUrl) {
      return res.status(404).json({ error: 'Sin imagen' });
    }
    return proxyImage(imageUrl, res);
  }

  if (type === 'ep') {
    const epNum = parseInt(ep);
    if (!epNum) return res.status(400).json({ error: 'Falta ep' });

    if (isAnime) {
      const MIRRORS = ['FLV', 'ONE', 'TIO', 'JK', 'ANIYAE', 'HENTAILA', 'TIOHENTAI'];

      for (const mirrorKey of MIRRORS) {
        const sourceUrl = item.sources?.[mirrorKey];
        if (!sourceUrl) continue;

        try {
          const raw = await getEpisodes(sourceUrl);
          const found = raw?.episodes?.find(e => Number(e.number) === epNum);

          if (found?.img) {
            return proxyImage(found.img, res);
          }
        } catch { }
      }
    }

    // Para manga (que no tienen imagen de capítulo por lo general)
    // o fallback para anime sin thumbnail de ep, usa el cover
    const fallback = item.image || item.cover;
    if (fallback) {
      return proxyImage(fallback, res);
    }

    return res.status(404).json({ error: 'Imagen de episodio no encontrada' });
  }

  return res.status(400).json({ error: `type inválido: ${type}` });
});

// ─────────────────────────────────────────────
// POST /cont/search
// ─────────────────────────────────────────────
exports.search = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) {
    return res.status(400).json({ error: 'Falta query' });
  }

  let results = [];
  let limit = 20;

  const match = query.trim().match(/^:\$([\w.]+):(.+)$/);

  if (match) {
    limit = Infinity;
    const [, keyPath, rawValue] = match;
    const targetValue = rawValue.trim().toLowerCase();

    const filtered = searchable.filter(item => {
      const getValueByPath = (obj, path) => {
        return path.split('.').reduce((acc, part) => {
          if (!acc) return undefined;
          const targetKey = Object.keys(acc).find(
            k => k.toLowerCase() === part.toLowerCase()
          );
          return targetKey ? acc[targetKey] : undefined;
        }, obj);
      };

      const itemVal = getValueByPath(item, keyPath);
      if (itemVal === undefined || itemVal === null) return false;
      if (typeof itemVal === 'number') {
        return itemVal === Number(rawValue.trim());
      }
      return String(itemVal).toLowerCase() === targetValue;
    });

    results = filtered.map(item => ({ item: item, score: 0 }));
  } else {
    const term = normalize(query);
    results = fuse.search(term);

    // Aquí omitimos Jikan (búsqueda web de anime) para que sea unificado localmente, 
    // o podríamos re-añadirlo solo para animes, pero para mantener velocidad lo dejamos en local.
  }

  const unique = new Map();
  for (const r of results) {
    const id = Number(r.item.unit_id);
    const current = unique.get(id);
    if (!current || r.score < current.score) {
      unique.set(id, r);
    }
  }

  const finalResults = [...unique.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(r => ({
      title: r.item.title,
      uid: Number(r.item.unit_id),
      unit_id: Number(r.item.unit_id),
      image: r.item.image || r.item.cover,
      type: r.item.contentType,
      score: r.score
    }));

  res.json(finalResults);
});

exports.rebuildSearch = asyncHandler(async (req, res) => {
  buildSearchIndex();
  res.json({ success: true, indexed: searchable.length });
});
