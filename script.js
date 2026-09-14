/* ระบบ POS ร้านค้า — เชื่อมต่อ Google Apps Script ผ่าน api.js */

var VAT_RATE = 0.07;   /* ราคาเมนูรวมภาษีแล้ว จึงถอด VAT ออกจากยอด ไม่ใช่บวกเพิ่ม */

/* ---------- ยูทิลิตี้ ---------- */
function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function baht(n, digits) {
  var v = Number(n || 0);
  /* ราคาที่มีเศษสตางค์ต้องเห็นทศนิยม ไม่งั้น 80.50 จะถูกปัดเป็น 81 */
  var d = digits == null ? (v % 1 === 0 ? 0 : 2) : digits;
  return '฿' + v.toLocaleString('th-TH', {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });
}

var toastTimer = null;
function toast(msg, kind) {
  var el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

document.querySelectorAll('[data-close]').forEach(function (b) {
  b.addEventListener('click', function () { closeModal(b.dataset.close); });
});
document.querySelectorAll('.scrim').forEach(function (s) {
  s.addEventListener('click', function (e) { if (e.target === s) s.classList.remove('open'); });
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.scrim.open').forEach(function (s) { s.classList.remove('open'); });
  setNav(false);
});

/* ---------- ลิ้นชักเมนูบนจอแคบ ---------- */
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  $('nav-toggle').setAttribute('aria-expanded', String(open));
}
$('nav-toggle').addEventListener('click', function () {
  setNav(!document.body.classList.contains('nav-open'));
});
$('nav-scrim').addEventListener('click', function () { setNav(false); });

/* addEventListener บน MediaQueryList เพิ่งรองรับใน Safari 14 เครื่องเก่าที่ใช้เป็นแคชเชียร์
   จะโยน TypeError ตรงนี้แล้วสคริปต์ทั้งไฟล์หยุดทำงาน — ปุ่มเข้าสู่ระบบจะกดไม่ได้เลย */
var WIDE = matchMedia('(min-width: 901px)');
var onWide = function (e) { if (e.matches) setNav(false); };
if (WIDE.addEventListener) WIDE.addEventListener('change', onWide);
else if (WIDE.addListener) WIDE.addListener(onWide);

/* ---------- สถานะของแอป ---------- */
var HAS_BACKEND = API.isReady();
var ME = null;
var MENU = [];
var ORDERS = [];
var CART = [];
var CATEGORY = 'all';
var PAYMENT = 'เงินสด';
var PENDING_IMAGE = null;   /* รูปที่เพิ่งเลือกแต่ยังไม่ได้บันทึก */
var CLEAR_IMAGE = false;    /* กดเอารูปเดิมออกโดยไม่ได้เลือกรูปใหม่ */
var LOADING_MENU = false;
var LOADING_ORDERS = false;
var ORDERS_DATE = '';       /* วันที่ของบิลที่กำลังดูอยู่ รูปแบบ yyyy-MM-dd */

var TAB = 'pos';
var TAB_TITLE = { pos: 'ขายหน้าร้าน', orders: 'ประวัติการขาย', menu: 'เมนูและราคา' };
var SEARCH_HINT = { orders: 'ค้นหาเลขที่บิล / โต๊ะ', menu: 'ค้นหาชื่อเมนู / หมวดหมู่' };

var NO_PIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L5 20"/></svg>';

function spinnerBox(text) {
  return '<div class="loading"><span class="spinner"></span>' + esc(text) + '</div>';
}

/* ---------- วันที่ (รูปแบบ yyyy-MM-dd แบบเวลาท้องถิ่น ห้ามใช้ toISOString เพราะเป็น UTC) ---------- */
function ymd(d) {
  return d.getFullYear()
    + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
    + '-' + ('0' + d.getDate()).slice(-2);
}

