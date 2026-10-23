const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 1_800_000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL = 15 * 60 * 1000;
const rateBuckets = new Map();
let schemaReady = false;
let adminChecked = false;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const now = () => new Date().toISOString();
const asText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const envBool = (env, key, fallback = false) => String(env[key] ?? fallback).toLowerCase() === 'true';
const paymentMode = env => String(env.PAYMENT_MODE || 'demo').toLowerCase();

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}

const fail = (status, message, details) => json({ error: message, ...(details ? { details } : {}) }, status);

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

const id = prefix => `${prefix}_${randomToken(10)}`;

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

async function hexDigest(value) {
  return [...await sha256(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$120000$${salt}$${bytesToBase64(new Uint8Array(bits))}`;
}

async function passwordMatches(password, stored) {
  const [algorithm, iterationText, salt, expected] = String(stored || '').split('$');
  if (algorithm !== 'pbkdf2' || !iterationText || !salt || !expected) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: Number(iterationText), hash: 'SHA-256' }, key, 256);
  return bytesToBase64(new Uint8Array(bits)) === expected;
}

async function tokenHash(token) {
  return hexDigest(token);
}

async function encryptionKey(env) {
  const configured = String(env.ENCRYPTION_KEY || '');
  if (configured.length < 32) throw new Error('ENCRYPTION_KEY must contain at least 32 characters');
  return crypto.subtle.importKey('raw', await sha256(configured), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(env, value) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), encoder.encode(JSON.stringify(value)));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptSecret(env, value) {
  const [ivText, encryptedText] = String(value || '').split('.');
  if (!ivText || !encryptedText) throw new Error('Invalid encrypted inventory record');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivText) }, await encryptionKey(env), base64ToBytes(encryptedText));
  return JSON.parse(decoder.decode(decrypted));
}

function defaultProducts() {
  const createdAt = now();
  return [
    { id: 'p_chatgpt', name: 'ChatGPT Plus', description: 'Личный аккаунт · 1 месяц', price: 790, category: 'subscriptions', icon: '✦', accent: '#a98cff', bg: '#27213a', color: '#bcaaff', delivery: 'instant', active: true, image: null, createdAt },
    { id: 'p_netflix', name: 'Netflix Premium', description: 'Private профиль · 30 дней', price: 349, category: 'subscriptions', icon: 'N', accent: '#ff6ec7', bg: '#38212f', color: '#ff80cf', delivery: 'instant', active: true, image: null, createdAt },
    { id: 'p_steam', name: 'Steam Wallet', description: 'Пополнение баланса · RU', price: 1000, category: 'games', icon: '⌁', accent: '#7ce7eb', bg: '#1d3439', color: '#7ce7eb', delivery: 'instant', active: true, image: null, createdAt },
    { id: 'p_spotify', name: 'Spotify Premium', description: 'Индивидуальная подписка · 1 мес', price: 299, category: 'subscriptions', icon: '◉', accent: '#d9ff46', bg: '#29321b', color: '#d9ff46', delivery: 'instant', active: true, image: null, createdAt },
    { id: 'p_adobe', name: 'Adobe Creative Cloud', description: 'Все приложения · 1 месяц', price: 1190, category: 'software', icon: 'A', accent: '#ff6ec7', bg: '#351f29', color: '#ff82c9', delivery: 'instant', active: true, image: null, createdAt },
    { id: 'p_telegram', name: 'Telegram номер', description: 'Легальный номер для подтверждения', price: 450, category: 'accounts', icon: '↗', accent: '#7ce7eb', bg: '#1e303a', color: '#7ce7eb', delivery: 'manual', active: true, image: null, createdAt },
  ];
}

function emptyDatabase() {
  return { users: [], products: [], orders: [], inventory: [], tickets: [], sessions: [], emailCodes: [], telegramSessions: [], telegram: { lastUpdateId: 0 } };
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  const initial = JSON.stringify(emptyDatabase());
  await env.DB.prepare('INSERT OR IGNORE INTO app_state (id, version, data, updated_at) VALUES (1, 0, ?, ?)').bind(initial, now()).run();
  schemaReady = true;
}

async function saveContext(context) {
  const serialized = JSON.stringify(context.db);
  if (encoder.encode(serialized).byteLength > MAX_STATE_BYTES) throw new Error('Размер базы превышает лимит бесплатного хранилища. Удалите старые данные или изображения.');
  const result = await context.env.DB.prepare('UPDATE app_state SET data = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?').bind(serialized, now(), context.version).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new Error('База обновилась параллельно. Повторите запрос');
  context.version += 1;
}

async function migrateDatabase(db, env) {
  let changed = false;
  for (const key of ['users', 'products', 'orders', 'inventory', 'tickets', 'sessions', 'emailCodes', 'telegramSessions']) {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  }
  if (!db.telegram || typeof db.telegram !== 'object' || Array.isArray(db.telegram)) { db.telegram = { lastUpdateId: 0 }; changed = true; }
  if (!db.products.length) { db.products = defaultProducts(); changed = true; }
  for (const product of db.products) {
    if (!product.createdAt) { product.createdAt = now(); changed = true; }
    if (!product.delivery) { product.delivery = 'instant'; changed = true; }
    if (product.active === undefined) { product.active = true; changed = true; }
    if (product.image === undefined) { product.image = null; changed = true; }
  }
  for (const order of db.orders) {
    if (!order.status) { order.status = 'awaiting_payment'; changed = true; }
    if (!order.paymentStatus) { order.paymentStatus = 'unpaid'; changed = true; }
    if (!order.totalCents) { order.totalCents = Math.round(Number(order.total || 0) * 100); changed = true; }
    if (!order.currency) { order.currency = 'RUB'; changed = true; }
    if (!order.updatedAt) { order.updatedAt = order.createdAt || now(); changed = true; }
    for (const item of order.items || []) if (!Array.isArray(item.inventoryIds)) { item.inventoryIds = []; changed = true; }
  }
  for (const ticket of db.tickets) {
    if (!Array.isArray(ticket.messages)) { ticket.messages = ticket.message ? [{ id: id('msg'), author: 'customer', message: ticket.message, createdAt: ticket.createdAt || now() }] : []; changed = true; }
  }
  if (envBool(env, 'SEED_DEMO_INVENTORY') && db.inventory.length === 0) {
    for (const product of db.products) {
      for (let index = 0; index < 3; index += 1) {
        const login = `demo-${product.id}-${index + 1}@example.invalid`;
        db.inventory.push({ id: id('inv'), productId: product.id, status: 'available', loginHint: `de***${index + 1}`, secret: await encryptSecret(env, { login, password: `Demo-${randomToken(8)}`, extra: 'Демонстрационный товар.' }), createdAt: now() });
      }
    }
    changed = true;
  }
  return changed;
}

async function loadContext(env, request) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  const context = { env, request, db: JSON.parse(row?.data || JSON.stringify(emptyDatabase())), version: Number(row?.version || 0) };
  if (await migrateDatabase(context.db, env)) await saveContext(context);
  return context;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified !== false, createdAt: user.createdAt };
}

function publicProduct(product, db) {
  const inventory = db.inventory.filter(item => item.productId === product.id);
  return { id: product.id, name: product.name, description: product.description, category: product.category, price: Number(product.price), currency: 'RUB', delivery: product.delivery, active: product.active !== false, stock: inventory.filter(item => item.status === 'available').length, icon: product.icon || '✦', accent: product.accent || '#a98cff', bg: product.bg || '#27213a', color: product.color || '#bcaaff', image: product.image || null, createdAt: product.createdAt };
}

function adminProduct(product, db) {
  const inventory = db.inventory.filter(item => item.productId === product.id);
  return { ...publicProduct(product, db), inventoryTotal: inventory.length, reserved: inventory.filter(item => item.status === 'reserved').length, sold: inventory.filter(item => item.status === 'sold').length, blocked: inventory.filter(item => item.status === 'blocked').length };
}

function orderForClient(order, includePayment = false) {
  return { id: order.id, items: (order.items || []).map(item => ({ productId: item.productId, name: item.name, price: item.price, quantity: item.quantity })), total: order.total, totalCents: order.totalCents, currency: order.currency || 'RUB', status: order.status, paymentStatus: order.paymentStatus, paymentProvider: order.paymentProvider, reservationExpiresAt: order.reservationExpiresAt || null, deliveryAvailable: Boolean(order.deliveryAvailableAt) && ['paid', 'fulfilled'].includes(order.status), deliveryAvailableAt: order.deliveryAvailableAt || null, deliveredAt: order.deliveredAt || null, createdAt: order.createdAt, updatedAt: order.updatedAt, ...(includePayment && order.paymentUrl ? { paymentUrl: order.paymentUrl } : {}) };
}

function inventoryForAdmin(item) {
  return { id: item.id, productId: item.productId, status: item.status, loginHint: item.loginHint || 'скрыт', orderId: item.orderId || null, createdAt: item.createdAt, soldAt: item.soldAt || null };
}

function parseCookies(request) {
  const result = {};
  for (const part of String(request.headers.get('Cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

async function sessionUser(request, context) {
  const token = parseCookies(request).slowy_session;
  if (!token) return null;
  const hashedToken = await tokenHash(token);
  const session = context.db.sessions.find(item => item.tokenHash === hashedToken);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) { context.db.sessions = context.db.sessions.filter(item => item !== session); await saveContext(context); return null; }
  return context.db.users.find(user => user.id === session.userId) || null;
}

async function requireUser(request, context) {
  const user = await sessionUser(request, context);
  return user || null;
}

async function ensureAdmin(context) {
  if (adminChecked) return;
  const email = asText(context.env.ADMIN_EMAIL || 'admin@slowy.local', 200).toLowerCase();
  const password = String(context.env.ADMIN_PASSWORD || '');
  const production = String(context.env.NODE_ENV || '').toLowerCase() === 'production';
  if (production && password.length < 12) throw new Error('Set ADMIN_EMAIL and a strong ADMIN_PASSWORD');
  let admin = context.db.users.find(user => user.role === 'admin' && user.email === email);
  if (!admin) {
    admin = { id: id('usr'), email, passwordHash: await hashPassword(password || randomToken(16)), role: 'admin', createdAt: now(), emailVerified: true };
    context.db.users.push(admin);
    await saveContext(context);
  } else if (password && production && !(await passwordMatches(password, admin.passwordHash))) {
    admin.passwordHash = await hashPassword(password);
    await saveContext(context);
  }
  adminChecked = true;
}

function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const requestOrigin = new URL(request.url).origin;
  return origin === requestOrigin || (env.APP_ORIGIN && origin === String(env.APP_ORIGIN).replace(/\/$/, ''));
}

async function requestBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('Размер запроса слишком большой');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Размер запроса слишком большой'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = decoder.decode(bytes);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Некорректный JSON'); }
}

function rateLimit(request, key, limit, windowMs) {
  const bucketKey = `${key}:${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'}`;
  const current = rateBuckets.get(bucketKey);
  const timestamp = Date.now();
  if (!current || current.expiresAt <= timestamp) { rateBuckets.set(bucketKey, { count: 1, expiresAt: timestamp + windowMs }); return true; }
  current.count += 1;
  return current.count <= limit;
}

function pruneEmailCodes(db) {
  const before = db.emailCodes.length;
  db.emailCodes = db.emailCodes.filter(item => Number(item.expiresAt) > Date.now());
  return before !== db.emailCodes.length;
}

function cleanImage(value) {
  const image = asText(value, 2_000_000);
  if (!image) return null;
  if (/^data:/i.test(image)) return null;
  try { const url = new URL(image); return url.protocol === 'https:' ? url.toString() : null; } catch { return null; }
}

function cleanProduct(input, existing = {}) {
  const product = { ...existing, name: asText(input.name ?? existing.name, 120), description: asText(input.description ?? existing.description, 1000), category: asText(input.category ?? existing.category ?? 'accounts', 40), price: Math.round(Number(input.price ?? existing.price) * 100) / 100, delivery: input.delivery === 'manual' ? 'manual' : 'instant', active: input.active === undefined ? existing.active !== false : input.active !== false, icon: asText(input.icon ?? existing.icon ?? '✦', 8) || '✦', accent: asText(input.accent ?? existing.accent ?? '#a98cff', 20), bg: asText(input.bg ?? existing.bg ?? '#27213a', 20), color: asText(input.color ?? existing.color ?? '#bcaaff', 20) };
  const imageValue = input.image === undefined ? existing.image : input.image;
  product.image = cleanImage(imageValue);
  if (imageValue && !product.image) return null;
  if (!product.name || !product.description || !Number.isFinite(product.price) || product.price < 0 || product.price > 10_000_000) return null;
  return product;
}

function availableInventory(db, productId) { return db.inventory.filter(item => item.productId === productId && item.status === 'available'); }

function releaseReservations(db, order) {
  for (const item of order.items || []) for (const inventoryId of item.inventoryIds || []) {
    const inventory = db.inventory.find(record => record.id === inventoryId);
    if (inventory && inventory.status === 'reserved' && inventory.reservedOrderId === order.id) { inventory.status = 'available'; delete inventory.reservedOrderId; delete inventory.reservedAt; delete inventory.reservationExpiresAt; }
  }
}

function cleanupExpiredReservations(db) {
  let changed = false;
  for (const order of db.orders) {
    if (order.status !== 'awaiting_payment' || !order.reservationExpiresAt || Date.parse(order.reservationExpiresAt) > Date.now()) continue;
    releaseReservations(db, order); order.status = 'expired'; order.paymentStatus = 'unpaid'; order.updatedAt = now(); changed = true;
  }
  return changed;
}

function reserveInventory(db, items, orderId, expiresAt) {
  const reservedItems = [];
  for (const requested of items) {
    const available = availableInventory(db, requested.productId);
    if (available.length < requested.quantity) { reservedItems.forEach(record => { record.status = 'available'; delete record.reservedOrderId; }); return null; }
    const selected = available.slice(0, requested.quantity);
    selected.forEach(record => { record.status = 'reserved'; record.reservedOrderId = orderId; record.reservedAt = now(); record.reservationExpiresAt = expiresAt; });
    reservedItems.push(...selected);
  }
  return reservedItems;
}

function markOrderPaid(db, order, providerPaymentId) {
  if (order.paymentStatus === 'paid') return false;
  if (!['awaiting_payment', 'payment_failed'].includes(order.status)) throw new Error('Заказ уже нельзя оплатить');
  if (order.reservationExpiresAt && Date.parse(order.reservationExpiresAt) <= Date.now()) { releaseReservations(db, order); order.status = 'expired'; order.paymentStatus = 'unpaid'; order.updatedAt = now(); throw new Error('Срок резерва заказа истек'); }
  for (const item of order.items || []) for (const inventoryId of item.inventoryIds || []) {
    const inventory = db.inventory.find(record => record.id === inventoryId);
    if (!inventory || (inventory.status !== 'reserved' && inventory.status !== 'sold') || (inventory.status === 'reserved' && inventory.reservedOrderId !== order.id)) throw new Error('Зарезервированный товар больше недоступен');
  }
  for (const item of order.items || []) for (const inventoryId of item.inventoryIds || []) {
    const inventory = db.inventory.find(record => record.id === inventoryId);
    inventory.status = 'sold'; inventory.orderId = order.id; inventory.soldAt = now(); delete inventory.reservedOrderId; delete inventory.reservedAt; delete inventory.reservationExpiresAt;
  }
  order.paymentStatus = 'paid'; order.paymentId = providerPaymentId || order.paymentId || null; order.status = order.items.every(item => item.delivery !== 'manual') ? 'fulfilled' : 'paid'; order.deliveryAvailableAt = order.status === 'fulfilled' ? now() : null; order.reservationExpiresAt = null; order.updatedAt = now(); return true;
}

function refundOrder(db, order) {
  if (order.paymentStatus !== 'paid') throw new Error('Оплаченный заказ не найден');
  order.status = 'refunded'; order.paymentStatus = 'refunded'; order.updatedAt = now();
  for (const item of order.items || []) for (const inventoryId of item.inventoryIds || []) { const inventory = db.inventory.find(record => record.id === inventoryId); if (inventory?.status === 'sold') inventory.status = 'blocked'; }
}

async function sendMail(env, to, subject, body) {
  if (!env.RESEND_API_KEY) {
    if (envBool(env, 'EMAIL_REQUIRED', true)) throw new Error('Email-сервис не настроен. Добавьте RESEND_API_KEY и EMAIL_FROM');
    return;
  }
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM || 'slowyshop <onboarding@resend.dev>', to: [to], subject, text: body }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

async function issueEmailCode(env, db, email, passwordHash) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
  await sendMail(env, email, 'slowyshop — подтверждение email', `Ваш код подтверждения slowyshop: ${code}\n\nКод действует 10 минут.`);
  db.emailCodes = db.emailCodes.filter(item => item.email !== email);
  db.emailCodes.push({ email, code, passwordHash, expiresAt: Date.now() + 600000 });
  const result = { pending: true, email, message: 'Код подтверждения отправлен на email' };
  if (!env.RESEND_API_KEY && !envBool(env, 'EMAIL_REQUIRED', true) && envBool(env, 'DEV_EMAIL_CODES', false)) result.devCode = code;
  return result;
}

async function createSession(db, user) {
  const token = randomToken(32);
  db.sessions = db.sessions.filter(session => Date.parse(session.expiresAt) > Date.now());
  db.sessions.push({ tokenHash: await tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL).toISOString() });
  return { token, user: publicUser(user) };
}

function sessionCookie(token, env, maxAge = SESSION_TTL / 1000) {
  return `slowy_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${envBool(env, 'COOKIE_SECURE', true) ? '; Secure' : ''}`;
}

async function createYooKassaPayment(env, request, order) {
  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) throw new Error('YooKassa не настроена');
  const origin = String(env.APP_ORIGIN || new URL(request.url).origin).replace(/\/$/, '');
  const response = await fetch('https://api.yookassa.ru/v3/payments', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`)}`, 'Content-Type': 'application/json', 'Idempotence-Key': `order_${order.id}` }, body: JSON.stringify({ amount: { value: Number(order.total).toFixed(2), currency: 'RUB' }, capture: true, confirmation: { type: 'redirect', return_url: `${origin}/?order=${encodeURIComponent(order.id)}` }, description: `slowyshop ${order.id}`, metadata: { orderId: order.id } }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.description || 'YooKassa не приняла платеж');
  if (!data.id || !data.confirmation?.confirmation_url) throw new Error('YooKassa вернула неполные данные платежа');
  return { id: data.id, url: data.confirmation?.confirmation_url };
}

