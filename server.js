const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');

const ROOT = __dirname;

loadEnvFile();

const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || path.join('data', 'db.json'));
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const PAYMENT_MODE = String(process.env.PAYMENT_MODE || 'demo').toLowerCase();
const APP_ORIGIN = String(process.env.APP_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const EMAIL_REQUIRED = IS_PRODUCTION || process.env.EMAIL_REQUIRED === 'true';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL = Math.max(5, Number(process.env.RESERVATION_MINUTES || 15)) * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const COOKIE_SECURE = IS_PRODUCTION || process.env.COOKIE_SECURE === 'true';
const SEED_DEMO_INVENTORY = !IS_PRODUCTION && process.env.SEED_DEMO_INVENTORY !== 'false';
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_MODE = String(process.env.TELEGRAM_MODE || 'polling').toLowerCase();
const TELEGRAM_WEBHOOK_URL = String(process.env.TELEGRAM_WEBHOOK_URL || '').trim().replace(/\/$/, '');
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TELEGRAM_ADMIN_CHAT_IDS = parseTelegramIds(process.env.TELEGRAM_ADMIN_CHAT_IDS);
const TELEGRAM_ADMIN_USER_IDS = parseTelegramIds(process.env.TELEGRAM_ADMIN_USER_IDS);
const TELEGRAM_ALLOWED_HOSTS = String(process.env.LOLZ_ALLOWED_HOSTS || 'lolz.live,lolz.guru').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
const TELEGRAM_SESSION_TTL = Math.max(5, Number(process.env.TELEGRAM_SESSION_MINUTES || 30)) * 60 * 1000;
const TELEGRAM_APPLICATION_COOLDOWN = Math.max(1, Number(process.env.TELEGRAM_APPLICATION_COOLDOWN_HOURS || 24)) * 60 * 60 * 1000;

let database;
let writeQueue = Promise.resolve();
const emailCodes = new Map();
const rateBuckets = new Map();
const telegramRateBuckets = new Map();
let telegramUpdateQueue = Promise.resolve();
let telegramPolling = false;
let mailTransport;

function loadEnvFile() {
  try {
    const envFile = require('node:fs').readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}

function parseTelegramIds(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(item => /^-?\d+$/.test(item)))];
}

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
const json = (res, status, payload, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};
const fail = (res, status, message, details) => json(res, status, { error: message, ...(details ? { details } : {}) });

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, key, limit, windowMs) {
  const bucketKey = `${key}:${clientIp(req)}`;
  const current = rateBuckets.get(bucketKey);
  const timestamp = Date.now();
  if (!current || current.expiresAt <= timestamp) {
    rateBuckets.set(bucketKey, { count: 1, expiresAt: timestamp + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

setInterval(() => {
  const timestamp = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.expiresAt <= timestamp) rateBuckets.delete(key);
  for (const [email, pending] of emailCodes) if (pending.expiresAt <= timestamp) emailCodes.delete(email);
  for (const [chatId, bucket] of telegramRateBuckets) if (bucket.expiresAt <= timestamp) telegramRateBuckets.delete(chatId);
}, 60_000).unref();

async function loadDatabase() {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { users: [], products: [], orders: [], inventory: [], tickets: [], sessions: [], telegramSessions: [], telegram: { lastUpdateId: 0 } };
    throw new Error(`Не удалось прочитать базу данных: ${error.message}`);
  }
}

async function getDatabase() {
  if (!database) {
    database = await loadDatabase();
    const changed = migrateDatabase(database);
    if (changed) await writeDatabase();
  }
  return database;
}

function writeDatabase() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const temporaryPath = `${DB_PATH}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(database, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, DB_PATH);
  });
  return writeQueue;
}

function migrateDatabase(db) {
  let changed = false;
  for (const key of ['users', 'products', 'orders', 'inventory', 'tickets', 'sessions', 'telegramSessions']) {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  }
  if (!db.telegram || typeof db.telegram !== 'object' || Array.isArray(db.telegram)) { db.telegram = { lastUpdateId: 0 }; changed = true; }
  if (!Number.isInteger(db.telegram.lastUpdateId) || db.telegram.lastUpdateId < 0) { db.telegram.lastUpdateId = 0; changed = true; }
  for (const product of db.products) {
    if (product.legacyStock === undefined && Number(product.stock) > 0) {
      product.legacyStock = Number(product.stock);
      product.stock = 0;
      changed = true;
    }
    if (product.legacyStock > 0 && !product.legacyInventorySeeded) {
      if (SEED_DEMO_INVENTORY) {
        for (let index = 0; index < product.legacyStock; index += 1) {
          const login = `demo-${product.id}-${index + 1}@example.invalid`;
          db.inventory.push({
            id: id('inv'),
            productId: product.id,
            status: 'available',
            loginHint: `de***${String(index + 1).padStart(2, '0')}`,
            secret: encryptSecret({ login, password: `Demo-${crypto.randomBytes(8).toString('hex')}`, extra: 'Демонстрационный товар. Перед реальными продажами импортируйте собственные аккаунты.' }),
            createdAt: now(),
          });
        }
      }
      product.legacyInventorySeeded = true;
      changed = true;
    }
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
    for (const item of order.items || []) {
      if (!Array.isArray(item.inventoryIds)) { item.inventoryIds = []; changed = true; }
    }
  }
  for (const ticket of db.tickets) {
    if (!Array.isArray(ticket.messages)) {
      ticket.messages = ticket.message ? [{ id: id('msg'), author: 'customer', message: ticket.message, createdAt: ticket.createdAt || now() }] : [];
      changed = true;
    }
  }
  return changed;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)));
}

async function passwordMatches(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key || !/^[a-f0-9]+$/i.test(key) || key.length !== 128) return false;
  const candidate = await hashPassword(password, salt);
  const candidateBuffer = Buffer.from(candidate.split(':')[1], 'hex');
  const storedBuffer = Buffer.from(key, 'hex');
  return candidateBuffer.length === storedBuffer.length && crypto.timingSafeEqual(candidateBuffer, storedBuffer);
}

function secretKey() {
  const configured = process.env.ENCRYPTION_KEY;
  if (IS_PRODUCTION && (!configured || configured.length < 32)) throw new Error('ENCRYPTION_KEY must be configured in production');
  return crypto.createHash('sha256').update(String(configured || 'local-development-key-change-me')).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const [ivText, tagText, encryptedText] = String(value || '').split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted inventory record');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8'));
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified !== false, createdAt: user.createdAt };
}

function publicProduct(product, db) {
  const inventoryTotal = db.inventory.filter(item => item.productId === product.id && ['available', 'reserved', 'sold', 'blocked'].includes(item.status));
  const stock = inventoryTotal.filter(item => item.status === 'available').length;
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    price: Number(product.price),
    currency: 'RUB',
    delivery: product.delivery,
    active: product.active !== false,
    stock,
    icon: product.icon || '✦',
    accent: product.accent || '#a98cff',
    bg: product.bg || '#27213a',
    color: product.color || '#bcaaff',
    image: product.image || null,
    createdAt: product.createdAt,
  };
}

function adminProduct(product, db) {
  const all = db.inventory.filter(item => item.productId === product.id);
  return { ...publicProduct(product, db), inventoryTotal: all.length, reserved: all.filter(item => item.status === 'reserved').length, sold: all.filter(item => item.status === 'sold').length, blocked: all.filter(item => item.status === 'blocked').length };
}

function orderItemsForClient(order) {
  return (order.items || []).map(item => ({ productId: item.productId, name: item.name, price: item.price, quantity: item.quantity }));
}

function orderForClient(order, includePayment = false) {
  return {
    id: order.id,
    items: orderItemsForClient(order),
    total: order.total,
    totalCents: order.totalCents,
    currency: order.currency || 'RUB',
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentProvider: order.paymentProvider,
    reservationExpiresAt: order.reservationExpiresAt || null,
    deliveryAvailable: Boolean(order.deliveryAvailableAt) && ['paid', 'fulfilled'].includes(order.status),
    deliveryAvailableAt: order.deliveryAvailableAt || null,
    deliveredAt: order.deliveredAt || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(includePayment && order.paymentUrl ? { paymentUrl: order.paymentUrl } : {}),
  };
}

function inventoryForAdmin(item) {
  return {
    id: item.id,
    productId: item.productId,
    status: item.status,
    loginHint: item.loginHint || 'скрыт',
    orderId: item.orderId || null,
    createdAt: item.createdAt,
    soldAt: item.soldAt || null,
  };
}

function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function sessionUser(req, db) {
  const token = cookies(req).slowy_session;
  if (!token) return null;
  const session = db.sessions.find(item => item.tokenHash === tokenHash(token));
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    db.sessions = db.sessions.filter(item => item !== session);
    await writeDatabase();
    return null;
  }
  return db.users.find(user => user.id === session.userId) || null;
}

async function requireUser(req, res, db) {
  const user = await sessionUser(req, db);
  if (!user) { fail(res, 401, 'Требуется авторизация'); return null; }
  return user;
}

async function requireAdmin(req, res, db) {
  const user = await requireUser(req, res, db);
  if (user && user.role !== 'admin') { fail(res, 403, 'Недостаточно прав'); return null; }
  return user;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === APP_ORIGIN) return true;
  if (!IS_PRODUCTION && ['localhost', '127.0.0.1'].some(host => origin === `http://${host}:${PORT}`)) return true;
  return false;
}

async function requestBody(req) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_BODY_BYTES) throw new Error('Размер запроса слишком большой');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('Размер запроса слишком большой');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Некорректный JSON'); }
}

