// src/core/cache/cacheInstances.js — REGISTRO CENTRALIZADO DE TODAS LAS CACHÉS
// Todas las instancias se crean aquí y se exportan con nombres descriptivos.
// Los módulos consumidores importan desde aquí en lugar de crear sus propias instancias.

const { TextCache, KeyCache, MemoryCache } = require('./cache');

// ─────────────────────────────────────────────
// MEDIA — TextCache para HLS/video/manga content
// ─────────────────────────────────────────────
const mediaTextCache = new TextCache({ ttlMs: 15 * 60 * 1000 }); // 15 min

// ─────────────────────────────────────────────
// MEDIA — MemoryCache para respuestas API (list, info, etc.)
// ─────────────────────────────────────────────
const responseCache = new MemoryCache({
  maxEntries: 50,
  maxStringLength: 1000000 // 1MB
});

// ─────────────────────────────────────────────
// ANIME — MemoryCache para descripciones
// ─────────────────────────────────────────────
const descriptionCache = new MemoryCache({
  maxEntries: 500,
  maxStringLength: 10000 // 10KB
});
const DESCRIPTION_TTL = 60_000 * 5; // 5 min

// ─────────────────────────────────────────────
// JSON SERVICE — MemoryCache para JSON crudos (anime_list, mangalist, etc.)
// ─────────────────────────────────────────────
const rawJsonCache = new MemoryCache({
  maxEntries: 10,
  maxStringLength: 5000000 // 5MB
});

// ─────────────────────────────────────────────
// JSON SERVICE — KeyCache para items individuales por unit_id
// ─────────────────────────────────────────────
const itemCache = new KeyCache({ ttlMs: 60 * 60 * 1000 }); // 1 hora

// ─────────────────────────────────────────────
// JSON SERVICE — MemoryCache para listas combinadas y búsquedas
// ─────────────────────────────────────────────
const listCache = new MemoryCache({
  maxEntries: 20,
  maxStringLength: 5000000 // 5MB
});

// ─────────────────────────────────────────────
// CORE — TextCache para links de video extraídos
// ─────────────────────────────────────────────
const linksCache = new TextCache({ ttlMs: 10 * 60 * 1000 }); // 10 min

module.exports = {
  // Media
  mediaTextCache,
  responseCache,

  // Anime
  descriptionCache,
  DESCRIPTION_TTL,

  // JSON Service
  rawJsonCache,
  itemCache,
  listCache,

  // Core
  linksCache,
};
