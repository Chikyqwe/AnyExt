// src/services/jsonService.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
// Asegúrate de definir DRAMA_FILE en '../config' si aplica, o se construirá usando path.join más abajo.
const { JSON_FOLDER, ANIME_FILE, MANGA_FILE, DRAMA_FILE } = require('../config');

// Importamos las nuevas clases de caché
const { KeyCache, MemoryCache } = require('../core/cache/cache');

// Ruta por defecto para el JSON de Drama en caso de que DRAMA_FILE no esté en config
const resolvedDramaFile = DRAMA_FILE
/**
 * Modernización: 
 * Usamos MemoryCache para el JSON bruto (acceso ultra rápido).
 * Usamos KeyCache para los elementos individuales por ID (persisten comprimidos).
 */
const rawCache = new MemoryCache({ maxEntries: 10 });
const itemCache = new KeyCache({ ttlMs: 10 * 60 * 1000 }); // 10 min persistentes

// Garantizar directorios
if (!fs.existsSync(JSON_FOLDER)) fs.mkdirSync(JSON_FOLDER, { recursive: true });
if (!fs.existsSync(path.join(JSON_FOLDER, 'manga'))) fs.mkdirSync(path.join(JSON_FOLDER, 'manga'), { recursive: true });
if (!fs.existsSync(path.join(JSON_FOLDER, 'drama'))) fs.mkdirSync(path.join(JSON_FOLDER, 'drama'), { recursive: true });

// Cachés de Manga
const rawMangaCache = new MemoryCache({ maxEntries: 10 });
const itemMangaCache = new KeyCache({ ttlMs: 10 * 60 * 1000 });

// Cachés de Drama
const rawDramaCache = new MemoryCache({ maxEntries: 10 });
const itemDramaCache = new KeyCache({ ttlMs: 10 * 60 * 1000 });

let inMemoryAnimeData = null;
let inMemoryMangaData = null;
let inMemoryDramaData = null;

