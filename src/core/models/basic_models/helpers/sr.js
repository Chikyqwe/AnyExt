const srCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 30 minutos

async function getSR(URLd, forceRefresh = false) {
    const origin = new URL(URLd).origin;
    const now = Date.now();

    if (!forceRefresh && srCache.has(origin)) {
        const cached = srCache.get(origin);
        if (now - cached.ts < CACHE_TTL_MS && cached.ids.length > 0) {
            return cached.ids;
        }
    }

    const ids = new Set();
    try {
        const res = await fetch(URLd, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await res.text();

        const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)]
            .map(m => m[1].startsWith("http") ? m[1] : origin + m[1]);

        await Promise.all(
            scripts.map(async (url) => {
                try {
                    const jsRes = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    const js = await jsRes.text();
                    for (const match of js.matchAll(/createServerReference\)\("([^"]+)"/g)) {
                        ids.add(match[1]);
                    }
                } catch (e) { }
            })
        );
    } catch (e) {
        if (srCache.has(origin)) {
            return srCache.get(origin).ids;
        }
    }

    const result = [...ids];
    if (result.length > 0) {
        srCache.set(origin, { ids: result, ts: now });
    }
    return result;
}

function clearSRCache(origin) {
    if (origin) {
        srCache.delete(origin);
    } else {
        srCache.clear();
    }
}

module.exports = { getSR, clearSRCache };