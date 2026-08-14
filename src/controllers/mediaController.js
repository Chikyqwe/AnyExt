// src/controllers/mediaController.js

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const path = require('path');
const { Transform } = require('stream');
const { default: axios } = require('axios');

const asyncHandler = require('../middlewares/asyncHandler');
const { mediaTextCache: cache, responseCache } = require('../core/cache/cacheInstances');
const apiQueue = require('../core/queue/queueService');
const { supabase } = require('../services/supabase/supabase');
const { HTTPS } = require('../config');

const { getAnimeByUnitId, getMangaByUnitId, getDramaByUnitId, getAllContentLists } = require('../services/jsonService');
const Fuse = require('fuse.js');
const { descriptionCache, DESCRIPTION_TTL: LRU_DESCRIPTION_TTL } = require('../core/cache/cacheInstances');

const { extractAllVideoLinks, getExtractor } = require('../core/core');
const { streamVideo, downloadVideo } = require('../utils/helpers');
const { parseMegaUrl, verificarArchivoMega } = require('../utils/CheckMega');
const { proxyImage, getEpisodes, getDescription, getValidEpisodeImage, checkImageExists } = require('../utils/helpers');

const PER_PAGE = 24;

// ─────────────────────────────────────────────
// NORMALIZE & SEARCH INDEX (OPTIMIZED)
// ─────────────────────────────────────────────
const normalize = (str = '') =>
  str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// --- Lightweight search entry (no spreading full objects) ---
// Each entry holds: { title, normalizedTitle, unit_id, image, contentType, _ref }
let searchable = [];
let fuse = null;

// --- Prefix index: first N chars → array of indices into searchable ---
const PREFIX_LEN = 3;
let prefixIndex = new Map();     // normalized prefix → [idx, idx, …]
let substringCache = new Map();  // normalized query → results  (TTL-based)
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 min
let searchCacheTimers = new Map();

function buildSearchIndex() {
  const t0 = Date.now();
  const all = getAllContentLists();

  const entries = [];
  const types = [
    [all.animes, 'anime'],
    [all.mangas, 'manga'],
    [all.dramas, 'drama']
  ];

  for (const [list, contentType] of types) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const norm = normalize(item.title);
      entries.push({
        title: item.title,
        normalizedTitle: norm,
        unit_id: item.unit_id,
        image: item.image || item.cover,
        slug: item.slug,
        contentType,
        _ref: item  // keep reference, no spread
      });
    }
  }

  searchable = entries;

  // Build prefix index
  prefixIndex = new Map();
  for (let idx = 0; idx < entries.length; idx++) {
    const norm = entries[idx].normalizedTitle;
    // Index all substrings of length PREFIX_LEN (trigrams)
    for (let j = 0; j <= norm.length - PREFIX_LEN; j++) {
      const tri = norm.substring(j, j + PREFIX_LEN);
      let arr = prefixIndex.get(tri);
      if (!arr) { arr = []; prefixIndex.set(tri, arr); }
      arr.push(idx);
    }
  }

  // Build Fuse index (lighter — only normalizedTitle)
  fuse = new Fuse(searchable, {
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    ignoreFieldNorm: true,
    minMatchCharLength: 2,
    shouldSort: true,
    keys: ['normalizedTitle']
  });

  // Clear search cache on rebuild
  substringCache.clear();
  for (const t of searchCacheTimers.values()) clearTimeout(t);
  searchCacheTimers.clear();

  console.log(`[SEARCH] Indexed ${searchable.length} contents in ${Date.now() - t0}ms (${prefixIndex.size} trigrams)`);
}

// --- Fast tier: trigram intersection for substring matching ---
function fastSubstringSearch(query, limit = 20) {
  const norm = normalize(query);
  if (norm.length < 2) return null; // too short for fast path

  // Extract trigrams from query
  const queryTrigrams = [];
  for (let i = 0; i <= norm.length - PREFIX_LEN; i++) {
    queryTrigrams.push(norm.substring(i, i + PREFIX_LEN));
  }

  if (queryTrigrams.length === 0) {
    // Query shorter than PREFIX_LEN: scan prefix index for matching keys
    const results = [];
    for (let idx = 0; idx < searchable.length; idx++) {
      if (searchable[idx].normalizedTitle.includes(norm)) {
        results.push({ item: searchable[idx], score: 0 });
        if (results.length >= limit) break;
      }
    }
    return results.length > 0 ? results : null;
  }

  // Intersect posting lists (smallest first for speed)
  const lists = queryTrigrams
    .map(tri => prefixIndex.get(tri))
    .filter(Boolean);

  if (lists.length === 0) return null;

  // Sort by smallest list first
  lists.sort((a, b) => a.length - b.length);

  // Intersect using Set from smallest list
  let candidates = new Set(lists[0]);
  for (let i = 1; i < lists.length && candidates.size > 0; i++) {
    const nextSet = new Set(lists[i]);
    for (const c of candidates) {
      if (!nextSet.has(c)) candidates.delete(c);
    }
  }

  if (candidates.size === 0) return null;

  // Verify actual substring match and score
  const results = [];
  for (const idx of candidates) {
    const entry = searchable[idx];
    const pos = entry.normalizedTitle.indexOf(norm);
    if (pos === -1) continue;

    // Score: 0 = perfect start match, higher = worse
    const score = pos === 0 ? 0 : pos / entry.normalizedTitle.length;
    results.push({ item: entry, score });
  }

  if (results.length === 0) return null;

  results.sort((a, b) => a.score - b.score);
  return results.slice(0, limit);
}

buildSearchIndex();