function text(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanImage(value) {
  const image = text(value, 2_000_000);
  if (!image) return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(image)) {
    if (image.length > 1_500_000) return null;
    return image;
  }
  try {
    const url = new URL(image);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanProduct(input, existing = {}) {
  const product = { ...existing };
  product.name = text(input.name ?? existing.name, 120);
  product.description = text(input.description ?? existing.description, 1000);
  product.category = text(input.category ?? existing.category ?? 'accounts', 40);
  product.price = Math.round(Number(input.price ?? existing.price) * 100) / 100;
  product.delivery = input.delivery === 'manual' ? 'manual' : 'instant';
  product.active = input.active === undefined ? existing.active !== false : input.active !== false;
  product.icon = text(input.icon ?? existing.icon ?? '✦', 8) || '✦';
  product.accent = text(input.accent ?? existing.accent ?? '#a98cff', 20);
  product.bg = text(input.bg ?? existing.bg ?? '#27213a', 20);
  product.color = text(input.color ?? existing.color ?? '#bcaaff', 20);
  const imageValue = input.image === undefined ? existing.image : input.image;
  product.image = cleanImage(imageValue);
  if (imageValue && !product.image) return null;
  if (!product.name || !product.description || !Number.isFinite(product.price) || product.price < 0 || product.price > 10_000_000) return null;
  return product;
}

function getAvailableInventory(db, productId) {
  return db.inventory.filter(item => item.productId === productId && item.status === 'available');
}

function releaseOrderReservations(db, order) {
  for (const item of order.items || []) {
    for (const inventoryId of item.inventoryIds || []) {
      const inventory = db.inventory.find(record => record.id === inventoryId);
      if (inventory && inventory.status === 'reserved' && inventory.reservedOrderId === order.id) {
        inventory.status = 'available';
        delete inventory.reservedOrderId;
        delete inventory.reservedAt;
        delete inventory.reservationExpiresAt;
      }
    }
  }
}

function cleanupExpiredReservations(db) {
  let changed = false;
  const timestamp = Date.now();
  for (const order of db.orders) {
    if (order.status !== 'awaiting_payment' || !order.reservationExpiresAt || Date.parse(order.reservationExpiresAt) > timestamp) continue;
    releaseOrderReservations(db, order);
    order.status = 'expired';
    order.paymentStatus = 'unpaid';
    order.updatedAt = now();
    changed = true;
  }
  return changed;
}

function reserveInventory(db, items, orderId, expiresAt) {
  const reservedItems = [];
  for (const requested of items) {
    const available = getAvailableInventory(db, requested.productId);
    if (available.length < requested.quantity) {
      for (const reserved of reservedItems) {
        reserved.status = 'available';
        delete reserved.reservedOrderId;
        delete reserved.reservedAt;
        delete reserved.reservationExpiresAt;
      }
      return null;
    }
    const selected = available.slice(0, requested.quantity);
    selected.forEach(record => {
      record.status = 'reserved';
      record.reservedOrderId = orderId;
      record.reservedAt = now();
      record.reservationExpiresAt = expiresAt;
    });
    reservedItems.push(...selected);
  }
  return reservedItems;
}

function markOrderPaid(db, order, providerPaymentId) {
  if (order.paymentStatus === 'paid') return false;
  if (!['awaiting_payment', 'payment_failed'].includes(order.status)) throw new Error('Заказ уже нельзя оплатить');
  if (order.reservationExpiresAt && Date.parse(order.reservationExpiresAt) <= Date.now()) {
    releaseOrderReservations(db, order);
    order.status = 'expired';
    order.paymentStatus = 'unpaid';
    order.updatedAt = now();
    throw new Error('Срок резерва заказа истек');
  }
  const timestamp = now();
  const inventoryRecords = [];
  for (const item of order.items || []) {
    for (const inventoryId of item.inventoryIds || []) {
      const inventory = db.inventory.find(record => record.id === inventoryId);
      if (!inventory || (inventory.status !== 'reserved' && inventory.status !== 'sold') || (inventory.status === 'reserved' && inventory.reservedOrderId !== order.id)) throw new Error('Зарезервированный товар больше недоступен');
      inventoryRecords.push(inventory);
    }
  }
  for (const inventory of inventoryRecords) {
    inventory.status = 'sold';
    inventory.orderId = order.id;
    inventory.soldAt = timestamp;
    delete inventory.reservedOrderId;
    delete inventory.reservedAt;
    delete inventory.reservationExpiresAt;
  }
  order.paymentStatus = 'paid';
  order.paymentId = providerPaymentId || order.paymentId || null;
  order.status = order.items.every(item => item.delivery === 'manual' ? false : true) ? 'fulfilled' : 'paid';
  order.deliveryAvailableAt = order.status === 'fulfilled' ? timestamp : null;
  order.reservationExpiresAt = null;
  order.updatedAt = timestamp;
  return true;
}

function markOrderFulfilled(db, order) {
  if (order.paymentStatus !== 'paid') throw new Error('Сначала подтвердите оплату');
  if (['refunded', 'cancelled'].includes(order.status)) throw new Error('Заказ уже закрыт');
  order.status = 'fulfilled';
  order.deliveryAvailableAt = order.deliveryAvailableAt || now();
  order.updatedAt = now();
}

function refundOrder(db, order) {
  if (order.paymentStatus !== 'paid') throw new Error('Оплаченный заказ не найден');
  if (order.status === 'refunded') return;
  order.status = 'refunded';
  order.paymentStatus = 'refunded';
  order.updatedAt = now();
  for (const item of order.items || []) {
    for (const inventoryId of item.inventoryIds || []) {
      const inventory = db.inventory.find(record => record.id === inventoryId);
      if (inventory && inventory.status === 'sold') inventory.status = 'blocked';
    }
  }
}

function smtpTransport() {
  if (mailTransport) return mailTransport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return mailTransport;
}

async function sendMail(to, subject, body) {
  if (!to) return;
  const transporter = smtpTransport();
  if (!transporter) {
    if (EMAIL_REQUIRED) throw new Error('Email-сервис не настроен. Заполните SMTP_HOST, SMTP_USER и SMTP_PASS');
    console.log(`[slowyshop] Email skipped for ${to}: ${subject}`);
    return;
  }
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text: body });
}

const TELEGRAM_APPLICATION_OPTIONS = {
  freedep: 'Фридеп',
  redeposit_return: 'Редеп с возвращением баланса',
  deposit_50_50: 'Деп 50/50',
};

const TELEGRAM_TICKET_STATUSES = {
  open: 'на проверке',
  in_progress: 'в работе',
  closed: 'закрыта',
};

const telegramSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function telegramIsEnabled() {
  return Boolean(TELEGRAM_BOT_TOKEN);
}

function telegramRecipients() {
  return [...new Set([...TELEGRAM_ADMIN_CHAT_IDS, ...TELEGRAM_ADMIN_USER_IDS])];
}