function parseYmd(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function shiftYmd(s, days) {
  var d = parseYmd(s);
  /* ยังไม่เคยโหลดบิลเลย ORDERS_DATE จะเป็นค่าว่างแล้วได้ 'NaN-aN-aN' ออกมา */
  if (isNaN(d.getTime())) d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}

/* บิลถูกกรองมาทีละวันอยู่แล้ว คอลัมน์เวลาจึงไม่ต้องซ้ำวันที่ให้กินความกว้าง */
function clockOf(s) {
  var m = /(\d{1,2}:\d{2})/.exec(String(s == null ? '' : s));
  return m ? m[1] : String(s == null ? '' : s);
}

function thaiDate(s) {
  return parseYmd(s).toLocaleDateString('th-TH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

// ขอรูปขนาด w400 จาก Drive แทนไฟล์เต็ม รูปเมนูในตารางกว้างไม่ถึง 400px อยู่แล้ว
function imgUrl(fileId) {
  return fileId ? 'https://lh3.googleusercontent.com/d/' + fileId + '=w400' : '';
}

/* referrerpolicy สำคัญมาก: ถ้าเบราว์เซอร์ส่ง Referer ไป lh3.googleusercontent.com
   Google จะตอบ 429 text/html แทบทุกครั้ง แล้วโดน ORB บล็อก รูปจะไม่ขึ้นเลย */
function picTag(src, alt, fileId) {
  if (!src) return NO_PIC;
  return '<img src="' + esc(src) + '" alt="' + esc(alt || '') + '" loading="lazy" referrerpolicy="no-referrer"'
    + (fileId ? ' data-drive-id="' + esc(fileId) + '"' : '') + '>';
}

/* รูปที่โหลดไม่ผ่านจริง ๆ ให้ลองอีกทางหนึ่ง แล้วถ้ายังไม่ได้ค่อยวางไอคอนแทน
   จะได้ไม่เหลือไอคอนรูปแตกค้างอยู่ในการ์ด/ตาราง */
document.addEventListener('error', function (e) {
  var el = e.target;
  if (!el || el.tagName !== 'IMG') return;
  var id = el.dataset.driveId;
  if (!id) return;

  var step = Number(el.dataset.picStep || 0);
  el.dataset.picStep = step + 1;

  if (step === 0) {
    el.src = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w400';
  } else if (step === 1) {
    /* 429 เป็นการจำกัดชั่วคราว รอสักครู่แล้วขอใหม่พร้อม cache-buster มักได้รูปกลับมา */
    setTimeout(function () {
      el.src = imgUrl(id) + '?r=' + Date.now();
    }, 1200);
  } else if (el.parentNode) {
    el.parentNode.innerHTML = NO_PIC;
  }
}, true);

/* ---------- เข้าสู่ระบบ / ออกจากระบบ ---------- */
var SESSION_KEY = 'pos.session';

function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(ME)); } catch (e) { }
}

function loadSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    var s = raw ? JSON.parse(raw) : null;
    return s && s.username ? s : null;
  } catch (e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { }
}

$('login-password-toggle').addEventListener('click', function () {
  var input = $('login-password');
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  this.setAttribute('aria-pressed', show ? 'true' : 'false');
  this.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
  input.focus();
});

/* เซิร์ฟเวอร์ตอบช้าเป็นวินาที ถ้าปุ่มแค่กดไม่ได้เฉย ๆ ผู้ใช้จะไม่รู้ว่ากดติดแล้วหรือยัง */
function setLoginBusy(busy) {
  var btn = $('login-btn');
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  btn.innerHTML = busy
    ? '<span class="spinner spinner-sm"></span>กำลังเข้าสู่ระบบ…'
    : 'เข้าสู่ระบบ';
}

$('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var err = $('login-error');
  err.textContent = '';

  if (!HAS_BACKEND) {
    err.textContent = 'ยังไม่ได้ตั้งค่า API_URL ใน api.js — ใส่ URL ของ Web App ก่อนถึงจะเข้าระบบได้';
    return;
  }

  setLoginBusy(true);
  API.checkLogin($('login-username').value.trim(), $('login-password').value)
    .then(function (res) {
      setLoginBusy(false);
      if (!res || !res.success) {
        err.textContent = (res && res.message) || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
        return;
      }
      ME = { username: res.username, role: res.role };
      saveSession();
      enterApp();
    })
    .catch(function (e2) {
      setLoginBusy(false);
      err.textContent = 'ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ: ' + (e2 && e2.message ? e2.message : e2);
    });
});