// ─────────────────────────────────────────────
// VIDEO UTILS
// ─────────────────────────────────────────────
function generateKey(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function norm(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (['yourupload', 'your-up', 'yu'].some(s => n.includes(s))) return 'yu';
  if (['burstcloud', 'bc'].some(s => n.includes(s))) return 'bc';
  if (['asnwish', 'obeywish', 'sw'].some(s => n.includes(s))) return 'sw';
  if (['mega', 'nz', 'mega.nz'].some(s => n.includes(s))) return 'mega';
  return n;
}

async function getVid(server, url, mid, refresh = false) {
  const id = mid || generateKey(url);
  if (!refresh && cache.exists(id)) return { mid: id, Rc: cache.load(id) };

  const ex = getExtractor(server);
  if (!ex) throw new Error('Extractor no encontrado');

  const r = await ex(url);
  if (!r || r.status >= 700) throw new Error(r?.mjs || 'Extractor error');

  const best = Array.isArray(r) ? r[0] : r;
  const content = best?.content?.length ? best.content : best?.hls?.content;
  if (!content?.length) throw new Error('Contenido vacío');

  const Rc = cache.save(id, content);
  return { mid: id, Rc };
}

async function filterV(videos) {
  const out = [];
  for (const v of videos) {
    const s = norm(v.servidor);

    // Permitir pasar si hay extractor disponible O si el servidor es Mega
    if (!getExtractor(s) && s !== 'mega') continue;

    const it = { servidor: s, label: v.label, name: v.name, url: v.url };

    if (typeof it.url === 'string' && it.url.includes('mega.nz')) {
      try {
        const { id, key } = parseMegaUrl(it.url);
        const r = await verificarArchivoMega(id, key);
        if (r?.disponible) it.url = `https://mega.nz/embed/${id}#${key}`;
        else continue;
      } catch {
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

const createVideoCleaner = () => {
  let buffer = Buffer.alloc(0);
  let synced = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 188) {
        if (!synced) {
          let found = -1;
          for (let i = 0; i < buffer.length - 376; i++) {
            if (buffer[i] === 0x47 && buffer[i + 188] === 0x47 && buffer[i + 376] === 0x47) {
              found = i;
              break;
            }
          }
          if (found === -1) { buffer = buffer.slice(buffer.length - 376); break; }
          buffer = buffer.slice(found);
          synced = true;
        }
        if (buffer.length < 188) break;
        this.push(buffer.slice(0, 188));
        buffer = buffer.slice(188);
      }

      callback();
    },
  });
};

function getContentType(item, defaultType) {
  // Si es del archivo de anime pero tiene btype "H", lo marcamos como hentai
  if (defaultType === 'anime' && item.btype === 'H') {
    return 'hentai';
  }
  if (defaultType === 'manga' && item.btype === 'C') {
    return 'manga';
  }
  return defaultType;
}

let listMetadataCache = null;

function getListMetadata() {
  if (listMetadataCache) return listMetadataCache;

  const all = getAllContentLists();
  const animes = all.animes || [];
  const mangas = all.mangas || [];
  const dramas = all.dramas || [];

  const items = [
    ...animes.map(a => ({
      title: a.title,
      slug: a.slug,
      unit_id: a.unit_id,
      image: a.image || a.cover,
      type: getContentType(a, 'anime')
    })),
    ...mangas.map(m => ({
      title: m.title,
      slug: m.slug,
      unit_id: m.unit_id,
      image: m.image || m.cover,
      type: getContentType(m, 'manga')
    })),
    ...dramas.map(d => ({
      title: d.title,
      slug: d.slug,
      unit_id: d.unit_id,
      image: d.image || d.cover,
      type: getContentType(d, 'drama')
    }))
  ];

  const total = items.length;
  listMetadataCache = {
    items,
    animesCount: animes.length,
    mangasCount: mangas.length,
    dramasCount: dramas.length,
    total,
    totalpages: Math.ceil(total / PER_PAGE),
    manga_start_page: Math.floor(animes.length / PER_PAGE) + 1,
    drama_start_page: Math.floor((animes.length + mangas.length) / PER_PAGE) + 1
  };

  return listMetadataCache;
}

exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;
  const meta = getListMetadata();

  if (p === 'all') {
    return res.json({ items: meta.items });
  }

  const cacheKey = `list:${p}`;
  let cached = responseCache.load(cacheKey);
  if (cached) return res.json(cached);

  const page = Math.max(1, parseInt(p) || 1);
  const start = (page - 1) * PER_PAGE;
  const slicedItems = meta.items.slice(start, start + PER_PAGE);

  const result = {
    page,
    total: meta.total,
    totalpages: meta.totalpages,
    manga_start_page: meta.manga_start_page,
    drama_start_page: meta.drama_start_page,
    items: slicedItems
  };

  responseCache.save(cacheKey, result, 5 * 60 * 1000);
  res.json(result);
});

// src/controllers/mediaController.js - exports.info optimizado

exports.info = asyncHandler(async (req, res, next) => {
  const uid = parseInt(req.query.uid);
  if (!uid) return res.status(400).json({ error: 'Falta parámetro uid' });

  const cacheKey = `info:${uid}`;
  let cached = responseCache.load(cacheKey);
  if (cached) return res.json(cached);

  const all = getAllContentLists();

  // Buscar en qué categoría está
  const anime = all.animes.find(a => a.unit_id === uid);
  const manga = all.mangas.find(m => m.unit_id === uid);
  const drama = all.dramas.find(d => d.unit_id === uid);

  let result = null;

  if (anime) {
    result = await getAnimeInfoOptimized(anime, uid);
  } else if (manga) {
    result = await getMangaInfoOptimized(manga, uid);
  } else if (drama) {
    result = await getDramaInfoOptimized(drama, uid);
  } else {
    return res.status(404).json({ error: `No se encontró contenido con uid ${uid}` });
  }

  responseCache.save(cacheKey, result, 10 * 60 * 500);
  return res.json(result);
});

// ─────────────────────────────────────────────
// FUNCIONES OPTIMIZADAS PARA INFO
// ─────────────────────────────────────────────

