const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка сессий
const sessionMiddleware = session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
});

app.use(sessionMiddleware);

// Передаем сессии в Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// Middleware для проверки авторизации
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(403).send('Необходимо войти в систему. <a href="/login">Войти</a>');
    }
    next();
};

// Настройка подключения к PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'agroshop',
    password: '2264',
    port: 5433,
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Ошибка подключения к базе данных:', err.stack);
    }
    console.log('Успешно подключено к базе данных PostgreSQL');
    release();
});

// Настройка шаблонизатора EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Настройка статических файлов
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Маршруты
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(`
            SELECT id, email, password, first_name, last_name, avatar_url
            FROM Users
            WHERE email = $1
        `, [email]);

        if (result.rows.length === 0) {
            return res.render('login', { error: 'Пользователь не найден' });
        }

        const user = result.rows[0];
        if (password !== user.password) {
            return res.render('login', { error: 'Неверный пароль' });
        }

        req.session.userId = user.id;
        req.session.user = {
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            avatar_url: user.avatar_url
        };
        res.redirect('/profile');
    } catch (err) {
        console.error('Ошибка при входе:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { email, password, firstName, lastName } = req.body;

    try {
        const existingUser = await pool.query(`
            SELECT id
            FROM Users
            WHERE email = $1
        `, [email]);

        if (existingUser.rows.length > 0) {
            return res.render('register', { error: 'Пользователь с таким email уже существует' });
        }

        const result = await pool.query(`
            INSERT INTO Users (email, password, first_name, last_name, role, registration_date)
            VALUES ($1, $2, $3, $4, 'user', CURRENT_TIMESTAMP)
            RETURNING id, email, first_name, last_name
        `, [email, password, firstName, lastName]);

        const user = result.rows[0];
        req.session.userId = user.id;
        req.session.user = {
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            avatar_url: null
        };
        res.redirect('/profile');
    } catch (err) {
        console.error('Ошибка при регистрации:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка при выходе:', err.stack);
            return res.status(500).send('Ошибка сервера');
        }
        res.redirect('/');
    });
});