async function verifyYooKassaPayment(env, paymentId) {
  const response = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`)}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.description || 'Не удалось проверить платеж');
  return data;
}

async function refundYooKassaPayment(env, payment) {
  const response = await fetch('https://api.yookassa.ru/v3/refunds', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`)}`, 'Content-Type': 'application/json', 'Idempotence-Key': `refund_${payment.id}` }, body: JSON.stringify({ payment_id: payment.id, amount: payment.amount, description: 'Возврат slowyshop' }) });
  if (!response.ok) throw new Error('Не удалось оформить возврат YooKassa');
}

async function handleYooKassaWebhook(request, env) {
  if (paymentMode(env) !== 'yookassa') return json({ ok: true });
  const payload = await requestBody(request);
  const paymentId = payload?.object?.id;
  if (!paymentId) return fail(400, 'Некорректное уведомление');
  const payment = await verifyYooKassaPayment(env, paymentId);
  const context = await loadContext(env, request);
  const orderId = payment.metadata?.orderId || payload.object.metadata?.orderId;
  const order = context.db.orders.find(item => item.id === orderId || item.paymentId === payment.id);
  if (!order) return fail(404, 'Заказ не найден');
  if (payment.amount?.currency !== 'RUB' || Number(payment.amount?.value) !== Number(order.total)) return fail(400, 'Сумма платежа не совпадает');
  if (payment.status === 'succeeded') {
    if (order.paymentStatus === 'paid') return json({ ok: true });
    try {
      if (['expired', 'cancelled'].includes(order.status) || (order.reservationExpiresAt && Date.parse(order.reservationExpiresAt) <= Date.now())) throw new Error('Заказ больше не может быть выдан');
      markOrderPaid(context.db, order, payment.id);
    } catch {
      await refundYooKassaPayment(env, payment);
      order.status = 'refunded'; order.paymentStatus = 'refunded'; order.paymentId = payment.id; order.updatedAt = now();
    }
  }
  if (payment.status === 'canceled' && order.status === 'awaiting_payment') { releaseReservations(context.db, order); order.status = 'payment_failed'; order.paymentStatus = 'failed'; order.updatedAt = now(); }
  await saveContext(context);
  return json({ ok: true });
}

async function telegramApi(env, method, payload = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API: HTTP ${response.status}`);
  return data.result;
}