async function getAnimeInfoOptimized(anime, uid) {
  const MIRRORS = ['FLV', 'ONE', 'TIO', 'JK', 'ANIYAE', 'HENTAILA', 'TIOHENTAI'];
  const availableMirrors = MIRRORS.filter(m => anime.sources?.[m]);

  if (availableMirrors.length === 0) {
    return {
      type: 'anime',
      title: anime.title,
      slug: anime.slug,
      category: anime.btype === 'H' ? 'Hentai' : 'Anime',
      eps: 0,
      desc: '',
      status: 'Desconocido',
      episodes: [],
      uid,
      image: anime.image || '',
      source: ''
    };
  }

  // ── 1. OBTENER DESCRIPCIÓN (solo del primer mirror disponible) ──
  const descCacheKey = `desc:${uid}`;
  let description = descriptionCache.load(descCacheKey) || '';

  if (!description) {
    const firstSource = anime.sources[availableMirrors[0]];
    if (firstSource) {
      try {
        description = await getDescription(firstSource);
        if (description) {
          descriptionCache.save(descCacheKey, description, LRU_DESCRIPTION_TTL);
        }
      } catch (err) {
        console.warn(`[info/desc] Error: ${err.message}`);
      }
    }
  }

  // ── 2. OBTENER EPISODIOS EN PARALELO (con timeout) ──
  const episodesPromises = availableMirrors.map(async (mirrorKey) => {
    const sourceUrl = anime.sources[mirrorKey];
    if (!sourceUrl) return null;

    try {
      // Timeout individual por mirror
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 8000)
      );

      const rawPromise = getEpisodes(sourceUrl);
      const raw = await Promise.race([rawPromise, timeoutPromise]);

      if (!raw?.episodes?.length) return null;

      return {
        mirrorKey,
        episodes: raw.episodes,
        isEnd: Boolean(raw.isEnd),
        tags: raw.tags || []
      };
    } catch (err) {
      console.warn(`[info/eps] ${mirrorKey}: ${err.message}`);
      return null;
    }
  });

  // Esperar todas las promesas (la que termine primero o todas)
  const results = await Promise.allSettled(episodesPromises);

  // Buscar el mirror con más episodios
  let bestResult = {
    episodes: [],
    status: 'Desconocido',
    source: null,
    tags: []
  };

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { mirrorKey, episodes, isEnd, tags } = result.value;
      if (episodes.length > bestResult.episodes.length) {
        bestResult = {
          episodes: episodes.map(ep => ({
            num: Number(ep.number),
            url: `/player/${uid}/${ep.number}`
          })),
          status: isEnd ? 'Finalizado' : 'En emisión',
          source: mirrorKey,
          tags: tags || []
        };
      }
    }
  }

  return {
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
  };
}

async function getDramaInfoOptimized(drama, uid) {
  const MIRRORS = ['dorlat', 'dormp4'];
  const availableMirrors = MIRRORS.filter(m => drama.sources?.[m]);

  if (availableMirrors.length === 0) {
    return {
      type: 'drama',
      title: drama.title,
      slug: drama.slug,
      category: 'drama',
      episodes_count: 0,
      desc: '',
      status: 'Desconocido',
      episodes: [],
      uid,
      image: drama.image || '',
      source: '',
      langs: [],
      subtitles: []
    };
  }

  // ── DESCRIPCIÓN ──
  const descCacheKey = `desc:${uid}`;
  let description = descriptionCache.load(descCacheKey) || '';

  if (!description) {
    const firstSource = drama.sources[availableMirrors[0]];
    if (firstSource) {
      try {
        description = await getDescription(firstSource);
        if (description) {
          descriptionCache.save(descCacheKey, description, LRU_DESCRIPTION_TTL);
        }
      } catch (err) {
        console.warn(`[info/desc] Drama error: ${err.message}`);
      }
    }
  }

  // ── EPISODIOS EN PARALELO ──
  const episodesPromises = availableMirrors.map(async (mirrorKey) => {
    const sourceUrl = drama.sources[mirrorKey];
    if (!sourceUrl) return null;

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 8000)
      );

      const rawPromise = getEpisodes(sourceUrl);
      const raw = await Promise.race([rawPromise, timeoutPromise]);

      if (raw && !raw.episodes && raw.chapters) {
        raw.episodes = raw.chapters;
      }

      if (!raw?.episodes?.length) return null;

      return {
        mirrorKey,
        episodes: raw.episodes,
        isEnd: Boolean(raw.isEnd),
        tags: raw.tags || [],
        langs: raw.langs || [],
        sub: raw.sub || []
      };
    } catch (err) {
      console.warn(`[info/eps] ${mirrorKey}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.allSettled(episodesPromises);

  let bestResult = {
    episodes: [],
    status: 'Desconocido',
    source: null,
    tags: [],
    langs: [],
    sub: []
  };

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { mirrorKey, episodes, isEnd, tags, langs, sub } = result.value;
      if (episodes.length > bestResult.episodes.length) {
        bestResult = {
          episodes: episodes.map(ep => ({
            num: Number(ep.num || ep.number),
            url: `/player/${uid}/${ep.number}`
          })),
          status: isEnd ? 'Finalizado' : 'En emisión',
          source: mirrorKey,
          tags: tags || [],
          langs: langs || [],
          sub: sub || []
        };
      }
    }
  }

  return {
    type: 'drama',
    title: drama.title,
    slug: drama.slug,
    category: 'drama',
    tags: bestResult.tags,
    episodes_count: bestResult.episodes.length,
    desc: description || '',
    langs: bestResult.langs,
    subtitles: bestResult.sub,
    status: bestResult.status,
    episodes: bestResult.episodes,
    uid,
    image: drama.image || '',
    source: bestResult.source || '',
  };
}

async function getMangaInfoOptimized(manga, uid) {
  const MIRRORS = ['tmo', 'oly', 'esp', 'tmonet'];
  const availableMirrors = MIRRORS.filter(m => manga.sources?.[m]);

  if (availableMirrors.length === 0) {
    return {
      type: 'manga',
      title: manga.title,
      slug: manga.slug,
      category: 'manga',
      chapters_count: 0,
      desc: manga.title || '',
      status: 'Desconocido',
      chapters: [],
      uid,
      image: manga.image || '',
      source: ''
    };
  }

  // ── OBTENER DESCRIPCIÓN (solo del primer mirror disponible) ──
  const descCacheKey = `desc:manga:${uid}`;
  let description = descriptionCache.load(descCacheKey) || '';

  if (!description) {
    const firstSource = manga.sources[availableMirrors[0]];
    if (firstSource) {
      try {
        description = await getDescription(firstSource);
        if (description) {
          descriptionCache.save(descCacheKey, description, LRU_DESCRIPTION_TTL);
        }
      } catch (err) {
        console.warn(`[info/desc] Manga error: ${err.message}`);
      }
    }
  }

  // ── CAPÍTULOS EN PARALELO ──
  const chaptersPromises = availableMirrors.map(async (mirrorKey) => {
    const sourceUrl = manga.sources[mirrorKey];
    if (!sourceUrl) return null;

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 8000)
      );

      const rawPromise = getEpisodes(sourceUrl);
      const raw = await Promise.race([rawPromise, timeoutPromise]);

      if (raw && !raw.chapters && raw.episodes) {
        raw.chapters = raw.episodes;
      }

      if (!raw?.chapters?.length) return null;

      return {
        mirrorKey,
        chapters: raw.chapters,
        isEnd: Boolean(raw.isEnd),
        tags: raw.tags || []
      };
    } catch (err) {
      console.warn(`[info/chapters] ${mirrorKey}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.allSettled(chaptersPromises);

  let bestResult = {
    chapters: [],
    status: 'Desconocido',
    source: null,
    tags: []
  };

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { mirrorKey, chapters, isEnd, tags } = result.value;
      if (chapters.length > bestResult.chapters.length) {
        bestResult = {
          chapters: chapters.map(ch => ({
            num: Number(ch.num || ch.number),
            url: `/reader/${uid}/${ch.number}`
          })),
          status: isEnd ? 'Finalizado' : 'En emisión',
          source: mirrorKey,
          tags: tags || []
        };
      }
    }
  }

  // Determinar categoría
  let category = 'manga';
  if (manga.btype === 'Mh') category = 'manhwa';
  else if (manga.btype === 'Mha') category = 'manhua';
  else if (manga.btype === 'C') category = 'comic';
  else if (manga.btype === 'N') category = 'novel';

  return {
    type: 'manga',
    title: manga.title,
    slug: manga.slug,
    category: category,
    tags: bestResult.tags,
    chapters_count: bestResult.chapters.length,
    desc: description || manga.title || '',  // ← Descripción añadida
    status: bestResult.status,
    chapters: bestResult.chapters,
    uid,
    image: manga.image || '',
    source: bestResult.source || '',
  };
}

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