function telegramRateLimit(chatId) {
  const key = String(chatId);
  const timestamp = Date.now();
  const current = telegramRateBuckets.get(key);
  if (!current || current.expiresAt <= timestamp) {
    telegramRateBuckets.set(key, { count: 1, expiresAt: timestamp + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 30;
}

async function telegramApi(method, payload = {}) {
  if (!telegramIsEnabled()) throw new Error('Telegram-бот не настроен');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API: HTTP ${response.status}`);
  return data.result;
}

async function telegramSendMessage(chatId, message, replyMarkup) {
  const payload = { chat_id: String(chatId), text: String(message).slice(0, 4096), disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi('sendMessage', payload);
}

async function telegramAnswerCallback(callbackQueryId) {
  if (!callbackQueryId || !telegramIsEnabled()) return;
  try { await telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId }); }
  catch (error) { console.warn(`[telegram] callback answer failed: ${error.message}`); }
}

function telegramMainKeyboard() {
  return { inline_keyboard: [[{ text: 'Подать заявку', callback_data: 'apply:start' }], [{ text: 'Моя заявка', callback_data: 'status' }]] };
}

function telegramOptionKeyboard() {
  return { inline_keyboard: [[{ text: 'Фридеп', callback_data: 'apply:freedep' }], [{ text: 'Редеп с возвратом баланса', callback_data: 'apply:redeposit_return' }], [{ text: 'Деп 50/50', callback_data: 'apply:deposit_50_50' }], [{ text: 'Отмена', callback_data: 'apply:cancel' }]] };
}

function telegramReviewKeyboard(ticketId) {
  return { inline_keyboard: [[{ text: 'Ссылка проверена', callback_data: `review:approve:${ticketId}` }], [{ text: 'Отклонить', callback_data: `review:reject:${ticketId}` }]] };
}

function telegramStatusLabel(ticket) {
  if (ticket.stage === 'profile_review') return 'проверка профиля';
  if (ticket.stage === 'awaiting_option') return 'выбор варианта';
  if (ticket.stage === 'rejected') return 'профиль отклонен';
  if (ticket.stage === 'application_review' && ticket.status === 'open') return 'заявка на проверке';
  return telegramTicketStatus(ticket.status);
}

function telegramCommentKeyboard() {
  return { inline_keyboard: [[{ text: 'Пропустить комментарий', callback_data: 'apply:skip' }], [{ text: 'Отмена', callback_data: 'apply:cancel' }]] };
}

function normalizeTelegramProfileUrl(value) {
  const raw = text(value, 500).replace(/\s+/g, '');
  if (!raw || !/^https:\/\//i.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  const validHost = TELEGRAM_ALLOWED_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
  if (!validHost || url.username || url.password || !/^\/(members|profile|profiles|users)\/[^/?#]+\/?$/i.test(url.pathname)) return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function telegramSession(db, chatId) {
  const session = db.telegramSessions.find(item => item.chatId === String(chatId));
  if (!session) return null;
  if (!session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) {
    db.telegramSessions = db.telegramSessions.filter(item => item !== session);
    return null;
  }
  return session;
}

function restoreTelegramSession(db, ticket, step) {
  const session = {
    id: id('tgs'),
    chatId: ticket.telegramChatId,
    telegramUserId: ticket.telegramUserId,
    telegramUsername: ticket.telegramUsername,
    ticketId: ticket.id,
    profileUrl: ticket.profileUrl,
    step,
    expiresAt: new Date(Date.now() + TELEGRAM_SESSION_TTL).toISOString(),
    createdAt: now(),
    updatedAt: now(),
  };
  db.telegramSessions = db.telegramSessions.filter(item => item.chatId !== ticket.telegramChatId);
  db.telegramSessions.push(session);
  return session;
}

function cancelTelegramSession(db, chatId) {
  const session = db.telegramSessions.find(item => item.chatId === String(chatId));
  if (session?.ticketId) {
    const ticket = db.tickets.find(item => item.id === session.ticketId && item.source === 'telegram');
    if (ticket && !['application_review', 'rejected', 'cancelled'].includes(ticket.stage)) {
      const cancelledAt = now();
      ticket.stage = 'cancelled';
      ticket.telegramReview = 'cancelled';
      ticket.status = 'closed';
      ticket.updatedAt = cancelledAt;
      if (!Array.isArray(ticket.messages)) ticket.messages = [];
      ticket.messages.push({ id: id('msg'), author: 'customer', message: 'Пользователь отменил черновик заявки.', createdAt: cancelledAt });
    }
  }
  db.telegramSessions = db.telegramSessions.filter(item => item.chatId !== String(chatId));
  return session;
}

function telegramTicketStatus(status) {
  return TELEGRAM_TICKET_STATUSES[status] || status || 'неизвестный статус';
}

function telegramTicketsForChat(db, chatId) {
  return db.tickets
    .filter(ticket => ticket.source === 'telegram' && ticket.telegramChatId === String(chatId))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
}

function telegramIsAdminCallback(callbackQuery) {
  const chatId = String(callbackQuery?.message?.chat?.id || '');
  const userId = String(callbackQuery?.from?.id || '');
  const chatType = callbackQuery?.message?.chat?.type;
  return TELEGRAM_ADMIN_USER_IDS.includes(userId) || (chatType === 'private' && chatId === userId && TELEGRAM_ADMIN_CHAT_IDS.includes(chatId));
}

function recentTelegramTicket(db, chatId) {
  const ticket = telegramTicketsForChat(db, chatId)[0];
  if (!ticket) return null;
  if (['open', 'in_progress'].includes(ticket.status)) return ticket;
  if (['rejected', 'cancelled'].includes(ticket.telegramReview) || ticket.stage === 'cancelled') return null;
  return Date.parse(ticket.createdAt || 0) + TELEGRAM_APPLICATION_COOLDOWN > Date.now() ? ticket : null;
}

async function notifyTelegramAdmins(message) {
  const recipients = telegramRecipients();
  if (!telegramIsEnabled() || !recipients.length) {
    if (telegramIsEnabled() && !recipients.length) console.warn('[telegram] TELEGRAM_ADMIN_CHAT_IDS or TELEGRAM_ADMIN_USER_IDS is empty; application was saved without notification');
    return;
  }
  await Promise.all(recipients.map(async chatId => {
    try { await telegramSendMessage(chatId, message); }
    catch (error) { console.error(`[telegram] admin notification failed for ${chatId}: ${error.message}`); }
  }));
}

async function notifyTelegramAdminsWithKeyboard(message, replyMarkup) {
  const recipients = telegramRecipients();
  if (!telegramIsEnabled() || !recipients.length) {
    if (telegramIsEnabled() && !recipients.length) console.warn('[telegram] TELEGRAM_ADMIN_CHAT_IDS or TELEGRAM_ADMIN_USER_IDS is empty; application was saved without notification');
    return;
  }
  await Promise.all(recipients.map(async chatId => {
    try { await telegramSendMessage(chatId, message, replyMarkup); }
    catch (error) { console.error(`[telegram] admin notification failed for ${chatId}: ${error.message}`); }
  }));
}

async function notifyTelegramTicket(ticket, message, statusMessage = '') {
  if (!telegramIsEnabled() || ticket.source !== 'telegram' || !ticket.telegramChatId) return;
  const prefix = statusMessage ? `${statusMessage}\n\n` : '';
  try { await telegramSendMessage(ticket.telegramChatId, `${prefix}Ответ по заявке ${ticket.id}:\n${message}`, telegramMainKeyboard()); }
  catch (error) { console.error(`[telegram] customer notification failed for ${ticket.id}: ${error.message}`); }
}

function telegramApplicationNotification(ticket) {
  return [
    'Новая заявка из Telegram',
    `ID: ${ticket.id}`,
    `Пользователь: ${ticket.telegramUsername ? `@${ticket.telegramUsername}` : `ID ${ticket.telegramUserId}`}`,
    `Профиль LOLZ: ${ticket.profileUrl}`,
    `Вариант: ${TELEGRAM_APPLICATION_OPTIONS[ticket.applicationType] || ticket.applicationType}`,
    `Комментарий: ${ticket.applicationComment || 'не указан'}`,
    '',
    `Откройте раздел «Заявки / обращения» в админке: ${APP_ORIGIN}`,
  ].join('\n');
}

async function telegramStartApplication(db, chat, from) {
  const staleSession = telegramSession(db, chat.id);
  const existing = recentTelegramTicket(db, chat.id);
  if (existing) {
    if (staleSession?.step === 'awaiting_comment') {
      await telegramSendMessage(chat.id, `Выберите, что делать с заявкой ${existing.id}.`, telegramCommentKeyboard());
      return;
    }
    if (existing.stage === 'awaiting_option') {
      if (!staleSession) { restoreTelegramSession(db, existing, 'awaiting_option'); await writeDatabase(); }
      await telegramSendMessage(chat.id, `Профиль по заявке ${existing.id} подтвержден. Выберите вариант.`, telegramOptionKeyboard());
      return;
    }
    const cooldown = Date.parse(existing.createdAt || 0) + TELEGRAM_APPLICATION_COOLDOWN;
    const suffix = existing.status === 'closed' && cooldown > Date.now() ? '\nНовая заявка будет доступна после окончания небольшого лимита.' : '';
    await telegramSendMessage(chat.id, `У вас уже есть заявка ${existing.id}: ${telegramStatusLabel(existing)}.${suffix}\n\nНажмите «Моя заявка», чтобы проверить статус.`, telegramMainKeyboard());
    return;
  }
  cancelTelegramSession(db, chat.id);
  db.telegramSessions.push({
    id: id('tgs'),
    chatId: String(chat.id),
    telegramUserId: String(from.id),
    telegramUsername: from.username || null,
    step: 'awaiting_profile',
    expiresAt: new Date(Date.now() + TELEGRAM_SESSION_TTL).toISOString(),
    createdAt: now(),
    updatedAt: now(),
  });
  await writeDatabase();
  await telegramSendMessage(chat.id, [
    'Шаг 1 из 3. Пришлите публичную ссылку на ваш профиль LOLZ.',
    '',
    'Пример: https://lolz.live/members/username.12345/',
    '',
    'Ссылка должна вести на профиль и начинаться с https://. Не отправляйте логин, пароль, cookies, коды подтверждения или платёжные данные.',
  ].join('\n'), { inline_keyboard: [[{ text: 'Отмена', callback_data: 'apply:cancel' }]] });
}

async function telegramSendStatus(db, chatId) {
  const tickets = telegramTicketsForChat(db, chatId);
  if (!tickets.length) {
    await telegramSendMessage(chatId, 'Заявок пока нет. Нажмите «Подать заявку», чтобы начать.', telegramMainKeyboard());
    return;
  }
  const lines = tickets.slice(0, 3).map(ticket => {
    const option = TELEGRAM_APPLICATION_OPTIONS[ticket.applicationType] || ticket.applicationType || 'вариант не указан';
    return `${ticket.id} · ${option} · ${telegramStatusLabel(ticket)}\nСоздана: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ticket.createdAt))}`;
  });
  const latest = tickets[0];
  let session = telegramSession(db, chatId);
  if (latest.stage === 'awaiting_option' && !session) { session = restoreTelegramSession(db, latest, 'awaiting_option'); await writeDatabase(); }
  const replyMarkup = session?.step === 'awaiting_comment' ? telegramCommentKeyboard() : latest.stage === 'awaiting_option' ? telegramOptionKeyboard() : telegramMainKeyboard();
  await telegramSendMessage(chatId, `Ваши заявки:\n\n${lines.join('\n\n')}`, replyMarkup);
}

async function telegramSubmitApplication(db, session) {
  const createdAt = now();
  const optionLabel = TELEGRAM_APPLICATION_OPTIONS[session.applicationType];
  const applicationComment = text(session.applicationComment, 2000);
  const message = [
    `Профиль LOLZ: ${session.profileUrl}`,
    `Выбранный вариант: ${optionLabel}`,
    `Комментарий: ${applicationComment || 'не указан'}`,
    '',
    'Ссылка проверяется оператором вручную. Автоматическое решение по заявке не принимается.',
  ].join('\n');
  const ticket = db.tickets.find(item => item.id === session.ticketId && item.source === 'telegram' && item.telegramChatId === session.chatId);
  if (!ticket) throw new Error('Заявка на проверку профиля не найдена');
  if (ticket.stage === 'application_review' && ticket.applicationType) {
    await telegramSendMessage(session.chatId, `Заявка ${ticket.id} уже отправлена оператору. Проверить статус можно командой /status.`, telegramMainKeyboard());
    db.telegramSessions = db.telegramSessions.filter(item => item !== session);
    await writeDatabase();
    return;
  }
  ticket.subject = `Telegram-заявка: ${optionLabel}`;
  ticket.message = message;
  if (!Array.isArray(ticket.messages)) ticket.messages = [];
  ticket.messages.push({ id: id('msg'), author: 'customer', message, createdAt });
  ticket.status = 'open';
  ticket.stage = 'application_review';
  ticket.telegramReview = 'approved';
  ticket.applicationType = session.applicationType;
  ticket.applicationComment = applicationComment || null;
  ticket.updatedAt = createdAt;
  db.telegramSessions = db.telegramSessions.filter(item => item !== session);
  await writeDatabase();
  await notifyTelegramAdmins(telegramApplicationNotification(ticket));
  await telegramSendMessage(session.chatId, [
    `Заявка ${ticket.id} отправлена.`,
    '',
    'Оператор проверит профиль и выбранный вариант вручную. Мы напишем сюда, если понадобится уточнение.',
    'Обычно статус можно проверить командой /status.',
  ].join('\n'), telegramMainKeyboard());
}

async function telegramCreateProfileReview(db, session) {
  const createdAt = now();
  const message = [
    `Профиль LOLZ: ${session.profileUrl}`,
    '',
    'Ожидает ручной проверки оператором. Вариант заявки будет доступен только после одобрения профиля.',
  ].join('\n');
  const ticket = {
    id: id('tkt'),
    userId: null,
    email: null,
    orderId: null,
    subject: 'Telegram-заявка: проверка профиля',
    message,
    messages: [{ id: id('msg'), author: 'customer', message, createdAt }],
    status: 'open',
    stage: 'profile_review',
    telegramReview: 'pending',
    source: 'telegram',
    profileUrl: session.profileUrl,
    applicationType: null,
    applicationComment: null,
    telegramChatId: session.chatId,
    telegramUserId: session.telegramUserId,
    telegramUsername: session.telegramUsername,
    contact: session.telegramUsername ? `@${session.telegramUsername}` : `Telegram ID ${session.telegramUserId}`,
    createdAt,
    updatedAt: createdAt,
  };
  session.ticketId = ticket.id;
  db.tickets.unshift(ticket);
  await writeDatabase();
  await notifyTelegramAdminsWithKeyboard([
    'Новая ссылка на ручную проверку',
    `ID: ${ticket.id}`,
    `Пользователь: ${ticket.telegramUsername ? `@${ticket.telegramUsername}` : `ID ${ticket.telegramUserId}`}`,
    `Профиль LOLZ: ${ticket.profileUrl}`,
    '',
    'Откройте заявку в админке и нажмите «Ссылка проверена», чтобы открыть пользователю выбор варианта.',
  ].join('\n'), telegramReviewKeyboard(ticket.id));
  await telegramSendMessage(session.chatId, [
    'Ссылка принята.',
    '',
    'Оператор вручную проверит профиль. Выбор варианта появится только после подтверждения ссылки.',
    `Номер заявки: ${ticket.id}`,
    '',
    'Проверить статус можно командой /status.',
  ].join('\n'), telegramMainKeyboard());
}

async function reviewTelegramTicket(db, ticket, decision, reviewer = 'web-admin') {
  if (ticket.source !== 'telegram' || ticket.stage !== 'profile_review' || ticket.telegramReview !== 'pending') throw new Error('Эта заявка уже обработана');
  const reviewedAt = now();
  let session = telegramSession(db, ticket.telegramChatId);
  if (session && session.ticketId !== ticket.id) session = null;
  if (decision === 'approve') {
    ticket.stage = 'awaiting_option';
    ticket.telegramReview = 'approved';
    ticket.status = 'in_progress';
    ticket.reviewDecision = 'approved';
    ticket.reviewedBy = reviewer;
    ticket.reviewedAt = reviewedAt;
    if (session) { session.step = 'awaiting_option'; session.updatedAt = reviewedAt; }
    else session = restoreTelegramSession(db, ticket, 'awaiting_option');
    if (!Array.isArray(ticket.messages)) ticket.messages = [];
    ticket.messages.push({ id: id('msg'), author: 'admin', message: 'Оператор подтвердил ссылку на профиль. Пользователю отправлен выбор варианта.', createdAt: reviewedAt });
    ticket.updatedAt = reviewedAt;
    await writeDatabase();
    if (telegramIsEnabled()) {
      try { await telegramSendMessage(ticket.telegramChatId, 'Профиль прошел ручную проверку. Теперь выберите вариант заявки.', telegramOptionKeyboard()); }
      catch (error) { console.error(`[telegram] review notification failed for ${ticket.id}: ${error.message}`); }
    }
    return 'Профиль подтвержден. Пользователю отправлен выбор варианта.';
  }
  if (decision === 'reject') {
    ticket.stage = 'rejected';
    ticket.telegramReview = 'rejected';
    ticket.status = 'closed';
    ticket.reviewDecision = 'rejected';
    ticket.reviewedBy = reviewer;
    ticket.reviewedAt = reviewedAt;
    if (!Array.isArray(ticket.messages)) ticket.messages = [];
    ticket.messages.push({ id: id('msg'), author: 'admin', message: 'Оператор отклонил ссылку на профиль.', createdAt: reviewedAt });
    ticket.updatedAt = reviewedAt;
    db.telegramSessions = db.telegramSessions.filter(item => item !== session);
    await writeDatabase();
    if (telegramIsEnabled()) {
      try { await telegramSendMessage(ticket.telegramChatId, `Заявка ${ticket.id}: профиль не прошел проверку. Если считаете это ошибкой, обратитесь к оператору.`, telegramMainKeyboard()); }
      catch (error) { console.error(`[telegram] rejection notification failed for ${ticket.id}: ${error.message}`); }
    }
    return 'Профиль отклонен. Пользователь уведомлен.';
  }
  throw new Error('Некорректное решение по профилю');
}

async function handleTelegramMessage(message) {
  if (!message?.chat?.id || !message.from) return;
  if (message.chat.type !== 'private') return;
  if (!telegramRateLimit(message.chat.id)) return telegramSendMessage(message.chat.id, 'Слишком много сообщений за минуту. Попробуйте немного позже.');
  const chatId = String(message.chat.id);
  const input = text(message.text, 3000);
  const command = input.match(/^\/(start|help|cancel|status|id)(?:@[^\s]+)?(?:\s+.*)?$/i)?.[1]?.toLowerCase();
  const db = await getDatabase();

  if (command === 'start' || command === 'help') {
    await telegramSendMessage(message.chat.id, [
      'Привет. Здесь можно оставить заявку на фридеп, редеп с возвратом баланса или деп 50/50.',
      '',
      'Сначала бот проверит формат публичной ссылки на профиль LOLZ. После ручной проверки профиля вы выберете вариант. Финальное решение и условия всегда подтверждает оператор.',
      '',
      'Не отправляйте пароли, коды, cookies, платёжные данные и доступы к аккаунтам.',
    ].join('\n'), telegramMainKeyboard());
    return;
  }
  if (command === 'id') {
    await telegramSendMessage(message.chat.id, `Ваш chat ID: ${message.chat.id}\nПередайте его администратору для настройки уведомлений.`);
    return;
  }
  if (command === 'cancel') {
    cancelTelegramSession(db, chatId);
    await writeDatabase();
    await telegramSendMessage(message.chat.id, 'Текущая заявка отменена. Данные черновика удалены.', telegramMainKeyboard());
    return;
  }
  if (command === 'status') {
    await telegramSendStatus(db, message.chat.id);
    return;
  }

  const session = telegramSession(db, chatId);
  if (!session) {
    await telegramSendMessage(message.chat.id, 'Сессия заявки истекла. Нажмите «Подать заявку», чтобы начать заново.', telegramMainKeyboard());
    return;
  }
  if (session.step === 'awaiting_profile') {
    const profileUrl = normalizeTelegramProfileUrl(input);
    if (!profileUrl) {
      await telegramSendMessage(message.chat.id, 'Не удалось проверить ссылку. Нужна публичная ссылка HTTPS на профиль LOLZ, например:\nhttps://lolz.live/members/username.12345/');
      return;
    }
    session.profileUrl = profileUrl;
    session.step = 'awaiting_review';
    session.updatedAt = now();
    await writeDatabase();
    await telegramCreateProfileReview(db, session);
    return;
  }
  if (session.step === 'awaiting_review') {
    await telegramSendMessage(message.chat.id, 'Профиль еще проверяется оператором. Когда проверка завершится, здесь появится выбор варианта.', telegramMainKeyboard());
    return;
  }
  if (session.step === 'awaiting_option') {
    await telegramSendMessage(message.chat.id, 'Выберите вариант кнопкой ниже.', telegramOptionKeyboard());
    return;
  }
  if (session.step === 'awaiting_comment') {
    if (!input) {
      await telegramSendMessage(message.chat.id, 'Напишите короткий комментарий или нажмите «Пропустить комментарий».', telegramCommentKeyboard());
      return;
    }
    session.applicationComment = input;
    await telegramSubmitApplication(db, session);
  }
}

async function handleTelegramCallback(callbackQuery) {
  if (!callbackQuery?.message?.chat?.id || !callbackQuery.from) return;
  await telegramAnswerCallback(callbackQuery.id);
  if (!telegramRateLimit(callbackQuery.message.chat.id)) return telegramSendMessage(callbackQuery.message.chat.id, 'Слишком много действий за минуту. Попробуйте немного позже.');
  const chat = callbackQuery.message.chat;
  const from = callbackQuery.from;
  const action = String(callbackQuery.data || '');
  const db = await getDatabase();
  const reviewMatch = action.match(/^review:(approve|reject):([^:]+)$/);
  if (reviewMatch) {
    if (!telegramIsAdminCallback(callbackQuery)) return telegramSendMessage(chat.id, 'Эта кнопка доступна только администратору.');
    const ticket = db.tickets.find(item => item.id === reviewMatch[2] && item.source === 'telegram');
    if (!ticket) return telegramSendMessage(chat.id, 'Заявка не найдена или уже удалена.');
    try { return telegramSendMessage(chat.id, `Заявка ${ticket.id}: ${await reviewTelegramTicket(db, ticket, reviewMatch[1], `telegram:${callbackQuery.from.id}`)}`); }
    catch (error) { return telegramSendMessage(chat.id, error.message); }
  }
  if (chat.type !== 'private') return;
  if (action === 'status') return telegramSendStatus(db, chat.id);
  if (action === 'apply:start') return telegramStartApplication(db, chat, from);
  if (action === 'apply:cancel') {
    cancelTelegramSession(db, chat.id);
    await writeDatabase();
    return telegramSendMessage(chat.id, 'Заявка отменена. Данные черновика удалены.', telegramMainKeyboard());
  }
  const session = telegramSession(db, chat.id);
  if (!session) return telegramSendMessage(chat.id, 'Сессия заявки истекла. Начните заново.', telegramMainKeyboard());
  if (action === 'apply:freedep' || action === 'apply:redeposit_return' || action === 'apply:deposit_50_50') {
    if (session.step !== 'awaiting_option' || !session.ticketId) return telegramSendMessage(chat.id, 'Сначала дождитесь ручной проверки профиля.', telegramMainKeyboard());
    session.applicationType = action.slice('apply:'.length);
    const ticket = db.tickets.find(item => item.id === session.ticketId && item.source === 'telegram' && item.telegramChatId === String(chat.id));
    if (!ticket || ticket.stage !== 'awaiting_option' || ticket.telegramReview !== 'approved') return telegramSendMessage(chat.id, 'Сначала дождитесь ручной проверки профиля.', telegramMainKeyboard());
    session.step = 'awaiting_comment';
    session.updatedAt = now();
    await writeDatabase();
    return telegramSendMessage(chat.id, `Вы выбрали «${TELEGRAM_APPLICATION_OPTIONS[session.applicationType]}».\n\nШаг 3 из 3. Напишите комментарий для оператора или пропустите этот шаг. Не отправляйте секретные данные.`, telegramCommentKeyboard());
  }
  if (action === 'apply:skip') {
    if (session.step !== 'awaiting_comment') return telegramSendMessage(chat.id, 'Сначала выберите вариант заявки.', telegramOptionKeyboard());
    return telegramSubmitApplication(db, session);
  }
  return telegramSendMessage(chat.id, 'Команда устарела. Нажмите «Подать заявку», чтобы начать заново.', telegramMainKeyboard());
}

async function processTelegramUpdate(update) {
  if (update.message) return handleTelegramMessage(update.message);
  if (update.callback_query) return handleTelegramCallback(update.callback_query);
}

function enqueueTelegramUpdate(update) {
  const task = telegramUpdateQueue.then(async () => {
    const db = await getDatabase();
    const updateId = Number(update?.update_id);
    if (!Number.isInteger(updateId) || updateId <= Number(db.telegram.lastUpdateId || 0)) return;
    await processTelegramUpdate(update);
    db.telegram.lastUpdateId = updateId;
    await writeDatabase();
  });
  telegramUpdateQueue = task.catch(error => console.error(`[telegram] update failed: ${error.message}`));
  return task;
}

async function telegramPollingLoop() {
  telegramPolling = true;
  while (telegramPolling) {
    try {
      const db = await getDatabase();
      const updates = await telegramApi('getUpdates', { offset: Number(db.telegram.lastUpdateId || 0) + 1, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates || []) await enqueueTelegramUpdate(update);
    } catch (error) {
      console.error(`[telegram] polling failed: ${error.message}`);
      await telegramSleep(5_000);
    }
  }
}

async function startTelegram() {
  if (!telegramIsEnabled()) return;
  if (!['polling', 'webhook'].includes(TELEGRAM_MODE)) throw new Error('TELEGRAM_MODE must be polling or webhook');
  const bot = await telegramApi('getMe');
  console.log(`[telegram] @${bot.username || bot.first_name || 'bot'} connected in ${TELEGRAM_MODE} mode`);
  await telegramApi('setMyCommands', { commands: [
    { command: 'start', description: 'Открыть меню' },
    { command: 'status', description: 'Проверить статус заявки' },
    { command: 'cancel', description: 'Отменить текущий шаг' },
    { command: 'help', description: 'Правила и помощь' },
  ] });
  if (TELEGRAM_MODE === 'webhook') {
    if (!TELEGRAM_WEBHOOK_URL || !/^https:\/\//i.test(TELEGRAM_WEBHOOK_URL)) throw new Error('TELEGRAM_WEBHOOK_URL must be an HTTPS webhook URL');
    if (!TELEGRAM_WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{1,256}$/.test(TELEGRAM_WEBHOOK_SECRET)) throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 1-256 letters, numbers, _ or -');
    await telegramApi('setWebhook', { url: TELEGRAM_WEBHOOK_URL, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    console.log(`[telegram] webhook configured: ${TELEGRAM_WEBHOOK_URL}`);
    return;
  }
  await telegramApi('deleteWebhook', { drop_pending_updates: false });
  telegramPollingLoop().catch(error => console.error(`[telegram] polling stopped: ${error.message}`));
}

async function issueEmailCode(email, passwordHash) {
  const code = String(crypto.randomInt(100000, 1000000));
  await sendMail(email, 'slowyshop — подтверждение email', `Ваш код подтверждения slowyshop: ${code}\n\nКод действует 10 минут.`);
  emailCodes.set(email, { code, passwordHash, expiresAt: Date.now() + 600_000 });
  const response = { pending: true, email, message: 'Код подтверждения отправлен на email' };
  if (!smtpTransport() && !EMAIL_REQUIRED && !IS_PRODUCTION && process.env.DEV_EMAIL_CODES !== 'false') response.devCode = code;
  return response;
}

async function createSession(res, db, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL;
  db.sessions = db.sessions.filter(session => session.expiresAt > Date.now());
  db.sessions.push({ id: id('ses'), userId: user.id, tokenHash: tokenHash(token), createdAt: now(), expiresAt });
  await writeDatabase();
  const cookie = [`slowy_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`, 'SameSite=Lax', ...(COOKIE_SECURE ? ['Secure'] : [])].join('; ');
  return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie });
}

async function createYooKassaPayment(order) {
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) throw new Error('Не настроены YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY');
  const response = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64')}`,
      'Content-Type': 'application/json',
      'Idempotence-Key': order.id,
    },
    body: JSON.stringify({
      amount: { value: Number(order.total).toFixed(2), currency: 'RUB' },
      capture: true,
      description: `Заказ ${order.id}`,
      metadata: { orderId: order.id },
      confirmation: { type: 'redirect', return_url: `${APP_ORIGIN}/?order=${encodeURIComponent(order.id)}` },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id || !data.confirmation?.confirmation_url) throw new Error(data.description || 'Платежный провайдер не создал платеж');
  return { id: data.id, url: data.confirmation.confirmation_url };
}

