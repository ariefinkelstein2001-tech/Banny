/* ============================================================
   BANNY - frontend
   - Carga catalogo desde /api/products (solo en la home)
   - Carrito con localStorage
   - Checkout via permalink de Shopify: /cart/{variantId}:{qty},...
   - Galeria en la pagina de producto
   ============================================================ */
(function () {
  'use strict';

  var CART_KEY = 'banny_cart_v1';

  // ---------- utilidades ----------
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function clp(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('es-CL'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- carrito ----------
  function loadCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveCart(cart) { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }

  function cartCount(cart) {
    return cart.reduce(function (s, i) { return s + i.qty; }, 0);
  }
  function cartTotal(cart) {
    return cart.reduce(function (s, i) { return s + i.qty * i.price; }, 0);
  }

  function addToCart(item) {
    if (!item.variant) return;
    var cart = loadCart();
    var found = cart.find(function (i) { return i.variant === item.variant; });
    if (found) found.qty += 1;
    else cart.push({ variant: item.variant, title: item.title, price: item.price, img: item.img, handle: item.handle, qty: 1 });
    saveCart(cart);
    renderCart();
    updateCount();
    toast('Agregado al carrito');
  }
  function setQty(variant, delta) {
    var cart = loadCart();
    var item = cart.find(function (i) { return i.variant === variant; });
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) cart = cart.filter(function (i) { return i.variant !== variant; });
    saveCart(cart);
    renderCart();
    updateCount();
  }
  function removeItem(variant) {
    saveCart(loadCart().filter(function (i) { return i.variant !== variant; }));
    renderCart();
    updateCount();
  }

  function updateCount() {
    var el = $('#cartCount');
    if (el) el.textContent = cartCount(loadCart());
  }

  function renderCart() {
    var wrap = $('#cartItems');
    if (!wrap) return;
    var cart = loadCart();
    if (!cart.length) {
      wrap.innerHTML = '<div class="cart-empty">Tu carrito esta vacio.<br>Suma algo con caracter.</div>';
    } else {
      wrap.innerHTML = cart.map(function (i) {
        return '<div class="cart-row">' +
          (i.img ? '<img src="' + esc(i.img) + '" alt="' + esc(i.title) + '">' : '<img alt="">') +
          '<div class="cart-row-info">' +
            '<div class="cart-row-title">' + esc(i.title) + '</div>' +
            '<div class="cart-row-price">' + clp(i.price) + '</div>' +
            '<div class="qty">' +
              '<button data-dec="' + i.variant + '" aria-label="Quitar uno">-</button>' +
              '<span>' + i.qty + '</span>' +
              '<button data-inc="' + i.variant + '" aria-label="Sumar uno">+</button>' +
            '</div>' +
          '</div>' +
          '<button class="cart-remove" data-rm="' + i.variant + '">Eliminar</button>' +
        '</div>';
      }).join('');
    }
    var totalEl = $('#cartTotal');
    if (totalEl) totalEl.textContent = clp(cartTotal(cart));
    var checkoutBtn = $('#checkoutBtn');
    if (checkoutBtn) checkoutBtn.disabled = cart.length === 0;
  }

  function checkout() {
    var cart = loadCart();
    if (!cart.length) return;
    var items = cart.map(function (i) { return i.variant + ':' + i.qty; }).join(',');
    // El server arma el permalink al carrito de Shopify y redirige.
    window.location.href = '/checkout?items=' + encodeURIComponent(items);
  }

  // ---------- drawer ----------
  function openCart() {
    var d = $('#cartDrawer'), o = $('#cartOverlay');
    if (d) { d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); }
    if (o) o.classList.add('open');
  }
  function closeCart() {
    var d = $('#cartDrawer'), o = $('#cartOverlay');
    if (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
    if (o) o.classList.remove('open');
  }

  // ---------- toast ----------
  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  // ---------- tarjeta de producto (home, client-side) ----------
  function cardHtml(p) {
    var priceBlock = p.compareAtPrice
      ? '<span class="price-sale">' + esc(p.price) + '</span> <span class="price-compare">' + esc(p.compareAtPrice) + '</span>'
      : '<span class="price">' + (p.priceFrom ? 'Desde ' : '') + esc(p.price || '') + '</span>';
    var badge = p.onSale ? '<span class="badge badge-sale">Oferta</span>' : '';
    var out = !p.available ? '<span class="badge badge-out">Agotado</span>' : '';
    var priceRaw = Number(String(p.price || '').replace(/[^0-9]/g, '')) || 0;
    var disabled = (p.available && p.defaultVariantId) ? '' : 'disabled';
    return '<article class="card">' +
      '<a class="card-media" href="/products/' + encodeURIComponent(p.handle) + '">' + badge + out +
        (p.image ? '<img loading="lazy" src="' + esc(p.image) + '" alt="' + esc(p.title) + '">' : '<div class="card-noimg">Banny</div>') +
      '</a>' +
      '<div class="card-body">' +
        '<a class="card-title" href="/products/' + encodeURIComponent(p.handle) + '">' + esc(p.title) + '</a>' +
        '<div class="card-price">' + priceBlock + '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-ghost btn-add" data-variant="' + (p.defaultVariantId || '') + '" data-title="' + esc(p.title) + '" data-price-raw="' + priceRaw + '" data-img="' + esc(p.image || '') + '" data-handle="' + esc(p.handle) + '" ' + disabled + '>Agregar</button>' +
          '<a class="btn btn-primary" href="/products/' + encodeURIComponent(p.handle) + '">Ver</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderCatalog(data) {
    var wrap = $('#catalog');
    if (!wrap) return;
    var countEl = $('#catalogCount');
    var chips = $('#categorias');

    if (data.error) {
      wrap.innerHTML = '<div class="notice notice-error"><strong>No pudimos cargar el catalogo desde Shopify.</strong>' +
        '<p>Revisa las env vars en Railway (SHOPIFY_STORE_DOMAIN y SHOPIFY_ADMIN_TOKEN). Detalle: ' + esc(data.error) + '</p></div>';
      return;
    }
    if (!data.count) {
      wrap.innerHTML = '<div class="notice"><strong>No hay productos con vendor "' + esc(data.vendor) + '" todavia.</strong>' +
        '<p>En cuanto se publiquen en el Shopify central apareceran aca automaticamente.</p></div>';
      return;
    }

    if (countEl) countEl.textContent = data.count + (data.count === 1 ? ' destilado disponible' : ' destilados disponibles');
    if (chips) {
      chips.innerHTML = data.categories.map(function (g) {
        return '<a class="chip" href="#cat-' + g.key + '">' + esc(g.label) + ' <span>' + g.items.length + '</span></a>';
      }).join('');
    }

    wrap.innerHTML = data.categories.map(function (g) {
      return '<section class="cat-section" id="cat-' + g.key + '">' +
        '<div class="cat-head"><h3>' + esc(g.label) + '</h3>' +
        '<span class="cat-count">' + g.items.length + (g.items.length === 1 ? ' producto' : ' productos') + '</span></div>' +
        '<div class="grid">' + g.items.map(cardHtml).join('') + '</div>' +
      '</section>';
    }).join('');
  }

  function loadCatalog() {
    var wrap = $('#catalog');
    if (!wrap) return; // no estamos en la home
    fetch('/api/products')
      .then(function (r) { return r.json(); })
      .then(renderCatalog)
      .catch(function () {
        wrap.innerHTML = '<div class="notice notice-error"><strong>No pudimos cargar el catalogo.</strong><p>Reintenta en unos segundos.</p></div>';
      });
  }

  // ---------- galeria PDP ----------
  function initGallery() {
    var thumbs = $all('.thumb');
    var main = $('#pdpMainImg');
    if (!thumbs.length || !main) return;
    thumbs.forEach(function (t) {
      t.addEventListener('click', function () {
        main.src = t.getAttribute('data-src');
        thumbs.forEach(function (x) { x.classList.remove('is-active'); });
        t.classList.add('is-active');
      });
    });
  }

  // ---------- delegacion de eventos ----------
  function bind() {
    document.addEventListener('click', function (e) {
      var add = e.target.closest('.btn-add');
      if (add && !add.disabled) {
        addToCart({
          variant: add.getAttribute('data-variant'),
          title: add.getAttribute('data-title'),
          price: Number(add.getAttribute('data-price-raw')) || 0,
          img: add.getAttribute('data-img'),
          handle: add.getAttribute('data-handle')
        });
        openCart();
        return;
      }
      var buy = e.target.closest('.btn-buynow');
      if (buy && !buy.disabled) {
        var v = buy.getAttribute('data-variant');
        if (v) window.location.href = '/checkout?items=' + encodeURIComponent(v + ':1');
        return;
      }
      var dec = e.target.closest('[data-dec]');
      if (dec) { setQty(dec.getAttribute('data-dec'), -1); return; }
      var inc = e.target.closest('[data-inc]');
      if (inc) { setQty(inc.getAttribute('data-inc'), 1); return; }
      var rm = e.target.closest('[data-rm]');
      if (rm) { removeItem(rm.getAttribute('data-rm')); return; }
    });

    var cartBtn = $('#cartBtn'); if (cartBtn) cartBtn.addEventListener('click', openCart);
    var cartClose = $('#cartClose'); if (cartClose) cartClose.addEventListener('click', closeCart);
    var overlay = $('#cartOverlay'); if (overlay) overlay.addEventListener('click', closeCart);
    var checkoutBtn = $('#checkoutBtn'); if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);

    var year = $('#year'); if (year) year.textContent = new Date().getFullYear();
  }

  // ---------- init ----------
  document.addEventListener('DOMContentLoaded', function () {
    bind();
    renderCart();
    updateCount();
    loadCatalog();
    initGallery();
  });
})();