const TELEGRAM_APPLICATION_OPTIONS = { freedep: 'Фридеп', redeposit_return: 'Редеп с возвращением баланса', deposit_50_50: 'Деп 50/50' };
const TELEGRAM_TICKET_STATUSES = { open: 'на проверке', in_progress: 'в работе', closed: 'закрыта' };

function telegramRecipients(env) {
  return [...new Set(String(`${env.TELEGRAM_ADMIN_CHAT_IDS || ''},${env.TELEGRAM_ADMIN_USER_IDS || ''}`).split(',').map(value => value.trim()).filter(value => /^-?\d+$/.test(value)))];
}

function telegramStatusLabel(ticket) {
  if (ticket.stage === 'profile_review') return 'проверка профиля';
  if (ticket.stage === 'awaiting_option') return 'выбор варианта';
  if (ticket.stage === 'rejected') return 'профиль отклонен';
  if (ticket.stage === 'application_review' && ticket.status === 'open') return 'заявка на проверке';
  return TELEGRAM_TICKET_STATUSES[ticket.status] || ticket.status || 'неизвестный статус';
}

function telegramMainKeyboard() {
  return { inline_keyboard: [[{ text: 'Подать заявку', callback_data: 'apply:start' }], [{ text: 'Моя заявка', callback_data: 'status' }]] };
}

