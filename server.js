'use strict';

/**
 * BANNY - destilados craft premium (Grupo Kairos)
 * --------------------------------------------------
 * Web liviana que lee productos del Shopify central (kairos-brewing)
 * filtrando por vendor = "Banny" via Admin API, y manda el checkout al
 * carrito de Shopify mediante permalink (/cart/{variantId}:{qty}).
 *
 * Misma arquitectura que la web de Kairos: nada hardcodeado, todo sale
 * de Shopify en runtime. El token NUNCA vive en el codigo, solo en env vars.
 */

const path = require('path');
const express = require('express');

const app = express();
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Configuracion (solo via variables de entorno)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const SHOP_DOMAIN = (process.env.SHOPIFY_STORE_DOMAIN || '').trim();
const ADMIN_TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || '').trim();
const API_VERSION = (process.env.SHOPIFY_API_VERSION || '2024-10').trim();
const VENDOR = (process.env.VENDOR || 'Banny').trim();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Palabras clave para EXCLUIR productos del catalogo web (formato granel
// que no va en la tienda online, ej: bidones de 20 L). Configurable por env.
// Coincide contra titulo / tags / product_type, sin distinguir acentos.
const EXCLUDE_KEYWORDS = (process.env.EXCLUDE_KEYWORDS || 'bidon')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SITE = {
  name: 'Banny by Kairos',
  tagline: 'Craft to be wild',
  description:
    'Banny es la linea de destilados y Ready To Drink de Kairos. Gin, ron, whisky, vermut y cocteles listos donde la experiencia en barra se transforma en producto.'
};

// Orden y matchers de categorias (mapeo desde product_type / tags de Shopify)
const CATEGORIES = [
  { key: 'gin', label: 'Gin', match: ['gin'] },
  { key: 'ron', label: 'Ron', match: ['ron', 'rum'] },
  { key: 'whisky', label: 'Whisky', match: ['whisky', 'whiskey'] },
  { key: 'vermut', label: 'Vermut', match: ['vermut', 'vermouth'] },
  {
    key: 'rtd',
    label: 'RTD',
    match: ['rtd', 'ready to drink', 'lata', 'coctel', 'cocktail', 'mojito', 'gin tonic', 'gintonic']
  }
];
const CATEGORY_FALLBACK = { key: 'otros', label: 'Otros' };

// ---------------------------------------------------------------------------
// Cache simple en memoria
// ---------------------------------------------------------------------------
let cache = { ts: 0, products: null, pages: null, error: null };

function configError() {
  if (!SHOP_DOMAIN) return 'Falta SHOPIFY_STORE_DOMAIN';
  if (!ADMIN_TOKEN) return 'Falta SHOPIFY_ADMIN_TOKEN';
  return null;
}

// ---------------------------------------------------------------------------
// Helpers de Shopify Admin API
// ---------------------------------------------------------------------------
function adminUrl(resourcePath) {
  return `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/${resourcePath}`;
}

async function adminFetch(url) {
  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Shopify ${res.status} ${res.statusText} -> ${body.slice(0, 200)}`);
  }
  return res;
}

// Parsea el header Link de Shopify para paginacion cursor-based
function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function fetchAllProducts() {
  // El filtro vendor lo aplica Shopify server-side. Igual revalidamos abajo
  // por si el dataset incluye algun caso borde.
  let url = adminUrl(
    `products.json?status=active&limit=250&vendor=${encodeURIComponent(VENDOR)}`
  );
  const all = [];
  let guard = 0;
  while (url && guard < 20) {
    guard += 1;
    const res = await adminFetch(url);
    const data = await res.json();
    if (Array.isArray(data.products)) all.push(...data.products);
    url = nextPageUrl(res.headers.get('link'));
  }
  return all;
}

async function fetchAllPages() {
  // Shopify "Pages" (contenido tipo /pages/{handle})
  let url = adminUrl('pages.json?limit=250');
  const all = [];
  let guard = 0;
  while (url && guard < 20) {
    guard += 1;
    const res = await adminFetch(url);
    const data = await res.json();
    if (Array.isArray(data.pages)) all.push(...data.pages);
    url = nextPageUrl(res.headers.get('link'));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Normalizacion
// ---------------------------------------------------------------------------
function classifyCategory(p) {
  const haystack = [p.product_type || '', p.tags || '', p.title || '']
    .join(' ')
    .toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.match.some((kw) => haystack.includes(kw))) return cat.key;
  }
  return CATEGORY_FALLBACK.key;
}

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// True si el producto debe excluirse del catalogo web (ej: bidones a granel).
function isExcluded(p) {
  if (!EXCLUDE_KEYWORDS.length) return false;
  const hay = stripAccents([p.title, p.tags, p.product_type].join(' ').toLowerCase());
  return EXCLUDE_KEYWORDS.some((kw) => hay.includes(stripAccents(kw)));
}

function money(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return null;
  // Pesos chilenos: sin decimales, separador de miles con punto
  return '$' + Math.round(n).toLocaleString('es-CL');
}

function normalizeProduct(p) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const firstVariant = variants[0] || {};
  const prices = variants
    .map((v) => Number(v.price))
    .filter((n) => isFinite(n));
  const minPrice = prices.length ? Math.min(...prices) : null;

  const compareRaw = Number(firstVariant.compare_at_price);
  const priceRaw = Number(firstVariant.price);
  const hasCompare = isFinite(compareRaw) && compareRaw > priceRaw;

  const available = variants.some(
    (v) => v.inventory_management == null || (v.inventory_quantity ?? 0) > 0 || v.inventory_policy === 'continue'
  );

  const images = Array.isArray(p.images) ? p.images : [];

  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type || '',
    tags: p.tags || '',
    category: classifyCategory(p),
    descriptionHtml: p.body_html || '',
    image: (p.image && p.image.src) || (images[0] && images[0].src) || null,
    images: images.map((img) => ({ src: img.src, alt: img.alt || p.title })),
    price: money(priceRaw),
    priceFrom: minPrice !== null && minPrice !== priceRaw ? money(minPrice) : null,
    compareAtPrice: hasCompare ? money(compareRaw) : null,
    onSale: hasCompare,
    available,
    defaultVariantId: firstVariant.id || null,
    variants: variants.map((v) => ({
      id: v.id,
      title: v.title,
      price: money(v.price),
      compareAtPrice:
        isFinite(Number(v.compare_at_price)) && Number(v.compare_at_price) > Number(v.price)
          ? money(v.compare_at_price)
          : null,
      available:
        v.inventory_management == null || (v.inventory_quantity ?? 0) > 0 || v.inventory_policy === 'continue'
    }))
  };
}

// ---------------------------------------------------------------------------
// Carga con cache
// ---------------------------------------------------------------------------
async function getData(force = false) {
  const err = configError();
  if (err) {
    cache = { ts: Date.now(), products: [], pages: [], error: err };
    return cache;
  }
  const fresh = Date.now() - cache.ts < CACHE_TTL_MS;
  if (!force && fresh && cache.products) return cache;

  try {
    const [rawProducts, rawPages] = await Promise.all([
      fetchAllProducts(),
      fetchAllPages().catch(() => []) // pages es opcional
    ]);
    const products = rawProducts
      .filter((p) => (p.vendor || '').trim().toLowerCase() === VENDOR.toLowerCase())
      .filter((p) => !isExcluded(p)) // fuera bidones / formato granel
      .map(normalizeProduct);
    cache = { ts: Date.now(), products, pages: rawPages, error: null };
  } catch (e) {
    cache = {
      ts: Date.now(),
      products: cache.products || [],
      pages: cache.pages || [],
      error: e.message
    };
  }
  return cache;
}

function groupByCategory(products) {
  const groups = [];
  for (const cat of CATEGORIES) {
    const items = products.filter((p) => p.category === cat.key);
    if (items.length) groups.push({ ...cat, items });
  }
  const others = products.filter((p) => p.category === CATEGORY_FALLBACK.key);
  if (others.length) groups.push({ ...CATEGORY_FALLBACK, items: others });
  return groups;
}

// ---------------------------------------------------------------------------
// Utilidades de render
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({ title, description, ogImage, bodyHtml, canonical }) {
  const t = escapeHtml(title || SITE.name);
  const d = escapeHtml(description || SITE.description);
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<meta property="og:image" content="${escapeHtml(ogImage || '/img/banny-logo.png')}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/img/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
${header()}
${bodyHtml}
${footer()}
<script src="/app.js" defer></script>
</body>
</html>`;
}

function header() {
  return `<header class="site-header" id="top">
  <div class="container header-inner">
    <a class="brand" href="/"><img src="/img/banny-logo.png" alt="Banny"></a>
    <nav class="nav">
      <a href="/#catalogo">Productos</a>
      <a href="/#categorias">Categorias</a>
      <a href="/#marca">La marca</a>
    </nav>
    <button class="cart-btn" id="cartBtn" aria-label="Abrir carrito">
      Carrito <span class="cart-count" id="cartCount">0</span>
    </button>
  </div>
</header>
${cartDrawer()}`;
}

function cartDrawer() {
  return `<div class="cart-overlay" id="cartOverlay"></div>
<aside class="cart-drawer" id="cartDrawer" aria-hidden="true">
  <div class="cart-head">
    <h3>Tu carrito</h3>
    <button class="cart-close" id="cartClose" aria-label="Cerrar">&times;</button>
  </div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-foot">
    <div class="cart-total"><span>Total</span><strong id="cartTotal">$0</strong></div>
    <button class="btn btn-primary btn-block" id="checkoutBtn" disabled>Ir al checkout</button>
    <p class="cart-note">El pago se completa de forma segura en Shopify.</p>
  </div>
</aside>`;
}

function footer() {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <img class="footer-logo" src="/img/banny-logo-cream.png" alt="Banny">
      <p class="footer-tag">${escapeHtml(SITE.tagline)}</p>
    </div>
    <div class="footer-meta">
      <p>Banny &middot; Una marca de Kairos</p>
      <p>Beber con moderacion. Venta exclusiva a mayores de 18 años.</p>
      <p>&copy; ${year} Banny by Kairos. Todos los derechos reservados.</p>
    </div>
  </div>
</footer>`;
}

function productCard(p) {
  const priceBlock = p.compareAtPrice
    ? `<span class="price-sale">${p.price}</span> <span class="price-compare">${p.compareAtPrice}</span>`
    : `<span class="price">${p.priceFrom ? 'Desde ' : ''}${p.price || ''}</span>`;
  const badge = p.onSale ? '<span class="badge badge-sale">Oferta</span>' : '';
  const sold = !p.available ? '<span class="badge badge-out">Agotado</span>' : '';
  const catLabel = (CATEGORIES.find((c) => c.key === p.category) || CATEGORY_FALLBACK).label;
  return `<article class="card cat-${p.category}">
  <a class="card-media" href="/products/${encodeURIComponent(p.handle)}">
    ${badge}${sold}
    ${p.image ? `<img loading="lazy" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}">` : '<div class="card-noimg">Banny</div>'}
  </a>
  <div class="card-body">
    <span class="card-cat">${escapeHtml(catLabel)}</span>
    <a class="card-title" href="/products/${encodeURIComponent(p.handle)}">${escapeHtml(p.title)}</a>
    <div class="card-price">${priceBlock}</div>
    <div class="card-actions">
      <button class="btn btn-ghost btn-add" data-variant="${p.defaultVariantId || ''}" data-title="${escapeHtml(p.title)}" data-price-raw="${rawPriceFromVariant(p)}" data-img="${escapeHtml(p.image || '')}" data-handle="${escapeHtml(p.handle)}" ${p.available && p.defaultVariantId ? '' : 'disabled'}>
        Agregar
      </button>
      <a class="btn btn-primary" href="/products/${encodeURIComponent(p.handle)}">Ver</a>
    </div>
  </div>
</article>`;
}

function rawPriceFromVariant(p) {
  // Para el carrito client-side necesitamos un numero. Reusamos el precio
  // formateado quitando todo lo no numerico.
  if (!p.price) return 0;
  return Number(String(p.price).replace(/[^0-9]/g, '')) || 0;
}

// ---------------------------------------------------------------------------
// Paginas (server-rendered para URLs compartibles / ads)
// ---------------------------------------------------------------------------
function renderProduct(p, data) {
  const related = data.products
    .filter((x) => x.category === p.category && x.handle !== p.handle)
    .slice(0, 4);

  const gallery = (p.images.length ? p.images : p.image ? [{ src: p.image, alt: p.title }] : [])
    .map(
      (img, i) =>
        `<button class="thumb${i === 0 ? ' is-active' : ''}" data-src="${escapeHtml(img.src)}"><img loading="lazy" src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt)}"></button>`
    )
    .join('');

  const priceBlock = p.compareAtPrice
    ? `<span class="pdp-price-sale">${p.price}</span> <span class="pdp-price-compare">${p.compareAtPrice}</span> <span class="badge badge-sale">Oferta</span>`
    : `<span class="pdp-price">${p.price || 'Consultar'}</span>`;

  const stock = p.available
    ? '<span class="stock in">En stock</span>'
    : '<span class="stock out">Agotado</span>';

  const body = `
<main class="container pdp">
  <a class="back" href="/#catalogo">&larr; Volver al catalogo</a>
  <div class="pdp-grid">
    <div class="pdp-media">
      <div class="pdp-main">
        ${p.image ? `<img id="pdpMainImg" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}">` : '<div class="card-noimg big">Banny</div>'}
      </div>
      ${p.images.length > 1 ? `<div class="pdp-thumbs">${gallery}</div>` : ''}
    </div>
    <div class="pdp-info">
      <p class="eyebrow">${escapeHtml(CATEGORIES.find((c) => c.key === p.category)?.label || p.productType || 'Banny')}</p>
      <h1>${escapeHtml(p.title)}</h1>
      <div class="pdp-price-row">${priceBlock}</div>
      <div class="pdp-stock">${stock}</div>
      <div class="pdp-actions">
        <button class="btn btn-ghost btn-lg btn-add" data-variant="${p.defaultVariantId || ''}" data-title="${escapeHtml(p.title)}" data-price-raw="${rawPriceFromVariant(p)}" data-img="${escapeHtml(p.image || '')}" data-handle="${escapeHtml(p.handle)}" ${p.available && p.defaultVariantId ? '' : 'disabled'}>Agregar al carrito</button>
        <button class="btn btn-primary btn-lg btn-buynow" data-variant="${p.defaultVariantId || ''}" ${p.available && p.defaultVariantId ? '' : 'disabled'}>Comprar ahora</button>
      </div>
      <div class="pdp-desc">${p.descriptionHtml || '<p>Destilado craft Banny, nacido en la barra de Kairos.</p>'}</div>
      <p class="pdp-legal">Producto apto solo para mayores de 18 años. Beber con moderacion. Una marca de Kairos.</p>
    </div>
  </div>
  ${
    related.length
      ? `<section class="block">
          <div class="block-head"><h2>Tambien de ${escapeHtml(CATEGORIES.find((c) => c.key === p.category)?.label || 'Banny')}</h2></div>
          <div class="grid">${related.map(productCard).join('')}</div>
        </section>`
      : ''
  }
