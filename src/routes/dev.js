// src/routes/devRoutes.js
const express = require('express');
const router = express.Router();

const asyncHandler = require('../middlewares/asyncHandler');
const { getRamStats, ramMonitor } = require('../core/cache/cache');
const { TextStore, keyStore, SimpleCache, MemCache } = require('../core/cache/cacheStorage');
const os = require('os');

// ─────────────────────────────────────────────
// FUNCIONES DE DUMP (deben estar definidas ANTES de usarlas)
// ─────────────────────────────────────────────

// Necesitamos importar decompressIfNeeded
const { decompressIfNeeded } = require('../core/cache/cacheStorage');

function dumpTextStore(instance, instanceName) {
    const data = [];
    const now = Date.now();
    let compressed = 0;
    let original = 0;
    let count = 0;

    if (instance.store) {
        for (const [key, entry] of instance.store) {
            if (now <= entry.exp) {
                try {
                    const decompressed = decompressIfNeeded(entry);
                    const text = decompressed.toString('utf8');

                    data.push({
                        key: key,
                        ttl: Math.floor((entry.exp - now) / 1000),
                        originalSize: entry.originalSize || entry.data.length,
                        compressedSize: entry.data.length,
                        compressed: entry.compressed || false,
                        compressionRatio: entry.originalSize > 0 ? (entry.data.length / entry.originalSize).toFixed(2) : 'N/A',
                        content: text,
                        contentPreview: text.length > 100 ? text.substring(0, 100) + '...' : text,
                        contentLength: text.length,
                        expiresAt: new Date(entry.exp).toISOString()
                    });

                    compressed += entry.data.length;
                    original += entry.originalSize || entry.data.length;
                    count++;
                } catch (err) {
                    console.error(`Error descomprimiendo entrada ${key}:`, err);
                }
            }
        }
    }

    return {
        instanceName: instanceName,
        type: 'TextStore',
        entries: data,
        count: count,
        totalCompressedBytes: compressed,
        totalOriginalBytes: original,
        compressionRatio: original > 0 ? (compressed / original).toFixed(2) : 'N/A',
        savings: original > 0 ? `${((1 - compressed / original) * 100).toFixed(1)}%` : 'N/A'
    };
}

