// src/services/jsonService.js - VERSIÓN CON TU CACHÉ

const fs = require('fs');
const path = require('path');
const { JSON_FOLDER, ANIME_FILE, MANGA_FILE, DRAMA_FILE } = require('../config');
const { KeyCache, MemoryCache } = require('../core/cache/cache');

// Usar tus clases de caché existentes
const rawJsonCache = new MemoryCache({
  maxEntries: 10,
  maxStringLength: 5000000 // 5MB para JSON grandes
});

const itemCache = new KeyCache({ ttlMs: 60 * 60 * 1000 }); // 1 hora
const listCache = new MemoryCache({
  maxEntries: 20,
  maxStringLength: 5000000
});

// Guardar timestamps de modificación
let fileStats = {
  anime: { mtime: 0, size: 0 },
  manga: { mtime: 0, size: 0 },
  drama: { mtime: 0, size: 0 }
};

// Función para cargar JSON con caché
function loadJsonWithCache(filePath, cacheKey, type) {
  // Verificar si el archivo cambió
  let currentStat = null;
  try {
    currentStat = fs.statSync(filePath);
  } catch {
    return { metadata: {}, animes: [] };
  }

  const stats = fileStats[type];
  const fileChanged = currentStat.mtimeMs !== stats.mtime || currentStat.size !== stats.size;

  // Si cambió, invalidar caché
  if (fileChanged) {
    fileStats[type] = { mtime: currentStat.mtimeMs, size: currentStat.size };
    rawJsonCache.remove(cacheKey);
    listCache.remove(`allContentLists`);
    itemCache.clear(); // Limpiar caché de items individuales
    console.log(`[CACHE] Archivo ${type} modificado, cache invalidado`);
  }

  // Intentar cargar desde caché
  let cached = rawJsonCache.load(cacheKey);
  if (cached) {
    return cached;
  }

  // Cargar desde disco
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    // Guardar en caché
    rawJsonCache.save(cacheKey, data);
    console.log(`[CACHE] ${type} cargado y cacheado (${Math.round(raw.length / 1024)}KB)`);

    return data;
  } catch (err) {
    console.error(`[ERROR] Leyendo ${filePath}:`, err);
    return { metadata: {}, animes: [] };
  }
}

// FUNCIONES OPTIMIZADAS
function readAnimeList() {
  const data = loadJsonWithCache(ANIME_FILE, 'animeData', 'anime');
  return data.animes || [];
}

function readMangaList() {
  const data = loadJsonWithCache(MANGA_FILE, 'mangaData', 'manga');
  return data.mangas || [];
}

function readDramaList() {
  const dramaFile = DRAMA_FILE || path.join(JSON_FOLDER, 'drama.json');
  const data = loadJsonWithCache(dramaFile, 'dramaData', 'drama');
  return data.doramas || [];
}

// OBTENER TODOS LOS CONTENIDOS DE UNA VEZ (OPTIMIZADO)
function getAllContentLists() {
  const cacheKey = 'allContentLists';

  let cached = listCache.load(cacheKey);
  if (cached) {
    return cached;
  }

  const result = {
    animes: readAnimeList(),
    mangas: readMangaList(),
    dramas: readDramaList()
  };

  // Guardar por 5 minutos
  listCache.save(cacheKey, result);
  return result;
}

// FUNCIÓN DE BÚSQUEDA OPTIMIZADA
function searchAllContent(query) {
  const searchCacheKey = `search:${query}`;
  let cached = listCache.load(searchCacheKey);
  if (cached) return cached;

  const all = getAllContentLists();
  const allItems = [
    ...all.animes.map(a => ({ ...a, contentType: 'anime' })),
    ...all.mangas.map(m => ({ ...m, contentType: 'manga' })),
    ...all.dramas.map(d => ({ ...d, contentType: 'drama' }))
  ];

  const searchTerm = query.toLowerCase().trim();
  let results;

  if (!searchTerm) {
    results = allItems.slice(0, 20);
  } else {
    results = allItems
      .filter(item => item.title.toLowerCase().includes(searchTerm))
      .slice(0, 20);
  }

  // Guardar búsqueda por 10 minutos
  listCache.save(searchCacheKey, results);
  return results;
}

// FUNCIONES GET OPTIMIZADAS
function getAnimeByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `animeUnitId:${numId}`;
  let cached = itemCache.load(cacheKey);
  if (cached) return cached;

  const animeList = readAnimeList();
  let anime = animeList.find(a => a.unit_id === numId);

  if (anime) {
    itemCache.save(cacheKey, anime);
    return anime;
  }

  const errorResponse = { error: true, message: "No encontrado" };
  itemCache.save(cacheKey, errorResponse);
  return errorResponse;
}

function getMangaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `mangaUnitId:${numId}`;
  let cached = itemCache.load(cacheKey);
  if (cached) return cached;

  const mangaList = readMangaList();
  let manga = mangaList.find(m => m.unit_id === numId);

  if (manga) {
    itemCache.save(cacheKey, manga);
    return manga;
  }

  const errorResponse = { error: true, message: "No encontrado" };
  itemCache.save(cacheKey, errorResponse);
  return errorResponse;
}

function getDramaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId)) return { error: true, message: "ID inválido" };

  const cacheKey = `dramaUnitId:${numId}`;
  let cached = itemCache.load(cacheKey);
  if (cached) return cached;

  const dramaList = readDramaList();
  let drama = dramaList.find(d => d.unit_id === numId);

  if (drama) {
    itemCache.save(cacheKey, drama);
    return drama;
  }

  const errorResponse = { error: true, message: "No encontrado" };
  itemCache.save(cacheKey, errorResponse);
  return errorResponse;
}

// FUNCIÓN PARA PRECARGAR CACHÉ
function preloadCache() {
  console.log('[CACHE] Pre-cargando todos los contenidos...');
  const start = Date.now();
  const data = getAllContentLists();
  const end = Date.now();
  console.log(`[CACHE] Pre-carga completada en ${end - start}ms`);
  console.log(`[CACHE] Animes: ${data.animes.length}, Mangas: ${data.mangas.length}, Dramas: ${data.dramas.length}`);
  return data;
}

// FUNCIÓN PARA RECARGAR MANUALMENTE
function reloadMemoryData() {
  console.log('[CACHE] Recargando datos manualmente...');
  // Invalidar todas las cachés
  rawJsonCache.remove('animeData');
  rawJsonCache.remove('mangaData');
  rawJsonCache.remove('dramaData');
  listCache.remove('allContentLists');
  itemCache.clear();

  // Recargar
  return preloadCache();
}

module.exports = {
  readRawJson: () => getAllContentLists(),
  getMetadata: () => {
    const all = getAllContentLists();
    return {
      animeCount: all.animes.length,
      mangaCount: all.mangas.length,
      dramaCount: all.dramas.length
    };
  },
  readAnimeList,
  readMangaList,
  readDramaList,
  getAllContentLists,
  searchAllContent,
  getAnimeByUnitId,
  getMangaByUnitId,
  getDramaByUnitId,
  preloadCache,
  reloadMemoryData,
};