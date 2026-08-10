// src/controllers/mediaController.js

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const path = require('path');
const { Transform } = require('stream');
const { default: axios } = require('axios');

const asyncHandler = require('../middlewares/asyncHandler');
const { TextCache } = require('../core/cache/cache');
const apiQueue = require('../core/queue/queueService');
const { supabase } = require('../services/supabase/supabase');
const { HTTPS } = require('../config');

const { readAnimeList, readMangaList, getAnimeByUnitId, getMangaByUnitId, getDramaByUnitId, buildEpisodeUrl, readDramaList } = require('../services/jsonService');
const animeController = require('./animeController');
const mangaController = require('./mangaController');
const dramaController = require('./dramaController');
const Fuse = require('fuse.js');

const { extractAllVideoLinks, getExtractor } = require('../core/core');
const { streamVideo, downloadVideo } = require('../utils/helpers');
const { parseMegaUrl, verificarArchivoMega } = require('../utils/CheckMega');

const PER_PAGE = 24;
const cache = new TextCache({ ttlMs: 15 * 60 * 1000 });

// ─────────────────────────────────────────────
// NORMALIZE & SEARCH INDEX
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
  const dramas = readDramaList().map(d => ({ ...d, contentType: 'drama' }));

  const all = [...animes, ...mangas, ...dramas];

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

// ─────────────────────────────────────────────
// CONTENT ROUTES
// ─────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
  const p = req.query.p;

  const animesRaw = readAnimeList();
  const mangasRaw = readMangaList();
  const dramasRaw = readDramaList();

  if (p === 'all') {
    const all = [
      ...animesRaw.map(a => ({ ...a, contentType: 'anime' })),
      ...mangasRaw.map(m => ({ ...m, contentType: 'manga' })),
      ...dramasRaw.map(d => ({ ...d, contentType: 'drama' }))
    ];
    return res.json({ items: all });
  }

  const page = Math.max(1, parseInt(p) || 1);
  const total = animesRaw.length + mangasRaw.length + dramasRaw.length;
  const start = (page - 1) * PER_PAGE;

  const allItems = [
    ...animesRaw.map(a => ({ ...a, contentType: 'anime' })),
    ...mangasRaw.map(m => ({ ...m, contentType: 'manga' })),
    ...dramasRaw.map(d => ({ ...d, contentType: 'drama' }))
  ];

  const slicedItems = allItems.slice(start, start + PER_PAGE);

  const items = slicedItems.map(item => ({
    title: item.title,
    slug: item.slug,
    unit_id: item.unit_id,
    image: item.image || item.cover,
    type: item.contentType
  }));

  const mangaStartPage = Math.floor(animesRaw.length / PER_PAGE) + 1;
  const dramaStartPage = Math.floor((animesRaw.length + mangasRaw.length) / PER_PAGE) + 1;

  res.json({
    page,
    total,
    totalpages: Math.ceil(total / PER_PAGE),
    manga_start_page: mangaStartPage,
    drama_start_page: dramaStartPage,
    items,
  });
});

exports.info = asyncHandler(async (req, res, next) => {
  const uid = parseInt(req.query.uid);
  if (!uid) return res.status(400).json({ error: 'Falta parámetro uid' });

  const anime = getAnimeByUnitId(uid);
  if (!anime.error) return animeController.info(req, res, next);

  const manga = getMangaByUnitId(uid);
  if (!manga.error) return mangaController.info(req, res, next);

  const drama = getDramaByUnitId(uid);
  if (!drama.error) return dramaController.info(req, res, next);

  return res.status(404).json({
    error: `No se encontró contenido con uid ${uid}`,
    recommendedAnimeId: anime.recommendedId,
    recommendedMangaId: manga.recommendedId,
    recommendedDramaId: drama.recommendedId
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

  const { proxyImage, getEpisodes } = require('../utils/helpers');

  if (type === 'cover') {
    const imageUrl = item.image || item.cover;
    if (!imageUrl) return res.status(404).json({ error: 'Sin imagen' });
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
          if (found?.img) return proxyImage(found.img, res);
        } catch { }
      }
    }
    const fallback = item.image || item.cover;
    if (fallback) return proxyImage(fallback, res);

    return res.status(404).json({ error: 'Imagen de episodio no encontrada' });
  }

  return res.status(400).json({ error: `type inválido: ${type}` });
});

exports.search = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Falta query' });

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
          const targetKey = Object.keys(acc).find(k => k.toLowerCase() === part.toLowerCase());
          return targetKey ? acc[targetKey] : undefined;
        }, obj);
      };

      const itemVal = getValueByPath(item, keyPath);
      if (itemVal === undefined || itemVal === null) return false;
      if (typeof itemVal === 'number') return itemVal === Number(rawValue.trim());
      return String(itemVal).toLowerCase() === targetValue;
    });
    results = filtered.map(item => ({ item: item, score: 0 }));
  } else {
    const term = normalize(query);
    results = fuse.search(term);
  }

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

exports.rebuildSearchLocal = buildSearchIndex;

// ─────────────────────────────────────────────
// VIDEO ROUTES
// ─────────────────────────────────────────────