function enterApp(silent) {
  document.body.classList.remove('guest');
  $('me-name').textContent = ME.username;
  $('me-role').textContent = String(ME.role || '').toLowerCase() === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน';
  $('me-initial').textContent = String(ME.username || '?').charAt(0);

  $('login-form').reset();
  $('login-error').textContent = '';

  if (!silent) toast('เข้าสู่ระบบสำเร็จ (' + ME.username + ')');

  /* ล็อกอินเสร็จต้องได้ขายทันที บิลย้อนหลังรอไว้โหลดตอนเปิดแท็บประวัติค่อยยิง
     จะได้ไม่ต้องรอ Apps Script อีกรอบทั้งที่ยังไม่มีใครดู */
  loadMenu();
}

$('logout-btn').addEventListener('click', function () {
  clearSession();
  ME = null;
  CART = [];
  MENU = [];
  ORDERS = [];
  ORDERS_DATE = '';
  CATEGORY = 'all';
  /* เครื่องเดียวใช้หลายคน ค่าที่ค้างอยู่ต้องไม่ตกไปถึงคนถัดไป */
  setPayment('เงินสด');
  $('table-no').value = '';
  document.body.classList.add('guest');
  showTab('pos');
  renderCats();
  renderBill();
  renderGrid();
});

/* ---------- สลับหน้า ---------- */
function showTab(tab) {
  TAB = tab;
  document.querySelectorAll('.side-nav button').forEach(function (b) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  ['pos', 'orders', 'menu'].forEach(function (t) {
    $('view-' + t).hidden = t !== tab;
  });

  /* แผงบิลมีไว้ใช้ตอนขายเท่านั้น หน้าอื่นคืนที่ให้ตาราง */
  document.body.classList.toggle('no-bill', tab !== 'pos');

  $('cats').hidden = tab !== 'pos';
  $('bar-tools').hidden = tab === 'pos';
  $('page-title').textContent = TAB_TITLE[tab];
  $('add-menu-btn').hidden = tab !== 'menu';

  if (tab !== 'pos') {
    $('admin-search').placeholder = SEARCH_HINT[tab];
    $('admin-search').value = '';
    /* ORDERS_DATE ว่างแปลว่ายังไม่เคยโหลดบิลเลยตั้งแต่ล็อกอิน เปิดแท็บครั้งแรกจึงค่อยยิง */
    if (tab === 'orders') {
      if (ORDERS_DATE) renderOrders();
      else loadOrders(ymd(new Date()));
    }
    else renderMenuTable();
  }
}

document.querySelectorAll('.side-nav button').forEach(function (b) {
  b.addEventListener('click', function () {
    showTab(b.dataset.tab);
    setNav(false);
  });
});

/* ---------- โหลดข้อมูล ---------- */
function onError(err) {
  console.error(err);
  toast('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ: ' + (err && err.message ? err.message : err), 'err');
}

var MENU_CACHE_KEY = 'pos.menu';

function saveMenuCache() {
  try { localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(MENU)); } catch (e) { }
}

