/**
 * image-server.js
 * Servidor local para buscar imagens de produtos de forma confiável.
 * Roda na porta 3737.
 * Execute: node image-server.js
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3737;

// Cabeçalhos CORS para o admin.html poder chamar
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// Headers de navegador para não ser bloqueado
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
};

async function fetchUrl(targetUrl) {
    const res = await fetch(targetUrl, {
        headers: { ...BROWSER_HEADERS, 'Host': new URL(targetUrl).hostname },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow'
    });
    const body = await res.text();
    return { body, finalUrl: res.url, statusCode: res.status };
}

// ─── Extração de imagem por plataforma ─────────────────────────────────────

function extractOgImage(html) {
    const patterns = [
        /property=["']og:image["']\s+content=["']([^"']+)["']/i,
        /content=["']([^"']+)["']\s+property=["']og:image["']/i,
        /<meta[^>]+og:image[^>]+content=["']([^"']+)["']/i,
        /og:image.*?content=["']([^"']+)["']/i,
    ];
    for (const rx of patterns) {
        const m = html.match(rx);
        if (m && m[1] && m[1].startsWith('http')) return m[1];
    }
    return null;
}

async function fetchMercadoLivre(productUrl) {
    // URLs tipo /p/MLB... são "páginas de produto" (comparador de preços)
    // Precisa buscar o item_id real dentro do HTML da página
    const isProductPage = /\/p\/MLB/i.test(productUrl);

    if (isProductPage) {
        console.log('  → URL tipo /p/ detectada, buscando item_id real...');
        try {
            const { body } = await fetchUrl(productUrl);

            // Tenta extrair o item_id real do JSON de dados na página
            const patterns = [
                /"item_id"\s*:\s*"(MLB\d+)"/i,
                /"itemId"\s*:\s*"(MLB\d+)"/i,
                /\"id\"\s*:\s*\"(MLB\d{5,12})\"/i,
                /\/MLB-?(\d{5,12})[-_]/,
                /MLB(\d{5,12})/,
            ];
            for (const rx of patterns) {
                const m = body.match(rx);
                if (m) {
                    const itemId = m[1].startsWith('MLB') ? m[1] : 'MLB' + m[1];
                    console.log(`  → item_id encontrado: ${itemId}`);
                    const result = await fetchMercadoLivreById(itemId);
                    if (result) return result;
                }
            }

            // Fallback: tenta og:image da página do produto
            const og = extractOgImage(body);
            // Filtra logos (geralmente são pequenos e contêm "logo" ou "brand" na URL)
            if (og && !og.includes('logo') && !og.includes('brand') && !og.includes('frontend-assets')) {
                return og;
            }
        } catch (e) {
            console.log('  → Erro ao buscar /p/:', e.message);
        }
        return null;
    }

    // URL normal: extrai MLB direto
    const match = productUrl.match(/MLB[_\-]?(\d+)/i);
    if (match) {
        return fetchMercadoLivreById('MLB' + match[1]);
    }

    // Fallback: busca no HTML
    try {
        const { body } = await fetchUrl(productUrl);
        const idMatch = body.match(/"item_id"\s*:\s*"(MLB\d+)"/i) || body.match(/MLB(\d{6,12})/i);
        if (!idMatch) return null;
        const itemId = idMatch[1].startsWith('MLB') ? idMatch[1] : 'MLB' + idMatch[1];
        return fetchMercadoLivreById(itemId);
    } catch { return null; }
}

function fetchMercadoLivreById(itemId) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.mercadolibre.com',
            path: `/items/${itemId}`,
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            timeout: 8000,
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    const pic = data.pictures && data.pictures[0];
                    resolve(pic ? (pic.secure_url || pic.url) : null);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function fetchShopee(productUrl) {
    // Resolve link encurtado (shp.ee)
    let resolvedUrl = productUrl;
    if (/shp\.ee|s\.shopee/i.test(productUrl)) {
        try {
            const redirected = await fetchUrl(productUrl);
            resolvedUrl = redirected.finalUrl || productUrl;
            console.log(`  → Link encurtado resolvido: ${resolvedUrl.slice(0, 80)}...`);
        } catch { }
    }

    // Extrai shopId e itemId da URL
    let shopId = null, itemId = null;
    const qsShop = resolvedUrl.match(/[?&]shopid=(\d+)/i);
    const qsItem = resolvedUrl.match(/[?&]itemid=(\d+)/i);
    if (qsShop && qsItem) { shopId = qsShop[1]; itemId = qsItem[1]; }
    else {
        // Formato: produto-nome-i.SHOPID.ITEMID ou .i.SHOPID.ITEMID
        const m = resolvedUrl.match(/[.-]i\.(\d+)\.(\d+)/i);
        if (m) { shopId = m[1]; itemId = m[2]; }
    }
    console.log(`  → shopId=${shopId}, itemId=${itemId}`);

    // Estratégia 1: Scraping da página do produto (mais confiável)
    try {
        // Usa User-Agent de robô (Facebook/WhatsApp) para forçar SSR na Shopee
        const shopeeHeaders = {
            'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'pt-BR,pt;q=0.9',
        };

        const { body } = await fetchCustom(resolvedUrl, shopeeHeaders);

        // Tenta og:image (geralmente é a imagem principal do produto)
        const og = extractOgImage(body);
        if (og && og.includes('susercontent.com') && !og.includes('logo') && !og.includes('promo-')) {
            console.log(`  → og:image encontrada: ${og.slice(0, 60)}...`);
            return og;
        }

        // Tenta extrair do JSON embutido na página (__NEXT_DATA__ ou window.__INITIAL_STATE__)
        const nextDataMatch = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
            try {
                const nd = JSON.parse(nextDataMatch[1]);
                const images = nd?.props?.pageProps?.originalItem?.images
                    || nd?.props?.initialState?.itemDetail?.data?.images
                    || [];
                if (images && images.length > 0) {
                    const hash = images[0];
                    if (hash && typeof hash === 'string') {
                        const imgUrl = hash.startsWith('http') ? hash : `https://down-br.img.susercontent.com/file/${hash}`;
                        return imgUrl;
                    }
                }
            } catch { }
        }

        // Tenta extrair hashes de imagem de produto reais da Shopee CDN (ignora banners promo)
        const cdnPatterns = [
            /"(br-\d+-[a-zA-Z0-9_-]+)(?:@[a-zA-Z0-9_@.]+)?"/gi,
            /https:\/\/down[-.]?(?:br\.)?img\.susercontent\.com\/file\/(br-\d+-[a-zA-Z0-9_-]+)/gi,
            /https:\/\/down[-.]?(?:br\.)?img\.susercontent\.com\/file\/([a-zA-Z0-9]{32})/gi
        ];
        
        for (const rx of cdnPatterns) {
            const matches = [...body.matchAll(rx)];
            for (const m of matches) {
                const imgHash = m[1] || m[0];
                if (imgHash && !imgHash.includes('promo-') && !imgHash.includes('logo')) {
                    const imgUrl = imgHash.startsWith('http') ? imgHash : `https://down-br.img.susercontent.com/file/${imgHash}`;
                    console.log(`  → Imagem de produto encontrada no HTML: ${imgUrl.slice(0, 70)}...`);
                    return imgUrl;
                }
            }
        }
    } catch (e) {
        console.log(`  → Erro scraping página: ${e.message}`);
    }

    // Estratégia 2: API interna da Shopee (funciona quando não há bloqueio)
    if (shopId && itemId) {
        try {
            const apiUrl = `https://shopee.com.br/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`;
            const apiHeaders = {
                ...BROWSER_HEADERS,
                'Referer': `https://shopee.com.br/`,
                'x-api-source': 'rn',
                'x-shopee-language': 'pt',
            };
            const { body } = await fetchCustom(apiUrl, apiHeaders);
            const data = JSON.parse(body);
            const imgHash = data?.data?.image || (data?.data?.images && data.data.images[0]);
            if (imgHash) {
                const imgUrl = imgHash.startsWith('http') ? imgHash : `https://down-br.img.susercontent.com/file/${imgHash}`;
                console.log(`  → API Shopee: ${imgUrl.slice(0, 60)}...`);
                return imgUrl;
            }
        } catch { }
    }

    return null;
}

// Fetch com headers customizados
async function fetchCustom(targetUrl, headers) {
    const res = await fetch(targetUrl, {
        headers: { ...headers, 'Host': new URL(targetUrl).hostname },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow'
    });
    const body = await res.text();
    return { body, finalUrl: res.url, statusCode: res.status };
}

async function fetchAmazon(productUrl) {
    try {
        const botHeaders = {
            'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Accept': 'text/html,application/xhtml+xml,application/xml',
        };
        const { body } = await fetchCustom(productUrl, botHeaders);
        // Amazon usa og:image
        const og = extractOgImage(body);
        if (og) return og;
        // CDN da Amazon
        const patterns = [
            /https:\/\/m\.media-amazon\.com\/images\/I\/[^\s"'<>]+/i,
            /https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[^\s"'<>]+/i,
            /https:\/\/images-amazon\.com\/images\/[^\s"'<>]+/i,
        ];
        for (const rx of patterns) {
            const m = body.match(rx);
            if (m) return m[0].replace(/\\u002F/g, '/').split('"')[0];
        }
    } catch { }
    return null;
}

async function fetchGeneric(productUrl) {
    try {
        const { body } = await fetchUrl(productUrl);
        return extractOgImage(body);
    } catch { }
    return null;
}

// ─── Servidor HTTP ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
    }

    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/fetch-image') {
        const productUrl = parsed.query.url;
        if (!productUrl) {
            res.writeHead(400, CORS_HEADERS);
            return res.end(JSON.stringify({ error: 'Parâmetro url não informado' }));
        }

        let imageUrl = null;
        let source = 'genérico';

        try {
            if (/mercadolivre\.com\.br|mercadolibre\.com|mlb\./i.test(productUrl)) {
                source = 'Mercado Livre API';
                imageUrl = await fetchMercadoLivre(productUrl);
            } else if (/shopee\.com\.br|shp\.ee|s\.shopee/i.test(productUrl)) {
                source = 'Shopee';
                imageUrl = await fetchShopee(productUrl);
            } else if (/amazon\.(com\.br|com)/i.test(productUrl)) {
                source = 'Amazon';
                imageUrl = await fetchAmazon(productUrl);
            }

            if (!imageUrl) {
                source = 'og:image genérico';
                imageUrl = await fetchGeneric(productUrl);
            }
        } catch (e) {
            console.error('Erro ao buscar imagem:', e.message);
        }

        res.writeHead(imageUrl ? 200 : 404, CORS_HEADERS);
        res.end(JSON.stringify({ imageUrl, source, success: !!imageUrl }));
        console.log(`[${new Date().toLocaleTimeString()}] ${source}: ${imageUrl ? '✅ ' + imageUrl.slice(0, 60) + '...' : '❌ não encontrada'}`);

    } else if (parsed.pathname === '/health') {
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ status: 'ok', message: 'Servidor de imagens rodando!' }));
    } else {
        res.writeHead(404, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'Rota não encontrada' }));
    }
});

server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   🖼️  Servidor de Imagens - Favoritos Jul  ║');
    console.log(`║   Rodando em: http://localhost:${PORT}        ║`);
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log('✅ Mercado Livre: API oficial');
    console.log('✅ Shopee: API interna + og:image');
    console.log('✅ Amazon: og:image + CDN');
    console.log('');
    console.log('Aguardando requisições...');
});