exports.img = asyncHandler(async (req, res) => {
  const { uid, type, ep } = req.body;
  if (!uid) return res.status(400).json({ error: 'Falta uid' });
  if (!type) return res.status(400).json({ error: 'Falta type' });

  let item = getAnimeByUnitId(parseInt(uid));
  let isAnime = true;
  let isManga = false;

  if (item.error) {
    item = getMangaByUnitId(parseInt(uid));
    isAnime = false;
    isManga = true;
  }

  if (item.error) {
    item = getDramaByUnitId(parseInt(uid));
    isAnime = false;
    isManga = false;
  }

  if (item.error) {
    return res.status(404).json({ error: `Contenido uid=${uid} no encontrado` });
  }

  // Manejar cover
  if (type === 'cover') {
    const imageUrl = item.image || item.cover;
    if (!imageUrl) return res.status(404).json({ error: 'Sin imagen' });

    // Verificar si la imagen existe
    const imageExists = await checkImageExists(imageUrl);
    if (!imageExists) {
      // Si la imagen no existe, podrías devolver una imagen por defecto o error
      return res.status(404).json({ error: 'Imagen no disponible' });
    }

    return proxyImage(imageUrl, res);
  }

  // Manejar episodio
  if (type === 'ep') {
    const epNum = parseInt(ep);
    if (!epNum) return res.status(400).json({ error: 'Falta ep' });

    const MIRRORS = ['FLV', 'ONE', 'TIO', 'JK', 'ANIYAE', 'HENTAILA', 'TIOHENTAI'];

    let finalImage = null;

    if (isAnime) {
      // Buscar imagen de episodio o fallback al cover
      finalImage = await getValidEpisodeImage(item, epNum, MIRRORS);
    } else {
      // Para manga o drama, usar directamente el cover como fallback
      const coverUrl = item.image || item.cover;
      if (coverUrl && await checkImageExists(coverUrl)) {
        finalImage = coverUrl;
      }
    }

    // Si no se encontró ninguna imagen válida
    if (!finalImage) {
      // Último intento: usar el cover sin verificar (por si acaso)
      const coverUrl = item.image || item.cover;
      if (coverUrl) {
        return proxyImage(coverUrl, res);
      }
      return res.status(404).json({ error: 'Imagen de episodio no encontrada' });
    }

    return proxyImage(finalImage, res);
  }

  return res.status(400).json({ error: `type inválido: ${type}` });
});