app.get('/catalog', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.article, p.name, p.description, p.image_url, p.price, p.stock, c.name AS category_name
            FROM Products p
            LEFT JOIN Categories c ON p.category_id = c.id
        `);
        res.render('catalog', { products: result.rows, user: req.session.user });
    } catch (err) {
        console.error('Ошибка при получении товаров:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/cart', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(403).send('Необходимо войти в систему. <a href="/login">Войти</a>');
        }

        const result = await pool.query(`
            SELECT c.id, c.quantity, p.article, p.name, p.price, p.image_url
            FROM Cart c
            JOIN Products p ON c.product_article = p.article
            WHERE c.user_id = $1
        `, [req.session.userId]);
        res.render('cart', { cartItems: result.rows, user: req.session.user });
    } catch (err) {
        console.error('Ошибка при получении корзины:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/cart/add', async (req, res) => {
    if (!req.session.userId) {
        return res.status(403).send('Необходимо войти в систему. <a href="/login">Войти</a>');
    }

    const { article, quantity } = req.body;
    const userId = req.session.userId;

    try {
        const existingItem = await pool.query(`
            SELECT id, quantity
            FROM Cart
            WHERE user_id = $1 AND product_article = $2
        `, [userId, article]);

        if (existingItem.rows.length > 0) {
            const newQuantity = existingItem.rows[0].quantity + parseInt(quantity);
            await pool.query(`
                UPDATE Cart
                SET quantity = $1
                WHERE id = $2
            `, [newQuantity, existingItem.rows[0].id]);
        } else {
            await pool.query(`
                INSERT INTO Cart (user_id, product_article, quantity)
                VALUES ($1, $2, $3)
            `, [userId, article, parseInt(quantity)]);
        }
        res.redirect('/cart');
    } catch (err) {
        console.error('Ошибка при добавлении товара в корзину:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/profile', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT email, first_name, last_name, phone, address, birth_date, gender, newsletter, registration_date, avatar_url
            FROM Users
            WHERE id = $1
        `, [req.session.userId]);

        if (result.rows.length === 0) {
            return res.status(404).send('Пользователь не найден');
        }
        res.render('profile', { user: result.rows[0] });
    } catch (err) {
        console.error('Ошибка при получении профиля:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршрут для страницы оплаты
app.get('/payment/:orderId', requireAuth, async (req, res) => {
    const orderId = req.params.orderId;
    const userId = req.session.userId;

    try {
        const orderRes = await pool.query(
            `SELECT o.id, o.total_price, o.shipping_address, o.created_at, oi.quantity, oi.price_at_time, p.name, p.article 
             FROM orders o 
             JOIN order_items oi ON o.id = oi.order_id 
             JOIN products p ON oi.product_article = p.article 
             WHERE o.id = $1 AND o.user_id = $2`,
            [orderId, userId]
        );

        if (orderRes.rows.length === 0) {
            return res.status(404).send('Заказ не найден');
        }

        const order = orderRes.rows[0];
        res.render('payment', { order, user: req.session.user });
    } catch (err) {
        console.error('Ошибка при получении заказа для оплаты:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршрут для обработки оплаты
app.post('/payment/:orderId/process', requireAuth, async (req, res) => {
    const orderId = req.params.orderId;
    const userId = req.session.userId;

    try {
        const orderRes = await pool.query(
            `SELECT * FROM orders WHERE id = $1 AND user_id = $2`,
            [orderId, userId]
        );

        if (orderRes.rows.length === 0) {
            return res.status(404).send('Заказ не найден');
        }

        // Здесь должна быть интеграция с платёжной системой (например, Stripe, PayPal).
        // Для примера просто обновим статус заказа.
        await pool.query(
            `UPDATE orders SET status = $1, payment_method = $2 WHERE id = $3`,
            ['completed', 'card', orderId]
        );

        res.redirect('/order-history');
    } catch (err) {
        console.error('Ошибка при обработке оплаты:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/profile', requireAuth, async (req, res) => {
    const {
        email, firstName, lastName, phone, address, birthDate, gender, newsletter, newPassword, currentPassword
    } = req.body;
    const userId = req.session.userId;

    try {
        const userResult = await pool.query(`
            SELECT password
            FROM Users
            WHERE id = $1
        `, [userId]);

        if (userResult.rows.length === 0) {
            return res.status(404).send('Пользователь не найден');
        }

        const currentPasswordInDb = userResult.rows[0].password;
        if (currentPassword !== currentPasswordInDb) {
            return res.status(400).send('Неверный текущий пароль');
        }

        const updateFields = [];
        const values = [];
        let paramIndex = 1;

        if (email) {
            updateFields.push(`email = $${paramIndex++}`);
            values.push(email);
        }
        if (firstName) {
            updateFields.push(`first_name = $${paramIndex++}`);
            values.push(firstName);
        }
        if (lastName) {
            updateFields.push(`last_name = $${paramIndex++}`);
            values.push(lastName);
        }
        if (phone) {
            updateFields.push(`phone = $${paramIndex++}`);
            values.push(phone);
        }
        if (address) {
            updateFields.push(`address = $${paramIndex++}`);
            values.push(address);
        }
        if (birthDate) {
            updateFields.push(`birth_date = $${paramIndex++}`);
            values.push(birthDate);
        }
        if (gender) {
            updateFields.push(`gender = $${paramIndex++}`);
            values.push(gender);
        }
        updateFields.push(`newsletter = $${paramIndex++}`);
        values.push(newsletter === 'on');

        if (newPassword) {
            updateFields.push(`password = $${paramIndex++}`);
            values.push(newPassword);
        }

        values.push(userId);

        if (updateFields.length > 0) {
            await pool.query(`
                UPDATE Users
                SET ${updateFields.join(', ')}
                WHERE id = $${paramIndex}
            `, values);

            const updatedUser = await pool.query(`
                SELECT email, first_name, last_name, avatar_url
                FROM Users
                WHERE id = $1
            `, [userId]);
            req.session.user = updatedUser.rows[0];
        }

        res.redirect('/profile');
    } catch (err) {
        console.error('Ошибка при обновлении профиля:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/order-history', requireAuth, async (req, res) => {
    try {
        const ordersResult = await pool.query(`
            SELECT id, total_price, status, shipping_address, payment_method, created_at
            FROM Orders
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [req.session.userId]);

        const orders = ordersResult.rows.map(order => {
            const totalPrice = parseFloat(order.total_price);
            return {
                ...order,
                total_price: isNaN(totalPrice) ? 0 : totalPrice
            };
        });

        for (let order of orders) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price_at_time, p.name, p.image_url
                FROM Order_Items oi
                JOIN Products p ON oi.product_article = p.article
                WHERE oi.order_id = $1
            `, [order.id]);

            order.items = itemsResult.rows.map(item => {
                const priceAtTime = parseFloat(item.price_at_time);
                return {
                    ...item,
                    price_at_time: isNaN(priceAtTime) ? 0 : priceAtTime
                };
            });
        }

        res.render('order-history', { orders, user: req.session.user });
    } catch (err) {
        console.error('Ошибка при получении истории заказов:', err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Логика бота через Socket.IO 
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId || null;
    console.log('Пользователь подключился, userId:', userId);

    // Функция для показа начального меню (без приветственного сообщения)
    const showMainMenu = (withGreeting = true) => {
        if (!userId) {
            if (withGreeting) {
                socket.emit('response', 'Привет! Я бот магазина семян. Ты можешь искать товары. Для других действий нужно войти в систему.');
            } else {
                socket.emit('response', 'Ты можешь искать товары или войти в систему для других действий:');
            }
            socket.emit('show_buttons', [
                { text: 'Поиск товаров', value: 'search' },
                { text: 'Оформить заказ', value: 'order' },
                { text: 'Показать историю заказов', value: 'history' }
            ]);
        } else {
            socket.emit('response', withGreeting ? 'Привет! Я бот магазина семян. Выбери действие:' : 'Выбери действие:');
            socket.emit('show_buttons', [
                { text: 'Поиск товаров', value: 'search' },
                { text: 'Оформить заказ', value: 'order' },
                { text: 'Показать историю заказов', value: 'history' }
            ]);
        }
    };

    // Показываем начальное меню при подключении (с приветствием)
    showMainMenu(true);

    // Храним состояние заказа
    let orderState = {};

    // Обработка нажатий на кнопки
    socket.on('button_click', async (buttonValue) => {
        console.log('Получено событие button_click:', buttonValue); // Отладка

        if (buttonValue === 'search') {
            socket.emit('response', 'Введи название товара или артикул для поиска (например, "Огурец Сюрприз" или "13326"):');
            socket.emit('show_input', { placeholder: 'Название товара или артикул' });
        } else if (buttonValue === 'order') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            // Шаг 1: Запрос артикула
            orderState = { step: 'article' };
            socket.emit('response', 'Введи артикул товара для заказа (например, "12345"):');
            socket.emit('show_input', { placeholder: 'Артикул товара' });
        } else if (buttonValue === 'history') {
            if (!userId) {
                socket.emit('response', 'Для просмотра истории заказов нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            const ordersRes = await pool.query(
                `SELECT o.id, o.total_price, o.created_at, oi.quantity, oi.price_at_time, p.name, p.article 
                 FROM orders o 
                 JOIN order_items oi ON o.id = oi.order_id 
                 JOIN products p ON oi.product_article = p.article 
                 WHERE o.user_id = $1`,
                [userId]
            );

            if (ordersRes.rows.length > 0) {
                let responseText = '<b>Ваши заказы:</b><br>';
                ordersRes.rows.forEach(row => {
                    responseText += `
                        <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                            <b>Заказ #${row.id}</b><br>
                            Дата: ${new Date(row.created_at).toLocaleString('ru-RU')}<br>
                            Товар: ${row.name} (арт. ${row.article})<br>
                            Количество: ${row.quantity} шт.<br>
                            Цена за единицу: ${row.price_at_time} руб.<br>
                            Итого: ${row.total_price} руб.
                        </div>
                    `;
                });
                socket.emit('response', responseText);
            } else {
                socket.emit('response', 'У вас пока нет заказов.');
            }

            showMainMenu(false);
        } else if (buttonValue === 'use_previous_address' && orderState.step === 'address') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            const userRes = await pool.query('SELECT address FROM users WHERE id = $1', [userId]);
            orderState.address = userRes.rows[0].address;

            const totalPrice = orderState.product.price * orderState.quantity;

            const orderRes = await pool.query(
                `INSERT INTO orders (user_id, total_price, status, shipping_address, payment_method, created_at) 
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
                [userId, totalPrice, 'pending', orderState.address, 'pending_payment']
            );
            const orderId = orderRes.rows[0].id;

            await pool.query(
                `INSERT INTO order_items (order_id, quantity, price_at_time, product_article) 
                 VALUES ($1, $2, $3, $4)`,
                [orderId, orderState.quantity, orderState.product.price, orderState.product.article]
            );

            await pool.query('UPDATE products SET stock = stock - $1 WHERE article = $2', [orderState.quantity, orderState.product.article]);

            const responseText = `
                <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                    <b>Заказ успешно оформлен!</b><br>
                    Заказ #${orderId}<br>
                    Товар: ${orderState.product.name} (арт. ${orderState.product.article})<br>
                    Количество: ${orderState.quantity} шт.<br>
                    Цена за единицу: ${orderState.product.price} руб.<br>
                    Итого: ${totalPrice} руб.<br>
                    Адрес доставки: ${orderState.address}<br>
                    <a href="/payment/${orderId}" style="color: #3c6f3c; text-decoration: underline;">Перейти к оплате</a>
                </div>
            `;
            socket.emit('response', responseText);

            orderState = {};
            showMainMenu(false);
        } else if (buttonValue === 'new_address' && orderState.step === 'address') {
            socket.emit('response', 'Укажи новый адрес доставки:');
            socket.emit('show_input', { placeholder: 'Адрес доставки' });
        }
    });

    // Обработка ввода данных
    socket.on('input_submit', async (msg) => {
        console.log('Получено событие input_submit:', msg); // Отладка

        if (orderState.step === 'article') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            const article = msg.trim().toUpperCase();
            if (!article.match(/^\d{5}$/)) {
                socket.emit('response', 'Укажи корректный артикул, например, "12345".');
                socket.emit('show_input', { placeholder: 'Артикул товара' });
                return;
            }

            const productRes = await pool.query('SELECT * FROM products WHERE article = $1', [article]);
            if (productRes.rows.length === 0 || productRes.rows[0].stock <= 0) {
                socket.emit('response', 'Товар не найден или отсутствует на складе.');
            } else {
                orderState.product = productRes.rows[0];
                orderState.step = 'quantity';
                socket.emit('response', `Вы выбрали: <b>${orderState.product.name}</b> (арт. ${article}). В наличии: ${orderState.product.stock} шт.<br>Укажи количество:`);
                socket.emit('show_input', { placeholder: 'Количество' });
                return;
            }
        } else if (orderState.step === 'quantity') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            const quantity = parseInt(msg.trim());
            if (isNaN(quantity) || quantity <= 0 || quantity > orderState.product.stock) {
                socket.emit('response', `Укажи корректное количество (от 1 до ${orderState.product.stock}):`);
                socket.emit('show_input', { placeholder: 'Количество' });
                return;
            }

            orderState.quantity = quantity;
            const userRes = await pool.query('SELECT address FROM users WHERE id = $1', [userId]);
            const previousAddress = userRes.rows[0]?.address || null;

            orderState.step = 'address';
            if (previousAddress) {
                socket.emit('response', `Предыдущий адрес доставки: <b>${previousAddress}</b><br>Использовать этот адрес?`);
                socket.emit('show_buttons', [
                    { text: 'Да, использовать', value: 'use_previous_address' },
                    { text: 'Нет, ввести новый', value: 'new_address' }
                ]);
            } else {
                socket.emit('response', 'Укажи адрес доставки:');
                socket.emit('show_input', { placeholder: 'Адрес доставки' });
            }
            return;
        } else if (orderState.step === 'address') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
            orderState.address = msg.trim();
            if (!orderState.address) {
                socket.emit('response', 'Адрес не может быть пустым. Укажи адрес доставки:');
                socket.emit('show_input', { placeholder: 'Адрес доставки' });
                return;
            }

            const totalPrice = orderState.product.price * orderState.quantity;

            const orderRes = await pool.query(
                `INSERT INTO orders (user_id, total_price, status, shipping_address, payment_method, created_at) 
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
                [userId, totalPrice, 'pending', orderState.address, 'pending_payment']
            );
            const orderId = orderRes.rows[0].id;

            await pool.query(
                `INSERT INTO order_items (order_id, quantity, price_at_time, product_article) 
                 VALUES ($1, $2, $3, $4)`,
                [orderId, orderState.quantity, orderState.product.price, orderState.product.article]
            );

            await pool.query('UPDATE products SET stock = stock - $1 WHERE article = $2', [orderState.quantity, orderState.product.article]);

            await pool.query('UPDATE users SET address = $1 WHERE id = $2', [orderState.address, userId]);

            const responseText = `
                <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                    <b>Заказ успешно оформлен!</b><br>
                    Заказ #${orderId}<br>
                    Товар: ${orderState.product.name} (арт. ${orderState.product.article})<br>
                    Количество: ${orderState.quantity} шт.<br>
                    Цена за единицу: ${orderState.product.price} руб.<br>
                    Итого: ${totalPrice} руб.<br>
                    Адрес доставки: ${orderState.address}<br>
                    <a href="/payment/${orderId}" style="color: #3c6f3c; text-decoration: underline;">Перейти к оплате</a>
                </div>
            `;
            socket.emit('response', responseText);

            orderState = {};
            showMainMenu(false);
        } else {
            // Поиск товара
            const searchQuery = msg.trim();
            if (!searchQuery) {
                socket.emit('response', 'Укажи, что именно ты хочешь найти. Например: "Огурец Сюрприз" или "13326".');
                socket.emit('show_input', { placeholder: 'Название товара или артикул' });
                return;
            }

            // Сначала ищем точное совпадение по артикулу
            const exactMatch = await pool.query(`
                SELECT p.*, c.name as category_name 
                FROM products p 
                LEFT JOIN categories c ON p.category_id = c.id 
                WHERE p.article = $1
            `, [searchQuery]);

            if (exactMatch.rows.length > 0) {
                // Если найдено точное совпадение по артикулу, показываем только его
                let responseText = '<b>Найденные товары:</b><br>';
                exactMatch.rows.forEach(row => {
                    responseText += `
                        <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                            <b>${row.name}</b><br>
                            Артикул: ${row.article}<br>
                            Категория: ${row.category_name || 'нет'}<br>
                            Цена: ${row.price} руб.<br>
                            В наличии: ${row.stock} шт.
                        </div>
                    `;
                });
                socket.emit('response', responseText);
            } else {
                // Если по артикулу ничего не найдено, ищем по названию
                // Сначала ищем по полной строке названия с SIMILARITY
                const fullMatchRes = await pool.query(`
                    SELECT p.*, c.name as category_name, SIMILARITY(p.name, $1) as similarity_score
                    FROM products p 
                    LEFT JOIN categories c ON p.category_id = c.id 
                    WHERE SIMILARITY(p.name, $1) > 0.3
                    ORDER BY similarity_score DESC
                    LIMIT 5
                `, [searchQuery]);

                // Затем ищем по отдельным словам в названии
                const wordMatchRes = await pool.query(`
                    WITH words AS (
                        SELECT p.*, c.name as category_name, unnest(string_to_array(p.name, ' ')) as word
                        FROM products p
                        LEFT JOIN categories c ON p.category_id = c.id
                    )
                    SELECT DISTINCT p.*, p.category_name, SIMILARITY(p.word, $1) as similarity_score
                    FROM words p
                    WHERE SIMILARITY(p.word, $1) > 0.5
                    ORDER BY similarity_score DESC
                    LIMIT 5
                `, [searchQuery]);

                // Объединяем результаты
                const combinedResults = [...fullMatchRes.rows, ...wordMatchRes.rows];
                // Удаляем дубликаты по article
                const uniqueResults = Array.from(new Map(combinedResults.map(item => [item.article, item])).values());

                if (uniqueResults.length > 0) {
                    let responseText = '<b>Возможно, вы имели в виду:</b><br>';
                    uniqueResults.forEach(row => {
                        responseText += `
                            <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                                <b>${row.name}</b><br>
                                Артикул: ${row.article}<br>
                                Категория: ${row.category_name || 'нет'}<br>
                                Цена: ${row.price} руб.<br>
                                В наличии: ${row.stock} шт.<br>
                                <i>Схожесть: ${(row.similarity_score * 100).toFixed(1)}%</i>
                            </div>
                        `;
                    });
                    socket.emit('response', responseText);
                } else {
                    socket.emit('response', 'Ничего не найдено. Попробуй уточнить запрос.');
                }
            }

            showMainMenu(false);
        }
    });

    // Обработка отмены действия
    socket.on('cancel_action', () => {
        console.log('Получено событие cancel_action'); // Отладка
        orderState = {}; // Сбрасываем состояние
        socket.emit('response', 'Действие отменено.');
        showMainMenu(false);
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});