function dumpKeyStore(instance, instanceName) {
    const data = [];
    const now = Date.now();
    let totalSize = 0;
    let count = 0;

    if (instance.store) {
        for (const [key, entry] of instance.store) {
            if (now <= entry.exp) {
                try {
                    const decompressed = decompressIfNeeded(entry);
                    const parsed = JSON.parse(decompressed.toString('utf8'));

                    data.push({
                        key: key,
                        ttl: Math.floor((entry.exp - now) / 1000),
                        compressedSize: entry.data.length,
                        compressed: entry.compressed || false,
                        content: parsed,
                        contentPreview: JSON.stringify(parsed).length > 100 ?
                            JSON.stringify(parsed).substring(0, 100) + '...' :
                            JSON.stringify(parsed),
                        contentLength: JSON.stringify(parsed).length,
                        expiresAt: new Date(entry.exp).toISOString()
                    });

                    totalSize += entry.data.length;
                    count++;
                } catch (err) {
                    console.error(`Error descomprimiendo entrada ${key}:`, err);
                }
            }
        }
    }

    return {
        instanceName: instanceName,
        type: 'keyStore',
        entries: data,
        count: count,
        totalSize: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
}

function dumpSimpleCache(instance, instanceName) {
    const data = [];
    const now = Date.now();
    let totalSize = 0;
    let count = 0;

    if (instance.store) {
        for (const [key, entry] of instance.store) {
            if (now <= entry.exp) {
                try {
                    const decompressed = decompressIfNeeded(entry);
                    const parsed = JSON.parse(decompressed.toString('utf8'));

                    data.push({
                        key: key,
                        ttl: Math.floor((entry.exp - now) / 1000),
                        compressedSize: entry.data.length,
                        compressed: entry.compressed || false,
                        content: parsed,
                        contentPreview: JSON.stringify(parsed).length > 100 ?
                            JSON.stringify(parsed).substring(0, 100) + '...' :
                            JSON.stringify(parsed),
                        contentLength: JSON.stringify(parsed).length,
                        expiresAt: new Date(entry.exp).toISOString()
                    });

                    totalSize += entry.data.length;
                    count++;
                } catch (err) {
                    console.error(`Error descomprimiendo entrada ${key}:`, err);
                }
            }
        }
    }

    return {
        instanceName: instanceName,
        type: 'SimpleCache',
        entries: data,
        count: count,
        totalSize: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
}

function dumpMemCache(instance, instanceName) {
    const data = [];
    const now = Date.now();
    let totalSize = 0;
    let count = 0;

    if (instance.cache) {
        for (const [key, entry] of instance.cache) {
            if (now <= entry.exp) {
                const content = entry.value;
                const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

                data.push({
                    key: key,
                    ttl: Math.floor((entry.exp - now) / 1000),
                    content: content,
                    contentPreview: contentStr.length > 100 ? contentStr.substring(0, 100) + '...' : contentStr,
                    contentLength: contentStr.length,
                    expiresAt: new Date(entry.exp).toISOString()
                });

                totalSize += contentStr.length;
                count++;
            }
        }
    }

    return {
        instanceName: instanceName,
        type: 'MemCache',
        entries: data,
        count: count,
        totalSize: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
}

// ─────────────────────────────────────────────
// ENDPOINT QUE DEVUELVE TODO EL CONTENIDO DE LOS CACHÉS
// ─────────────────────────────────────────────
router.get('/api/dev/cache/dump/all', asyncHandler(async (req, res) => {
    try {
        // Obtener estadísticas del cache
        const cacheStats = getRamStats();

        // Obtener estadísticas de MEMORIA DEL PROCESO NODE.JS
        const memoryUsage = process.memoryUsage();
        const rss = memoryUsage.rss;
        const rssMB = rss / (1024 * 1024);
        const heapUsed = memoryUsage.heapUsed;
        const heapUsedMB = heapUsed / (1024 * 1024);
        const heapTotal = memoryUsage.heapTotal;
        const heapTotalMB = heapTotal / (1024 * 1024);

        // LÍMITE MÁXIMO: 510 MB
        const MAX_PROCESS_MEMORY_MB = 510;
        const processMemoryPercentage = (rssMB / MAX_PROCESS_MEMORY_MB) * 100;

        // Variables para acumular datos de todas las instancias
        let allCacheData = {
            textStores: [],
            keyStores: [],
            simpleCaches: [],
            memCaches: []
        };

        let totalEntries = 0;
        let totalCompressedBytes = 0;
        let totalOriginalBytes = 0;
        let totalRawData = 0;

        // Necesitamos acceso a las instancias registradas en ramMonitor
        const instances = ramMonitor.instances || [];

        // Procesar cada instancia registrada
        for (const instance of instances) {
            const instanceName = instance.constructor?.name || 'Unknown';

            if (instance instanceof TextStore) {
                const dump = dumpTextStore(instance, instanceName);
                allCacheData.textStores.push(dump);
                totalEntries += dump.count;
                totalCompressedBytes += dump.totalCompressedBytes || 0;
                totalOriginalBytes += dump.totalOriginalBytes || 0;
                // Calcular raw data de las entradas
                for (const entry of dump.entries) {
                    totalRawData += entry.contentLength || 0;
                }
            } else if (instance instanceof keyStore) {
                const dump = dumpKeyStore(instance, instanceName);
                allCacheData.keyStores.push(dump);
                totalEntries += dump.count;
                totalCompressedBytes += dump.totalSize || 0;
                totalOriginalBytes += dump.totalSize || 0;
                for (const entry of dump.entries) {
                    totalRawData += entry.contentLength || 0;
                }
            } else if (instance instanceof SimpleCache) {
                const dump = dumpSimpleCache(instance, instanceName);
                allCacheData.simpleCaches.push(dump);
                totalEntries += dump.count;
                totalCompressedBytes += dump.totalSize || 0;
                totalOriginalBytes += dump.totalSize || 0;
                for (const entry of dump.entries) {
                    totalRawData += entry.contentLength || 0;
                }
            } else if (instance instanceof MemCache) {
                const dump = dumpMemCache(instance, instanceName);
                allCacheData.memCaches.push(dump);
                totalEntries += dump.count;
                for (const entry of dump.entries) {
                    totalRawData += entry.contentLength || 0;
                }
            }
        }

        // Calcular estadísticas globales
        const globalCompressionRatio = totalOriginalBytes > 0 ?
            (totalCompressedBytes / totalOriginalBytes).toFixed(2) : 'N/A';

        // Determinar estado de salud
        let healthStatus = 'healthy';
        let healthWarnings = [];
        let healthRecommendations = [];

        if (rssMB > MAX_PROCESS_MEMORY_MB * 0.90) {
            healthStatus = 'critical';
            healthWarnings.push(`🔴 PROCESO CRÍTICO: ${rssMB.toFixed(0)}MB / ${MAX_PROCESS_MEMORY_MB}MB (${processMemoryPercentage.toFixed(1)}%)`);
            healthRecommendations.push('⚠️ EL PROCESO ESTÁ CERCA DEL LÍMITE DE 510MB - ¡REINICIAR INMEDIATAMENTE!');
        } else if (rssMB > MAX_PROCESS_MEMORY_MB * 0.75) {
            healthStatus = 'warning';
            healthWarnings.push(`🟡 PROCESO EN ALERTA: ${rssMB.toFixed(0)}MB / ${MAX_PROCESS_MEMORY_MB}MB (${processMemoryPercentage.toFixed(1)}%)`);
            healthRecommendations.push('⚠️ Memoria del proceso alta, monitorear crecimiento');
        }

        // Preparar respuesta con TODO el contenido
        const response = {
            success: true,
            data: {
                // Metadatos
                metadata: {
                    timestamp: new Date().toISOString(),
                    totalEntries: totalEntries,
                    totalRawDataMB: (totalRawData / (1024 * 1024)).toFixed(2),
                    totalCompressedMB: (totalCompressedBytes / (1024 * 1024)).toFixed(2),
                    totalOriginalMB: (totalOriginalBytes / (1024 * 1024)).toFixed(2),
                    globalCompressionRatio: globalCompressionRatio,
                    compressionSavings: totalOriginalBytes > 0 ?
                        `${((1 - totalCompressedBytes / totalOriginalBytes) * 100).toFixed(1)}%` : 'N/A'
                },

                // TODOS los contenidos por tipo de cache
                contents: {
                    textStores: allCacheData.textStores,
                    keyStores: allCacheData.keyStores,
                    simpleCaches: allCacheData.simpleCaches,
                    memCaches: allCacheData.memCaches
                },

                // Estadísticas de memoria del proceso
                processMemory: {
                    rss: {
                        bytes: rss,
                        mb: rssMB.toFixed(2),
                        percentage: processMemoryPercentage.toFixed(1),
                        limit: MAX_PROCESS_MEMORY_MB,
                        available: (MAX_PROCESS_MEMORY_MB - rssMB).toFixed(2)
                    },
                    heap: {
                        used: {
                            bytes: heapUsed,
                            mb: heapUsedMB.toFixed(2)
                        },
                        total: {
                            bytes: heapTotal,
                            mb: heapTotalMB.toFixed(2)
                        },
                        percentage: ((heapUsed / heapTotal) * 100).toFixed(1)
                    }
                },

                // Estado de salud
                health: {
                    status: healthStatus,
                    warnings: healthWarnings,
                    recommendations: healthRecommendations,
                    metrics: {
                        processMemoryPercentage: parseFloat(processMemoryPercentage.toFixed(1)),
                        threshold_warning: 75,
                        threshold_critical: 90
                    }
                },

                // Resumen por tipo
                summary: {
                    totalTextEntries: allCacheData.textStores.reduce((acc, s) => acc + s.count, 0),
                    totalKeyEntries: allCacheData.keyStores.reduce((acc, s) => acc + s.count, 0),
                    totalSimpleEntries: allCacheData.simpleCaches.reduce((acc, s) => acc + s.count, 0),
                    totalMemEntries: allCacheData.memCaches.reduce((acc, s) => acc + s.count, 0),
                    totalEntries: totalEntries
                }
            }
        };

        return res.json(response);
    } catch (error) {
        console.error('[DevAPI] Error obteniendo dump completo:', error);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener dump completo de cachés',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}));

// ─────────────────────────────────────────────
// ENDPOINT PARA DUMP DE UN CACHE ESPECÍFICO
// CORREGIDO: sin ? en la ruta
// ─────────────────────────────────────────────
router.get('/api/dev/cache/dump/:type', asyncHandler(async (req, res) => {
    try {
        const { type } = req.params;
        const { key } = req.query; // Usar query param en lugar de path param opcional
        const instances = ramMonitor.instances || [];
        let found = [];

        // Buscar instancias del tipo solicitado
        for (const instance of instances) {
            let instanceType = instance.constructor?.name || '';
            let data = null;

            if (type === 'text' && instance instanceof TextStore) {
                data = dumpTextStore(instance, instanceType);
            } else if (type === 'key' && instance instanceof keyStore) {
                data = dumpKeyStore(instance, instanceType);
            } else if (type === 'simple' && instance instanceof SimpleCache) {
                data = dumpSimpleCache(instance, instanceType);
            } else if (type === 'mem' && instance instanceof MemCache) {
                data = dumpMemCache(instance, instanceType);
            }

            if (data) {
                // Filtrar por key específica si se proporcionó
                if (key) {
                    data.entries = data.entries.filter(e => e.key === key);
                    data.count = data.entries.length;
                }
                found.push(data);
            }
        }

        return res.json({
            success: true,
            data: {
                type: type,
                key: key || 'all',
                instances: found,
                totalInstances: found.length,
                totalEntries: found.reduce((acc, f) => acc + f.count, 0)
            }
        });
    } catch (error) {
        console.error('[DevAPI] Error obteniendo dump específico:', error);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener dump específico',
            message: error.message
        });
    }
}));

// ─────────────────────────────────────────────
// ENDPOINT PARA OBTENER UNA KEY ESPECÍFICA
// ─────────────────────────────────────────────
router.get('/api/dev/cache/dump/:type/:key', asyncHandler(async (req, res) => {
    try {
        const { type, key } = req.params;
        const instances = ramMonitor.instances || [];
        let found = [];

        // Buscar instancias del tipo solicitado
        for (const instance of instances) {
            let instanceType = instance.constructor?.name || '';
            let data = null;

            if (type === 'text' && instance instanceof TextStore) {
                data = dumpTextStore(instance, instanceType);
            } else if (type === 'key' && instance instanceof keyStore) {
                data = dumpKeyStore(instance, instanceType);
            } else if (type === 'simple' && instance instanceof SimpleCache) {
                data = dumpSimpleCache(instance, instanceType);
            } else if (type === 'mem' && instance instanceof MemCache) {
                data = dumpMemCache(instance, instanceType);
            }

            if (data) {
                // Filtrar por key específica
                data.entries = data.entries.filter(e => e.key === key);
                data.count = data.entries.length;
                if (data.count > 0) {
                    found.push(data);
                }
            }
        }

        return res.json({
            success: true,
            data: {
                type: type,
                key: key,
                instances: found,
                totalInstances: found.length,
                totalEntries: found.reduce((acc, f) => acc + f.count, 0)
            }
        });
    } catch (error) {
        console.error('[DevAPI] Error obteniendo key específica:', error);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener key específica',
            message: error.message
        });
    }
}));

module.exports = router;