(() => {
  'use strict';

  const state = {
    products: [],
    cart: readCart(),
    user: null,
    category: 'all',
    authMode: 'login',
    pendingPayment: null,
    adminProducts: [],
    adminOrders: [],
    adminTickets: [],
    userOrders: [],
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const money = amount => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(Number(amount || 0));
  const date = value => value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const shortId = value => `#${String(value || '').slice(-8)}`;
  const categoryName = value => ({ accounts: 'Аккаунты', subscriptions: 'Подписки', software: 'Софт', games: 'Игры' }[value] || value || 'Товар');
  const statusName = value => ({ awaiting_payment: 'Ожидает оплату', paid: 'Оплачен', fulfilled: 'Выдан', expired: 'Истек резерв', cancelled: 'Отменен', refunded: 'Возврат', payment_failed: 'Ошибка оплаты' }[value] || value || 'Неизвестно');
  const telegramApplicationName = value => ({ freedep: 'Фридеп', redeposit_return: 'Редеп с возвращением баланса', deposit_50_50: 'Деп 50/50' }[value] || value || 'Не указан');
  const legalDocuments = {
    offer: {
      title: 'Публичная оферта',
      intro: 'Условия продажи цифровых товаров через slowyshop.',
      sections: [
        { heading: '1. Общие положения', paragraphs: ['Продавец размещает в каталоге цифровые товары, подписки и доступы с описанием цены, срока, способа доставки и условий гарантии. Покупатель оформляет заказ, принимая условия настоящего документа.'] },
        { heading: '2. Заказ и оплата', paragraphs: ['Заказ считается оформленным после подтверждения на сайте. До подтверждения оплаты товар может быть зарезервирован на ограниченный срок. Цена фиксируется в заказе на момент оформления.', 'Оплата проводится через подключенный платежный сервис. Данные банковской карты не передаются и не хранятся slowyshop.'] },
        { heading: '3. Выдача и использование', paragraphs: ['После подтверждения оплаты данные товара появляются в личном кабинете или передаются оператором согласно карточке товара. Покупатель обязан не передавать полученный доступ третьим лицам и соблюдать правила соответствующего сервиса.', 'Запрещены перепродажа, обход ограничений сервиса, мошенничество и использование товара для нарушения закона.'] },
        { heading: '4. Реквизиты продавца', paragraphs: ['Перед публикацией оферты укажите здесь полное наименование продавца, ИНН/ОГРН или статус самозанятого/ИП, адрес, email поддержки и платежные реквизиты. Не оставляйте шаблонные данные в production.'] },
      ],
    },
    privacy: {
      title: 'Политика конфиденциальности',
      intro: 'Какие данные нужны для оформления заказа и поддержки.',
      sections: [
        { heading: '1. Какие данные обрабатываются', paragraphs: ['slowyshop может обрабатывать email, историю заказов, обращения в поддержку, технические данные сессии и сведения, необходимые для проведения платежа. Пароли хранятся в виде защищенных хешей, а данные выдачи шифруются.'] },
        { heading: '2. Для чего используются данные', paragraphs: ['Данные нужны для регистрации, подтверждения email, оформления и выдачи заказа, возвратов, предотвращения злоупотреблений и ответа на обращения. Email может использоваться для сервисных уведомлений о заказе и тикете.'] },
        { heading: '3. Передача и хранение', paragraphs: ['Платежные данные обрабатывает платежный провайдер по своим правилам. Мы не продаем персональные данные. Доступ к данным ограничивается ролями, а сроки хранения определяются необходимостью исполнения заказа и требованиями закона.'] },
        { heading: '4. Контакты', paragraphs: ['Запрос на уточнение или удаление данных можно направить через поддержку в личном кабинете или на email, указанный в реквизитах продавца.'] },
      ],
    },
    refunds: {
      title: 'Правила возврата',
      intro: 'Порядок обращения по цифровому товару и оплате.',
      sections: [
        { heading: '1. Если товар не выдан', paragraphs: ['Если оплата подтверждена, но выдача недоступна, создайте обращение в личном кабинете. Мы проверим заказ и предложим повторную выдачу, замену или возврат в зависимости от обстоятельств.'] },
        { heading: '2. Если доступ не работает', paragraphs: ['Не меняйте данные аккаунта до обращения в поддержку. Укажите номер заказа и описание проблемы. Обращение рассматривается по условиям гарантии, указанным в карточке товара; при подтвержденной неисправности возможны замена или возврат.'] },
        { heading: '3. Ограничения', paragraphs: ['Возврат не применяется к нарушениям правил сервиса покупателем, передаче данных третьим лицам, самостоятельной смене пароля или использованию товара после истечения срока гарантии, если иное не предусмотрено законом.'] },
        { heading: '4. Как обратиться', paragraphs: ['Откройте личный кабинет, создайте тикет и приложите номер заказа. Не отправляйте пароль или другие секретные данные в обращении. Решение и срок возврата сообщаются через поддержку.'] },
      ],
    },
  };

  function readImageFile(file) {
    if (!file) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      reader.readAsDataURL(file);
    });
  }

  function readCart() {
    try {
      const value = JSON.parse(localStorage.getItem('slowy-cart') || '[]');
      return Array.isArray(value) ? value.filter(item => item && typeof item.productId === 'string' && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10) : [];
    } catch { return []; }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
    return data;
  }

  function saveCart() { localStorage.setItem('slowy-cart', JSON.stringify(state.cart)); }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function setMessage(selector, message = '', good = false) {
    const node = $(selector);
    node.textContent = message;
    node.style.color = good ? 'var(--success)' : '';
  }

  function openOverlay() { $('#overlay').classList.add('open'); document.body.classList.add('locked'); }
  function closeOverlayIfUnused() { if (!$('.drawer.open') && !$('.modal.open')) { $('#overlay').classList.remove('open'); document.body.classList.remove('locked'); } }
  function openDrawer() { $('#cartDrawer').classList.add('open'); openOverlay(); }
  function closeDrawer() { $('#cartDrawer').classList.remove('open'); closeOverlayIfUnused(); }
  function openModal(selector) { $(selector).classList.add('open'); openOverlay(); }
  function closeModal(selector) { $(selector).classList.remove('open'); closeOverlayIfUnused(); }

  function updateHeader() {
    $('#profileText').textContent = state.user ? state.user.email.split('@')[0] : 'Войти';
    $('#adminButton').classList.toggle('hidden', state.user?.role !== 'admin');
    $('#cartCount').textContent = String(state.cart.reduce((sum, item) => sum + item.quantity, 0));
  }

  async function loadProducts() {
    state.products = await request('/api/products');
    state.cart = state.cart.filter(item => state.products.some(product => product.id === item.productId));
    saveCart();
    renderProducts();
    renderCart();
  }

  function renderProducts() {
    const query = $('#searchInput').value.trim().toLowerCase();
    const delivery = $('#deliverySelect').value;
    const sort = $('#sortSelect').value;
    let list = state.products.filter(product => (state.category === 'all' || product.category === state.category) && (!query || `${product.name} ${product.description}`.toLowerCase().includes(query)) && (delivery === 'all' || product.delivery === delivery));
    if (sort === 'low') list = [...list].sort((a, b) => a.price - b.price);
    if (sort === 'high') list = [...list].sort((a, b) => b.price - a.price);
    $('#productTotal').textContent = String(list.length).padStart(2, '0');
    const grid = $('#productGrid');
    grid.replaceChildren();
    if (!list.length) { grid.append(make('div', 'empty', 'По этому запросу ничего не найдено.')); return; }
    list.forEach(product => grid.append(productCard(product)));
  }

  function productCard(product) {
    const card = make('article', 'product-card');
    const cover = make('div', 'product-cover');
    cover.style.setProperty('--card-accent', product.accent);
    cover.style.setProperty('--card-bg', product.bg);
    if (product.image) cover.style.background = `url("${product.image}") center / cover no-repeat`;
    const badges = make('div', 'badges');
    badges.append(make('span', '', categoryName(product.category)), make('span', '', product.delivery === 'instant' ? 'Моментально' : 'Вручную'));
    const icon = make('div', 'product-icon', product.icon || '✦');
    icon.style.setProperty('--icon-bg', product.bg);
    icon.style.setProperty('--icon-color', product.color);
    cover.append(badges, icon);
    const body = make('div', 'product-body');
    body.append(make('h3', '', product.name));
    const description = make('p', 'product-description', product.description);
    description.title = product.description;
    body.append(description);
    const priceRow = make('div', 'price-row');
    priceRow.append(make('strong', 'price', money(product.price)));
    const oldPrice = Math.max(1, Math.round(product.price * 1.16 / 10) * 10);
    priceRow.append(make('span', 'old-price', money(oldPrice)), make('span', 'discount', `-${Math.round((1 - product.price / oldPrice) * 100)}%`));
    body.append(priceRow);
    const meta = make('div', 'product-meta');
    meta.append(make('span', product.stock > 0 ? 'stock-good' : '', product.stock > 0 ? `В наличии: ${product.stock}` : 'Нет в наличии'), make('span', '', product.delivery === 'instant' ? 'Автовыдача' : 'Оператор'));
    body.append(meta);
    const buy = make('button', 'product-buy', product.stock > 0 ? 'Добавить в корзину' : 'Нет в наличии');
    buy.type = 'button'; buy.disabled = product.stock < 1; buy.addEventListener('click', () => addToCart(product.id));
    body.append(buy); card.append(cover, body); return card;
  }

  function addToCart(productId) {
    const product = state.products.find(item => item.id === productId);
    if (!product) return;
    const item = state.cart.find(entry => entry.productId === productId);
    if (item) item.quantity = Math.min(10, item.quantity + 1); else state.cart.push({ productId, quantity: 1 });
    saveCart(); renderCart(); updateHeader(); openDrawer();
  }

  function changeCart(productId, delta) {
    const item = state.cart.find(entry => entry.productId === productId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity < 1) state.cart = state.cart.filter(entry => entry.productId !== productId);
    if (item.quantity > 10) item.quantity = 10;
    saveCart(); renderCart(); updateHeader();
  }

  function renderCart() {
    const list = $('#cartList'); list.replaceChildren();
    let total = 0;
    if (!state.cart.length) list.append(make('div', 'cart-empty', 'Корзина пока пуста.'));
    state.cart.forEach(item => {
      const product = state.products.find(entry => entry.id === item.productId);
      if (!product) return;
      total += product.price * item.quantity;
      const row = make('div', 'cart-item');
      const thumb = make('div', 'cart-thumb', product.icon || '✦'); thumb.style.color = product.color; thumb.style.background = product.bg;
      const info = make('div'); info.append(make('h4', '', `${product.name} × ${item.quantity}`), make('p', '', product.description));
      const actions = make('div', 'cart-actions');
      const minus = make('button', 'qty-button', '−'); minus.type = 'button'; minus.addEventListener('click', () => changeCart(product.id, -1));
      const plus = make('button', 'qty-button', '+'); plus.type = 'button'; plus.addEventListener('click', () => changeCart(product.id, 1));
      const remove = make('button', 'remove-button', 'Убрать'); remove.type = 'button'; remove.addEventListener('click', () => { state.cart = state.cart.filter(entry => entry.productId !== product.id); saveCart(); renderCart(); updateHeader(); });
      actions.append(minus, plus, remove); info.append(actions);
      row.append(thumb, info, make('strong', '', money(product.price * item.quantity))); list.append(row);
    });
    $('#cartTotal').textContent = money(total); updateHeader();
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const verification = mode === 'verify';
    $('#verificationBlock').classList.toggle('hidden', !verification);
    $('#passwordInput').classList.toggle('hidden', verification);
    $('#passwordLabel').classList.toggle('hidden', verification);
    $('#authSwitch').classList.toggle('hidden', verification);
    $('#authTitle').textContent = verification ? 'Проверьте почту' : mode === 'login' ? 'Войти в slowyshop.' : 'Создать slowyshop.';
    $('#authIntro').textContent = verification ? 'Введите код из письма. В локальном режиме он показан ниже.' : mode === 'login' ? 'Заказы, выдача и поддержка будут в одном личном кабинете.' : 'Мы отправим код подтверждения на указанную почту.';
    $('#authSubmit').textContent = verification ? 'Подтвердить email' : mode === 'login' ? 'Войти' : 'Отправить код';
    $('#authSwitch').textContent = mode === 'login' ? 'Создать новый аккаунт' : 'У меня уже есть аккаунт';
    setMessage('#authMessage');
    if (!verification) { $('#devCode').classList.add('hidden'); $('#devCode').replaceChildren(); }
  }

  function openAuth(mode = 'login') { setAuthMode(mode); openModal('#authModal'); $('#emailInput').focus(); }

  async function submitAuth(event) {
    event.preventDefault();
    const email = $('#emailInput').value.trim();
    try {
      if (state.authMode === 'verify') {
        const data = await request('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ email, code: $('#verificationCode').value.trim() }) });
        state.user = data.user; closeModal('#authModal'); updateHeader(); showToast('Email подтвержден. Добро пожаловать.'); await showAccount(); return;
      }
      const data = await request(`/api/auth/${state.authMode}`, { method: 'POST', body: JSON.stringify({ email, password: $('#passwordInput').value }) });
      if (state.authMode === 'register') {
        setAuthMode('verify');
        if (data.devCode) { const code = make('strong', '', data.devCode); $('#devCode').replaceChildren(make('span', '', 'Локальный код подтверждения'), code); $('#devCode').classList.remove('hidden'); }
        setMessage('#authMessage', 'Код отправлен. Он действует 10 минут.', true);
        return;
      }
      state.user = data.user; closeModal('#authModal'); updateHeader(); showToast('Вы вошли в аккаунт.'); if (state.user.role === 'admin') showAdmin(); else showAccount();
    } catch (error) { setMessage('#authMessage', error.message); }
  }

  async function checkout() {
    if (!state.cart.length) { showToast('Добавьте товар в корзину.'); return; }
    if (!state.user) { closeDrawer(); openAuth(); showToast('Сначала войдите в аккаунт.'); return; }
    try { const data = await request('/api/orders', { method: 'POST', body: JSON.stringify({ items: state.cart }) }); state.pendingPayment = data; closeDrawer(); showPayment(data); } catch (error) { showToast(error.message); await loadProducts(); }
  }

  function showPayment(data) {
    const order = data.order;
    $('#paymentSummary').replaceChildren(make('span', '', `${shortId(order.id)} · ${order.items.map(item => `${item.name} × ${item.quantity}`).join(', ')}`), make('strong', '', money(order.total)));
    const demo = data.payment?.mode === 'demo';
    $('#confirmPayment').classList.toggle('hidden', !demo); $('#externalPayment').classList.toggle('hidden', demo); $('#externalPayment').href = data.payment?.confirmationUrl || '#';
    $('#paymentCopy').textContent = demo ? 'Это безопасный demo-режим для проверки сценария. В production используйте PAYMENT_MODE=yookassa.' : 'Вы будете перенаправлены на защищенную страницу платежного провайдера.';
    $('#confirmPayment').textContent = demo ? 'Подтвердить demo-оплату' : 'Оплатить'; setMessage('#paymentMessage'); openModal('#paymentModal');
  }

  async function confirmPayment() {
    if (!state.pendingPayment?.order?.id) return;
    $('#confirmPayment').disabled = true;
    try { await request('/api/payments/demo/confirm', { method: 'POST', body: JSON.stringify({ orderId: state.pendingPayment.order.id }) }); state.cart = []; saveCart(); renderCart(); closeModal('#paymentModal'); showToast('Оплата подтверждена. Данные доступны в кабинете.'); await loadProducts(); await showAccount(); } catch (error) { setMessage('#paymentMessage', error.message); } finally { $('#confirmPayment').disabled = false; }
  }

  function setView(view) {
    $('#storeView').classList.toggle('hidden', view !== 'store'); $('#accountView').classList.toggle('hidden', view !== 'account'); $('#legalView').classList.toggle('hidden', view !== 'legal'); $('#adminView').classList.toggle('hidden', view !== 'admin');
    $$('.info-grid, .support-strip, .footer').forEach(section => section.classList.toggle('hidden', view !== 'store'));
    if (view !== 'store') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function navigateToSection(section) {
    setView('store');
    $('.main-nav').classList.remove('open');
    requestAnimationFrame(() => {
      const target = document.getElementById(section);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showLegal(key) {
    const documentData = legalDocuments[key];
    if (!documentData) return;
    $('#legalTitle').replaceChildren(document.createTextNode(documentData.title), make('span', 'accent', '.'));
    $('#legalIntro').textContent = documentData.intro;
    const content = $('#legalContent'); content.replaceChildren();
    documentData.sections.forEach(section => { content.append(make('h2', '', section.heading)); section.paragraphs.forEach(paragraph => content.append(make('p', '', paragraph))); });
    setView('legal'); window.history.replaceState(null, '', `#${key}`); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function showAccount() {
    if (!state.user) { openAuth(); return; }
    setView('account'); $('#accountEmail').textContent = state.user.email;
    await Promise.all([loadOrders(), loadTickets()]);
  }

  async function loadOrders() { const orders = await request('/api/orders'); state.userOrders = orders; renderOrders(orders); fillTicketOrders(orders); }

  function renderOrders(orders) {
    const list = $('#ordersList'); list.replaceChildren();
    if (!orders.length) { list.append(make('p', 'empty-copy', 'Заказов пока нет. Откройте каталог и выберите товар.')); return; }
    orders.forEach(order => {
      const card = make('article', 'order-card'); const top = make('div', 'order-top'); top.append(make('strong', '', shortId(order.id)), make('span', '', date(order.createdAt)));
      const items = make('p', 'order-items', order.items.map(item => `${item.name} × ${item.quantity}`).join(' · ')); const bottom = make('div', 'order-bottom');
      const badge = make('span', `status-badge ${['cancelled', 'refunded', 'expired', 'payment_failed'].includes(order.status) ? 'danger' : order.status === 'awaiting_payment' ? 'neutral' : ''}`, statusName(order.status)); const controls = make('div', 'table-actions');
      if (order.deliveryAvailable) { const delivery = make('button', 'table-button', 'Открыть выдачу'); delivery.type = 'button'; delivery.addEventListener('click', () => loadDelivery(order.id)); controls.append(delivery); }
      if (order.status === 'awaiting_payment') { const pay = make('button', 'table-button', 'Оплатить'); pay.type = 'button'; pay.addEventListener('click', () => reopenPayment(order)); const cancel = make('button', 'table-button', 'Отменить'); cancel.type = 'button'; cancel.addEventListener('click', () => cancelOrder(order.id)); controls.append(pay, cancel); }
      bottom.append(badge, make('strong', '', money(order.total)), controls); card.append(top, items, bottom); list.append(card);
    });
  }

  function reopenPayment(order) { if (order.paymentUrl) { window.location.href = order.paymentUrl; return; } state.pendingPayment = { order, payment: { mode: 'demo', orderId: order.id } }; showPayment(state.pendingPayment); }

  async function cancelOrder(orderId) {
    if (!window.confirm('Отменить заказ и освободить резерв?')) return;
    try { await request(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' }); showToast('Заказ отменен.'); await loadProducts(); await loadOrders(); } catch (error) { showToast(error.message); }
  }

  async function loadDelivery(orderId) {
    try {
      const data = await request(`/api/orders/${encodeURIComponent(orderId)}/delivery`); const panel = $('#deliveryList'); panel.replaceChildren(); const card = make('div', 'delivery-card'); card.append(make('h3', '', `Выдача ${shortId(data.orderId)}`));
      data.items.forEach(item => { const block = make('div'); block.append(make('h3', '', item.productName)); [['Логин', item.login], ['Пароль', item.password], ['Дополнительно', item.extra || '—']].forEach(([label, value]) => { const row = make('div', 'secret-row'); row.append(make('span', '', label), make('strong', 'secret-value', value)); block.append(row); }); card.append(block); }); panel.append(card); $('#deliveryPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) { showToast(error.message); }
  }

  function fillTicketOrders(orders) { const select = $('#ticketOrder'); select.replaceChildren(); select.append(new Option('Без заказа', '')); orders.forEach(order => select.append(new Option(`${shortId(order.id)} · ${money(order.total)}`, order.id))); }

  async function loadTickets() {
    const tickets = await request('/api/tickets'); const list = $('#ticketsList'); list.replaceChildren();
    if (!tickets.length) { list.append(make('p', 'empty-copy', 'Обращений пока нет.')); return; }
    tickets.forEach(ticket => {
      const card = make('div', 'ticket-card');
      card.append(make('strong', '', ticket.subject), make('small', '', `${ticket.status} · ${date(ticket.createdAt)}`));
      (ticket.messages || [{ message: ticket.message, author: 'customer', createdAt: ticket.createdAt }]).forEach(message => card.append(make('p', message.author === 'admin' ? 'ticket-admin-message' : 'ticket-customer-message', `${message.author === 'admin' ? 'Поддержка: ' : 'Вы: '}${message.message}`)));
      const reply = make('textarea', 'field textarea ticket-reply'); reply.maxLength = 3000; reply.placeholder = 'Ответить в этом обращении';
      const replyButton = make('button', 'button secondary small-button', 'Ответить'); replyButton.type = 'button';
      const replyStatus = make('p', 'form-message', '');
      replyButton.addEventListener('click', async () => {
        const message = reply.value.trim();
        if (!message) { replyStatus.textContent = 'Введите сообщение.'; return; }
        replyButton.disabled = true; replyStatus.textContent = '';
        try { await request(`/api/tickets/${encodeURIComponent(ticket.id)}/reply`, { method: 'POST', body: JSON.stringify({ message }) }); await loadTickets(); }
        catch (error) { replyStatus.textContent = error.message; }
        finally { replyButton.disabled = false; }
      });
      card.append(reply, replyButton, replyStatus); list.append(card);
    });
  }

  async function submitTicket(event) {
    event.preventDefault();
    try { await request('/api/tickets', { method: 'POST', body: JSON.stringify({ orderId: $('#ticketOrder').value, subject: $('#ticketSubject').value, message: $('#ticketMessage').value }) }); $('#ticketForm').reset(); setMessage('#ticketMessageStatus', 'Обращение отправлено.', true); await loadTickets(); } catch (error) { setMessage('#ticketMessageStatus', error.message); }
  }

  async function showAdmin() { if (state.user?.role !== 'admin') { openAuth(); return; } setView('admin'); await loadAdmin(); }

  async function loadAdmin() {
    try { const [stats, products, orders, tickets] = await Promise.all([request('/api/admin/stats'), request('/api/admin/products'), request('/api/admin/orders'), request('/api/admin/tickets')]); state.adminProducts = products; state.adminOrders = orders; state.adminTickets = tickets; $('#statRevenue').textContent = money(stats.revenue); $('#statOrders').textContent = stats.orders; $('#statInventory').textContent = stats.availableInventory; $('#statTickets').textContent = stats.openTickets; renderAdminProducts(); renderInventoryProductSelect(); renderAdminOrders(); renderAdminTickets(); await loadInventory(); } catch (error) { showToast(error.message); }
  }

  function renderAdminProducts() {
    const list = $('#adminProducts'); list.replaceChildren();
    state.adminProducts.forEach(product => { const row = make('div', 'table-row'); row.append(make('span', '', `${product.name}${product.active ? '' : ' · скрыт'}`), make('span', '', money(product.price)), make('span', '', `${product.stock} / ${product.inventoryTotal}`)); const actions = make('span', 'table-actions'); const edit = make('button', 'table-button', 'Изменить'); edit.type = 'button'; edit.addEventListener('click', () => editProduct(product)); const hide = make('button', 'table-button', product.active ? 'Скрыть' : 'Удалить'); hide.type = 'button'; hide.addEventListener('click', () => archiveProduct(product.id)); actions.append(edit, hide); row.append(actions); list.append(row); });
    if (!state.adminProducts.length) list.append(make('div', 'empty', 'Товаров пока нет.'));
  }

  function renderInventoryProductSelect() { const select = $('#inventoryProduct'); const selected = select.value; select.replaceChildren(); state.adminProducts.filter(product => product.active).forEach(product => select.append(new Option(`${product.name} · доступно ${product.stock}`, product.id))); if (state.adminProducts.some(product => product.id === selected)) select.value = selected; }

  async function loadInventory() {
    const productId = $('#inventoryProduct').value;
    if (!productId) { $('#adminInventory').replaceChildren(); $('#inventorySummary').textContent = ''; return; }
    const product = state.adminProducts.find(item => item.id === productId); const inventory = await request(`/api/admin/inventory?productId=${encodeURIComponent(productId)}`); $('#inventorySummary').textContent = `${product?.name || 'Товар'}: ${product?.stock || 0} доступно · ${product?.reserved || 0} в резерве · ${product?.sold || 0} продано`;
    const list = $('#adminInventory'); list.replaceChildren(); inventory.forEach(item => { const row = make('div', 'table-row'); row.append(make('span', '', product?.name || item.productId), make('span', '', item.loginHint), make('span', '', item.status), make('span', 'table-actions')); if (['available', 'blocked'].includes(item.status)) { const button = make('button', 'table-button', item.status === 'available' ? 'Заблокировать' : 'Разблокировать'); button.type = 'button'; button.addEventListener('click', () => toggleInventory(item)); row.lastChild.append(button); } list.append(row); }); if (!inventory.length) list.append(make('div', 'empty', 'В этом товаре пока нет единиц.'));
  }

  async function toggleInventory(item) { try { await request(`/api/admin/inventory/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: item.status === 'available' ? 'blocked' : 'available' }) }); await loadAdmin(); } catch (error) { showToast(error.message); } }

  function editProduct(product) { $('#productForm').classList.remove('hidden'); $('#productId').value = product.id; $('#productName').value = product.name; $('#productDescription').value = product.description; $('#productPrice').value = product.price; $('#productCategory').value = product.category; $('#productDelivery').value = product.delivery; $('#productImage').value = product.image?.startsWith('data:') ? '' : (product.image || ''); $('#productImageFile').value = ''; $('#productName').focus(); }
  function resetProductForm() { $('#productForm').reset(); $('#productId').value = ''; $('#productForm').classList.add('hidden'); setMessage('#productMessage'); }

  async function submitProduct(event) {
    event.preventDefault(); const productId = $('#productId').value; const file = $('#productImageFile').files[0];
    try {
      const uploadedImage = file ? await readImageFile(file) : '';
      const payload = { name: $('#productName').value, description: $('#productDescription').value, price: Number($('#productPrice').value), category: $('#productCategory').value, delivery: $('#productDelivery').value, image: uploadedImage || $('#productImage').value.trim() };
      await request(productId ? `/api/admin/products/${encodeURIComponent(productId)}` : '/api/admin/products', { method: productId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); resetProductForm(); await loadProducts(); await loadAdmin(); showToast('Товар сохранен.');
    } catch (error) { setMessage('#productMessage', error.message); }
  }

  async function archiveProduct(productId) { if (!window.confirm('Скрыть товар из каталога?')) return; try { await request(`/api/admin/products/${encodeURIComponent(productId)}`, { method: 'DELETE' }); await loadProducts(); await loadAdmin(); } catch (error) { showToast(error.message); } }

  async function submitInventory(event) {
    event.preventDefault();
    try { const data = await request('/api/admin/inventory/bulk', { method: 'POST', body: JSON.stringify({ productId: $('#inventoryProduct').value, accounts: $('#inventoryAccounts').value }) }); $('#inventoryAccounts').value = ''; setMessage('#inventoryMessage', `Загружено: ${data.added}. Пропущено: ${data.skipped}.`, true); await loadProducts(); await loadAdmin(); } catch (error) { setMessage('#inventoryMessage', error.message); }
  }

  function renderAdminOrders() {
    const list = $('#adminOrders'); list.replaceChildren();
    state.adminOrders.forEach(order => { const row = make('div', 'table-row admin-order-row'); const owner = make('span'); owner.append(make('strong', '', shortId(order.id)), make('small', '', ` ${order.email || ''}`)); row.append(owner, make('span', '', money(order.total))); const select = document.createElement('select'); select.className = 'table-button'; const allowed = order.status === 'paid' ? ['paid', 'fulfilled', 'refunded'] : order.status === 'awaiting_payment' ? ['awaiting_payment', 'cancelled'] : [order.status]; allowed.forEach(value => select.append(new Option(statusName(value), value, false, order.status === value))); select.addEventListener('change', () => updateAdminOrder(order.id, select.value)); row.append(select, make('span', '', date(order.createdAt))); list.append(row); }); if (!state.adminOrders.length) list.append(make('div', 'empty', 'Заказов пока нет.'));
  }

  async function updateAdminOrder(orderId, status) { try { await request(`/api/admin/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAdmin(); showToast('Статус заказа обновлен.'); } catch (error) { showToast(error.message); await loadAdmin(); } }

  function renderAdminTickets() {
    const list = $('#adminTickets'); list.replaceChildren();
    state.adminTickets.forEach(ticket => {
      const card = make('div', 'ticket-card');
      const heading = make('div', 'order-top');
      heading.append(make('strong', '', ticket.subject), make('span', '', ticket.status));
      card.append(heading);
      if (ticket.source === 'telegram' && ticket.telegram) {
        const telegramDetails = make('div', 'telegram-ticket-details');
        telegramDetails.append(make('span', 'ticket-source', 'Telegram'));
        telegramDetails.append(make('p', '', `Контакт: ${ticket.telegram.username ? `@${ticket.telegram.username}` : `ID ${ticket.telegram.userId || '—'}`}`));
        const profile = make('a', 'ticket-profile-link', ticket.telegram.profileUrl || 'Ссылка не указана');
        profile.href = ticket.telegram.profileUrl || '#';
        profile.target = '_blank';
        profile.rel = 'noopener noreferrer';
        telegramDetails.append(make('p', '', 'Профиль LOLZ:'), profile);
        telegramDetails.append(make('p', '', `Вариант: ${telegramApplicationName(ticket.telegram.applicationType)}`));
        if (ticket.telegram.applicationComment) telegramDetails.append(make('p', '', `Комментарий: ${ticket.telegram.applicationComment}`));
        card.append(telegramDetails);
        if (ticket.stage === 'profile_review' && ticket.telegramReview === 'pending') {
          const reviewActions = make('div', 'table-actions ticket-review-actions');
          const approve = make('button', 'table-button', 'Ссылка проверена');
          const reject = make('button', 'table-button', 'Отклонить');
          approve.type = 'button'; reject.type = 'button';
          approve.addEventListener('click', () => reviewTelegramTicket(ticket.id, 'approve_profile'));
          reject.addEventListener('click', () => reviewTelegramTicket(ticket.id, 'reject_profile'));
          reviewActions.append(approve, reject); card.append(reviewActions);
        }
      } else {
        card.append(make('p', '', `${ticket.email || 'без email'} · ${ticket.orderId || 'без заказа'}`));
      }
      (ticket.messages || [{ message: ticket.message, author: 'customer' }]).forEach(message => card.append(make('p', message.author === 'admin' ? 'ticket-admin-message' : 'ticket-customer-message', `${message.author === 'admin' ? 'Поддержка: ' : 'Клиент: '}${message.message}`)));
      const reply = make('textarea', 'field textarea ticket-reply', '');
      reply.placeholder = ticket.source === 'telegram' ? 'Ответить пользователю в Telegram' : 'Ваш ответ клиенту';
      const replyButton = make('button', 'button primary small-button', 'Ответить');
      replyButton.type = 'button';
      replyButton.addEventListener('click', async () => {
        try { await request(`/api/admin/tickets/${encodeURIComponent(ticket.id)}/reply`, { method: 'POST', body: JSON.stringify({ message: reply.value }) }); await loadAdmin(); }
        catch (error) { showToast(error.message); }
      });
      const select = document.createElement('select');
      select.className = 'table-button';
      ['open', 'in_progress', 'closed'].forEach(value => select.append(new Option(value, value, false, ticket.status === value)));
      select.addEventListener('change', async () => {
        try { await request(`/api/admin/tickets/${encodeURIComponent(ticket.id)}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await loadAdmin(); }
        catch (error) { showToast(error.message); }
      });
      card.append(reply, replyButton, select); list.append(card);
    });
    if (!state.adminTickets.length) list.append(make('p', 'empty-copy', 'Обращений пока нет.'));
  }

  async function reviewTelegramTicket(ticketId, status) {
    try {
      const data = await request(`/api/admin/tickets/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      showToast(data.reviewMessage || 'Заявка обновлена.');
      await loadAdmin();
    } catch (error) { showToast(error.message); }
  }

  async function logout() { try { await request('/api/auth/logout', { method: 'POST' }); state.user = null; closeDrawer(); closeModal('#authModal'); closeModal('#paymentModal'); updateHeader(); setView('store'); showToast('Вы вышли из аккаунта.'); } catch (error) { showToast(error.message); } }

  async function init() {
    const theme = localStorage.getItem('slowy-theme'); document.documentElement.dataset.theme = theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    $('#themeToggle').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('slowy-theme', next); });
    $('#cartButton').addEventListener('click', openDrawer); $('#closeCart').addEventListener('click', closeDrawer); $('#overlay').addEventListener('click', () => { closeDrawer(); closeModal('#authModal'); closeModal('#paymentModal'); });
    $('#heroLogin').addEventListener('click', () => state.user ? showAccount() : openAuth()); $('#profileButton').addEventListener('click', () => state.user ? (state.user.role === 'admin' ? showAdmin() : showAccount()) : openAuth()); $('#adminButton').addEventListener('click', showAdmin);
    $('#closeAuth').addEventListener('click', () => closeModal('#authModal')); $('#closePayment').addEventListener('click', () => closeModal('#paymentModal')); $('#cancelPayment').addEventListener('click', () => closeModal('#paymentModal')); $('#authForm').addEventListener('submit', submitAuth); $('#authSwitch').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login')); $('#resendCodeButton').addEventListener('click', async () => { try { const data = await request('/api/auth/resend-code', { method: 'POST', body: JSON.stringify({ email: $('#emailInput').value.trim() }) }); if (data.devCode) { const code = make('strong', '', data.devCode); $('#devCode').replaceChildren(make('span', '', 'Локальный код подтверждения'), code); $('#devCode').classList.remove('hidden'); } setMessage('#authMessage', 'Новый код отправлен.', true); } catch (error) { setMessage('#authMessage', error.message); } });
    $('#checkoutButton').addEventListener('click', checkout); $('#confirmPayment').addEventListener('click', confirmPayment); $('#accountLogout').addEventListener('click', logout); $('#adminLogout').addEventListener('click', logout); $('#backToStore').addEventListener('click', () => setView('store')); $('#backToStoreFromLegal').addEventListener('click', () => { window.history.replaceState(null, '', '#top'); navigateToSection('top'); }); $('#refreshOrders').addEventListener('click', loadOrders); $('#supportButton').addEventListener('click', () => state.user ? showAccount() : openAuth()); $('#ticketForm').addEventListener('submit', submitTicket); $$('[data-legal]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showLegal(link.dataset.legal); }));
    $('#newProductButton').addEventListener('click', () => { resetProductForm(); $('#productForm').classList.remove('hidden'); $('#productName').focus(); }); $('#cancelProductButton').addEventListener('click', resetProductForm); $('#productForm').addEventListener('submit', submitProduct); $('#inventoryForm').addEventListener('submit', submitInventory); $('#inventoryProduct').addEventListener('change', loadInventory); $('#refreshAdmin').addEventListener('click', loadAdmin); $('#toggleInventoryForm').addEventListener('click', () => { const panel = $('#inventoryPanel'); const open = panel.classList.toggle('hidden'); $('#toggleInventoryForm').textContent = open ? 'Открыть' : 'Скрыть'; $('#toggleInventoryForm').setAttribute('aria-expanded', String(!open)); });
    $('#searchInput').addEventListener('input', renderProducts); $('#sortSelect').addEventListener('change', renderProducts); $('#deliverySelect').addEventListener('change', renderProducts); $('#categories').addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (!button) return; $$('.pill').forEach(item => item.classList.toggle('active', item === button)); state.category = button.dataset.category; renderProducts(); }); $('#mobileMenu').addEventListener('click', () => $('.main-nav').classList.toggle('open')); $$('[data-section]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); navigateToSection(link.dataset.section); }));
    try { const session = await request('/api/auth/me'); state.user = session.user; updateHeader(); await loadProducts(); const query = new URLSearchParams(window.location.search); if (state.user && query.get('order')) { await request(`/api/orders/${encodeURIComponent(query.get('order'))}/refresh-payment`, { method: 'POST' }).catch(() => null); await showAccount(); showToast('Платеж проверен.'); } } catch { $('#productGrid').replaceChildren(make('div', 'empty', 'Сервер не запущен. Для каталога выполните npm start.')); }
    const legalKey = window.location.hash.slice(1); if (legalDocuments[legalKey]) showLegal(legalKey);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
