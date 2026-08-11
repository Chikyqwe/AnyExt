// src/core/cache/cacheStorage.js — 100% IN-MEMORY CON COMPRESIÓN
// Zero disk I/O. Los datos se comprimen con gzip cuando superan un umbral.

const zlib = require("zlib");

// ─────────────────────────────────────────────
// UMBRAL: comprimir solo si el payload supera este tamaño (bytes)
// ─────────────────────────────────────────────
const COMPRESS_THRESHOLD = 1024; // 1KB

// ─────────────────────────────────────────────
// MONITOR DE RAM — Registro automático de todas las instancias
// ─────────────────────────────────────────────
class RamMonitor {
    constructor() {
        this.instances = [];
        this.enabled = true;
    }

    register(instance) {
        if (!this.enabled) return;
        this.instances.push(instance);
    }

    getRamUsage() {
        if (!this.enabled) return { totalBytes: 0, totalMB: 0, details: [] };

        let totalBytes = 0;
        const details = [];
        const now = Date.now();

        for (const instance of this.instances) {
            if (!instance || !instance.getStats) continue;

            try {
                const stats = instance.getStats();
                let instanceBytes = 0;

                if (stats.totalOriginalBytes) {
                    instanceBytes = stats.totalOriginalBytes;
                } else if (stats.totalSize) {
                    instanceBytes = stats.totalSize;
                } else if (stats.count && stats.totalCompressedBytes) {
                    instanceBytes = stats.totalOriginalBytes || stats.totalCompressedBytes;
                } else {
                    if (instance.store) {
                        for (const [, entry] of instance.store) {
                            if (now <= entry.exp) {
                                instanceBytes += entry.data ? entry.data.length : 0;
                            }
                        }
                    }
                }

                totalBytes += instanceBytes;
                details.push({
                    name: instance.constructor.name || 'Unknown',
                    bytes: instanceBytes,
                    mb: (instanceBytes / (1024 * 1024)).toFixed(2),
                    stats: stats
                });
            } catch (err) {
                console.warn(`[RamMonitor] Error obteniendo stats de ${instance.constructor.name}:`, err);
            }
        }

        return {
            totalBytes,
            totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
            details: details.filter(d => d.bytes > 0 || d.stats?.count > 0),
            instances: this.instances.length,
            timestamp: new Date().toISOString()
        };
    }

    getStats() {
        return this.getRamUsage();
    }
}

// Instancia única del monitor
const ramMonitor = new RamMonitor();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function compressIfNeeded(buf) {
    if (buf.length > COMPRESS_THRESHOLD) {
        return { data: zlib.gzipSync(buf), compressed: true };
    }
    return { data: buf, compressed: false };
}

function decompressIfNeeded(entry) {
    if (entry.compressed) {
        return zlib.gunzipSync(entry.data);
    }
    return entry.data;
}

// ─────────────────────────────────────────────
// TEXTSTORE — Almacena strings comprimidos en RAM
// ─────────────────────────────────────────────
class TextStore {
    constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
        this.ttlMs = ttlMs;
        this.store = new Map();
        ramMonitor.register(this);
    }

    set(uuid, text) {
        const raw = Buffer.from(text, "utf8");
        const { data, compressed } = compressIfNeeded(raw);
        const exp = Date.now() + this.ttlMs;

        this.store.set(uuid, { data, compressed, exp, originalSize: raw.length });

        return {
            ok: true,
            savedToDisk: false,
            originalSize: raw.length,
            compressedSize: data.length
        };
    }

    get(uuid) {
        const entry = this.store.get(uuid);
        if (!entry) return null;

        if (Date.now() > entry.exp) {
            this.store.delete(uuid);
            return null;
        }

        return decompressIfNeeded(entry).toString("utf8");
    }

    has(uuid) {
        const entry = this.store.get(uuid);
        if (!entry) return false;
        if (Date.now() > entry.exp) {
            this.store.delete(uuid);
            return false;
        }
        return true;
    }

    delete(uuid) {
        this.store.delete(uuid);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.exp) this.store.delete(key);
        }
    }

    getStats() {
        let totalCompressed = 0;
        let totalOriginal = 0;
        let count = 0;
        const now = Date.now();
        for (const [, entry] of this.store) {
            if (now <= entry.exp) {
                totalCompressed += entry.data.length;
                totalOriginal += entry.originalSize;
                count++;
            }
        }
        return {
            count,
            totalCompressedBytes: totalCompressed,
            totalOriginalBytes: totalOriginal,
            compressionRatio: totalOriginal > 0 ? (totalCompressed / totalOriginal).toFixed(2) : 'N/A'
        };
    }
}

// ─────────────────────────────────────────────
// KEYSTORE — Almacena objetos serializados + comprimidos en RAM
// ─────────────────────────────────────────────
class keyStore {
    constructor({ ttlMs = 15 * 60 * 1000 } = {}) {
        this.ttlMs = ttlMs;
        this.store = new Map();
        ramMonitor.register(this);
    }

    set(keyId, keyData) {
        const raw = Buffer.from(JSON.stringify(keyData), "utf8");
        const { data, compressed } = compressIfNeeded(raw);
        const exp = Date.now() + this.ttlMs;

        this.store.set(keyId, { data, compressed, exp, size: raw.length });
    }