function loadMenuCache() {
  try {
    var raw = localStorage.getItem(MENU_CACHE_KEY);
    var list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function loadMenu() {
  if (!HAS_BACKEND) return Promise.resolve();

  /* วาดเมนูของรอบก่อนออกมาก่อนเลย แล้วค่อยทับด้วยของจริงเมื่อโหลดเสร็จ — ไม่ต้องนั่งดูสปินเนอร์ */
  if (!MENU.length) {
    MENU = loadMenuCache();
    renderCats();
    renderCatOptions();
  }

  LOADING_MENU = true;
  renderGrid();
  renderMenuTable();

  return API.getAllMenuForAdmin()
    .then(function (data) {
      MENU = (data || []).map(function (it) {
        return {
          id: it.id,
          name: it.name,
          category: it.category,
          price: Number(it.price) || 0,
          active: !!it.active,
          driveId: it.driveId || '',
          fileId: it.fileId || '',
          image: imgUrl(it.fileId)
        };
      });
      saveMenuCache();
    })
    .catch(onError)
    .finally(function () {
      LOADING_MENU = false;
      renderCats();
      renderGrid();
      renderMenuTable();
      renderCatOptions();
    });
}

function loadOrders(date) {
  if (!HAS_BACKEND) return Promise.resolve();
  var next = date || ORDERS_DATE || ymd(new Date());
  /* เปลี่ยนวันแล้วต้องล้างของเดิม ไม่งั้นยอดสรุปยังเป็นของวันก่อนระหว่างรอโหลด */
  if (next !== ORDERS_DATE) ORDERS = [];
  ORDERS_DATE = next;
  $('day-date').value = ORDERS_DATE;
  LOADING_ORDERS = true;
  renderOrders();

  /* กดเปลี่ยนวันรัว ๆ ผลลัพธ์ของวันเก่าอาจกลับมาทีหลัง จึงต้องทิ้งถ้าไม่ใช่วันที่ดูอยู่ */
  var want = ORDERS_DATE;
  return API.getOrdersByDate(ORDERS_DATE)
    .then(function (data) {
      if (want !== ORDERS_DATE) return;
      ORDERS = (data && data.orders) || [];
    })
    .catch(function (e) { if (want === ORDERS_DATE) onError(e); })
    .finally(function () {
      if (want !== ORDERS_DATE) return;
      LOADING_ORDERS = false;
      renderOrders();
    });
}

/* ---------- หน้าขาย ---------- */
function renderCats() {
  var cats = [];
  MENU.forEach(function (m) {
    if (m.active && m.category && cats.indexOf(m.category) < 0) cats.push(m.category);
  });
  if (CATEGORY !== 'all' && cats.indexOf(CATEGORY) < 0) CATEGORY = 'all';

  var box = $('cats');
  box.innerHTML = '';
  ['all'].concat(cats).forEach(function (c) {
    var b = document.createElement('button');
    b.className = CATEGORY === c ? 'on' : '';
    b.textContent = c === 'all' ? 'ทั้งหมด' : c;
    b.addEventListener('click', function () {
      CATEGORY = c;
      renderCats();
      renderGrid();
    });
    box.appendChild(b);
  });
}

function cartQty(id) {
  var line = CART.filter(function (c) { return String(c.id) === String(id); })[0];
  return line ? line.qty : 0;
}

function renderGrid() {
  var grid = $('grid');

  /* โชว์สปินเนอร์เฉพาะตอนยังไม่มีข้อมูลในมือ ถ้ามีของเดิมอยู่แล้วให้คงไว้ก่อน จะได้ไม่กะพริบ */
  if (LOADING_MENU && !MENU.length) {
    grid.innerHTML = spinnerBox('กำลังโหลดเมนู…');
    return;
  }

  var list = MENU.filter(function (m) {
    if (!m.active) return false;
    return CATEGORY === 'all' || m.category === CATEGORY;
  });

  if (!list.length) {
    grid.innerHTML = '<div class="empty">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h11a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3z"/><path d="M18 8h2v13H7"/></svg>'
      + (MENU.length ? 'ไม่มีเมนูในหมวดนี้' : 'ยังไม่มีเมนูในระบบ — เพิ่มได้ที่หน้าเมนูและราคา')
      + '</div>';
    return;
  }

  grid.innerHTML = list.map(function (m) {
    var q = cartQty(m.id);
    var pic = picTag(m.image, m.name, m.fileId);
    return '<button type="button" class="card" data-id="' + esc(m.id) + '">'
      + '<span class="card-pic">' + pic + '</span>'
      + (q ? '<span class="card-qty">' + q + '</span>' : '')
      + '<span class="card-body">'
      + '<span class="card-name">' + esc(m.name) + '</span>'
      + '<span class="card-price">' + baht(m.price) + '</span>'
      + '</span></button>';
  }).join('');

  grid.querySelectorAll('.card').forEach(function (card) {
    card.addEventListener('click', function () { addToCart(card.dataset.id); });
  });
}

/* ---------- บิล ---------- */
function addToCart(id) {
  var item = MENU.filter(function (m) { return String(m.id) === String(id); })[0];
  if (!item) return;

  var line = CART.filter(function (c) { return String(c.id) === String(id); })[0];
  if (line) line.qty++;
  else CART.push({ id: item.id, name: item.name, price: item.price, qty: 1 });

  renderBill();
  renderGrid();
}

function cartTotal() {
  return CART.reduce(function (s, c) { return s + c.price * c.qty; }, 0);
}

function renderBill() {
  var total = cartTotal();
  var pieces = CART.reduce(function (s, c) { return s + c.qty; }, 0);
  var net = total / (1 + VAT_RATE);

  $('sum-net').textContent = baht(net, 2);
  $('sum-vat').textContent = baht(total - net, 2);
  $('bill-sum').hidden = !CART.length;

  $('checkout-btn').disabled = !CART.length;
  $('checkout-btn').textContent = 'ชำระเงิน ' + baht(total);
  $('clear-cart-btn').disabled = !CART.length;

  var tag = $('cart-tag');
  tag.textContent = pieces;
  tag.classList.toggle('on', pieces > 0);

  var box = $('bill-items');
  if (!CART.length) {
    box.innerHTML = '<div class="bill-empty">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 7H6"/></svg>'
      + 'ยังไม่มีรายการ<br>กดที่การ์ดเมนูเพื่อเพิ่มลงบิล</div>';
    return;
  }

  box.innerHTML = CART.map(function (c, i) {
    return '<div class="bi">'
      + '<span class="bi-name">' + esc(c.name) + ' <i>×' + c.qty + '</i></span>'
      + '<span class="bi-total">' + baht(c.price * c.qty) + '</span>'
      + '<span class="bi-unit">' + baht(c.price) + ' / หน่วย</span>'
      + '<span class="bi-qty">'
      + '<button type="button" data-act="minus" data-i="' + i + '" aria-label="ลดจำนวน"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></button>'
      + '<b>' + c.qty + '</b>'
      + '<button type="button" data-act="plus" data-i="' + i + '" aria-label="เพิ่มจำนวน"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>'
      + '<button type="button" class="rm" data-act="remove" data-i="' + i + '" aria-label="เอาออก"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
      + '</span></div>';
  }).join('');

  box.querySelectorAll('button[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = Number(b.dataset.i);
      var act = b.dataset.act;
      if (act === 'plus') {
        CART[i].qty++;
      } else if (act === 'minus') {
        CART[i].qty--;
        if (CART[i].qty <= 0) CART.splice(i, 1);
      } else {
        CART.splice(i, 1);
      }
      renderBill();
      renderGrid();
    });
  });
}

