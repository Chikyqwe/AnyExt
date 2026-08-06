async function getSR(URLd) {
    const BASE = new URL(URLd).origin;
    const ids = new Set();

    const html = await (await fetch(URLd)).text();

    const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)]
        .map(m => m[1].startsWith("http") ? m[1] : BASE + m[1]);

    await Promise.all(
        scripts.map(async (url) => {
            try {
                const js = await (await fetch(url)).text();
                for (const match of js.matchAll(/createServerReference\)\("([^"]+)"/g)) {
                    ids.add(match[1]);
                }
            } catch (e) { }
        })
    );

    return [...ids];
}

module.exports = { getSR }