</main>`;

  return layout({
    title: `${p.title} - ${SITE.name}`,
    description: stripHtml(p.descriptionHtml).slice(0, 160) || SITE.description,
    ogImage: p.image,
    bodyHtml: body,
    canonical: `/products/${encodeURIComponent(p.handle)}`
  });
}

function renderContentPage(pg) {
  const body = `
<main class="container content-page">
  <a class="back" href="/">&larr; Inicio</a>
  <article class="prose">
    <h1>${escapeHtml(pg.title)}</h1>
    ${pg.body_html || ''}
  </article>
</main>`;
  return layout({
    title: `${pg.title} - ${SITE.name}`,
    description: stripHtml(pg.body_html).slice(0, 160) || SITE.description,
    bodyHtml: body,
    canonical: `/pages/${encodeURIComponent(pg.handle)}`
  });
}

function renderNotFound() {
  const body = `
<main class="container notfound">
  <h1>404</h1>
  <p>No encontramos lo que buscas.</p>
  <a class="btn btn-primary" href="/">Volver al inicio</a>
</main>`;
  return layout({ title: `No encontrado - ${SITE.name}`, bodyHtml: body });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

// Estaticos (css, js, public/index.html para la home liviana)
app.use(express.static(path.join(__dirname, 'public')));

// API JSON del catalogo: la home (index.html) lo consume client-side
app.get('/api/products', async (req, res) => {
  const data = await getData();
  const groups = groupByCategory(data.products);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    vendor: VENDOR,
    count: data.products.length,
    error: data.error,
    categories: groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items
    })),
    products: data.products
  });
});

// Diagnostico: confirma config + cuantos productos de Banny hay (sin secretos)
app.get('/api/_diag', async (req, res) => {
  const data = await getData(req.query.refresh === '1');
  const groups = groupByCategory(data.products);
  res.json({
    ok: !data.error && data.products.length > 0,
    vendor: VENDOR,
    shopConfigured: !configError(),
    shopDomain: SHOP_DOMAIN || null,
    apiVersion: API_VERSION,
    error: data.error,
    totalProducts: data.products.length,
    excludeKeywords: EXCLUDE_KEYWORDS,
    byCategory: groups.map((g) => ({ category: g.key, label: g.label, count: g.items.length })),
    sampleHandles: data.products.slice(0, 10).map((p) => p.handle),
    pages: (data.pages || []).map((pg) => pg.handle),
    cartPermalinkFormat: `https://${SHOP_DOMAIN || '{store}'}/cart/{variantId}:{qty}`
  });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Paginas de producto: URL IDENTICA a Shopify -> /products/{handle}