    get(keyId) {
        const entry = this.store.get(keyId);
        if (!entry) return null;

        if (Date.now() > entry.exp) {
            this.store.delete(keyId);
            return null;
        }

        const buf = decompressIfNeeded(entry);
        return JSON.parse(buf.toString("utf8"));
    }

    has(keyId) {
        const entry = this.store.get(keyId);
        if (!entry) return false;
        if (Date.now() > entry.exp) {
            this.store.delete(keyId);
            return false;
        }
        return true;
    }

    delete(keyId) {
        this.store.delete(keyId);
    }

    clear() {
        const count = this.store.size;
        this.store.clear();
        console.log(`[KeyStore] Clear completado: ${count} entradas eliminadas de RAM`);
    }

    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.store) {
            if (now > entry.exp) {
                this.store.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[KeyStore] Cleanup: ${cleaned} entradas expiradas eliminadas`);
        }
    }

    getStats() {
        let totalSize = 0;
        let count = 0;
        const now = Date.now();
        const expired = [];
        for (const [key, entry] of this.store) {
            if (now > entry.exp) {
                expired.push(key);
            } else {
                totalSize += entry.data.length;
                count++;
            }
        }
        return {
            total: count,
            expired: expired.length,
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
        };
    }
}

// ─────────────────────────────────────────────
// SIMPLECACHE — Cache genérico en RAM con compresión
// ─────────────────────────────────────────────
class SimpleCache {
    constructor(cleanInterval = 60_000) {
        this.store = new Map();
        this.cleanInterval = setInterval(() => this.cleanup(), cleanInterval);
        if (this.cleanInterval.unref) this.cleanInterval.unref();
        ramMonitor.register(this);
    }

    set(key, value, ttl = 60_000) {
        const raw = Buffer.from(JSON.stringify(value), "utf8");
        const { data, compressed } = compressIfNeeded(raw);
        this.store.set(key, { data, compressed, exp: Date.now() + ttl });
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.exp) {
            this.store.delete(key);
            return undefined;
        }

        const buf = decompressIfNeeded(entry);
        return JSON.parse(buf.toString("utf8"));
    }

    has(key) {
        const entry = this.store.get(key);
        if (!entry) return false;
        if (Date.now() > entry.exp) {
            this.store.delete(key);
            return false;
        }
        return true;
    }

    del(key) {
        this.store.delete(key);
    }

    delete(key) {
        this.store.delete(key);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.exp) this.store.delete(key);
        }
    }

    getStats() {
        let totalSize = 0;
        let count = 0;
        const now = Date.now();
        for (const [, entry] of this.store) {
            if (now <= entry.exp) {
                totalSize += entry.data.length;
                count++;
            }
        }
        return {
            count,
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
        };
    }

    stop() {
        clearInterval(this.cleanInterval);
    }
}

// ─────────────────────────────────────────────
// MEMCACHE — Cache en RAM puro (sin compresión)
// ─────────────────────────────────────────────
class MemCache {
    constructor({
        maxEntries = 100,
        maxStringLength = 50000,
        cleanInterval = 30000
    } = {}) {
        this.cache = new Map();
        this.maxEntries = maxEntries;
        this.maxStringLength = maxStringLength;
        this.timer = setInterval(() => this.cleanup(), cleanInterval);
        if (this.timer.unref) this.timer.unref();
        ramMonitor.register(this);
    }

    set(key, value, ttl = 60000) {
        if (typeof value === 'string' && value.length > this.maxStringLength) {
            console.warn(`MemCache: Entry "${key}" exceeds size limit (${value.length} > ${this.maxStringLength}).`);
            return false;
        }

        if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, { value, exp: Date.now() + ttl });
        return true;
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.exp) {
            this.cache.delete(key);
            return undefined;
        }

        return entry.value;
    }

    delete(key) {
        this.cache.delete(key);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now > entry.exp) this.cache.delete(key);
        }
    }

    getStats() {
        let totalSize = 0;
        let count = 0;
        const now = Date.now();
        for (const [, entry] of this.cache) {
            if (now <= entry.exp) {
                const size = entry.value ? JSON.stringify(entry.value).length : 0;
                totalSize += size;
                count++;
            }
        }
        return {
            count,
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
        };
    }

    dump() {
        const result = {};
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now <= entry.exp) {
                result[key] = entry.value;
            }
        }
        return result;
    }

    stop() {
        clearInterval(this.timer);
    }
}

// ─────────────────────────────────────────────
// DUMP ALL (para debugging)
// ─────────────────────────────────────────────
function dumpAllCache() {
    console.warn('[dumpAllCache] En modo RAM, cada instancia de cache es independiente.');
    return {};
}

// ─────────────────────────────────────────────
// EXPORTACIONES - ¡TODAS las que necesitamos!
// ─────────────────────────────────────────────
module.exports = {
    TextStore,
    keyStore,
    SimpleCache,
    MemCache,
    dumpAllCache,
    ramMonitor,          // <-- Exportado
    decompressIfNeeded,  // <-- Exportado
    compressIfNeeded,    // <-- Exportado (por si acaso)
    COMPRESS_THRESHOLD   // <-- Exportado (por si acaso)
};