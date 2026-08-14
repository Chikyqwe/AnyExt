// src/services/jsonService.js (Migrated to SQLite)

const path = require('path');
const Database = require('better-sqlite3');
const { JSON_FOLDER } = require('../config');

// Initialize database
const DB_FILE = path.join(JSON_FOLDER, 'database.sqlite');
let db;

try {
  db = new Database(DB_FILE, { readonly: true });
} catch (err) {
  console.error('[DB ERROR] Failed to connect to SQLite:', err);
}

// Helper to parse sources string to JSON object
function formatItem(row) {
  if (!row) return null;
  return {
    unit_id: row.unit_id,
    id: row.id,
    title: row.title,
    slug: row.slug,
    image: row.image,
    btype: row.btype,
    contentType: row.contentType,
    sources: row.sources ? JSON.parse(row.sources) : {}
  };
}

// Obtener listas
function readAnimeList() {
  if (!db) return [];
  const stmt = db.prepare(`SELECT * FROM content WHERE contentType = 'anime'`);
  return stmt.all().map(formatItem);
}

function readMangaList() {
  if (!db) return [];
  const stmt = db.prepare(`SELECT * FROM content WHERE contentType = 'manga'`);
  return stmt.all().map(formatItem);
}

function readDramaList() {
  if (!db) return [];
  const stmt = db.prepare(`SELECT * FROM content WHERE contentType = 'drama'`);
  return stmt.all().map(formatItem);
}

// OBTENER TODOS LOS CONTENIDOS
function getAllContentLists() {
  return {
    animes: readAnimeList(),
    mangas: readMangaList(),
    dramas: readDramaList()
  };
}

// FUNCIÓN DE BÚSQUEDA OPTIMIZADA
function searchAllContent(query) {
  if (!db) return [];
  const searchTerm = (query || '').toLowerCase().trim();

  if (!searchTerm) {
    const stmt = db.prepare(`SELECT * FROM content LIMIT 20`);
    return stmt.all().map(formatItem);
  } else {
    // using LIKE for basic search
    const stmt = db.prepare(`SELECT * FROM content WHERE LOWER(title) LIKE ? LIMIT 20`);
    return stmt.all(`%${searchTerm}%`).map(formatItem);
  }
}

// FUNCIONES GET OPTIMIZADAS
function getAnimeByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId) || !db) return { error: true, message: "ID inválido" };

  const stmt = db.prepare(`SELECT * FROM content WHERE unit_id = ? AND contentType = 'anime'`);
  const row = stmt.get(numId);

  if (row) {
    return formatItem(row);
  }
  return { error: true, message: "No encontrado" };
}

function getMangaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId) || !db) return { error: true, message: "ID inválido" };

  const stmt = db.prepare(`SELECT * FROM content WHERE unit_id = ? AND contentType = 'manga'`);
  const row = stmt.get(numId);

  if (row) {
    return formatItem(row);
  }
  return { error: true, message: "No encontrado" };
}

function getDramaByUnitId(unitId) {
  const numId = parseInt(unitId, 10);
  if (isNaN(numId) || !db) return { error: true, message: "ID inválido" };

  const stmt = db.prepare(`SELECT * FROM content WHERE unit_id = ? AND contentType = 'drama'`);
  const row = stmt.get(numId);

  if (row) {
    return formatItem(row);
  }
  return { error: true, message: "No encontrado" };
}

// FUNCIÓN PARA PRECARGAR CACHÉ - ya no es necesaria con SQLite, pero la dejamos para compatibilidad
function preloadCache() {
  console.log('[CACHE] Preload was called, but using SQLite now.');
  return getAllContentLists();
}

// FUNCIÓN PARA RECARGAR MANUALMENTE
function reloadMemoryData() {
  console.log('[CACHE] Reload was called, but using SQLite now.');
  return getAllContentLists();
}

module.exports = {
  readRawJson: () => getAllContentLists(),
  getMetadata: () => {
    if (!db) return { animeCount: 0, mangaCount: 0, dramaCount: 0 };

    const countAnime = db.prepare(`SELECT COUNT(*) as count FROM content WHERE contentType = 'anime'`).get().count;
    const countManga = db.prepare(`SELECT COUNT(*) as count FROM content WHERE contentType = 'manga'`).get().count;
    const countDrama = db.prepare(`SELECT COUNT(*) as count FROM content WHERE contentType = 'drama'`).get().count;

    return {
      animeCount: countAnime,
      mangaCount: countManga,
      dramaCount: countDrama
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