exports.search = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Falta query' });

  let results = [];
  let limit = 20;
  const trimmed = query.trim();
  const match = trimmed.match(/^:\$([\w.]+):(.+)$/);

  if (match) {
    // --- Advanced field filter (no caching) ---
    limit = Infinity;
    const [, keyPath, rawValue] = match;
    const targetValue = rawValue.trim().toLowerCase();

    const getValueByPath = (obj, pathStr) => {
      const parts = pathStr.split('.');
      let acc = obj;
      for (const part of parts) {
        if (!acc || typeof acc !== 'object') return undefined;
        // Use _ref for nested field access
        const src = acc._ref || acc;
        const targetKey = Object.keys(src).find(k => k.toLowerCase() === part.toLowerCase());
        acc = targetKey ? src[targetKey] : undefined;
      }
      return acc;
    };

    const filtered = searchable.filter(item => {
      const itemVal = getValueByPath(item, keyPath);
      if (itemVal === undefined || itemVal === null) return false;
      if (typeof itemVal === 'number') return itemVal === Number(rawValue.trim());
      return String(itemVal).toLowerCase() === targetValue;
    });
    results = filtered.map(item => ({ item, score: 0 }));
  } else {
    // --- Standard search: check cache first ---
    const cacheKey = normalize(trimmed);
    const cached = substringCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Tier 1: Fast trigram substring search
    const fastResults = fastSubstringSearch(trimmed, 30);

    if (fastResults && fastResults.length >= 3) {
      results = fastResults;
    } else {
      // Tier 2: Fuse.js fuzzy fallback (handles typos)
      const term = normalize(trimmed);
      const fuseResults = fuse.search(term);

      // Merge fast + fuzzy, preferring better scores
      const merged = new Map();
      if (fastResults) {
        for (const r of fastResults) {
          merged.set(Number(r.item.unit_id), r);
        }
      }
      for (const r of fuseResults) {
        const id = Number(r.item.unit_id);
        const existing = merged.get(id);
        if (!existing || r.score < existing.score) {
          merged.set(id, r);
        }
      }
      results = [...merged.values()];
    }
  }

  // Deduplicate by unit_id
  const unique = new Map();
  for (const r of results) {
    const id = Number(r.item.unit_id);
    const current = unique.get(id);
    if (!current || r.score < current.score) unique.set(id, r);
  }

  const finalResults = [...unique.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(r => ({
      title: r.item.title,
      uid: Number(r.item.unit_id),
      unit_id: Number(r.item.unit_id),
      image: r.item.image,
      type: r.item.contentType,
      score: r.score
    }));

  // Cache standard search results
  if (!match) {
    const cacheKey = normalize(trimmed);
    substringCache.set(cacheKey, finalResults);
    const timer = setTimeout(() => {
      substringCache.delete(cacheKey);
      searchCacheTimers.delete(cacheKey);
    }, SEARCH_CACHE_TTL);
    timer.unref();
    searchCacheTimers.set(cacheKey, timer);
  }

  res.json(finalResults);
});

exports.rebuildSearch = asyncHandler(async (req, res) => {
  buildSearchIndex();
  res.json({ success: true, indexed: searchable.length });
});

exports.rebuildSearchLocal = buildSearchIndex;

// ─────────────────────────────────────────────
// VIDEO ROUTES
// ─────────────────────────────────────────────