$('clear-cart-btn').addEventListener('click', function () {
  CART = [];
  renderBill();
  renderGrid();
});

function setPayment(name) {
  PAYMENT = name;
  $('bill-pay').querySelectorAll('button').forEach(function (x) {
    x.className = x.dataset.pay === name ? 'on' : '';
  });
}

$('bill-pay').querySelectorAll('button').forEach(function (b) {
  b.addEventListener('click', function () { setPayment(b.dataset.pay); });
});

/* ---------- ชำระเงิน ---------- */
function checkout() {
  if (!CART.length) return;
  if (!HAS_BACKEND) { toast('ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์', 'err'); return; }

  var table = $('table-no').value.trim() || 'สั่งกลับบ้าน / ไม่ระบุ';
  var order = {
    tableName: table,
    payment: PAYMENT,
    items: CART.map(function (c) { return { name: c.name, price: c.price, qty: c.qty }; })
  };

  $('checkout-btn').disabled = true;

  API.submitOrder(order)
    .then(function (res) {
      if (!res || !res.success) {
        toast((res && res.message) || 'บันทึกออเดอร์ไม่สำเร็จ', 'err');
        $('checkout-btn').disabled = false;
        return;
      }
      toast('บันทึกบิล ' + res.orderId + ' แล้ว');
      CART = [];
      $('table-no').value = '';
      renderBill();
      renderGrid();
      loadOrders(ymd(new Date()));
    })
    .catch(function (e) {
      $('checkout-btn').disabled = false;
      console.error(e);
      /* บิลอาจถูกบันทึกไปแล้วแต่คำตอบหายระหว่างทาง กดซ้ำทันทีจะได้บิลซ้ำ */
      toast('บันทึกบิลไม่สำเร็จ — ตรวจที่ประวัติการขายก่อนกดชำระเงินซ้ำ', 'err');
    });
}

$('checkout-btn').addEventListener('click', checkout);

/* ---------- ประวัติการขาย ---------- */
$('day-date').addEventListener('change', function () {
  if (this.value) loadOrders(this.value);
  else this.value = ORDERS_DATE;
});
$('day-prev').addEventListener('click', function () { loadOrders(shiftYmd(ORDERS_DATE, -1)); });
$('day-next').addEventListener('click', function () { loadOrders(shiftYmd(ORDERS_DATE, 1)); });
$('day-today').addEventListener('click', function () { loadOrders(ymd(new Date())); });

