# Banny

Web de **Banny** — destilados craft premium del **Grupo Kairos** (gin, ron, whisky, vermut y RTD).
_craft to be wild._

Misma arquitectura que la web de Kairos Brewing: backend Express liviano que lee los
productos del **Shopify central** (`kairos-brewing.myshopify.com`) vía Admin API,
**filtrando solo los productos con `vendor = "Banny"`**, y manda el checkout al
carrito de Shopify mediante permalink. Nada de productos hardcodeados.

## Arquitectura

- **Backend:** Express (Node 18+). Sin base de datos.
- **Fuente de datos:** Shopify Admin API, filtro `vendor=Banny`. Cache en memoria (5 min).
- **Home (`/`):** `public/index.html` liviano; el catálogo se renderiza en el cliente
  consumiendo `/api/products`.
- **Páginas de producto (`/products/{handle}`):** server-rendered, con el **mismo handle
  de Shopify** y meta/OG tags, para no romper ads ni links que ya circulan.
- **Páginas de contenido (`/pages/{handle}`):** server-rendered desde las Pages de Shopify.
- **Checkout:** permalink de Shopify `https://{store}/cart/{variantId}:{qty},...`
  (ruta interna `/checkout?items=...` que redirige).

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | sí | — | `kairos-brewing.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | sí | — | Token Admin API (secreto, **solo env var**) |
| `SHOPIFY_API_VERSION` | no | `2024-10` | Versión del Admin API |
| `VENDOR` | no | `Banny` | Vendor a filtrar |
| `EXCLUDE_KEYWORDS` | no | `bidon` | Palabras (coma-separadas) para excluir del catálogo, ej. bidones a granel de 20 L |
| `PORT` | no | `3000` | Lo inyecta Railway |

El token **nunca** va en el código ni en el repo. Ver `.env.example`.

## Correr local

```bash
npm install
export SHOPIFY_STORE_DOMAIN=kairos-brewing.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_xxx
npm start
# http://localhost:3000
```

## Verificar Shopify (Paso 0)

Cuenta cuántos productos de Banny hay sin levantar la web:

```bash
npm run verify
```

O con la app corriendo, el endpoint de diagnóstico (sin secretos):

```
GET /api/_diag
```

Devuelve: total de productos Banny, conteo por categoría, handles de ejemplo y el
formato del permalink de carrito.

## Endpoints

| Ruta | Descripción |
|---|---|
| `GET /` | Home (catálogo en vivo) |
| `GET /products/{handle}` | Página de producto (URL idéntica a Shopify) |
| `GET /pages/{handle}` | Página de contenido de Shopify |
| `GET /api/products` | Catálogo JSON (vendor Banny) |
| `GET /api/_diag` | Diagnóstico de config + conteo |
| `GET /checkout?items=variantId:qty,...` | Redirige al carrito de Shopify |
| `GET /healthz` | Health check |

## Deploy en Railway

1. Conectar el repo.
2. Setear `SHOPIFY_STORE_DOMAIN` y `SHOPIFY_ADMIN_TOKEN` (Railway inyecta `PORT`).
3. Start command: `npm start` (o lo toma de `package.json`).

## Categorías

Se infieren desde `product_type` / `tags` de Shopify: **Gin, Ron, Whisky, Vermut, RTD**
(y "Otros" como fallback). No hay que tocar código al sumar productos.

## Identidad de marca

Basada en el manual de marca de Banny (deck oficial):

- **Logo:** wordmark manuscrito "BANNY" (`public/img/banny-logo.png` y versión crema
  para fondos oscuros). Extraído del manual.
- **Paleta:** `#77CBBF` turquesa · `#fff3e8` crema · `#94c46b` verde · `#7da6d8` azul ·
  `#EEAB37` mostaza · `#0b0f33` navy (bandas/footer).
- **Tipografía:** Montserrat (400–900).
- **Tagline:** _Craft to be wild_. Banny es la línea de destilados y RTD de **Kairos**,
  donde la experiencia en barra se transforma en producto.
- Cada categoría tiene color de acento propio (chips, secciones y tarjetas).

---

Beber con moderación. Venta exclusiva a mayores de 18 años.