function telegramOptionKeyboard() {
  return { inline_keyboard: [[{ text: 'Фридеп', callback_data: 'apply:freedep' }], [{ text: 'Редеп с возвратом баланса', callback_data: 'apply:redeposit_return' }], [{ text: 'Деп 50/50', callback_data: 'apply:deposit_50_50' }], [{ text: 'Отмена', callback_data: 'apply:cancel' }]] };
}

function telegramCommentKeyboard() {
  return { inline_keyboard: [[{ text: 'Пропустить комментарий', callback_data: 'apply:skip' }], [{ text: 'Отмена', callback_data: 'apply:cancel' }]] };
}

function telegramReviewKeyboard(ticketId) {
  return { inline_keyboard: [[{ text: 'Ссылка проверена', callback_data: `review:approve:${ticketId}` }], [{ text: 'Отклонить', callback_data: `review:reject:${ticketId}` }]] };
}

function telegramAllowedHosts(env) {
  return String(env.LOLZ_ALLOWED_HOSTS || 'lolz.live,lolz.guru').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

function normalizeTelegramProfileUrl(env, value) {
  const raw = asText(value, 500).replace(/\s+/g, '');
  if (!raw || !/^https:\/\//i.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (!telegramAllowedHosts(env).some(host => hostname === host || hostname.endsWith(`.${host}`))) return null;
  if (url.username || url.password || !/^\/(members|profile|profiles|users)\/[^/?#]+\/?$/i.test(url.pathname)) return null;
  url.search = ''; url.hash = '';
  return url.toString();
}

function telegramSession(db, chatId) {
  const session = db.telegramSessions.find(item => item.chatId === String(chatId));
  if (!session) return null;
  if (!session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) { db.telegramSessions = db.telegramSessions.filter(item => item !== session); return null; }
  return session;
}

function telegramTicketsForChat(db, chatId) {
  return db.tickets.filter(ticket => ticket.source === 'telegram' && ticket.telegramChatId === String(chatId)).sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
}

function telegramIsAdminCallback(env, callbackQuery) {
  const chatId = String(callbackQuery?.message?.chat?.id || '');
  const userId = String(callbackQuery?.from?.id || '');
  const chatType = callbackQuery?.message?.chat?.type;
  const admins = telegramRecipients(env);
  return String(env.TELEGRAM_ADMIN_USER_IDS || '').split(',').map(value => value.trim()).includes(userId) || (chatType === 'private' && chatId === userId && admins.includes(chatId));
}

async function telegramSave(context) {
  await saveContext(context);
}

async function notifyTelegramTicket(env, ticket, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !ticket.telegramChatId) return;
  await telegramApi(env, 'sendMessage', { chat_id: ticket.telegramChatId, text: `Ответ по обращению ${ticket.id}:\n${message}` });
}

async function notifyTelegramAdmins(env, message, replyMarkup) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await Promise.all(telegramRecipients(env).map(chatId => telegramApi(env, 'sendMessage', { chat_id: chatId, text: String(message).slice(0, 4096), disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }).catch(() => null)));
}

async function telegramStartApplication(context, chat, from) {
  const db = context.db;
  const existing = telegramTicketsForChat(db, chat.id).find(ticket => ['open', 'in_progress'].includes(ticket.status) || (Date.parse(ticket.createdAt || 0) + 24 * 60 * 60 * 1000 > Date.now() && !['rejected', 'cancelled'].includes(ticket.telegramReview)));
  if (existing) {
    const session = telegramSession(db, chat.id);
    if (existing.stage === 'awaiting_option') { if (!session) db.telegramSessions.push({ id: id('tgs'), chatId: String(chat.id), telegramUserId: String(from.id), telegramUsername: from.username || null, ticketId: existing.id, step: 'awaiting_option', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt: now(), updatedAt: now() }); await telegramSave(context); await telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: `Профиль по заявке ${existing.id} подтвержден. Выберите вариант.`, reply_markup: telegramOptionKeyboard() }); return; }
    await telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: `У вас уже есть заявка ${existing.id}: ${telegramStatusLabel(existing)}.`, reply_markup: telegramMainKeyboard() });
    return;
  }
  db.telegramSessions = db.telegramSessions.filter(item => item.chatId !== String(chat.id));
  db.telegramSessions.push({ id: id('tgs'), chatId: String(chat.id), telegramUserId: String(from.id), telegramUsername: from.username || null, step: 'awaiting_profile', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt: now(), updatedAt: now() });
  await telegramSave(context);
  await telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Шаг 1 из 3. Пришлите публичную HTTPS-ссылку на профиль LOLZ.\n\nНе отправляйте пароли, cookies, коды подтверждения или платёжные данные.', reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'apply:cancel' }]] } });
}

async function telegramCreateProfileReview(context, session) {
  const createdAt = now();
  const ticket = { id: id('tkt'), userId: null, email: null, orderId: null, subject: 'Telegram-заявка: проверка профиля', message: `Профиль LOLZ: ${session.profileUrl}\n\nОжидает ручной проверки оператором.`, messages: [{ id: id('msg'), author: 'customer', message: `Профиль LOLZ: ${session.profileUrl}`, createdAt }], status: 'open', stage: 'profile_review', telegramReview: 'pending', source: 'telegram', profileUrl: session.profileUrl, applicationType: null, applicationComment: null, telegramChatId: session.chatId, telegramUserId: session.telegramUserId, telegramUsername: session.telegramUsername, contact: session.telegramUsername ? `@${session.telegramUsername}` : `Telegram ID ${session.telegramUserId}`, createdAt, updatedAt: createdAt };
  session.ticketId = ticket.id;
  context.db.tickets.unshift(ticket);
  await telegramSave(context);
  await notifyTelegramAdmins(context.env, `Новая ссылка на ручную проверку\nID: ${ticket.id}\nПользователь: ${ticket.telegramUsername ? `@${ticket.telegramUsername}` : `ID ${ticket.telegramUserId}`}\nПрофиль LOLZ: ${ticket.profileUrl}`, telegramReviewKeyboard(ticket.id));
  await telegramApi(context.env, 'sendMessage', { chat_id: session.chatId, text: `Ссылка принята. Оператор вручную проверит профиль.\nНомер заявки: ${ticket.id}`, reply_markup: telegramMainKeyboard() });
}

async function telegramSubmitApplication(context, session) {
  const ticket = context.db.tickets.find(item => item.id === session.ticketId && item.source === 'telegram' && item.telegramChatId === session.chatId);
  if (!ticket) throw new Error('Заявка на проверку профиля не найдена');
  const optionLabel = TELEGRAM_APPLICATION_OPTIONS[session.applicationType];
  const applicationComment = asText(session.applicationComment, 2000);
  const message = `Профиль LOLZ: ${session.profileUrl}\nВыбранный вариант: ${optionLabel}\nКомментарий: ${applicationComment || 'не указан'}`;
  ticket.subject = `Telegram-заявка: ${optionLabel}`; ticket.message = message; ticket.messages.push({ id: id('msg'), author: 'customer', message, createdAt: now() }); ticket.status = 'open'; ticket.stage = 'application_review'; ticket.telegramReview = 'approved'; ticket.applicationType = session.applicationType; ticket.applicationComment = applicationComment || null; ticket.updatedAt = now();
  context.db.telegramSessions = context.db.telegramSessions.filter(item => item !== session);
  await telegramSave(context);
  await notifyTelegramAdmins(context.env, `Новая заявка из Telegram\nID: ${ticket.id}\nПрофиль LOLZ: ${ticket.profileUrl}\nВариант: ${optionLabel}`);
  await telegramApi(context.env, 'sendMessage', { chat_id: session.chatId, text: `Заявка ${ticket.id} отправлена оператору.`, reply_markup: telegramMainKeyboard() });
}

