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
  getAllAnimes,
  readAnimeList
} = require('../services/jsonService');

const {
  getDescription,
  getEpisodes,
  getEpisodeImage,
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
// SEARCH ENGINE
// ─────────────────────────────────────────────

let searchable = [];
let fuse = null;

function buildSearchIndex() {
  const all = readAnimeList();

  searchable = all.map(anime => ({
    ...anime,
    normalizedTitle: normalize(anime.title),
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

  console.log(`[SEARCH] Indexed ${searchable.length} animes`);
}

buildSearchIndex();

// ─────────────────────────────────────────────
// GET /anime/list?p={page|all}
// ─────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;

  if (p === 'all') {
    return res.sendFile(getJSONPath('anime_list.json'));
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

  if (!anime) {
    return res.status(404).json({ error: `No se encontró anime con uid = ${uid}` });
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

  for (const mirrorKey of MIRRORS) {
    const sourceUrl = anime.sources?.[mirrorKey];
    if (!sourceUrl) continue;

    try {
      const raw = await getEpisodes(sourceUrl);
      if (!raw?.episodes?.length) continue;

      // Comparamos si este mirror tiene más episodios que el mejor encontrado hasta ahora
      if (raw.episodes.length > bestResult.episodes.length) {
        bestResult = {
          episodes: raw.episodes.map(ep => ({
            num: Number(ep.number),
            url: `/player/${uid}/${ep.number}`,
          })),
          status: Boolean(raw.isEnd) ? 'Finalizado' : 'En emisión',
          source: mirrorKey
        };
      }
    } catch (err) {
      console.warn(`[info/eps] ${mirrorKey}: ${err.message}`);
    }
  }

  res.json({
    type: 'anime',
    title: anime.title,
    slug: anime.slug,
    category: anime.category || 'anime',
    eps: bestResult.episodes.length,
    desc: description || '',
    tags: anime.tags || [],
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

// ─────────────────────────────────────────────
// SEARCH
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
    
    const filtered = searchable.filter(anime => {
      const getValueByPath = (obj, path) => {
        return path.split('.').reduce((acc, part) => {
          if (!acc) return undefined;
          const targetKey = Object.keys(acc).find(
            k => k.toLowerCase() === part.toLowerCase()
          );
          return targetKey ? acc[targetKey] : undefined;
        }, obj);
      };

      const animeVal = getValueByPath(anime, keyPath);
      if (animeVal === undefined || animeVal === null) return false;
      if (typeof animeVal === 'number') {
        return animeVal === Number(rawValue.trim());
      }
      return String(animeVal).toLowerCase() === targetValue;
    });

    results = filtered.map(anime => ({ item: anime, score: 0 }));
  } else {
    const term = normalize(query);
    results = fuse.search(term);

    try {
      const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(term)}&limit=10`);
      if (response.ok) {
        const json = await response.json();
        const aliases = [];
        for (const anime of json.data) {
          if (!anime.title) continue;
          const n = normalize(anime.title);
          if (n && !aliases.includes(n)) {
            aliases.push(n);
          }
        }
        for (const alias of aliases) {
          const exactMatches = searchable.filter(a => a.normalizedTitle === alias);
          for (const anime of exactMatches) {
            results.push({ item: anime, score: 0 });
          }
        }
      }
    } catch (err) {
      console.error('[JIKAN]', err.message);
    }
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
      image: r.item.image,
      score: r.score
    }));

  res.json(finalResults);
});

exports.rebuildSearch = asyncHandler(async (req, res) => {
  buildSearchIndex();
  res.json({ success: true, indexed: searchable.length });
});

exports.initmjs = asyncHandler(async (req, res) => {
  res.json({
    mjs: 'This is the AnyExt API, please return to the main page.',
    web: 'https://anyext-m5lt.onrender.com/',
    date: new Date().toISOString()
  });
});