exports.play = asyncHandler(async (req, res) => {
  try {
    let { type = 'anime', Did, uid, ep, s = 'auto', m, refresh, Os = false, lang = null } = req.body;
    uid = uid ? parseInt(uid) : undefined;
    ep = ep ? parseInt(ep) : undefined;

    // Drama default language: Korean (009)
    if ((type === 'drama' || type === 'dorama') && !lang) {
      lang = '009';
    }

    if (!uid) {
      return res.status(400).json({
        error: true,
        message: 'uid obligatorio',
        code: 'MISSING_UID'
      });
    }
    if (!ep) {
      return res.status(400).json({
        error: true,
        message: 'ep obligatorio',
        code: 'MISSING_EP'
      });
    }

    // ─────────────────────────────────────────────
    // 📖 MANGA
    // ─────────────────────────────────────────────
    if (type === 'manga') {
      const { getEpisodes } = require('../utils/helpers');

      const manga = getMangaByUnitId(uid);
      if (!manga?.unit_id) {
        return res.status(404).json({
          error: true,
          message: 'Manga no encontrado',
          code: 'MANGA_NOT_FOUND',
          data: { uid, type }
        });
      }

      const isAutoMirror = m === 'auto' || !m || m === '';
      const mirrorsToTry = isAutoMirror
        ? Object.keys(manga.sources || {}).filter(k => manga.sources[k])
        : [m];

      if (mirrorsToTry.length === 0) {
        return res.status(404).json({
          error: true,
          message: 'No hay mirrors disponibles',
          code: 'NO_MIRRORS_AVAILABLE',
          data: {
            uid,
            type,
            availableSources: Object.keys(manga.sources || {}),
            requestedMirror: m
          }
        });
      }

      let validImgs = null;
      let finalMirror = null;
      let mid = null;
      const errors = [];

      for (const mirrorKey of mirrorsToTry) {
        const sourceUrl = manga.sources?.[mirrorKey];
        if (!sourceUrl) {
          errors.push({ mirror: mirrorKey, error: 'sourceUrl no existe' });
          continue;
        }

        let raw;
        try {
          raw = await getEpisodes(sourceUrl);
        } catch (e) {
          errors.push({
            mirror: mirrorKey,
            error: 'Error en getEpisodes',
            details: e.message,
            stack: e.stack
          });
          continue;
        }

        if (raw && !raw.chapters && raw.episodes) {
          raw.chapters = raw.episodes;
        }

        if (!raw?.chapters) {
          errors.push({
            mirror: mirrorKey,
            error: 'No hay chapters en la respuesta',
            rawKeys: raw ? Object.keys(raw) : null,
            rawSample: raw ? JSON.stringify(raw).substring(0, 200) : null
          });
          continue;
        }

        const chapter = raw.chapters.find(c => Number(c.num || c.number) === ep);
        if (!chapter) {
          errors.push({
            mirror: mirrorKey,
            error: `Capítulo ${ep} no encontrado`,
            availableChapters: raw.chapters.map(c => c.num || c.number)
          });
          continue;
        }

        let coreExtractorName = mirrorKey;
        if (mirrorKey === 'olympusxyz') coreExtractorName = 'oly';
        if (mirrorKey === 'mangalect' || mirrorKey === 'lectesp') coreExtractorName = 'esp';
        if (mirrorKey === 'zonatmo') coreExtractorName = 'tmonet';

        const ex = getExtractor(coreExtractorName);
        if (!ex) {
          errors.push({
            mirror: mirrorKey,
            error: `Extractor ${coreExtractorName} no encontrado`,
            availableExtractors: Object.keys(extractorMap || {})
          });
          continue;
        }

        try {
          const imgs = await ex(chapter.url);
          if (imgs && imgs.length > 0) {
            validImgs = imgs;
            finalMirror = mirrorKey;
            mid = generateKey(chapter.url);
            break;
          } else {
            errors.push({
              mirror: mirrorKey,
              error: 'No se encontraron imágenes',
              imgsLength: imgs?.length || 0
            });
          }
        } catch (e) {
          errors.push({
            mirror: mirrorKey,
            error: 'Error extrayendo imágenes',
            details: e.message,
            stack: e.stack,
            url: chapter.url
          });
        }
      }

      if (!validImgs) {
        return res.status(404).json({
          error: true,
          message: 'No se encontraron imágenes en ningún mirror',
          code: 'NO_IMAGES_FOUND',
          data: {
            uid,
            ep,
            mirrorsTried: mirrorsToTry,
            errors
          }
        });
      }

      cache.save(mid, JSON.stringify(validImgs));

      const now = Math.floor(Date.now() / 1000);
      return res.json({
        type: 'manga',
        mirror: finalMirror,
        servers: [finalMirror],
        Sserver: finalMirror,
        url: `/api/getMedia/${mid}`,
        mid,
        mtype: 'json',
        timestamp: now,
        exp: now + 15 * 60,
      });
    }

    // ─────────────────────────────────────────────
    // 📺 ANIME Y DRAMA (VIDEO)
    // ─────────────────────────────────────────────
    let contentItem = null;

    if (type === 'drama' || type === 'dorama') {
      contentItem = getDramaByUnitId(uid);
      if (!contentItem?.unit_id) {
        return res.status(404).json({
          error: true,
          message: 'Drama no encontrado',
          code: 'DRAMA_NOT_FOUND',
          data: { uid, type }
        });
      }
    } else {
      contentItem = getAnimeByUnitId(uid);
      if (!contentItem?.unit_id) {
        return res.status(404).json({
          error: true,
          message: 'Anime no encontrado',
          code: 'ANIME_NOT_FOUND',
          data: { uid, type }
        });
      }
    }

    const isAutoMirror = m === 'auto' || !m || m === '';
    const mirrorsToTry = isAutoMirror
      ? Object.keys(contentItem.sources || {}).filter(k => contentItem.sources[k])
      : [m];

    if (mirrorsToTry.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'No hay mirrors disponibles',
        code: 'NO_MIRRORS_AVAILABLE',
        data: {
          uid,
          type,
          availableSources: Object.keys(contentItem.sources || {}),
          requestedMirror: m
        }
      });
    }

    let valid = [];
    let finalMirror = null;
    const force = refresh === true || refresh === 'true';
    const errors = [];

    // Obtener episodios y servidores válidos
    for (const mirrorKey of mirrorsToTry) {
      const sourceUrl = contentItem.sources?.[mirrorKey];
      if (!sourceUrl) {
        errors.push({ mirror: mirrorKey, error: 'sourceUrl no existe' });
        continue;
      }

      let raw;
      try {
        raw = await getEpisodes(sourceUrl);
      } catch (e) {
        errors.push({
          mirror: mirrorKey,
          error: 'Error en getEpisodes',
          details: e.message,
          stack: e.stack,
          sourceUrl
        });
        continue;
      }

      if (!raw) {
        errors.push({
          mirror: mirrorKey,
          error: 'raw es null/undefined',
          sourceUrl
        });
        continue;
      }

      if (raw && !raw.episodes && raw.chapters) {
        raw.episodes = raw.chapters;
      }

      if (!raw?.episodes) {
        errors.push({
          mirror: mirrorKey,
          error: 'No hay episodes en la respuesta',
          rawKeys: Object.keys(raw),
          rawSample: JSON.stringify(raw).substring(0, 500)
        });
        continue;
      }

      const episode = raw.episodes.find(e => Number(e.num || e.number) === ep);
      if (!episode) {
        errors.push({
          mirror: mirrorKey,
          error: `Episodio ${ep} no encontrado`,
          availableEpisodes: raw.episodes.map(e => e.num || e.number),
          totalEpisodes: raw.episodes.length
        });
        continue;
      }

      if (!episode?.url) {
        errors.push({
          mirror: mirrorKey,
          error: 'El episodio no tiene URL',
          episodeData: episode
        });
        continue;
      }

      let vids;
      try {
        vids = await extractAllVideoLinks(episode.url, lang);
      } catch (e) {
        errors.push({
          mirror: mirrorKey,
          error: 'Error en extractAllVideoLinks',
          details: e.message,
          stack: e.stack,
          url: episode.url,
          lang
        });
        continue;
      }

      if (!vids) {
        errors.push({
          mirror: mirrorKey,
          error: 'vids es null/undefined',
          url: episode.url,
          lang
        });
        continue;
      }

      if (vids.status && vids.status >= 700) {
        errors.push({
          mirror: mirrorKey,
          error: 'Error en extractAllVideoLinks',
          status: vids.status,
          message: vids.mjs || 'Error desconocido',
          url: episode.url,
          lang
        });
        continue;
      }

      if (!Array.isArray(vids) || vids.length === 0) {
        errors.push({
          mirror: mirrorKey,
          error: 'vids no es array o está vacío',
          vidsType: typeof vids,
          vidsLength: vids?.length,
          url: episode.url,
          lang
        });
        continue;
      }

      let filtered;
      try {
        filtered = await filterV(vids);
      } catch (e) {
        errors.push({
          mirror: mirrorKey,
          error: 'Error en filterV',
          details: e.message,
          stack: e.stack,
          vidsCount: vids.length
        });
        continue;
      }

      if (filtered && filtered.length > 0) {
        valid = filtered;
        finalMirror = mirrorKey;
        break;
      } else {
        errors.push({
          mirror: mirrorKey,
          error: 'No se encontraron servidores válidos después del filtro',
          totalVids: vids.length,
          filteredCount: filtered?.length || 0,
          serversFound: vids.map(v => v.servidor),
          lang
        });
      }
    }

    if (!valid.length) {
      return res.status(404).json({
        error: true,
        message: 'No hay servidores válidos en ningún mirror',
        code: 'NO_VALID_SERVERS',
        data: {
          uid,
          ep,
          type,
          lang,
          mirrorsTried: mirrorsToTry,
          errors: errors.slice(0, 20) // Limit to avoid huge response
        }
      });
    }

    const normalizedS = s !== 'auto' ? norm(s) : null;
    const sel = normalizedS ? valid.find(v => v.servidor === normalizedS) ?? valid[0] : valid[0];
    const serverNames = valid.map(v => v.servidor);
    const now = Math.floor(Date.now() / 1000);

    // ─────────────────────────────────────────────
    // 🔄 FUNCIÓN PARA PROCESAR CADA SERVIDOR CON REINTENTOS
    // ─────────────────────────────────────────────
    async function processServer(server, force, lang, type, finalMirror, serverNames, now) {
      try {
        // 1. Servidores HLS / Stream
        if (['sw', 'voe', 'streamwish', 'uqload'].includes(server.servidor)) {
          try {
            const { mid, Rc } = await getVid(server.servidor, server.url, null, force);
            return {
              success: true,
              data: {
                type,
                mirror: finalMirror,
                servers: serverNames,
                Sserver: server.servidor,
                url: `/api/getMedia/${mid}`,
                mid,
                lang: server.lang || lang || 'sub',
                mtype: 'hls',
                timestamp: now,
                exp: now + 15 * 60,
              }
            };
          } catch (e) {
            return {
              success: false,
              error: `Error en getVid: ${e.message}`,
              details: {
                server: server.servidor,
                url: server.url,
                force,
                stack: e.stack
              }
            };
          }
        }

        // 2. Servidor MEGA
        if (server.servidor === 'mega') {
          const mid = generateKey(server.url);
          cache.save(mid, server.url);
          return {
            success: true,
            data: {
              type,
              mirror: finalMirror,
              servers: serverNames,
              Sserver: server.servidor,
              url: `/api/getMedia/${mid}`,
              mid,
              lang: server.lang || lang || 'sub',
              mtype: 'embed',
              timestamp: now,
              exp: now + 15 * 60,
            }
          };
        }

        // 3. Servidores con extractor directo
        const ex = getExtractor(server.servidor);
        if (!ex) {
          return {
            success: false,
            error: `Extractor no encontrado para ${server.servidor}`,
            details: {
              server: server.servidor,
              availableExtractors: Object.keys(extractorMap || {})
            }
          };
        }

        const r = await ex(server.url);

        if (!r || r.status >= 700) {
          return {
            success: false,
            error: r?.mjs || 'Error en el extractor',
            details: {
              server: server.servidor,
              url: server.url,
              status: r?.status,
              response: r ? JSON.stringify(r).substring(0, 200) : null
            }
          };
        }

        // Verificar diferentes formatos de respuesta
        let videoUrl = r.url;
        if (!videoUrl && r.content && Array.isArray(r.content) && r.content.length > 0) {
          videoUrl = r.content[0]?.url || r.content[0];
        }
        if (!videoUrl && r.hls?.content && r.hls.content.length > 0) {
          videoUrl = r.hls.content[0]?.url || r.hls.content[0];
        }

        if (videoUrl) {
          const mid = generateKey(videoUrl);
          cache.save(mid, videoUrl);
          return {
            success: true,
            data: {
              type,
              mirror: finalMirror,
              servers: serverNames,
              Sserver: server.servidor,
              url: `/api/getMedia/${mid}`,
              mid,
              lang: server.lang || lang || 'sub',
              mtype: 'mp4',
              timestamp: now,
              exp: now + 15 * 60,
            }
          };
        }

        // Intentar con el primer contenido si existe
        if (r.content && Array.isArray(r.content) && r.content.length > 0) {
          const firstContent = r.content[0];
          if (typeof firstContent === 'string') {
            const mid = generateKey(firstContent);
            cache.save(mid, firstContent);
            return {
              success: true,
              data: {
                type,
                mirror: finalMirror,
                servers: serverNames,
                Sserver: server.servidor,
                url: `/api/getMedia/${mid}`,
                mid,
                lang: server.lang || lang || 'sub',
                mtype: 'mp4',
                timestamp: now,
                exp: now + 15 * 60,
              }
            };
          }
        }

        return {
          success: false,
          error: 'Formato de respuesta no reconocido',
          details: {
            server: server.servidor,
            url: server.url,
            responseType: typeof r,
            responseKeys: r ? Object.keys(r) : null,
            responseSample: r ? JSON.stringify(r).substring(0, 500) : null
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          details: {
            server: server.servidor,
            url: server.url,
            stack: error.stack
          }
        };
      }
    }

    // ─────────────────────────────────────────────
    // 📤 RESPUESTA PARA OS (SOLO SERVIDORES)
    // ─────────────────────────────────────────────
    if (Os) {
      return res.json({
        type,
        mirror: finalMirror,
        servers: valid.map(v => ({
          name: v.servidor,
          url: v.url,
          lang: v.lang || lang || 'sub'
        }))
      });
    }

    // ─────────────────────────────────────────────
    // 🔄 REINTENTOS CON MÚLTIPLES SERVIDORES
    // ─────────────────────────────────────────────
    const sortedServers = [
      sel,
      ...valid.filter(v => v.servidor !== sel.servidor)
    ];

    let lastError = null;
    let lastErrorDetails = null;
    let attempts = 0;

    for (const server of sortedServers) {
      attempts++;
      const result = await processServer(server, force, lang, type, finalMirror, serverNames, now);

      if (result.success) {
        return res.json(result.data);
      }

      lastError = result.error;
      lastErrorDetails = result.details || null;
    }

    // ─────────────────────────────────────────────
    // ⚠️ TODOS LOS SERVIDORES FALLARON
    // ─────────────────────────────────────────────
    return res.status(404).json({
      error: true,
      message: `No se pudo obtener el video de ningún servidor. Último error: ${lastError}`,
      code: 'ALL_SERVERS_FAILED',
      data: {
        uid,
        ep,
        type,
        lang,
        attempts,
        servers_tried: sortedServers.map(s => s.servidor),
        last_error: lastError,
        last_error_details: lastErrorDetails,
        errors: errors.slice(0, 10) // Include first 10 errors from mirror processing
      }
    });

  } catch (e) {
    console.error('[play] Error crítico:', e.message);
    console.error('[play] Stack:', e.stack);
    if (!res.headersSent) {
      res.status(500).json({
        error: true,
        message: e.message || 'Error interno del servidor',
        code: 'INTERNAL_ERROR',
        data: {
          stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
        }
      });
    }
  }
});