async function reviewTelegramTicket(context, ticket, decision, reviewer = 'web-admin') {
  if (ticket.source !== 'telegram' || ticket.stage !== 'profile_review' || ticket.telegramReview !== 'pending') throw new Error('Эта заявка уже обработана');
  const reviewedAt = now();
  if (decision === 'approve') { ticket.stage = 'awaiting_option'; ticket.telegramReview = 'approved'; ticket.status = 'in_progress'; ticket.reviewDecision = 'approved'; ticket.reviewedBy = reviewer; ticket.reviewedAt = reviewedAt; const session = telegramSession(context.db, ticket.telegramChatId); if (session) session.step = 'awaiting_option'; else context.db.telegramSessions.push({ id: id('tgs'), chatId: ticket.telegramChatId, telegramUserId: ticket.telegramUserId, telegramUsername: ticket.telegramUsername, ticketId: ticket.id, step: 'awaiting_option', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt: reviewedAt, updatedAt: reviewedAt }); ticket.messages.push({ id: id('msg'), author: 'admin', message: 'Оператор подтвердил ссылку на профиль.', createdAt: reviewedAt }); ticket.updatedAt = reviewedAt; await telegramSave(context); await telegramApi(context.env, 'sendMessage', { chat_id: ticket.telegramChatId, text: 'Профиль прошел ручную проверку. Теперь выберите вариант заявки.', reply_markup: telegramOptionKeyboard() }); return 'Профиль подтвержден.'; }
  if (decision === 'reject') { ticket.stage = 'rejected'; ticket.telegramReview = 'rejected'; ticket.status = 'closed'; ticket.reviewDecision = 'rejected'; ticket.reviewedBy = reviewer; ticket.reviewedAt = reviewedAt; ticket.messages.push({ id: id('msg'), author: 'admin', message: 'Оператор отклонил ссылку на профиль.', createdAt: reviewedAt }); context.db.telegramSessions = context.db.telegramSessions.filter(item => item.chatId !== ticket.telegramChatId); ticket.updatedAt = reviewedAt; await telegramSave(context); await telegramApi(context.env, 'sendMessage', { chat_id: ticket.telegramChatId, text: `Заявка ${ticket.id}: профиль не прошел проверку.`, reply_markup: telegramMainKeyboard() }); return 'Профиль отклонен.'; }
  throw new Error('Некорректное решение по профилю');
}