function renderOrders() {
  var today = ymd(new Date());
  var isToday = ORDERS_DATE === today;
  var dayWord = isToday ? 'วันนี้' : 'วันที่เลือก';

  /* เครื่องแคชเชียร์เปิดค้างข้ามคืน ถ้าตั้ง max แค่ตอนล็อกอินจะเลือกวันนี้ไม่ได้ในวันถัดมา */
  $('day-date').max = today;
  $('day-next').disabled = !ORDERS_DATE || ORDERS_DATE >= today;
  $('day-today').disabled = isToday;
  $('day-label').textContent = ORDERS_DATE ? thaiDate(ORDERS_DATE) : '';

  var total = ORDERS.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);

  $('stat-sales-label').textContent = 'ยอดขาย' + dayWord;
  $('stat-sales').textContent = baht(total);
  $('stat-count').textContent = ORDERS.length;
  $('stat-avg').textContent = baht(ORDERS.length ? total / ORDERS.length : 0);
  $('orders-head').textContent = 'บิลของ' + dayWord;

  var body = $('orders-rows');
  if (LOADING_ORDERS && !ORDERS.length) {
    $('orders-count').textContent = '';
    body.innerHTML = '<tr><td colspan="6">' + spinnerBox('กำลังโหลดบิล…') + '</td></tr>';
    return;
  }

  var q = TAB === 'orders' ? $('admin-search').value.trim().toLowerCase() : '';
  var list = ORDERS.filter(function (o) {
    return !q || (o.orderId + ' ' + o.table).toLowerCase().indexOf(q) >= 0;
  });

  $('orders-count').textContent = list.length + ' บิล';

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>'
      + (ORDERS.length ? 'ไม่พบบิลที่ตรงกับที่ค้นหา' : 'ไม่มีบิลของ' + dayWord) + '</div></td></tr>';
    return;
  }

  body.innerHTML = list.map(function (o) {
    var items = (o.items || []).map(function (it) { return it.name + ' ×' + it.qty; }).join(', ');
    var cash = String(o.payment).indexOf('สด') >= 0;
    return '<tr>'
      + '<td class="l t-time" title="' + esc(o.time) + '">' + esc(clockOf(o.time)) + '</td>'
      + '<td class="l t-id">' + esc(o.orderId) + '</td>'
      + '<td class="l c-table">' + esc(o.table) + '</td>'
      + '<td class="l c-items t-sub">' + esc(items) + '</td>'
      + '<td><span class="pill ' + (cash ? 'p-cash' : 'p-trans') + '">' + esc(o.payment) + '</span></td>'
      + '<td class="r t-money">' + baht(o.total) + '</td>'
      + '</tr>';
  }).join('');
}

/* ---------- เมนูและราคา ---------- */
function renderCatOptions() {
  var all = [];
  MENU.forEach(function (m) { if (m.category && all.indexOf(m.category) < 0) all.push(m.category); });
  $('cat-options').innerHTML = all.map(function (c) {
    return '<option value="' + esc(c) + '"></option>';
  }).join('');
}

function renderMenuTable() {
  var body = $('menu-rows');
  if (LOADING_MENU && !MENU.length) {
    $('menu-count').textContent = '';
    body.innerHTML = '<tr><td colspan="6">' + spinnerBox('กำลังโหลดเมนู…') + '</td></tr>';
    return;
  }

  var q = TAB === 'menu' ? $('admin-search').value.trim().toLowerCase() : '';
  var list = MENU.filter(function (m) {
    return !q || (m.name + ' ' + m.category).toLowerCase().indexOf(q) >= 0;
  });

  $('menu-count').textContent = list.length + ' รายการ';

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h11a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3z"/><path d="M18 8h2v13H7"/></svg>'
      + (MENU.length ? 'ไม่พบเมนูที่ตรงกับที่ค้นหา' : 'ยังไม่มีเมนูในระบบ') + '</div></td></tr>';
    return;
  }

  body.innerHTML = list.map(function (m) {
    var pic = picTag(m.image, m.name, m.fileId);
    return '<tr>'
      + '<td class="c-img"><span class="t-pic">' + pic + '</span></td>'
      + '<td class="l t-name">' + esc(m.name) + '</td>'
      + '<td class="l c-cat t-sub">' + esc(m.category) + '</td>'
      + '<td class="r t-money">' + baht(m.price) + '</td>'
      + '<td><span class="pill ' + (m.active ? 'p-on' : 'p-off') + '">' + (m.active ? 'เปิดขาย' : 'ปิดขาย') + '</span></td>'
      + '<td><span class="acts">'
      + '<button class="mini" data-act="edit" data-id="' + esc(m.id) + '">แก้ไข</button>'
      + '<button class="mini ' + (m.active ? 'warn' : 'go') + '" data-act="toggle" data-id="' + esc(m.id) + '">' + (m.active ? 'ปิดขาย' : 'เปิดขาย') + '</button>'
      + '<button class="mini danger" data-act="delete" data-id="' + esc(m.id) + '">ลบ</button>'
      + '</span></td></tr>';
  }).join('');

  body.querySelectorAll('button[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var item = MENU.filter(function (m) { return String(m.id) === b.dataset.id; })[0];
      if (!item) return;
      if (b.dataset.act === 'edit') openMenuForm(item);
      else if (b.dataset.act === 'delete') askDeleteMenu(item);
      else toggleActive(item);
    });
  });
}