app.get('/products/:handle', async (req, res) => {
  const data = await getData();
  const product = data.products.find((p) => p.handle === req.params.handle);
  if (!product) {
    res.status(404).send(renderNotFound());
    return;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderProduct(product, data));
});

// Paginas de contenido: /pages/{handle} identico a Shopify
app.get('/pages/:handle', async (req, res) => {
  const data = await getData();
  const pg = (data.pages || []).find((x) => x.handle === req.params.handle);
  if (!pg) {
    res.status(404).send(renderNotFound());
    return;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderContentPage(pg));
});

// Checkout: redirige al carrito de Shopify con permalink (igual que Kairos)
// /checkout?items=variantId:qty,variantId:qty
app.get('/checkout', (req, res) => {
  const items = String(req.query.items || '').trim();
  if (!SHOP_DOMAIN || !/^\d+:\d+(,\d+:\d+)*$/.test(items)) {
    res.redirect('/#catalogo');
    return;
  }
  res.redirect(`https://${SHOP_DOMAIN}/cart/${items}`);
});

// 404
app.use((req, res) => {
  res.status(404).send(renderNotFound());
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  const cfg = configError();
  console.log(`[Banny] escuchando en puerto ${PORT}`);
  console.log(`[Banny] vendor filtrado: "${VENDOR}"`);
  if (cfg) {
    console.warn(`[Banny] ATENCION: ${cfg}. El catalogo saldra vacio hasta setear las env vars.`);
  } else {
    console.log(`[Banny] Shopify: ${SHOP_DOMAIN} (API ${API_VERSION})`);
    // Precarga (no bloquea el arranque)
    getData(true)
      .then((d) =>
        console.log(
          d.error
            ? `[Banny] error cargando productos: ${d.error}`
            : `[Banny] productos de Banny cargados: ${d.products.length}`
        )
      )
      .catch((e) => console.error('[Banny] precarga fallo:', e.message));
  }
});

module.exports = app;
