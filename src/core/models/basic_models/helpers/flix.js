const { getSR } = require("./sr");

async function getflix(url) {
    const parsedUrl = new URL(url);
    const BASE = parsedUrl.origin;
    const token = parsedUrl.pathname.split("/").filter(Boolean).pop();
    const BODY = [token];

    const ids = await getSR(url);
    if (ids.length === 0) return null;

    for (const id of ids) {
        try {
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
                            return parsedData.iframeUrl;
                        }
                    }
                }
            }
        } catch (e) { }
    }

    return null;
}

module.exports = { getflix }