$('admin-search').addEventListener('input', function () {
  if (TAB === 'orders') renderOrders();
  else if (TAB === 'menu') renderMenuTable();
});

function setPreview(src, fileId) {
  $('image-preview').innerHTML = src ? picTag(src, 'ตัวอย่างรูปเมนู', fileId) : 'ไม่มีรูป';
  $('clear-image-btn').hidden = !src;
}

function openMenuForm(item) {
  $('menu-form').reset();
  PENDING_IMAGE = null;
  CLEAR_IMAGE = false;

  $('menu-id').value = item ? item.id : '';
  $('menu-name').value = item ? item.name : '';
  $('menu-category').value = item ? item.category : '';
  $('menu-price').value = item ? item.price : '';
  setPreview(item ? item.image : '', item ? item.fileId : '');

  $('menu-modal-title').textContent = item ? 'แก้ไขเมนู — ' + item.name : 'เพิ่มเมนู';

  openModal('menu-modal');
  $('menu-name').focus();
}

$('add-menu-btn').addEventListener('click', function () { openMenuForm(null); });
$('pick-image-btn').addEventListener('click', function () { $('menu-image-input').click(); });

/* รูปจากมือถือมักใหญ่หลายเมกะไบต์ ส่ง base64 ดิบไปให้ Apps Script อัปโหลดจะช้ามาก
   ย่อฝั่งเบราว์เซอร์ก่อนจึงเหลือหลักร้อยกิโลไบต์ */
var IMAGE_MAX_PX = 900;

function compressImage(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('อ่านไฟล์รูปไม่สำเร็จ')); };
    reader.onload = function (ev) {
      var img = new Image();
      img.onerror = function () { reject(new Error('ไฟล์นี้ไม่ใช่รูปภาพ')); };
      img.onload = function () {
        var scale = Math.min(1, IMAGE_MAX_PX / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext('2d');
        /* JPEG ไม่มีช่องโปร่งใส ส่วนที่โปร่งของ PNG จะกลายเป็นสีดำถ้าไม่รองพื้นขาวไว้ก่อน */
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

$('menu-image-input').addEventListener('change', function (e) {
  var file = e.target.files[0];
  if (!file) return;
  compressImage(file)
    .then(function (dataUrl) {
      PENDING_IMAGE = dataUrl;
      CLEAR_IMAGE = false;
      setPreview(PENDING_IMAGE);
    })
    .catch(function (err) {
      $('menu-image-input').value = '';
      toast(err.message, 'err');
    });
});

$('clear-image-btn').addEventListener('click', function () {
  PENDING_IMAGE = null;
  CLEAR_IMAGE = true;
  $('menu-image-input').value = '';
  setPreview('');
});

$('menu-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!HAS_BACKEND) { toast('ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์', 'err'); return; }

  var id = $('menu-id').value;
  var name = $('menu-name').value.trim();
  var category = $('menu-category').value.trim();
  var priceRaw = $('menu-price').value;
  var price = Number(priceRaw);

  if (!name || !category || priceRaw === '' || !(price >= 0)) {
    toast('กรอกชื่อเมนู หมวดหมู่ และราคาให้ครบ', 'err');
    return;
  }

  var payload = { name: name, category: category, price: price };
  if (PENDING_IMAGE) payload.imageBase64 = PENDING_IMAGE;

  var existing = MENU.filter(function (m) { return String(m.id) === String(id); })[0];
  if (existing) {
    payload.id = id;
    payload.active = existing.active;
    /* ไม่ได้เลือกรูปใหม่และไม่ได้กดเอารูปออก = เก็บรูปเดิมไว้ */
    if (!PENDING_IMAGE && !CLEAR_IMAGE) payload.driveId = existing.driveId;
  }

  var btn = $('menu-save-btn');
  btn.disabled = true;
  btn.textContent = PENDING_IMAGE ? 'กำลังอัปโหลดรูป…' : 'กำลังบันทึก…';

  (existing ? API.updateMenuItem(payload) : API.addMenuItem(payload))
    .then(function (res) {
      if (!res || !res.success) {
        toast((res && res.message) || 'บันทึกเมนูไม่สำเร็จ', 'err');
        return;
      }
      closeModal('menu-modal');
      toast((existing ? 'แก้ไขเมนู "' : 'เพิ่มเมนู "') + name + '" เรียบร้อยแล้ว');
      loadMenu();
    })
    .catch(onError)
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'บันทึกเมนู';
    });
});

