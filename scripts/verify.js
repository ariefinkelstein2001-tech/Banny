'use strict';

/**
 * Verificacion PASO 0: se conecta al Shopify central, filtra por
 * vendor = "Banny" via Admin API y reporta cuantos productos hay.
 *
 * Uso (con las env vars seteadas, p.ej. en Railway o local con .env):
 *   node scripts/verify.js
 *
 * NO imprime el token. Solo cuenta y muestra handles/categorias.
 */

const SHOP_DOMAIN = (process.env.SHOPIFY_STORE_DOMAIN || '').trim();
const ADMIN_TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || '').trim();
const API_VERSION = (process.env.SHOPIFY_API_VERSION || '2024-10').trim();
const VENDOR = (process.env.VENDOR || 'Banny').trim();

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  if (!SHOP_DOMAIN || !ADMIN_TOKEN) {
    console.error('ERROR: faltan SHOPIFY_STORE_DOMAIN y/o SHOPIFY_ADMIN_TOKEN.');
    process.exit(1);
  }

  let url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/products.json?status=active&limit=250&vendor=${encodeURIComponent(VENDOR)}`;
  const products = [];
  let guard = 0;

  while (url && guard < 20) {
    guard += 1;
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        Accept: 'application/json'
      }
    });
    if (!res.ok) {
      console.error(`ERROR Shopify ${res.status} ${res.statusText}`);
      console.error((await res.text()).slice(0, 300));
      process.exit(1);
    }
    const data = await res.json();
    if (Array.isArray(data.products)) products.push(...data.products);
    url = nextPageUrl(res.headers.get('link'));
  }

  const banny = products.filter(
    (p) => (p.vendor || '').trim().toLowerCase() === VENDOR.toLowerCase()
  );

  console.log('================ VERIFICACION BANNY ================');
  console.log(`Tienda:        ${SHOP_DOMAIN} (API ${API_VERSION})`);
  console.log(`Vendor filtro: "${VENDOR}"`);
  console.log(`Productos con vendor exacto "${VENDOR}": ${banny.length}`);
  console.log('---------------------------------------------------');

  const byType = {};
  banny.forEach((p) => {
    const t = p.product_type || '(sin tipo)';
    byType[t] = (byType[t] || 0) + 1;
  });
  console.log('Por product_type:');
  Object.entries(byType).forEach(([k, v]) => console.log(`  - ${k}: ${v}`));

  console.log('---------------------------------------------------');
  console.log('Handles (URL = /products/{handle}):');
  banny.slice(0, 30).forEach((p) => {
    const v = (p.variants && p.variants[0]) || {};
    console.log(`  - /products/${p.handle}  | ${p.title}  | $${v.price || '?'}  | variant ${v.id || '?'}`);
  });

  if (banny.length === 0) {
    console.log('\nATENCION: no se encontraron productos con vendor "Banny".');
    console.log('La pagina saldria vacia. Revisa el vendor en Shopify.');
    process.exit(2);
  }
  console.log('\nOK: hay productos de Banny. La web los mostrara.');
}

main().catch((e) => {
  console.error('Fallo inesperado:', e.message);
  process.exit(1);
});
