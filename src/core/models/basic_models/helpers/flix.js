const { getSR } = require("./sr");

let lastWorkingActionId = null;

async function getflix(url) {
    const parsedUrl = new URL(url);
    const BASE = parsedUrl.origin;
    const token = parsedUrl.pathname.split("/").filter(Boolean).pop();
    const BODY = [token];

    const ids = await getSR(url);
    if (!ids || ids.length === 0) return null;

    let testIds = [...ids];
    if (lastWorkingActionId && testIds.includes(lastWorkingActionId)) {
        testIds.sort((a, b) => (a === lastWorkingActionId ? -1 : b === lastWorkingActionId ? 1 : 0));
    }

    const testId = async (id) => {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "content-type": "text/x-component",
                "next-action": id,
                "accept": "text/x-component",
                "Referer": url,
                "Origin": BASE
            },
            body: JSON.stringify(BODY)
        });

        const txt = await res.text();
        const esInvalido = !txt || txt.includes('1:"$undefined"') || txt.includes('1:[]') || txt.includes('1:{"ok":false');

        if (!esInvalido) {
            const lines = txt.split("\n");
            for (const line of lines) {
                if (line.startsWith("1:")) {
                    const jsonStr = line.slice(2).trim();
                    const parsedData = JSON.parse(jsonStr);
                    if (parsedData && parsedData.iframeUrl) {
                        lastWorkingActionId = id;
                        return parsedData.iframeUrl;
                    }
                }
            }
        }
        throw new Error('Invalid action');
    };

    try {
        return await Promise.any(testIds.map(id => testId(id)));
    } catch {
        lastWorkingActionId = null;
        const freshIds = await getSR(url, true);
        if (freshIds && freshIds.length > 0) {
            try {
                return await Promise.any(freshIds.map(id => testId(id)));
            } catch {
                return null;
            }
        }
        return null;
    }
}

module.exports = { getflix };