function toggleActive(item) {
  if (!HAS_BACKEND) { toast('ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์', 'err'); return; }
  API.updateMenuItem({
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price,
    active: !item.active,
    driveId: item.driveId
  })
    .then(function (res) {
      if (!res || !res.success) {
        toast((res && res.message) || 'อัปเดตสถานะไม่สำเร็จ', 'err');
        return;
      }
      toast((item.active ? 'ปิดขาย "' : 'เปิดขาย "') + item.name + '" แล้ว');
      loadMenu();
    })
    .catch(onError);
}

var DELETE_TARGET = null;

function askDeleteMenu(item) {
  DELETE_TARGET = item;
  $('delete-name').textContent = item.name;
  openModal('delete-modal');
}

$('delete-confirm-btn').addEventListener('click', function () {
  if (!DELETE_TARGET) return;
  if (!HAS_BACKEND) { toast('ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์', 'err'); return; }

  var item = DELETE_TARGET;
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'กำลังลบ…';

  API.deleteMenuItem(item.id)
    .then(function (res) {
      if (!res || !res.success) toast((res && res.message) || 'ลบเมนูไม่สำเร็จ', 'err');
      else toast('ลบเมนู "' + item.name + '" แล้ว');
    })
    .catch(onError)
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'ลบเมนู';
      DELETE_TARGET = null;
      closeModal('delete-modal');
      /* การตอบกลับหลุดได้ทั้งที่เซิร์ฟเวอร์ลบไปแล้ว จึงยึดรายการจริงจากเซิร์ฟเวอร์เสมอ
         ไม่อย่างนั้นตารางจะค้างแสดงเมนูที่ไม่มีอยู่จริง */
      loadMenu().then(dropMissingFromCart);
    });
});

/* เมนูที่หายไปจากเซิร์ฟเวอร์ต้องออกจากบิลที่ยังไม่ได้ชำระด้วย
   ไม่งั้นจะกดชำระเงินด้วยเมนูที่ถูกลบไปแล้ว */
function dropMissingFromCart() {
  var before = CART.length;
  CART = CART.filter(function (c) {
    return MENU.some(function (m) { return String(m.id) === String(c.id); });
  });
  if (CART.length !== before) renderBill();
}

/* ---------- เริ่มต้น ---------- */
if (!HAS_BACKEND) {
  console.warn('ยังไม่ได้ตั้งค่า API_URL ใน api.js — ใส่ URL ของ Web App (Deploy > Web app) ก่อน ถึงจะเรียก backend ได้');
} else {
  console.info('เชื่อมต่อ backend ผ่าน ' + API.mode());
}

showTab('pos');
renderBill();

/* คืนสถานะล็อกอินหลังรีเฟรชหน้า ไม่ต้องกรอกใหม่ทุกครั้ง */
var SAVED = HAS_BACKEND ? loadSession() : null;

if (SAVED) {
  ME = SAVED;
  enterApp(true);
}