exports.getMedia = asyncHandler(async (req, res) => {
  const mid = req.params.p;
  if (!cache.exists(mid)) return res.status(403).json({ error: 'Contenido expirado. Solicite el video de nuevo.' });

  const content = cache.load(mid);

  if (typeof content === 'string' && content.startsWith('http') && !content.includes('\n')) {
    // Si es la URL embed de Mega, retornarla en JSON directamente
    if (content.includes('mega.nz/embed/')) {
      return res.json({ url: content });
    }

    const base = `${HTTPS ? 'https' : 'http'}://${req.get('host')}`;
    return res.json({ url: `${base}/api/stream?gid=${mid}` });
  }

  if (typeof content === 'string' && (content.startsWith('[') || content.startsWith('{'))) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(content);
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.send(content);
});

exports.stream = asyncHandler(async (req, res) => {
  const v = req.query.gid || req.query.v;
  if (!v) return res.status(400).json({ error: 'Falta parámetro "?gid" o "?v"' });

  let targetUrl = v;
  if (cache.exists(v)) {
    const cached = cache.load(v);
    if (typeof cached === 'string' && cached.startsWith('http')) targetUrl = cached;
  }
  streamVideo(targetUrl, req, res);
});

exports.reqProxy = asyncHandler(async (req, res) => {
  const u = req.query.u || req.query.url;
  if (!u) return res.status(400).json({ error: 'Falta parámetro u' });

  let extraHeaders = {};
  if (req.query.h) { try { extraHeaders = JSON.parse(req.query.h); } catch { } }

  try {
    const { data } = await axios.get(u, { timeout: 10_000, headers: extraHeaders });
    res.json(data);
  } catch (e) {
    console.error('[reqProxy]', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

const { Readable } = require('stream');

exports.proxy = asyncHandler(async (req, res) => {
  let u = req.query.url;
  if (!u && req.query.gid) {
    try { u = Buffer.from(req.query.gid, 'base64url').toString('utf8'); } catch (e) { }
  }
  if (!u) return res.status(400).json({ error: 'Falta url' });

  let r = req.query.ref;
  if (!r && req.query.f) {
    try { r = Buffer.from(req.query.f, 'base64url').toString('utf8'); } catch (e) { }
  }

  try {
    const response = await fetch(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': r || ''
      },
      redirect: 'follow' // Sigue las redirecciones automáticas (301, 302, etc.)
    });

    if (!response.ok) {
      return res.status(response.status).end();
    }

    res.writeHead(200, {
      'Content-Type': 'video/MP2T',
      'Access-Control-Allow-Origin': '*'
    });

    // Convertir el stream Web a NodeStream para poder usar .pipe()
    const cleaner = createVideoCleaner();
    Readable.fromWeb(response.body).pipe(cleaner).pipe(res);

  } catch (e) {
    console.error('[proxy]', e.message);
    if (!res.headersSent) res.status(502).end();
  }
});

exports.download = (req, res) => downloadVideo(req, res);

exports.queueStatus = (req, res) => {
  try {
    const p = apiQueue.getPendingCount();
    const t = apiQueue.getCurrentTask();
    res.json({
      pendingCount: p,
      currentTask: t ? { name: t.meta.name, startedAt: t.startedAt, meta: t.meta } : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno' });
  }
};

exports.appV = asyncHandler(async (req, res) => {
  function versionToCode(version) {
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
    return major * 100000 + minor * 1000 + patch;
  }
  const ver = req.query.version ?? null;
  const { data: files, error } = await supabase.storage.from('AnyExt').list('', { limit: 200 });
  if (error) throw error;

  const apk = files
    .filter(f => /^AnyExt-(\d+(?:\.\d+)*)\.apk$/.test(f.name))
    .map(f => {
      const m = f.name.match(/^AnyExt-(\d+(?:\.\d+)*)\.apk$/);
      const v = m[1];
      return { nombre: f.name, version: v, code: versionToCode(v) };
    });

  if (ver) {
    const a = apk.find(a => a.code === Number(ver));
    if (!a) return res.status(404).json({ error: 'Versión no encontrada' });
    const { data: s, error: se } = await supabase.storage.from('AnyExt').createSignedUrl(a.nombre, 60);
    if (se) throw se;
    return res.json({ url: s.signedUrl, nombre: a.nombre });
  }

  apk.sort((a, b) => require('semver').rcompare(a.version, b.version));
  res.json({ actual: apk[0] || null, anterior: apk[1] || null, anteriores: apk.slice(2) });
});