async function handleTelegramMessage(context, message) {
  if (!message?.chat?.id || !message.from || message.chat.type !== 'private') return;
  const input = asText(message.text, 3000); const command = input.match(/^\/(start|help|cancel|status)(?:@[^\s]+)?/i)?.[1]?.toLowerCase(); const db = context.db; const chatId = String(message.chat.id);
  if (command === 'start' || command === 'help') return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Здесь можно оставить заявку. Не отправляйте пароли, cookies, коды или платежные данные.', reply_markup: telegramMainKeyboard() });
  if (command === 'status') { const tickets = telegramTicketsForChat(db, chatId); return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: tickets.length ? tickets.slice(0, 3).map(ticket => `${ticket.id} · ${telegramStatusLabel(ticket)}`).join('\n') : 'Заявок пока нет.', reply_markup: telegramMainKeyboard() }); }
  if (command === 'cancel') { db.telegramSessions = db.telegramSessions.filter(item => item.chatId !== chatId); await telegramSave(context); return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Текущий шаг отменен.', reply_markup: telegramMainKeyboard() }); }
  const session = telegramSession(db, chatId);
  if (!session) return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Сессия истекла. Нажмите «Подать заявку».', reply_markup: telegramMainKeyboard() });
  if (session.step === 'awaiting_profile') { const profileUrl = normalizeTelegramProfileUrl(context.env, input); if (!profileUrl) return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Нужна публичная HTTPS-ссылка на профиль LOLZ.' }); session.profileUrl = profileUrl; session.step = 'awaiting_review'; await telegramSave(context); return telegramCreateProfileReview(context, session); }
  if (session.step === 'awaiting_review') return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Профиль еще проверяется оператором.', reply_markup: telegramMainKeyboard() });
  if (session.step === 'awaiting_option') return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Выберите вариант кнопкой ниже.', reply_markup: telegramOptionKeyboard() });
  if (session.step === 'awaiting_comment') { if (!input) return telegramApi(context.env, 'sendMessage', { chat_id: message.chat.id, text: 'Напишите комментарий или пропустите шаг.', reply_markup: telegramCommentKeyboard() }); session.applicationComment = input; return telegramSubmitApplication(context, session); }
}

async function handleTelegramCallback(context, callbackQuery) {
  if (!callbackQuery?.message?.chat?.id || !callbackQuery.from) return;
  const chat = callbackQuery.message.chat; const from = callbackQuery.from; const action = String(callbackQuery.data || ''); const db = context.db;
  await telegramApi(context.env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => null);
  const reviewMatch = action.match(/^review:(approve|reject):([^:]+)$/);
  if (reviewMatch) { if (!telegramIsAdminCallback(context.env, callbackQuery)) return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Эта кнопка доступна только администратору.' }); const ticket = db.tickets.find(item => item.id === reviewMatch[2] && item.source === 'telegram'); if (!ticket) return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Заявка не найдена.' }); return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: await reviewTelegramTicket(context, ticket, reviewMatch[1], `telegram:${from.id}`) }); }
  if (chat.type !== 'private') return;
  if (action === 'status') return handleTelegramMessage(context, { chat, from, text: '/status' });
  if (action === 'apply:start') return telegramStartApplication(context, chat, from);
  if (action === 'apply:cancel') { db.telegramSessions = db.telegramSessions.filter(item => item.chatId !== String(chat.id)); await telegramSave(context); return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Заявка отменена.', reply_markup: telegramMainKeyboard() }); }
  const session = telegramSession(db, chat.id); if (!session) return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Сессия истекла.', reply_markup: telegramMainKeyboard() });
  if (['apply:freedep', 'apply:redeposit_return', 'apply:deposit_50_50'].includes(action)) { if (session.step !== 'awaiting_option') return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Сначала дождитесь проверки профиля.', reply_markup: telegramMainKeyboard() }); session.applicationType = action.slice(6); session.step = 'awaiting_comment'; await telegramSave(context); return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: `Вы выбрали «${TELEGRAM_APPLICATION_OPTIONS[session.applicationType]}». Напишите комментарий или пропустите.`, reply_markup: telegramCommentKeyboard() }); }
  if (action === 'apply:skip') { if (session.step !== 'awaiting_comment') return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Сначала выберите вариант.', reply_markup: telegramOptionKeyboard() }); return telegramSubmitApplication(context, session); }
  return telegramApi(context.env, 'sendMessage', { chat_id: chat.id, text: 'Команда устарела.', reply_markup: telegramMainKeyboard() });
}

async function processTelegramUpdate(context, update) {
  if (update.message) return handleTelegramMessage(context, update.message);
  if (update.callback_query) return handleTelegramCallback(context, update.callback_query);
}

async function handleTelegramWebhook(request, env) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '');
  if (!env.TELEGRAM_BOT_TOKEN || !secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return fail(403, 'Недопустимое уведомление Telegram');
  const update = await requestBody(request);
  const context = await loadContext(env, request);
  const updateId = Number(update?.update_id);
  if (Number.isInteger(updateId) && updateId <= Number(context.db.telegram.lastUpdateId || 0)) return json({ ok: true });
  await processTelegramUpdate(context, update);
  if (Number.isInteger(updateId)) { context.db.telegram.lastUpdateId = updateId; await saveContext(context); }
  return json({ ok: true });
}

async function api(request, env, pathname) {
  if (pathname === '/api/telegram/webhook' && request.method === 'POST') return handleTelegramWebhook(request, env);
  if (pathname === '/api/payments/yookassa/webhook' && request.method === 'POST') return handleYooKassaWebhook(request, env);
  if (!sameOrigin(request, env) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) return fail(403, 'Недопустимый источник запроса');
  if (pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'slowyshop-workers', paymentMode: paymentMode(env), database: 'd1', email: { configured: Boolean(env.RESEND_API_KEY), required: envBool(env, 'EMAIL_REQUIRED', true) }, telegram: { configured: Boolean(env.TELEGRAM_BOT_TOKEN) } });
  const context = await loadContext(env, request);
  await ensureAdmin(context);
  const db = context.db;
  if (pruneEmailCodes(db) || cleanupExpiredReservations(db)) await saveContext(context);
  const method = request.method;

  if (pathname === '/api/products' && method === 'GET') return json(db.products.filter(product => product.active !== false).map(product => publicProduct(product, db)));
  if (pathname === '/api/auth/me' && method === 'GET') return json({ user: publicUser(await sessionUser(request, context)) || null });

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!rateLimit(request, 'register', 5, 3600000)) return fail(429, 'Слишком много попыток регистрации');
    const input = await requestBody(request); const email = asText(input.email, 200).toLowerCase(); const password = String(input.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 200) return fail(400, 'Введите корректный email и пароль от 8 до 200 символов');
    if (db.users.some(user => user.email === email)) return fail(409, 'Пользователь с таким email уже существует');
    try { const result = await issueEmailCode(env, db, email, await hashPassword(password)); await saveContext(context); return json(result, 202); } catch (error) { return fail(502, error.message); }
  }

  if (pathname === '/api/auth/resend-code' && method === 'POST') {
    if (!rateLimit(request, 'resend-code', 5, 900000)) return fail(429, 'Слишком много запросов кода');
    const input = await requestBody(request); const email = asText(input.email, 200).toLowerCase(); const pending = db.emailCodes.find(item => item.email === email);
    if (!pending) return fail(400, 'Сначала начните регистрацию');
    try { const result = await issueEmailCode(env, db, email, pending.passwordHash); await saveContext(context); return json(result, 202); } catch (error) { return fail(502, error.message); }
  }

  if (pathname === '/api/auth/verify-email' && method === 'POST') {
    if (!rateLimit(request, 'verify-email', 10, 900000)) return fail(429, 'Слишком много попыток подтверждения');
    const input = await requestBody(request); const email = asText(input.email, 200).toLowerCase(); const pending = db.emailCodes.find(item => item.email === email);
    if (!pending || pending.expiresAt < Date.now() || String(input.code || '') !== pending.code) return fail(400, 'Неверный или просроченный код');
    if (db.users.some(user => user.email === email)) return fail(409, 'Пользователь с таким email уже существует');
    const user = { id: id('usr'), email, passwordHash: pending.passwordHash, role: 'user', createdAt: now(), emailVerified: true }; db.users.push(user); db.emailCodes = db.emailCodes.filter(item => item !== pending); const session = await createSession(db, user); await saveContext(context);
    return json({ user: session.user }, 200, { 'Set-Cookie': sessionCookie(session.token, env) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!rateLimit(request, 'login', 10, 900000)) return fail(429, 'Слишком много попыток входа');
    const input = await requestBody(request); const email = asText(input.email, 200).toLowerCase(); const user = db.users.find(item => item.email === email);
    if (!user || !(await passwordMatches(String(input.password || ''), user.passwordHash))) return fail(401, 'Неверный email или пароль');
    const session = await createSession(db, user); await saveContext(context); return json({ user: session.user }, 200, { 'Set-Cookie': sessionCookie(session.token, env) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(request).slowy_session;
    const hashedToken = await tokenHash(token || '');
    db.sessions = db.sessions.filter(session => session.tokenHash !== hashedToken);
    await saveContext(context);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', env, 0) });
  }

  if (pathname === '/api/orders' && method === 'GET') {
    const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация');
    return json(db.orders.filter(order => order.userId === user.id).map(order => orderForClient(order, true)));
  }

  if (pathname === '/api/orders' && method === 'POST') {
    if (!rateLimit(request, 'create-order', 20, 900000)) return fail(429, 'Слишком много заказов. Попробуйте позже');
    const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация');
    const input = await requestBody(request); const rawItems = Array.isArray(input.items) ? input.items : []; if (!rawItems.length || rawItems.length > 20) return fail(400, 'Корзина пуста или содержит слишком много позиций');
    const quantities = new Map();
    for (const item of rawItems) { const productId = asText(item.productId, 100); const quantity = Math.floor(Number(item.quantity)); if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail(400, 'Некорректное количество товара'); quantities.set(productId, (quantities.get(productId) || 0) + quantity); }
    const normalized = []; let totalCents = 0;
    for (const [productId, quantity] of quantities) { const product = db.products.find(item => item.id === productId && item.active !== false); if (!product) return fail(400, 'Товар недоступен'); if (quantity > 10) return fail(400, 'Слишком большое количество одного товара'); if (availableInventory(db, product.id).length < quantity) return fail(400, `Недостаточно товара: ${product.name}`); const price = Math.round(Number(product.price) * 100) / 100; normalized.push({ productId: product.id, name: product.name, price, quantity, delivery: product.delivery }); totalCents += Math.round(price * 100) * quantity; }
    const orderId = id('ord'); const expiresAt = new Date(Date.now() + RESERVATION_TTL).toISOString(); const reserved = reserveInventory(db, normalized, orderId, expiresAt); if (!reserved) return fail(409, 'Товар только что закончился. Обновите корзину');
    let offset = 0; for (const item of normalized) { item.inventoryIds = reserved.slice(offset, offset + item.quantity).map(record => record.id); offset += item.quantity; }
    const order = { id: orderId, userId: user.id, email: user.email, items: normalized, total: totalCents / 100, totalCents, currency: 'RUB', status: 'awaiting_payment', paymentStatus: 'unpaid', paymentProvider: paymentMode(env), reservationExpiresAt: expiresAt, createdAt: now(), updatedAt: now() }; db.orders.unshift(order); await saveContext(context);
    let payment = { mode: paymentMode(env), orderId };
    try {
      if (paymentMode(env) === 'yookassa') { const providerPayment = await createYooKassaPayment(env, request, order); order.paymentId = providerPayment.id; order.paymentUrl = providerPayment.url; order.updatedAt = now(); await saveContext(context); payment = { mode: 'yookassa', orderId, paymentId: providerPayment.id, confirmationUrl: providerPayment.url }; }
      else if (paymentMode(env) === 'demo') payment = { mode: 'demo', orderId, paymentId: `demo_${order.id}`, confirmationUrl: null };
      else throw new Error('Неизвестный PAYMENT_MODE');
    } catch (error) { releaseReservations(db, order); order.status = 'payment_failed'; order.paymentStatus = 'failed'; order.updatedAt = now(); await saveContext(context); return fail(502, error.message); }
    return json({ order: orderForClient(order, true), payment }, 201);
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === 'GET') { const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const order = db.orders.find(item => item.id === orderMatch[1] && item.userId === user.id); return order ? json(orderForClient(order, true)) : fail(404, 'Заказ не найден'); }

  const deliveryMatch = pathname.match(/^\/api\/orders\/([^/]+)\/delivery$/);
  if (deliveryMatch && method === 'GET') {
    const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const order = db.orders.find(item => item.id === deliveryMatch[1] && item.userId === user.id); if (!order) return fail(404, 'Заказ не найден'); if (order.paymentStatus !== 'paid' || !['paid', 'fulfilled'].includes(order.status) || !order.deliveryAvailableAt) return fail(402, 'Данные появятся после подтверждения оплаты и выдачи заказа');
    const items = []; for (const item of order.items || []) for (const inventoryId of item.inventoryIds || []) { const inventory = db.inventory.find(record => record.id === inventoryId && record.orderId === order.id); if (!inventory) return fail(500, 'Данные товара недоступны'); items.push({ productId: item.productId, productName: item.name, ...await decryptSecret(env, inventory.secret) }); }
    order.deliveredAt = order.deliveredAt || now(); order.deliveryViews = Number(order.deliveryViews || 0) + 1; order.updatedAt = now(); await saveContext(context); return json({ orderId: order.id, items, viewedAt: order.deliveredAt });
  }

  const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') { const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const order = db.orders.find(item => item.id === cancelMatch[1] && item.userId === user.id); if (!order) return fail(404, 'Заказ не найден'); if (order.status !== 'awaiting_payment') return fail(400, 'Этот заказ уже нельзя отменить самостоятельно'); releaseReservations(db, order); order.status = 'cancelled'; order.paymentStatus = 'unpaid'; order.updatedAt = now(); await saveContext(context); return json(orderForClient(order)); }

  if (pathname === '/api/payments/demo/confirm' && method === 'POST') { if (paymentMode(env) !== 'demo') return fail(404, 'Demo-платежи отключены'); if (!rateLimit(request, 'demo-payment', 10, 900000)) return fail(429, 'Слишком много попыток оплаты'); const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const input = await requestBody(request); const order = db.orders.find(item => item.id === asText(input.orderId, 100) && item.userId === user.id); if (!order) return fail(404, 'Заказ не найден'); try { markOrderPaid(db, order, `demo_${order.id}`); } catch (error) { return fail(400, error.message); } await saveContext(context); return json(orderForClient(order)); }

  const paymentRefresh = pathname.match(/^\/api\/orders\/([^/]+)\/refresh-payment$/);
  if (paymentRefresh && method === 'POST') { const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const order = db.orders.find(item => item.id === paymentRefresh[1] && item.userId === user.id); if (!order) return fail(404, 'Заказ не найден'); if (paymentMode(env) !== 'yookassa' || !order.paymentId) return json(orderForClient(order, true)); const payment = await verifyYooKassaPayment(env, order.paymentId); if (payment.amount?.currency !== 'RUB' || Number(payment.amount?.value) !== Number(order.total)) return fail(400, 'Сумма платежа не совпадает'); if (payment.status === 'succeeded' && order.paymentStatus !== 'paid') { try { if (['expired', 'cancelled'].includes(order.status) || (order.reservationExpiresAt && Date.parse(order.reservationExpiresAt) <= Date.now())) throw new Error('Заказ больше не может быть выдан'); markOrderPaid(db, order, payment.id); } catch { await refundYooKassaPayment(env, payment); order.status = 'refunded'; order.paymentStatus = 'refunded'; order.updatedAt = now(); } } await saveContext(context); return json(orderForClient(order, true)); }

  if (pathname === '/api/tickets' && method === 'GET') { const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); return json(db.tickets.filter(ticket => ticket.userId === user.id)); }
  if (pathname === '/api/tickets' && method === 'POST') { if (!rateLimit(request, 'ticket', 10, 3600000)) return fail(429, 'Слишком много обращений'); const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const input = await requestBody(request); const subject = asText(input.subject, 160); const message = asText(input.message, 3000); const orderId = asText(input.orderId, 100) || null; if (subject.length < 3 || message.length < 5) return fail(400, 'Заполните тему и сообщение'); if (orderId && !db.orders.some(order => order.id === orderId && order.userId === user.id)) return fail(400, 'Заказ не найден'); const ticket = { id: id('tkt'), userId: user.id, email: user.email, orderId, subject, message, messages: [{ id: id('msg'), author: 'customer', message, createdAt: now() }], status: 'open', createdAt: now(), updatedAt: now() }; db.tickets.unshift(ticket); await saveContext(context); return json(ticket, 201); }

  const userTicketReply = pathname.match(/^\/api\/tickets\/([^/]+)\/reply$/);
  if (userTicketReply && method === 'POST') { if (!rateLimit(request, 'ticket-reply', 20, 3600000)) return fail(429, 'Слишком много ответов'); const user = await requireUser(request, context); if (!user) return fail(401, 'Требуется авторизация'); const ticket = db.tickets.find(item => item.id === userTicketReply[1] && item.userId === user.id); if (!ticket) return fail(404, 'Обращение не найдено'); const input = await requestBody(request); const message = asText(input.message, 3000); if (!message) return fail(400, 'Введите сообщение'); if (!Array.isArray(ticket.messages)) ticket.messages = []; ticket.messages.push({ id: id('msg'), author: 'customer', message, createdAt: now() }); ticket.status = 'open'; ticket.updatedAt = now(); await saveContext(context); if (env.ADMIN_EMAIL) await sendMail(env, env.ADMIN_EMAIL, `slowyshop — новый ответ ${ticket.id}`, message).catch(() => {}); return json(ticket, 201); }

  const adminProductMatch = pathname.match(/^\/api\/admin\/products(?:\/([^/]+))?$/);
  if (adminProductMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const productId = adminProductMatch[1];
    if (method === 'POST') { const product = cleanProduct(await requestBody(request)); if (!product) return fail(400, 'Некорректные данные товара'); product.id = id('prd'); product.createdAt = now(); db.products.push(product); await saveContext(context); return json(adminProduct(product, db), 201); }
    const product = db.products.find(item => item.id === productId); if (!product) return fail(404, 'Товар не найден');
    if (method === 'DELETE') { product.active = false; product.updatedAt = now(); await saveContext(context); return json({ ok: true, product: adminProduct(product, db) }); }
    const updated = cleanProduct(await requestBody(request), product); if (!updated) return fail(400, 'Некорректные данные товара'); Object.assign(product, updated, { updatedAt: now() }); await saveContext(context); return json(adminProduct(product, db));
  }
  if (pathname === '/api/admin/products' && method === 'GET') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); return json(db.products.map(product => adminProduct(product, db))); }

  if (pathname === '/api/admin/inventory' && method === 'GET') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const productId = asText(new URL(request.url).searchParams.get('productId'), 100); return json(db.inventory.filter(item => !productId || item.productId === productId).map(inventoryForAdmin)); }
  if (pathname === '/api/admin/inventory' && method === 'POST') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const input = await requestBody(request); const product = db.products.find(item => item.id === asText(input.productId, 100)); const login = asText(input.login, 500); const password = String(input.password || '').slice(0, 1000); if (!product || !login || !password) return fail(400, 'Выберите товар и заполните логин и пароль'); const inventory = { id: id('inv'), productId: product.id, status: 'available', loginHint: login.length > 4 ? `${login.slice(0, 2)}***${login.slice(-2)}` : 'скрыт', secret: await encryptSecret(env, { login, password, extra: asText(input.extra, 2000) }), createdAt: now() }; db.inventory.push(inventory); await saveContext(context); return json(inventoryForAdmin(inventory), 201); }
  if (pathname === '/api/admin/inventory/bulk' && method === 'POST') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const input = await requestBody(request); const product = db.products.find(item => item.id === asText(input.productId, 100)); const lines = Array.isArray(input.accounts) ? input.accounts : String(input.accounts || '').split(/\r?\n/); if (!product || !lines.length) return fail(400, 'Выберите товар и добавьте строки аккаунтов'); let added = 0; let skipped = 0; for (const rawLine of lines) { const line = rawLine && typeof rawLine === 'object' ? `${rawLine.login || ''}|${rawLine.password || ''}|${rawLine.extra || ''}` : String(rawLine || '').trim(); if (!line || line.startsWith('#')) continue; const parts = line.split('|'); const login = asText(parts[0], 500); const password = String(parts[1] || '').slice(0, 1000); if (!login || !password) { skipped += 1; continue; } db.inventory.push({ id: id('inv'), productId: product.id, status: 'available', loginHint: login.length > 4 ? `${login.slice(0, 2)}***${login.slice(-2)}` : 'скрыт', secret: await encryptSecret(env, { login, password, extra: asText(parts.slice(2).join('|'), 2000) }), createdAt: now() }); added += 1; } await saveContext(context); return json({ added, skipped }, 201); }

  const inventoryMatch = pathname.match(/^\/api\/admin\/inventory\/([^/]+)$/);
  if (inventoryMatch && ['PATCH', 'DELETE'].includes(method)) { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const inventory = db.inventory.find(item => item.id === inventoryMatch[1]); if (!inventory) return fail(404, 'Единица товара не найдена'); if (method === 'DELETE') { if (!['available', 'blocked'].includes(inventory.status)) return fail(400, 'Проданный или зарезервированный аккаунт нельзя удалить'); db.inventory = db.inventory.filter(item => item !== inventory); await saveContext(context); return json({ ok: true }); } const input = await requestBody(request); if (!['available', 'blocked'].includes(input.status) || !['available', 'blocked'].includes(inventory.status)) return fail(400, 'Можно менять только доступный или заблокированный аккаунт'); inventory.status = input.status; await saveContext(context); return json(inventoryForAdmin(inventory)); }

  if (pathname === '/api/admin/orders' && method === 'GET') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); return json(db.orders.map(order => ({ ...orderForClient(order), email: order.email, userId: order.userId, paymentId: order.paymentId || null }))); }
  const adminOrder = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (adminOrder && method === 'PATCH') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const order = db.orders.find(item => item.id === adminOrder[1]); if (!order) return fail(404, 'Заказ не найден'); const input = await requestBody(request); try { if (input.status === 'fulfilled') { if (order.paymentStatus !== 'paid') throw new Error('Сначала подтвердите оплату'); order.status = 'fulfilled'; order.deliveryAvailableAt = order.deliveryAvailableAt || now(); } else if (input.status === 'refunded') { if (paymentMode(env) === 'yookassa' && order.paymentId) await refundYooKassaPayment(env, { id: order.paymentId, amount: { value: Number(order.total).toFixed(2), currency: 'RUB' } }); refundOrder(db, order); } else if (input.status === 'cancelled' && order.status === 'awaiting_payment') { releaseReservations(db, order); order.status = 'cancelled'; order.paymentStatus = 'unpaid'; } else if (input.status !== order.status) return fail(400, 'Недопустимый переход статуса'); order.updatedAt = now(); } catch (error) { return fail(400, error.message); } await saveContext(context); return json(orderForClient(order)); }
  if (pathname === '/api/admin/stats' && method === 'GET') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); return json({ revenue: db.orders.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + Number(order.total || 0), 0), orders: db.orders.length, customers: db.users.filter(item => item.role === 'user').length, products: db.products.filter(item => item.active !== false).length, availableInventory: db.inventory.filter(item => item.status === 'available').length, openTickets: db.tickets.filter(item => item.status === 'open').length }); }
  if (pathname === '/api/admin/tickets' && method === 'GET') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); return json(db.tickets.map(ticket => ({ ...ticket, telegram: ticket.source === 'telegram' ? { chatId: ticket.telegramChatId || null, userId: ticket.telegramUserId || null, username: ticket.telegramUsername || null, profileUrl: ticket.profileUrl || null, applicationType: ticket.applicationType || null, applicationComment: ticket.applicationComment || null } : null }))); }

  const adminTicketReply = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/reply$/);
  if (adminTicketReply && method === 'POST') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const ticket = db.tickets.find(item => item.id === adminTicketReply[1]); if (!ticket) return fail(404, 'Обращение не найдено'); const input = await requestBody(request); const message = asText(input.message, 3000); if (!message) return fail(400, 'Введите ответ'); ticket.messages = Array.isArray(ticket.messages) ? ticket.messages : []; ticket.messages.push({ id: id('msg'), author: 'admin', message, createdAt: now() }); ticket.status = 'in_progress'; ticket.updatedAt = now(); await saveContext(context); if (ticket.email) await sendMail(env, ticket.email, `slowyshop — ответ по обращению ${ticket.id}`, message).catch(() => {}); await notifyTelegramTicket(env, ticket, message).catch(() => {}); return json(ticket, 201); }

  const adminProductImage = pathname.match(/^\/api\/admin\/products\/([^/]+)\/image$/);
  if (adminProductImage && method === 'POST') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const product = db.products.find(item => item.id === adminProductImage[1]); if (!product) return fail(404, 'Товар не найден'); const input = await requestBody(request); const rawImage = asText(input.image, 2_000_000); const image = cleanImage(rawImage); if (rawImage && !image) return fail(400, 'Некорректное изображение'); product.image = image; product.updatedAt = now(); await saveContext(context); return json(adminProduct(product, db)); }

  const adminTicket = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (adminTicket && method === 'PATCH') { const user = await requireUser(request, context); if (!user || user.role !== 'admin') return fail(user ? 403 : 401, 'Недостаточно прав'); const ticket = db.tickets.find(item => item.id === adminTicket[1]); if (!ticket) return fail(404, 'Обращение не найдено'); const input = await requestBody(request); if (ticket.source === 'telegram' && ['approve_profile', 'reject_profile'].includes(input.status)) { try { return json({ ...ticket, reviewMessage: await reviewTelegramTicket(context, ticket, input.status === 'approve_profile' ? 'approve' : 'reject', `web:${user.id}`) }); } catch (error) { return fail(400, error.message); } } if (!['open', 'in_progress', 'closed'].includes(input.status)) return fail(400, 'Некорректный статус обращения'); ticket.status = input.status; ticket.updatedAt = now(); await saveContext(context); return json(ticket); }
  return fail(404, 'Маршрут не найден');
}

export class StoreCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const task = this.queue.catch(() => null).then(async () => {
      try { return await api(request, this.env, new URL(request.url).pathname); }
      catch (error) { console.error(error); return fail(500, 'Внутренняя ошибка сервера'); }
    });
    this.queue = task.then(() => null, () => null);
    return task;
  }
}

export default {
  async fetch(request, env) {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith('/api/')) {
        const id = env.COORDINATOR.idFromName('slowyshop-store');
        return env.COORDINATOR.get(id).fetch(request);
      }
      const response = await env.ASSETS.fetch(request);
      if (!response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com");
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(error);
      return fail(500, 'Внутренняя ошибка сервера');
    }
  },
};
