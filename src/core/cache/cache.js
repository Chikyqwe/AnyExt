// src/core/cache/cache.js — Wrappers sobre cacheStorage (100% RAM)
const { TextStore, keyStore, SimpleCache, MemCache, ramMonitor } = require('./cacheStorage');
const { CACHE } = require("../../config");

// --- CACHE DE TEXTO (comprimido en RAM) ---
class TextCache {
    constructor(options = { ttlMs: 5 * 60 * 1000 }) {
        this.cache = new TextStore(options);
        if (CACHE) {
            setInterval(() => this.cache.cleanup(), 60_000).unref();
        }
    }

    save(uuid, text) {
        if (!CACHE) return;
        const result = this.cache.set(uuid, text);
        this._logRamUsage();
        return result;
    }

    _logRamUsage() {
        if (process.env.DEBUG_RAM === 'true') {
            const usage = ramMonitor.getRamUsage();
            console.log(`[TextCache] RAM usage: ${usage.totalMB} MB (${usage.details.length} cache instances)`);
        }
    }

    load(uuid) {
        if (!CACHE) return null;
        return this.cache.get(uuid);
    }

    exists(uuid) {
        if (!CACHE) return false;
        return this.cache.has(uuid);
    }

    remove(uuid) {
        if (!CACHE) return;
        this.cache.delete(uuid);
    }

    getStats() {
        return this.cache.getStats();
    }
}

// --- CACHE DE LLAVES (objetos serializados + comprimidos en RAM) ---
class KeyCache {
    constructor(options = { ttlMs: 15 * 60 * 1000 }) {
        this.key = new keyStore(options);
        if (CACHE) {
            setInterval(() => this.key.cleanup(), 60_000).unref();
        }
    }

    save(keyId, keyData) {
        if (!CACHE) return;
        this.key.set(keyId, keyData);
        this._logRamUsage();
    }

    _logRamUsage() {
        if (process.env.DEBUG_RAM === 'true') {
            const usage = ramMonitor.getRamUsage();
            console.log(`[KeyCache] RAM usage: ${usage.totalMB} MB (${usage.details.length} cache instances)`);
        }
    }

    load(keyId) {
        if (!CACHE) return null;
        return this.key.get(keyId);
    }

    exists(keyId) {
        if (!CACHE) return false;
        return this.key.has(keyId);
    }

    remove(keyId) {
        if (!CACHE) return;
        this.key.delete(keyId);
    }

    clear() {
        if (!CACHE) return;
        this.key.clear();
    }

    getStats() {
        return this.key.getStats();
    }
}

// --- CACHE GENÉRICO (comprimido en RAM, reemplaza disco) ---
class DiskCache {
    constructor(cleanInterval = 60_000) {
        this.cache = new SimpleCache(cleanInterval);
    }

    save(key, value, ttl) {
        if (!CACHE) return;
        this.cache.set(key, value, ttl);
        this._logRamUsage();
    }

    _logRamUsage() {
        if (process.env.DEBUG_RAM === 'true') {
            const usage = ramMonitor.getRamUsage();
            console.log(`[DiskCache] RAM usage: ${usage.totalMB} MB (${usage.details.length} cache instances)`);
        }
    }

    load(key) {
        if (!CACHE) return null;
        return this.cache.get(key);
    }

    exists(key) {
        if (!CACHE) return false;
        return this.cache.has(key);
    }

    remove(key) {
        if (!CACHE) return;
        this.cache.del(key);
    }

    getStats() {
        return this.cache.getStats();
    }
}

// --- CACHE MEMORIA (objetos directos, sin compresión) ---
class MemoryCache {
    constructor(options = { maxEntries: 100, maxStringLength: 50000 }) {
        this.cache = new MemCache(options);
    }

    save(key, value, ttl) {
        if (!CACHE) return;
        const result = this.cache.set(key, value, ttl);
        this._logRamUsage();
        return result;
    }

    _logRamUsage() {
        if (process.env.DEBUG_RAM === 'true') {
            const usage = ramMonitor.getRamUsage();
            console.log(`[MemoryCache] RAM usage: ${usage.totalMB} MB (${usage.details.length} cache instances)`);
        }
    }

    load(key) {
        if (!CACHE) return null;
        return this.cache.get(key);
    }

    exists(key) {
        if (!CACHE) return false;
        return this.cache.get(key) !== undefined;
    }

    remove(key) {
        if (!CACHE) return;
        this.cache.delete(key);
    }

    getStats() {
        return this.cache.getStats();
    }
}

// Función de utilidad para obtener estadísticas completas
function getRamStats() {
    return ramMonitor.getRamUsage();
}

// ─────────────────────────────────────────────
// EXPORTACIONES - ¡IMPORTANTE! Exportar ramMonitor
// ─────────────────────────────────────────────
module.exports = {
    TextCache,
    KeyCache,
    DiskCache,
    MemoryCache,
    getRamStats,
    ramMonitor  // <-- ESTO ES CRUCIAL - Exportar ramMonitor
};