function reloadMemoryData() {
  // Cargar Animes
  try {
    if (!fs.existsSync(ANIME_FILE)) {
      inMemoryAnimeData = { metadata: {}, animes: [] };
    } else {
      inMemoryAnimeData = JSON.parse(fs.readFileSync(ANIME_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[JSON SERVICE] Error leyendo JSON de animes:', err);
    inMemoryAnimeData = { metadata: {}, animes: [] };
  }

  // Cargar Mangas
  try {
    if (!fs.existsSync(MANGA_FILE)) {
      inMemoryMangaData = { metadata: {}, mangas: [] };
    } else {
      inMemoryMangaData = JSON.parse(fs.readFileSync(MANGA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[JSON SERVICE] Error leyendo JSON de mangas:', err);
    inMemoryMangaData = { metadata: {}, mangas: [] };
  }

  // Cargar Dramas
  try {
    if (!fs.existsSync(resolvedDramaFile)) {
      inMemoryDramaData = { metadata: {}, dramas: [] };
    } else {
      inMemoryDramaData = JSON.parse(fs.readFileSync(resolvedDramaFile, 'utf8'));
    }
  } catch (err) {
    console.error('[JSON SERVICE] Error leyendo JSON de dramas:', err);
    inMemoryDramaData = { metadata: {}, dramas: [] };
  }
}

// Carga inicial
reloadMemoryData();

/**
 * Lee el JSON completo y lo cachea en RAM
 */
function readRawJson() {
  return inMemoryAnimeData;
}

/**
 * Devuelve metadata
 */
function getMetadata() {
  return readRawJson().metadata || {};
}

/**
 * Devuelve lista de animes
 */
function readAnimeList() {
  return readRawJson().animes || [];
}

/**
 * Busca anime por ID, usa KeyCache (Disco + Gzip)
 */
function getAnimeById(id) {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;

  const cacheKey = `animeId:${numId}`;
  let anime = itemCache.load(cacheKey);
  if (anime) return anime;

  anime = readAnimeList().find(a => a.id === numId) || null;
  if (anime) itemCache.save(cacheKey, anime);
  return anime;
}

/**
 * Busca anime por unit_id, usa KeyCache (Disco + Gzip)
 */
function getAnimeByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `animeUnitId:${numId}`;
  let cachedResponse = itemCache.load(cacheKey);
  if (cachedResponse) return cachedResponse;

  const animeList = readAnimeList();
  if (!animeList || animeList.length === 0) return { error: true, message: "No hay datos disponibles" };

  let anime = animeList.find(a => a.unit_id === numId);

  if (anime) {
    itemCache.save(cacheKey, anime);
    return anime;
  }

  const closestAnime = animeList.reduce((closest, current) => {
    const currentDiff = Math.abs(current.unit_id - numId);
    const closestDiff = Math.abs(closest.unit_id - numId);
    return currentDiff < closestDiff ? current : closest;
  });

  const errorResponse = {
    error: true,
    recommendedId: closestAnime.unit_id
  };

  itemCache.save(cacheKey, errorResponse);

  return errorResponse;
}

/**
 * Lee el JSON completo de Mangas y lo cachea en RAM
 */
function readMangaRawJson() {
  return inMemoryMangaData;
}

/**
 * Devuelve lista de mangas
 */
function readMangaList() {
  return readMangaRawJson().mangas || [];
}

/**
 * Busca manga por unit_id
 */
function getMangaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `mangaUnitId:${numId}`;
  let cachedResponse = itemMangaCache.load(cacheKey);
  if (cachedResponse) return cachedResponse;

  const mangaList = readMangaList();
  if (!mangaList || mangaList.length === 0) return { error: true, message: "No hay datos disponibles" };

  let manga = mangaList.find(a => a.unit_id === numId);

  if (manga) {
    itemMangaCache.save(cacheKey, manga);
    return manga;
  }

  const closestManga = mangaList.reduce((closest, current) => {
    const currentDiff = Math.abs(current.unit_id - numId);
    const closestDiff = Math.abs(closest.unit_id - numId);
    return currentDiff < closestDiff ? current : closest;
  });

  const errorResponse = {
    error: true,
    recommendedId: closestManga.unit_id
  };

  itemMangaCache.save(cacheKey, errorResponse);

  return errorResponse;
}

// ==========================================
// 🎭 FUNCIONES PARA DRAMA
// ==========================================

/**
 * Lee el JSON completo de Dramas en RAM
 */
function readDramaRawJson() {
  return inMemoryDramaData;
}

/**
 * Devuelve la lista de dramas
 */
function readDramaList() {
  return readDramaRawJson().doramas || [];
}

/**
 * Busca drama por unit_id, usa KeyCache
 */
function getDramaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `dramaUnitId:${numId}`;
  let cachedResponse = itemDramaCache.load(cacheKey);
  if (cachedResponse) return cachedResponse;

  const dramaList = readDramaList();
  if (!dramaList || dramaList.length === 0) return { error: true, message: "No hay datos disponibles" };

  let drama = dramaList.find(d => d.unit_id === numId);

  if (drama) {
    itemDramaCache.save(cacheKey, drama);
    return drama;
  }

  const closestDrama = dramaList.reduce((closest, current) => {
    const currentDiff = Math.abs(current.unit_id - numId);
    const closestDiff = Math.abs(closest.unit_id - numId);
    return currentDiff < closestDiff ? current : closest;
  });

  const errorResponse = {
    error: true,
    recommendedId: closestDrama.unit_id
  };

  itemDramaCache.save(cacheKey, errorResponse);

  return errorResponse;
}

/**
 * Construye URL de episodio según mirror
 */
async function buildEpisodeUrl(anime, ep, mirror = 1) {
  const m = parseInt(mirror, 10);
  const e = parseInt(ep, 10);

  if (!anime?.sources) {
    console.log('[buildEpisodeUrl] Error: El objeto anime no tiene sources');
    return null;
  }

  switch (m) {
    case 1:
      if (anime.sources.FLV) {
        return anime.sources.FLV.replace('/anime/', '/ver/') + `-${e}`;
      }
      break;
    case 2:
      if (anime.sources.ONE) {
        return anime.sources.ONE.replace('/anime/', '/ver/') + `-${e}`;
      }
      break;
    case 3:
      if (anime.sources.TIO) {
        let url = anime.sources.TIO;

        if (url.includes('tioanime.com')) {
          return url.replace('/anime/', '/ver/') + `-${e}`;
        } else if (url.includes('tiohentai.com')) {
          return url.replace(/-\d+$/, `-${e}`);
        }
      }
      break;
    case 4:
      if (anime.sources.JK) {
        return anime.sources.JK + `${e}/`;
      }
      break;
    case 5:
      if (anime.sources.ANIYAE) {
        const { data: html } = await axios.get(anime.sources.ANIYAE);
        const $ = cheerio.load(html);

        let animeId = null;

        $('script').each((i, el) => {
          const text = $(el).html();
          if (!text) return;

          const match = text.match(/animeId\s*=\s*(\d+)/);
          if (match) {
            animeId = match[1];
          }
        });

        if (!animeId) throw new Error("❌ No se encontró animeId");

        const api = `https://open.aniyae.net/wp-json/kiranime/v1/anime/${animeId}/episodes?page=1&per_page=999999999&order=asc`;

        const res = await axios.get(api);
        const epsArray = res.data.episodes || [];

        return epsArray[e - 1].url;
      }
      break;
    case 6:
      if (anime.sources.HENTAILA) {
        return anime.sources.HENTAILA + `/${e}`;
      }
      break;
    case 7:
      if (anime.sources.TIOHENTAI) {
        return anime.sources.TIOHENTAI.replace('/hentai/', '/ver/') + `-${e}`;
      }
      break;
  }

  return null;
}

/**
 * Lista archivos JSON en el folder
 */
function getJsonFiles() {
  try {
    return fs.readdirSync(JSON_FOLDER).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.error('[JSON SERVICE] Error leyendo directorio JSON:', err);
    return [];
  }
}

/**
 * Ruta completa de un JSON
 */
function getJSONPath(filename) {
  return path.join(JSON_FOLDER, filename);
}

module.exports = {
  readRawJson,
  getMetadata,
  readAnimeList,
  getAnimeById,
  getAnimeByUnitId,
  buildEpisodeUrl,
  getJsonFiles,
  getJSONPath,
  readMangaRawJson,
  readMangaList,
  getMangaByUnitId,
  readDramaRawJson,
  readDramaList,
  getDramaByUnitId,
  reloadMemoryData
};