exports.play = asyncHandler(async (req, res) => {
  try {
    let { type = 'anime', Did, uid, ep, s = 'auto', m, refresh, Os = false, lang = null } = req.body;
    uid = uid ? parseInt(uid) : undefined;
    ep = ep ? parseInt(ep) : undefined;

    if (!uid) return res.status(400).json({ error: true, message: 'uid obligatorio' });
    if (!ep) return res.status(400).json({ error: true, message: 'ep obligatorio' });

    // ─────────────────────────────────────────────
    // 📖 MANGA
    // ─────────────────────────────────────────────
    if (type === 'manga') {
      const { getEpisodes } = require('../utils/helpers');

      const manga = getMangaByUnitId(uid);
      if (!manga?.unit_id) return res.status(404).json({ error: true, message: 'Manga no encontrado' });

      const isAutoMirror = m === 'auto' || !m || m === '';
      const mirrorsToTry = isAutoMirror
        ? Object.keys(manga.sources || {}).filter(k => manga.sources[k])
        : [m];

      if (mirrorsToTry.length === 0) return res.status(404).json({ error: true, message: 'No hay mirrors disponibles' });

      let validImgs = null;
      let finalMirror = null;
      let mid = null;

      for (const mirrorKey of mirrorsToTry) {
        const sourceUrl = manga.sources?.[mirrorKey];
        if (!sourceUrl) continue;

        let raw;
        try { raw = await getEpisodes(sourceUrl); } catch (e) { continue; }

        if (raw && !raw.chapters && raw.episodes) raw.chapters = raw.episodes;
        if (!raw?.chapters) continue;

        const chapter = raw.chapters.find(c => Number(c.num || c.number) === ep);
        if (!chapter) continue;

        let coreExtractorName = mirrorKey;
        if (mirrorKey === 'olympusxyz') coreExtractorName = 'oly';
        if (mirrorKey === 'mangalect' || mirrorKey === 'lectesp') coreExtractorName = 'esp';
        if (mirrorKey === 'zonatmo') coreExtractorName = 'tmonet';

        const ex = getExtractor(coreExtractorName);
        if (!ex) continue;

        try {
          const imgs = await ex(chapter.url);
          if (imgs && imgs.length > 0) {
            validImgs = imgs;
            finalMirror = mirrorKey;
            mid = generateKey(chapter.url);
            break;
          }
        } catch (e) { continue; }
      }

      if (!validImgs) return res.status(404).json({ error: true, message: 'No se encontraron imágenes' });

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
    const { getEpisodes } = require('../utils/helpers');

    let contentItem = null;

    if (type === 'drama' || type === 'dorama') {
      contentItem = getDramaByUnitId(uid);
      if (!contentItem?.unit_id) return res.status(404).json({ error: true, message: 'Drama no encontrado' });
    } else {
      contentItem = getAnimeByUnitId(uid);
      if (!contentItem?.unit_id) return res.status(404).json({ error: true, message: 'Anime no encontrado' });
    }

    const isAutoMirror = m === 'auto' || !m || m === '';
    const mirrorsToTry = isAutoMirror
      ? Object.keys(contentItem.sources || {}).filter(k => contentItem.sources[k])
      : [m];

    if (mirrorsToTry.length === 0) return res.status(404).json({ error: true, message: 'No hay mirrors disponibles' });

    let valid = [];
    let finalMirror = null;
    const force = refresh === true || refresh === 'true';

    // Obtener episodios y servidores válidos
    for (const mirrorKey of mirrorsToTry) {
      const sourceUrl = contentItem.sources?.[mirrorKey];
      if (!sourceUrl) continue;

      let raw;
      try { raw = await getEpisodes(sourceUrl); } catch (e) { continue; }

      if (raw && !raw.episodes && raw.chapters) raw.episodes = raw.chapters;
      if (!raw?.episodes) continue;

      const episode = raw.episodes.find(e => Number(e.num || e.number) === ep);
      if (!episode?.url) continue;

      const vids = await extractAllVideoLinks(episode.url, lang);
      if (!vids || vids.status >= 700) continue;

      const filtered = await filterV(vids);
      if (filtered && filtered.length > 0) {
        valid = filtered;
        finalMirror = mirrorKey;
        break;
      }
    }

    if (!valid.length) return res.status(404).json({ error: true, message: 'No hay servidores válidos' });

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
            error: `Extractor no encontrado para ${server.servidor}`
          };
        }

        const r = await ex(server.url);
        if (!r || r.status >= 700) {
          return {
            success: false,
            error: r?.mjs || 'Error en el extractor'
          };
        }

        if (r.url) {
          const mid = generateKey(r.url);
          cache.save(mid, r.url);
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

        return {
          success: false,
          error: 'Formato de respuesta no reconocido'
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
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
        servers: serverNames
      });
    }

    // ─────────────────────────────────────────────
    // 🔄 REINTENTOS CON MÚLTIPLES SERVIDORES
    // ─────────────────────────────────────────────
    // Ordenar servidores: primero el seleccionado, luego los demás
    const sortedServers = [
      sel,
      ...valid.filter(v => v.servidor !== sel.servidor)
    ];

    let lastError = null;
    let attempts = 0;

    for (const server of sortedServers) {
      attempts++;
      const result = await processServer(server, force, lang, type, finalMirror, serverNames, now);

      if (result.success) {
        console.log(`[play] Éxito con servidor: ${server.servidor}`);
        return res.json(result.data);
      }

      lastError = result.error;
    }

    // ─────────────────────────────────────────────
    // ⚠️ TODOS LOS SERVIDORES FALLARON
    // ─────────────────────────────────────────────
    console.error(`[play] Todos los ${attempts} servidores fallaron. Último error: ${lastError}`);
    return res.status(404).json({
      error: true,
      message: `No se pudo obtener el video de ningún servidor. Último error: ${lastError}`,
      attempts: attempts,
      servers_tried: sortedServers.map(s => s.servidor)
    });

  } catch (e) {
    console.error('[play] Error general:', e);
    if (!res.headersSent) {
      res.status(500).json({
        error: true,
        message: e.message || 'Error interno del servidor'
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