async function verifyYooKassaPayment(paymentId) {
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) throw new Error('Платежный провайдер не настроен');
  const response = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64')}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Не удалось проверить платеж');
  return data;
}

async function refundYooKassaPayment(payment) {
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) throw new Error('Платежный провайдер не настроен');
  const response = await fetch('https://api.yookassa.ru/v3/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64')}`,
      'Content-Type': 'application/json',
      'Idempotence-Key': `refund_${payment.id}`,
    },
    body: JSON.stringify({ payment_id: payment.id, amount: payment.amount, description: 'Автоматический возврат: резерв заказа истек или был отменен' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error(data.description || 'Не удалось создать возврат');
  return data;
}

async function handleYooKassaWebhook(req, res) {
  if (PAYMENT_MODE !== 'yookassa') return json(res, 200, { ok: true });
  const payload = await requestBody(req);
  const paymentId = payload?.object?.id;
  if (!paymentId) return fail(res, 400, 'Некорректное уведомление');
  const payment = await verifyYooKassaPayment(paymentId);
  const db = await getDatabase();
  if (cleanupExpiredReservations(db)) await writeDatabase();
  const orderId = payment.metadata?.orderId || payload.object.metadata?.orderId;
  const order = db.orders.find(item => item.id === orderId || item.paymentId === payment.id);
  if (!order) return json(res, 200, { ok: true });
  if (payment.amount?.currency !== 'RUB' || Number(payment.amount?.value) !== Number(order.total)) return fail(res, 400, 'Сумма платежа не совпадает');
  if (payment.status === 'succeeded') {
    if (!['awaiting_payment', 'payment_failed'].includes(order.status)) {
      if (order.status === 'expired' && order.paymentStatus !== 'refunded') {
        await refundYooKassaPayment(payment);
        order.status = 'refunded';
        order.paymentStatus = 'refunded';
        order.paymentId = payment.id;
        order.updatedAt = now();
        await writeDatabase();
      } else if (order.paymentStatus !== 'paid') {
        await refundYooKassaPayment(payment);
        order.status = 'refunded';
        order.paymentStatus = 'refunded';
        order.paymentId = payment.id;
        order.updatedAt = now();
        await writeDatabase();
      }
      return json(res, 200, { ok: true });
    }
    markOrderPaid(db, order, payment.id);
    await writeDatabase();
  } else if (payment.status === 'canceled' && order.status === 'awaiting_payment') {
    releaseOrderReservations(db, order);
    order.status = 'payment_failed';
    order.paymentStatus = 'failed';
    order.updatedAt = now();
    await writeDatabase();
  }
  return json(res, 200, { ok: true });
}

async function api(req, res, pathname) {
  if (pathname === '/api/telegram/webhook' && req.method === 'POST') {
    if (TELEGRAM_MODE !== 'webhook' || !telegramIsEnabled() || !TELEGRAM_WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== TELEGRAM_WEBHOOK_SECRET) return fail(res, 403, 'Недопустимое уведомление Telegram');
    try {
      const payload = await requestBody(req);
      if (!Number.isInteger(Number(payload?.update_id))) return fail(res, 400, 'Некорректное уведомление Telegram');
      await enqueueTelegramUpdate(payload);
      return json(res, 200, { ok: true });
    } catch (error) {
      console.error(`[telegram] webhook failed: ${error.message}`);
      return fail(res, 400, 'Не удалось обработать уведомление Telegram');
    }
  }
  if (pathname === '/api/payments/yookassa/webhook' && req.method === 'POST') {
    try { return await handleYooKassaWebhook(req, res); } catch (error) { console.error(error); return fail(res, 500, 'Ошибка обработки платежного уведомления'); }
  }
  if (!sameOrigin(req) && ['POST', 'PATCH', 'DELETE'].includes(req.method)) return fail(res, 403, 'Недопустимый источник запроса');
  const db = await getDatabase();
  let changedByCleanup = cleanupExpiredReservations(db);
  if (changedByCleanup) await writeDatabase();
  const method = req.method;

  try {
    if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, service: 'slowyshop', paymentMode: PAYMENT_MODE, email: { configured: Boolean(smtpTransport()), required: EMAIL_REQUIRED }, telegram: { configured: telegramIsEnabled(), mode: TELEGRAM_MODE, adminsConfigured: telegramRecipients().length > 0 } });
    if (pathname === '/api/products' && method === 'GET') return json(res, 200, db.products.filter(product => product.active !== false).map(product => publicProduct(product, db)));
    if (pathname === '/api/auth/me' && method === 'GET') return json(res, 200, { user: publicUser(await sessionUser(req, db)) || null });

    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!rateLimit(req, 'register', 5, 60 * 60 * 1000)) return fail(res, 429, 'Слишком много попыток регистрации');
      const input = await requestBody(req);
      const email = text(input.email, 200).toLowerCase();
      const password = String(input.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 200) return fail(res, 400, 'Введите корректный email и пароль от 8 до 200 символов');
      if (db.users.some(user => user.email === email)) return fail(res, 409, 'Пользователь с таким email уже существует');
      try { return json(res, 202, await issueEmailCode(email, await hashPassword(password))); }
      catch (error) { console.error('[slowyshop] registration email failed:', error.message); return fail(res, 502, error.message); }
    }

    if (pathname === '/api/auth/resend-code' && method === 'POST') {
      if (!rateLimit(req, 'resend-code', 5, 15 * 60 * 1000)) return fail(res, 429, 'Слишком много запросов кода');
      const input = await requestBody(req);
      const email = text(input.email, 200).toLowerCase();
      const pending = emailCodes.get(email);
      if (!pending) return fail(res, 400, 'Сначала начните регистрацию');
      try { return json(res, 202, await issueEmailCode(email, pending.passwordHash)); }
      catch (error) { console.error('[slowyshop] resend email failed:', error.message); return fail(res, 502, error.message); }
    }

    if (pathname === '/api/auth/verify-email' && method === 'POST') {
      if (!rateLimit(req, 'verify-email', 10, 15 * 60 * 1000)) return fail(res, 429, 'Слишком много попыток подтверждения');
      const input = await requestBody(req);
      const email = text(input.email, 200).toLowerCase();
      const pending = emailCodes.get(email);
      if (!pending || pending.expiresAt < Date.now() || String(input.code || '') !== pending.code) return fail(res, 400, 'Неверный или просроченный код');
      if (db.users.some(user => user.email === email)) return fail(res, 409, 'Пользователь с таким email уже существует');
      const user = { id: id('usr'), email, passwordHash: pending.passwordHash, role: 'user', createdAt: now(), emailVerified: true };
      db.users.push(user);
      emailCodes.delete(email);
      await writeDatabase();
      return createSession(res, db, user);
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!rateLimit(req, 'login', 10, 15 * 60 * 1000)) return fail(res, 429, 'Слишком много попыток входа');
      const input = await requestBody(req);
      const email = text(input.email, 200).toLowerCase();
      const user = db.users.find(item => item.email === email);
      if (!user || !(await passwordMatches(String(input.password || ''), user.passwordHash))) return fail(res, 401, 'Неверный email или пароль');
      return createSession(res, db, user);
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = cookies(req).slowy_session;
      db.sessions = db.sessions.filter(session => session.tokenHash !== tokenHash(token || ''));
      await writeDatabase();
      return json(res, 200, { ok: true }, { 'Set-Cookie': `slowy_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}` });
    }

    if (pathname === '/api/orders' && method === 'GET') {
      const user = await requireUser(req, res, db); if (!user) return;
      return json(res, 200, db.orders.filter(order => order.userId === user.id).map(order => orderForClient(order, true)));
    }

    if (pathname === '/api/orders' && method === 'POST') {
      if (!rateLimit(req, 'create-order', 20, 15 * 60 * 1000)) return fail(res, 429, 'Слишком много заказов. Попробуйте позже');
      const user = await requireUser(req, res, db); if (!user) return;
      const input = await requestBody(req);
      const rawItems = Array.isArray(input.items) ? input.items : [];
      if (!rawItems.length || rawItems.length > 20) return fail(res, 400, 'Корзина пуста или содержит слишком много позиций');
      const quantities = new Map();
      for (const item of rawItems) {
        const productId = text(item.productId, 100);
        const quantity = Math.floor(Number(item.quantity));
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail(res, 400, 'Некорректное количество товара');
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
      }
      const normalized = [];
      let totalCents = 0;
      for (const [productId, quantity] of quantities) {
        const product = db.products.find(item => item.id === productId && item.active !== false);
        if (!product) return fail(res, 400, 'Товар недоступен');
        if (quantity > 10) return fail(res, 400, 'Слишком большое количество одного товара');
        const available = getAvailableInventory(db, product.id).length;
        if (available < quantity) return fail(res, 400, `Недостаточно товара: ${product.name}`);
        const price = Math.round(Number(product.price) * 100) / 100;
        normalized.push({ productId: product.id, name: product.name, price, quantity, delivery: product.delivery });
        totalCents += Math.round(price * 100) * quantity;
      }
      const orderId = id('ord');
      const expiresAt = new Date(Date.now() + RESERVATION_TTL).toISOString();
      const reserved = reserveInventory(db, normalized, orderId, expiresAt);
      if (!reserved) return fail(res, 409, 'Товар только что закончился. Обновите корзину');
      let offset = 0;
      for (const item of normalized) { item.inventoryIds = reserved.slice(offset, offset + item.quantity).map(record => record.id); offset += item.quantity; }
      const order = {
        id: orderId,
        userId: user.id,
        email: user.email,
        items: normalized,
        total: totalCents / 100,
        totalCents,
        currency: 'RUB',
        status: 'awaiting_payment',
        paymentStatus: 'unpaid',
        paymentProvider: PAYMENT_MODE,
        reservationExpiresAt: expiresAt,
        createdAt: now(),
        updatedAt: now(),
      };
      db.orders.unshift(order);
      await writeDatabase();
      let payment = { mode: PAYMENT_MODE, orderId };
      try {
        if (PAYMENT_MODE === 'yookassa') {
          const providerPayment = await createYooKassaPayment(order);
          order.paymentId = providerPayment.id;
          order.paymentUrl = providerPayment.url;
          order.updatedAt = now();
          await writeDatabase();
          payment = { mode: PAYMENT_MODE, orderId, paymentId: providerPayment.id, confirmationUrl: providerPayment.url };
        } else if (PAYMENT_MODE === 'demo') {
          payment = { mode: 'demo', orderId, paymentId: `demo_${order.id}`, confirmationUrl: null };
        } else {
          throw new Error('Неизвестный PAYMENT_MODE');
        }
      } catch (error) {
        releaseOrderReservations(db, order);
        order.status = 'payment_failed';
        order.paymentStatus = 'failed';
        order.updatedAt = now();
        await writeDatabase();
        return fail(res, 502, error.message);
      }
      return json(res, 201, { order: orderForClient(order, true), payment });
    }

    const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && method === 'GET') {
      const user = await requireUser(req, res, db); if (!user) return;
      const order = db.orders.find(item => item.id === orderMatch[1] && item.userId === user.id);
      if (!order) return fail(res, 404, 'Заказ не найден');
      return json(res, 200, orderForClient(order, true));
    }

    const deliveryMatch = pathname.match(/^\/api\/orders\/([^/]+)\/delivery$/);
    if (deliveryMatch && method === 'GET') {
      const user = await requireUser(req, res, db); if (!user) return;
      const order = db.orders.find(item => item.id === deliveryMatch[1] && item.userId === user.id);
      if (!order) return fail(res, 404, 'Заказ не найден');
      if (order.paymentStatus !== 'paid' || !['paid', 'fulfilled'].includes(order.status) || !order.deliveryAvailableAt) return fail(res, 402, 'Данные появятся после подтверждения оплаты и выдачи заказа');
      const delivery = [];
      for (const item of order.items || []) {
        for (const inventoryId of item.inventoryIds || []) {
          const inventory = db.inventory.find(record => record.id === inventoryId && record.orderId === order.id);
          if (!inventory) return fail(res, 500, 'Данные товара недоступны');
          delivery.push({ productId: item.productId, productName: item.name, ...decryptSecret(inventory.secret) });
        }
      }
      order.deliveredAt = order.deliveredAt || now();
      order.deliveryViews = Number(order.deliveryViews || 0) + 1;
      order.updatedAt = now();
      await writeDatabase();
      return json(res, 200, { orderId: order.id, items: delivery, viewedAt: order.deliveredAt });
    }

    const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const user = await requireUser(req, res, db); if (!user) return;
      const order = db.orders.find(item => item.id === cancelMatch[1] && item.userId === user.id);
      if (!order) return fail(res, 404, 'Заказ не найден');
      if (order.status !== 'awaiting_payment') return fail(res, 400, 'Этот заказ уже нельзя отменить самостоятельно');
      releaseOrderReservations(db, order);
      order.status = 'cancelled';
      order.paymentStatus = 'unpaid';
      order.updatedAt = now();
      await writeDatabase();
      return json(res, 200, orderForClient(order));
    }

    if (pathname === '/api/payments/demo/confirm' && method === 'POST') {
      if (PAYMENT_MODE !== 'demo') return fail(res, 404, 'Demo-платежи отключены');
      if (!rateLimit(req, 'demo-payment', 10, 15 * 60 * 1000)) return fail(res, 429, 'Слишком много попыток оплаты');
      const user = await requireUser(req, res, db); if (!user) return;
      const input = await requestBody(req);
      const order = db.orders.find(item => item.id === text(input.orderId, 100) && item.userId === user.id);
      if (!order) return fail(res, 404, 'Заказ не найден');
      try { markOrderPaid(db, order, `demo_${order.id}`); } catch (error) { return fail(res, 400, error.message); }
      await writeDatabase();
      return json(res, 200, orderForClient(order));
    }

    const paymentRefresh = pathname.match(/^\/api\/orders\/([^/]+)\/refresh-payment$/);
    if (paymentRefresh && method === 'POST') {
      const user = await requireUser(req, res, db); if (!user) return;
      const order = db.orders.find(item => item.id === paymentRefresh[1] && item.userId === user.id);
      if (!order) return fail(res, 404, 'Заказ не найден');
      if (PAYMENT_MODE !== 'yookassa' || !order.paymentId) return json(res, 200, orderForClient(order, true));
      const payment = await verifyYooKassaPayment(order.paymentId);
      if (payment.status === 'succeeded' && ['awaiting_payment', 'payment_failed'].includes(order.status)) {
        try { markOrderPaid(db, order, payment.id); } catch (error) {
          if (order.status === 'expired' || error.message.includes('истек')) {
            await refundYooKassaPayment(payment);
            order.status = 'refunded';
            order.paymentStatus = 'refunded';
            order.paymentId = payment.id;
            order.updatedAt = now();
          } else throw error;
        }
      } else if (payment.status === 'succeeded' && order.status === 'expired' && order.paymentStatus !== 'refunded') {
        await refundYooKassaPayment(payment);
        order.status = 'refunded';
        order.paymentStatus = 'refunded';
        order.paymentId = payment.id;
        order.updatedAt = now();
      }
      if (payment.status === 'canceled' && order.status === 'awaiting_payment') { releaseOrderReservations(db, order); order.status = 'payment_failed'; order.paymentStatus = 'failed'; order.updatedAt = now(); }
      await writeDatabase();
      return json(res, 200, orderForClient(order, true));
    }

    if (pathname === '/api/tickets' && method === 'GET') {
      const user = await requireUser(req, res, db); if (!user) return;
      return json(res, 200, db.tickets.filter(ticket => ticket.userId === user.id).map(ticket => ({ ...ticket })));
    }

    if (pathname === '/api/tickets' && method === 'POST') {
      if (!rateLimit(req, 'ticket', 10, 60 * 60 * 1000)) return fail(res, 429, 'Слишком много обращений');
      const user = await requireUser(req, res, db); if (!user) return;
      const input = await requestBody(req);
      const subject = text(input.subject, 160);
      const message = text(input.message, 3000);
      const orderId = text(input.orderId, 100) || null;
      if (subject.length < 3 || message.length < 5) return fail(res, 400, 'Заполните тему и сообщение');
      if (orderId && !db.orders.some(order => order.id === orderId && order.userId === user.id)) return fail(res, 400, 'Заказ не найден');
      const ticket = { id: id('tkt'), userId: user.id, email: user.email, orderId, subject, message, messages: [{ id: id('msg'), author: 'customer', message, createdAt: now() }], status: 'open', createdAt: now(), updatedAt: now() };
      db.tickets.unshift(ticket);
      await writeDatabase();
      return json(res, 201, ticket);
    }

    const userTicketReply = pathname.match(/^\/api\/tickets\/([^/]+)\/reply$/);
    if (userTicketReply && method === 'POST') {
      if (!rateLimit(req, 'ticket-reply', 20, 60 * 60 * 1000)) return fail(res, 429, 'Слишком много ответов');
      const user = await requireUser(req, res, db); if (!user) return;
      const ticket = db.tickets.find(item => item.id === userTicketReply[1] && item.userId === user.id);
      if (!ticket) return fail(res, 404, 'Обращение не найдено');
      const input = await requestBody(req);
      const message = text(input.message, 3000);
      if (!message) return fail(res, 400, 'Введите сообщение');
      if (!Array.isArray(ticket.messages)) ticket.messages = ticket.message ? [{ id: id('msg'), author: 'customer', message: ticket.message, createdAt: ticket.createdAt || now() }] : [];
      ticket.messages.push({ id: id('msg'), author: 'customer', message, createdAt: now() });
      ticket.status = 'open';
      ticket.updatedAt = now();
      await writeDatabase();
      if (process.env.ADMIN_EMAIL) {
        try { await sendMail(process.env.ADMIN_EMAIL, `slowyshop — новый ответ по обращению ${ticket.id}`, `Пользователь ${user.email} ответил на обращение «${ticket.subject}»:\n\n${message}`); } catch (error) { console.error('[slowyshop] ticket notification failed:', error.message); }
      }
      return json(res, 201, ticket);
    }

    const adminProductMatch = pathname.match(/^\/api\/admin\/products(?:\/([^/]+))?$/);
    if (adminProductMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const productId = adminProductMatch[1];
      if (method === 'POST') {
        const product = cleanProduct(await requestBody(req));
        if (!product) return fail(res, 400, 'Заполните название, описание, корректную цену и изображение HTTPS/PNG/JPEG/WEBP до 1 МБ');
        product.id = id('prd'); product.createdAt = now(); product.active = true;
        db.products.push(product); await writeDatabase(); return json(res, 201, adminProduct(product, db));
      }
      const product = db.products.find(item => item.id === productId);
      if (!product) return fail(res, 404, 'Товар не найден');
      if (method === 'DELETE') {
        product.active = false;
        product.updatedAt = now();
        await writeDatabase();
        return json(res, 200, { ok: true, product: adminProduct(product, db) });
      }
      const updated = cleanProduct(await requestBody(req), product);
      if (!updated) return fail(res, 400, 'Некорректные данные товара или изображения');
      Object.assign(product, updated, { updatedAt: now() });
      await writeDatabase();
      return json(res, 200, adminProduct(product, db));
    }

    if (pathname === '/api/admin/products' && method === 'GET') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      return json(res, 200, db.products.map(product => adminProduct(product, db)));
    }

    if (pathname === '/api/admin/inventory' && method === 'GET') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const productId = text(new URL(req.url, APP_ORIGIN).searchParams.get('productId'), 100);
      return json(res, 200, db.inventory.filter(item => !productId || item.productId === productId).map(inventoryForAdmin));
    }

    if (pathname === '/api/admin/inventory' && method === 'POST') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const input = await requestBody(req);
      const product = db.products.find(item => item.id === text(input.productId, 100));
      const login = text(input.login, 500);
      const password = String(input.password || '').slice(0, 1000);
      if (!product || !login || !password) return fail(res, 400, 'Выберите товар и заполните логин и пароль');
      const inventory = { id: id('inv'), productId: product.id, status: 'available', loginHint: login.length > 4 ? `${login.slice(0, 2)}***${login.slice(-2)}` : 'скрыт', secret: encryptSecret({ login, password, extra: text(input.extra, 2000) }), createdAt: now() };
      db.inventory.push(inventory); await writeDatabase(); return json(res, 201, inventoryForAdmin(inventory));
    }

    if (pathname === '/api/admin/inventory/bulk' && method === 'POST') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const input = await requestBody(req);
      const product = db.products.find(item => item.id === text(input.productId, 100));
      const lines = Array.isArray(input.accounts) ? input.accounts : String(input.accounts || '').split(/\r?\n/);
      if (!product || !lines.length) return fail(res, 400, 'Выберите товар и добавьте строки аккаунтов');
      let added = 0; let skipped = 0;
      for (const rawLine of lines) {
        if (rawLine && typeof rawLine === 'object') {
          const login = text(rawLine.login, 500); const password = String(rawLine.password || '').slice(0, 1000); const extra = text(rawLine.extra, 2000);
          if (!login || !password) { skipped += 1; continue; }
          db.inventory.push({ id: id('inv'), productId: product.id, status: 'available', loginHint: login.length > 4 ? `${login.slice(0, 2)}***${login.slice(-2)}` : 'скрыт', secret: encryptSecret({ login, password, extra }), createdAt: now() }); added += 1; continue;
        }
        const line = String(rawLine || '').trim();
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('|');
        const secondSeparator = separator < 0 ? -1 : line.indexOf('|', separator + 1);
        const login = text(separator < 0 ? '' : line.slice(0, separator), 500);
        const password = String(separator < 0 ? '' : line.slice(separator + 1, secondSeparator < 0 ? undefined : secondSeparator)).slice(0, 1000);
        const extra = text(secondSeparator < 0 ? '' : line.slice(secondSeparator + 1), 2000);
        if (!login || !password) { skipped += 1; continue; }
        db.inventory.push({ id: id('inv'), productId: product.id, status: 'available', loginHint: login.length > 4 ? `${login.slice(0, 2)}***${login.slice(-2)}` : 'скрыт', secret: encryptSecret({ login, password, extra }), createdAt: now() });
        added += 1;
      }
      await writeDatabase();
      return json(res, 201, { added, skipped });
    }

    const inventoryMatch = pathname.match(/^\/api\/admin\/inventory\/([^/]+)$/);
    if (inventoryMatch && ['PATCH', 'DELETE'].includes(method)) {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const inventory = db.inventory.find(item => item.id === inventoryMatch[1]);
      if (!inventory) return fail(res, 404, 'Единица товара не найдена');
      if (method === 'DELETE') {
        if (!['available', 'blocked'].includes(inventory.status)) return fail(res, 400, 'Проданный или зарезервированный аккаунт нельзя удалить');
        db.inventory = db.inventory.filter(item => item !== inventory); await writeDatabase(); return json(res, 200, { ok: true });
      }
      const input = await requestBody(req);
      if (!['available', 'blocked'].includes(input.status) || !['available', 'blocked'].includes(inventory.status)) return fail(res, 400, 'Можно менять только доступный или заблокированный аккаунт');
      inventory.status = input.status; await writeDatabase(); return json(res, 200, inventoryForAdmin(inventory));
    }

    if (pathname === '/api/admin/orders' && method === 'GET') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      return json(res, 200, db.orders.map(order => ({ ...orderForClient(order, false), email: order.email, userId: order.userId, paymentId: order.paymentId || null })));
    }

    const adminOrder = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (adminOrder && method === 'PATCH') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const order = db.orders.find(item => item.id === adminOrder[1]);
      if (!order) return fail(res, 404, 'Заказ не найден');
      const input = await requestBody(req);
      try {
        if (input.status === 'fulfilled') markOrderFulfilled(db, order);
        else if (input.status === 'refunded') {
          if (order.status !== 'refunded' && PAYMENT_MODE === 'yookassa') {
            if (!order.paymentId) throw new Error('У заказа отсутствует идентификатор платежа');
            await refundYooKassaPayment({ id: order.paymentId, amount: { value: Number(order.total).toFixed(2), currency: 'RUB' } });
          }
          if (order.status !== 'refunded') refundOrder(db, order);
        }
        else if (input.status === 'cancelled' && order.status === 'awaiting_payment') { releaseOrderReservations(db, order); order.status = 'cancelled'; order.paymentStatus = 'unpaid'; order.updatedAt = now(); }
        else if (input.status !== order.status) return fail(res, 400, 'Недопустимый переход статуса');
      } catch (error) { return fail(res, 400, error.message); }
      await writeDatabase(); return json(res, 200, orderForClient(order));
    }

    if (pathname === '/api/admin/stats' && method === 'GET') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      return json(res, 200, {
        revenue: db.orders.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + Number(order.total || 0), 0),
        orders: db.orders.length,
        customers: db.users.filter(user => user.role === 'user').length,
        products: db.products.filter(product => product.active !== false).length,
        availableInventory: db.inventory.filter(item => item.status === 'available').length,
        openTickets: db.tickets.filter(ticket => ticket.status === 'open').length,
      });
    }

    if (pathname === '/api/admin/tickets' && method === 'GET') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      return json(res, 200, db.tickets.map(ticket => ({
        ...ticket,
        telegram: ticket.source === 'telegram' ? {
          chatId: ticket.telegramChatId || null,
          userId: ticket.telegramUserId || null,
          username: ticket.telegramUsername || null,
          profileUrl: ticket.profileUrl || null,
          applicationType: ticket.applicationType || null,
          applicationComment: ticket.applicationComment || null,
        } : null,
      })));
    }

    const adminTicketReply = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/reply$/);
    if (adminTicketReply && method === 'POST') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const ticket = db.tickets.find(item => item.id === adminTicketReply[1]);
      if (!ticket) return fail(res, 404, 'Обращение не найдено');
      const input = await requestBody(req);
      const message = text(input.message, 3000);
      if (message.length < 1) return fail(res, 400, 'Введите ответ');
      if (!Array.isArray(ticket.messages)) ticket.messages = [{ id: id('msg'), author: 'customer', message: ticket.message, createdAt: ticket.createdAt }];
      ticket.messages.push({ id: id('msg'), author: 'admin', message, createdAt: now() });
      ticket.status = 'in_progress';
      ticket.updatedAt = now();
      await writeDatabase();
      try { await sendMail(ticket.email, `slowyshop — ответ по обращению ${ticket.id}`, `Поддержка ответила на ваше обращение «${ticket.subject}»:\n\n${message}\n\nОткройте личный кабинет, чтобы продолжить диалог.`); } catch (error) { console.error('[slowyshop] customer notification failed:', error.message); }
      await notifyTelegramTicket(ticket, message, 'Статус заявки обновлен: в работе.');
      return json(res, 201, ticket);
    }

    const adminProductImage = pathname.match(/^\/api\/admin\/products\/([^/]+)\/image$/);
    if (adminProductImage && method === 'POST') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const product = db.products.find(item => item.id === adminProductImage[1]);
      if (!product) return fail(res, 404, 'Товар не найден');
      const input = await requestBody(req);
      const rawImage = text(input.image, 2_000_000);
      const image = cleanImage(rawImage);
      if (rawImage && !image) return fail(res, 400, 'Используйте HTTPS-ссылку или изображение PNG/JPEG/WEBP/GIF размером до 1 МБ');
      product.image = image;
      product.updatedAt = now();
      await writeDatabase();
      return json(res, 200, adminProduct(product, db));
    }

    const adminTicket = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
    if (adminTicket && method === 'PATCH') {
      const admin = await requireAdmin(req, res, db); if (!admin) return;
      const ticket = db.tickets.find(item => item.id === adminTicket[1]);
      if (!ticket) return fail(res, 404, 'Обращение не найдено');
      const input = await requestBody(req);
      if (ticket.source === 'telegram' && ['approve_profile', 'reject_profile'].includes(input.status)) {
        try {
          const message = await reviewTelegramTicket(db, ticket, input.status === 'approve_profile' ? 'approve' : 'reject', `web:${admin.id}`);
          return json(res, 200, { ...ticket, reviewMessage: message });
        } catch (error) { return fail(res, 400, error.message); }
      }
      if (!['open', 'in_progress', 'closed'].includes(input.status)) return fail(res, 400, 'Некорректный статус обращения');
      if (ticket.source === 'telegram' && ticket.stage === 'profile_review' && input.status !== ticket.status) return fail(res, 400, 'Сначала примите решение по проверке профиля');
      if (ticket.source === 'telegram' && ticket.stage === 'awaiting_option' && input.status !== ticket.status) return fail(res, 400, 'Дождитесь выбора варианта пользователем');
      const previousStatus = ticket.status;
      ticket.status = input.status; ticket.updatedAt = now(); await writeDatabase();
      if (previousStatus !== input.status) await notifyTelegramTicket(ticket, `Статус заявки изменен: ${telegramTicketStatus(input.status)}.`, 'Обновление заявки.');
      return json(res, 200, ticket);
    }

    return fail(res, 404, 'Маршрут не найден');
  } catch (error) {
    console.error(error);
    return fail(res, error.message === 'Размер запроса слишком большой' ? 413 : 500, error.message === 'Размер запроса слишком большой' ? error.message : 'Внутренняя ошибка сервера');
  }
}

async function serve(req, res, pathname) {
  const allowedFiles = new Set(['/', '/index.html', '/styles.css', '/app.js']);
  if (!allowedFiles.has(pathname)) return fail(res, 404, 'Файл не найден');
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(ROOT, file);
  try {
    const content = await fs.readFile(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com" });
    res.end(content);
  } catch { fail(res, 404, 'Файл не найден'); }
}

async function ensureAdmin() {
  const db = await getDatabase();
  const email = text(process.env.ADMIN_EMAIL || 'admin@slowy.local', 200).toLowerCase();
  const configuredPassword = process.env.ADMIN_PASSWORD;
  let admin = db.users.find(user => user.role === 'admin' && user.email === email);
  if (IS_PRODUCTION && (!configuredPassword || configuredPassword.length < 12)) throw new Error('Set ADMIN_EMAIL and a strong ADMIN_PASSWORD before production start');
  if (!admin) {
    const password = configuredPassword || crypto.randomBytes(12).toString('base64url');
    admin = { id: id('usr'), email, passwordHash: await hashPassword(password), role: 'admin', createdAt: now(), emailVerified: true };
    db.users.push(admin);
    await writeDatabase();
    console.log(`Admin created: ${email} / ${password}`);
  } else if (configuredPassword && (IS_PRODUCTION || process.env.ADMIN_RESET_PASSWORD === 'true')) {
    if (configuredPassword.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
    if (!(await passwordMatches(configuredPassword, admin.passwordHash))) {
      admin.passwordHash = await hashPassword(configuredPassword);
      await writeDatabase();
      console.log(`Admin password synchronized for ${email}`);
    }
  } else if (!configuredPassword) {
    console.warn('ADMIN_PASSWORD is not set. Set it in .env before using this instance outside local development.');
  }
}

async function start() {
  await ensureAdmin();
  if (!['demo', 'yookassa'].includes(PAYMENT_MODE)) throw new Error('PAYMENT_MODE must be demo or yookassa');
  if (IS_PRODUCTION && PAYMENT_MODE === 'demo') console.warn('PAYMENT_MODE=demo is enabled. This mode must not be used for real sales.');
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, APP_ORIGIN).pathname);
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      return await serve(req, res, pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера'); else res.end();
    }
  });
  server.listen(PORT, () => console.log(`slowyshop running at ${APP_ORIGIN}`));
  try { await startTelegram(); }
  catch (error) {
    console.error(`[telegram] startup failed: ${error.message}`);
    if (IS_PRODUCTION) { server.close(); throw error; }
  }
}

start().catch(error => { console.error(error.message); process.exitCode = 1; });
