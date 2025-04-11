const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const schedule = require('node-schedule');
require('dotenv').config()

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка логирования с помощью winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'logs/app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d'
        })
    ]
});

// Логгер для статистики посещений и заказов
const statsLogger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new DailyRotateFile({
            filename: 'logs/stats-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d'
        })
    ]
});

// Настройка подключения к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { 
      rejectUnauthorized: false 
    } : false
  });

pool.connect((err, client, release) => {
    if (err) {
        logger.error('Ошибка подключения к базе данных: ' + err.stack);
        return;
    }
    logger.info('Успешно подключено к базе данных PostgreSQL');
    release();
});

// Настройка сессий
const sessionMiddleware = session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
});

// Переменные для хранения статистики в памяти
let dailyStats = {
    visits: 0,
    productOrders: {}
};

// Middleware
app.use(sessionMiddleware);
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

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

// Middleware для проверки роли администратора
const requireAdmin = async (req, res, next) => {
    if (!req.session.userId) {
        return res.status(403).send('Необходимо войти в систему. <a href="/login">Войти</a>');
    }
    try {
        const result = await pool.query('SELECT role FROM Users WHERE id = $1', [req.session.userId]);
        if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
            return res.status(403).send('Доступ запрещён. Требуются права администратора. <a href="/">На главную</a>');
        }
        next();
    } catch (err) {
        logger.error('Ошибка при проверке роли администратора: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
};

// Middleware для подсчета уникальных посещений
app.use((req, res, next) => {
    const visitTracked = req.cookies['visitTracked'];
    if (!visitTracked) {
        dailyStats.visits++;
        res.cookie('visitTracked', 'true', {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: true
        });
    }
    next();
});

// Настройка шаблонизатора EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Функция для записи статистики в лог-файл
function logDailyStats() {
    statsLogger.info(dailyStats);
    dailyStats = {
        visits: 0,
        productOrders: {}
    };
}

// Планировщик для записи статистики каждый день в полночь
schedule.scheduleJob('0 0 * * *', () => {
    logDailyStats();
    logger.info('Ежедневная статистика записана в лог-файл');
});

// Основные маршруты
app.get('/', async (req, res) => {
    try {
        const categoriesResult = await pool.query(`
            SELECT id, name, image_url
            FROM Categories
            WHERE parent_id IS NULL
            ORDER BY name
        `);
        res.render('index', {
            user: req.session.user,
            categories: categoriesResult.rows
        });
    } catch (err) {
        logger.error('Ошибка при загрузке главной страницы: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
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
        logger.info(`Попытка входа: email=${email}, password=${password}`);
        const result = await pool.query(`
            SELECT id, email, password, first_name, last_name, avatar_url, role
            FROM Users
            WHERE email = $1
        `, [email]);
        if (result.rows.length === 0) {
            logger.warn(`Пользователь с email ${email} не найден`);
            return res.render('login', { error: 'Пользователь не найден', user: null });
        }
        const user = result.rows[0];
        logger.info(`Найден пользователь: email=${user.email}, хранимый пароль=${user.password}`);
        const match = await bcrypt.compare(password, user.password);
        logger.info(`Результат сравнения паролей: match=${match}`);
        if (!match) {
            logger.warn(`Неверный пароль для пользователя ${email}`);
            return res.render('login', { error: 'Неверный пароль', user: null });
        }
        req.session.userId = user.id;
        req.session.user = {
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            avatar_url: user.avatar_url,
            role: user.role
        };
        logger.info(`Пользователь ${user.email} (роль: ${user.role}) вошёл в систему`);
        if (user.role === 'admin') {
            res.redirect('/admin');
        } else {
            res.redirect('/');
        }
    } catch (err) {
        logger.error('Ошибка при входе: ' + err.stack);
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
    const saltRounds = 10;
    try {
        const existingUser = await pool.query(`
            SELECT id
            FROM Users
            WHERE email = $1
        `, [email]);
        if (existingUser.rows.length > 0) {
            return res.render('register', { error: 'Пользователь с таким email уже существует', user: null });
        }
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const result = await pool.query(`
            INSERT INTO Users (email, password, first_name, last_name, role, registration_date)
            VALUES ($1, $2, $3, $4, 'user', CURRENT_TIMESTAMP)
            RETURNING id, email, first_name, last_name
        `, [email, hashedPassword, firstName, lastName]);
        const user = result.rows[0];
        req.session.userId = user.id;
        req.session.user = {
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            avatar_url: null,
            role: 'user'
        };
        logger.info(`Новый пользователь зарегистрирован: ${user.email}`);
        if (user.role === 'admin') {
            res.redirect('/admin');
        } else {
            res.redirect('/');
        }
    } catch (err) {
        logger.error('Ошибка при регистрации: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/logout', (req, res) => {
    const userEmail = req.session.user?.email || 'неизвестный пользователь';
    req.session.destroy((err) => {
        if (err) {
            logger.error('Ошибка при выходе: ' + err.stack);
            return res.status(500).send('Ошибка сервера');
        }
        logger.info(`Пользователь ${userEmail} вышел из системы`);
        res.redirect('/');
    });
});

// Маршруты каталога и товаров
app.get('/catalog', async (req, res) => {
    const { search, sort, category, inStock } = req.query;
    const searchQuery = search || '';
    const sortOption = sort || 'name_asc';
    const categoryId = category || '';
    const inStockFilter = inStock || '';
    try {
        const categoriesResult = await pool.query(`
            SELECT id, name
            FROM Categories
            ORDER BY name
        `);
        let query = '';
        const values = [];
        let conditions = [];
        if (categoryId) {
            query = `
                WITH RECURSIVE category_tree AS (
                    SELECT id
                    FROM Categories
                    WHERE id = $1
                    UNION ALL
                    SELECT c.id
                    FROM Categories c
                    JOIN category_tree ct ON c.parent_id = ct.id
                )
            `;
            values.push(categoryId);
        }
        query += `
            SELECT p.article, p.name, p.description, p.image_url, p.price, p.stock, c.name AS category_name,
                   COALESCE(ps.add_to_cart_count, 0) AS popularity
        `;
        if (searchQuery) {
            query += `,
                   GREATEST(
                       SIMILARITY(LOWER(p.name), LOWER($${values.length + 1})),
                       SIMILARITY(LOWER(p.description), LOWER($${values.length + 1})),
                       SIMILARITY(LOWER(p.name), LOWER($${values.length + 2})),
                       SIMILARITY(LOWER(p.description), LOWER($${values.length + 2}))
                   ) AS similarity_score
            `;
        } else {
            query += `,
                   0 AS similarity_score
            `;
        }
        query += `
            FROM Products p
            LEFT JOIN Categories c ON p.category_id = c.id
            LEFT JOIN product_stats ps ON p.article = ps.product_article
        `;
        if (categoryId) {
            conditions.push(`p.category_id IN (SELECT id FROM category_tree)`);
        }
        if (inStockFilter === 'true') {
            conditions.push(`p.stock > 0`);
        } else if (inStockFilter === 'false') {
            conditions.push(`p.stock = 0`);
        }
        if (searchQuery) {
            let normalizedQuery = searchQuery.toLowerCase();
            const endings = ['ы', 'и', 'ов', 'ами', 'ам', 'ах', 'ей', 'ой', 'а', 'я'];
            for (const ending of endings) {
                if (normalizedQuery.endsWith(ending)) {
                    normalizedQuery = normalizedQuery.slice(0, -ending.length);
                    break;
                }
            }
            conditions.push(`
                (
                    p.article = $${values.length + 1}
                    OR SIMILARITY(LOWER(p.name), LOWER($${values.length + 1})) > 0.2
                    OR SIMILARITY(LOWER(p.description), LOWER($${values.length + 1})) > 0.2
                    OR SIMILARITY(LOWER(p.name), LOWER($${values.length + 2})) > 0.2
                    OR SIMILARITY(LOWER(p.description), LOWER($${values.length + 2})) > 0.2
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(string_to_array(LOWER(p.name), ' ')) AS word
                        WHERE SIMILARITY(word, $${values.length + 1}) > 0.2
                           OR SIMILARITY(word, $${values.length + 2}) > 0.2
                           OR word ILIKE '%' || $${values.length + 1} || '%'
                           OR word ILIKE '%' || $${values.length + 2} || '%'
                    )
                )
            `);
            values.push(searchQuery.toUpperCase());
            values.push(normalizedQuery);
        }
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        if (searchQuery) {
            query += ' ORDER BY similarity_score DESC';
        } else {
            if (sortOption === 'name_asc') {
                query += ' ORDER BY p.name ASC';
            } else if (sortOption === 'name_desc') {
                query += ' ORDER BY p.name DESC';
            } else if (sortOption === 'price_asc') {
                query += ' ORDER BY p.price ASC';
            } else if (sortOption === 'price_desc') {
                query += ' ORDER BY p.price DESC';
            } else if (sortOption === 'popularity_asc') {
                query += ' ORDER BY COALESCE(ps.add_to_cart_count, 0) ASC';
            } else if (sortOption === 'popularity_desc') {
                query += ' ORDER BY COALESCE(ps.add_to_cart_count, 0) DESC';
            }
        }
        console.log('SQL Query:', query);
        console.log('Values:', values);
        const result = await pool.query(query, values);
        result.rows.forEach(row => {
            logger.info(`Найден товар: ${row.name} (арт. ${row.article}), схожесть: ${(row.similarity_score * 100).toFixed(1)}%`);
        });
        res.render('catalog', {
            products: result.rows,
            categories: categoriesResult.rows,
            searchQuery,
            sort: sortOption,
            categoryId,
            inStock: inStockFilter,
            user: req.session.user || null
        });
    } catch (err) {
        logger.error('Ошибка при загрузке каталога: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/product/:article', async (req, res) => {
    const article = req.params.article;
    try {
        const productResult = await pool.query(`
            SELECT p.article, p.name, p.description, p.image_url, p.price, p.stock, c.name AS category_name
            FROM Products p
            LEFT JOIN Categories c ON p.category_id = c.id
            WHERE p.article = $1
        `, [article]);
        if (productResult.rows.length === 0) {
            return res.status(404).send('Товар не найден');
        }
        res.render('product', {
            product: productResult.rows[0],
            user: req.session.user || null
        });
    } catch (err) {
        logger.error('Ошибка при загрузке страницы товара: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршруты корзины
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
        logger.error('Ошибка при получении корзины: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/cart/add', requireAuth, async (req, res) => {
    const { article, quantity } = req.body;
    const userId = req.session.userId;
    const quantityNum = parseInt(quantity);
    if (!article || isNaN(quantityNum) || quantityNum <= 0) {
        return res.status(400).send('Неверные данные');
    }
    try {
        const productResult = await pool.query(`
            SELECT stock
            FROM Products
            WHERE article = $1
        `, [article]);
        if (productResult.rows.length === 0) {
            return res.status(404).send('Товар не найден');
        }
        const stock = productResult.rows[0].stock;
        if (quantityNum > stock) {
            return res.status(400).send(`Недостаточно товара на складе. В наличии: ${stock} шт.`);
        }
        const cartResult = await pool.query(`
            SELECT id, quantity
            FROM Cart
            WHERE user_id = $1 AND product_article = $2
        `, [userId, article]);
        if (cartResult.rows.length > 0) {
            const newQuantity = cartResult.rows[0].quantity + quantityNum;
            if (newQuantity > stock) {
                return res.status(400).send(`Недостаточно товара на складе. В наличии: ${stock} шт.`);
            }
            await pool.query(`
                UPDATE Cart
                SET quantity = $1
                WHERE id = $2
            `, [newQuantity, cartResult.rows[0].id]);
        } else {
            await pool.query(`
                INSERT INTO Cart (user_id, product_article, quantity)
                VALUES ($1, $2, $3)
            `, [userId, article, quantityNum]);
        }
        await pool.query(`
            INSERT INTO product_stats (product_article, add_to_cart_count)
            VALUES ($1, 1)
            ON CONFLICT (product_article)
            DO UPDATE SET add_to_cart_count = product_stats.add_to_cart_count + 1
        `, [article]);
        logger.info(`Товар ${article} добавлен в корзину пользователя ${userId}, количество: ${quantityNum}`);
        res.redirect('/cart');
    } catch (err) {
        logger.error('Ошибка при добавлении товара в корзину: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршруты профиля
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
        logger.error('Ошибка при получении профиля: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/profile', requireAuth, async (req, res) => {
    const { email, firstName, lastName, phone, address, birthDate, gender, newsletter, newPassword, currentPassword } = req.body;
    const userId = req.session.userId;
    const saltRounds = 10;
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
        const match = await bcrypt.compare(currentPassword, currentPasswordInDb);
        if (!match) {
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
            const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
            updateFields.push(`password = $${paramIndex++}`);
            values.push(hashedNewPassword);
        }
        values.push(userId);
        if (updateFields.length > 0) {
            await pool.query(`
                UPDATE Users
                SET ${updateFields.join(', ')}
                WHERE id = $${paramIndex}
            `, values);
            const updatedUser = await pool.query(`
                SELECT email, first_name, last_name, avatar_url, role
                FROM Users
                WHERE id = $1
            `, [userId]);
            req.session.user = {
                email: updatedUser.rows[0].email,
                first_name: updatedUser.rows[0].first_name,
                last_name: updatedUser.rows[0].last_name,
                avatar_url: updatedUser.rows[0].avatar_url,
                role: updatedUser.rows[0].role
            };
            logger.info(`Профиль пользователя ${userId} обновлён`);
        }
        res.redirect('/profile');
        if (newPassword) {
            logger.info(`Пользователь ${userId} обновил пароль`);
        }
    } catch (err) {
        logger.error('Ошибка при обновлении профиля: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршруты оформления заказа
app.get('/checkout', requireAuth, async (req, res) => {
    try {
        const cartResult = await pool.query(`
            SELECT c.id, c.quantity, p.article, p.name, p.price, p.image_url, p.stock
            FROM Cart c
            JOIN Products p ON c.product_article = p.article
            WHERE c.user_id = $1
        `, [req.session.userId]);
        const userResult = await pool.query(`
            SELECT address
            FROM Users
            WHERE id = $1
        `, [req.session.userId]);
        if (cartResult.rows.length === 0) {
            return res.redirect('/cart');
        }
        res.render('checkout', {
            cartItems: cartResult.rows,
            user: { ...req.session.user, address: userResult.rows[0].address }
        });
    } catch (err) {
        logger.error('Ошибка при загрузке страницы оформления заказа: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/checkout', requireAuth, async (req, res) => {
    const { shippingAddress } = req.body;
    const userId = req.session.userId;
    try {
        const cartResult = await pool.query(`
            SELECT c.id, c.quantity, p.article, p.name, p.price, p.image_url, p.stock
            FROM Cart c
            JOIN Products p ON c.product_article = p.article
            WHERE c.user_id = $1
        `, [userId]);
        if (cartResult.rows.length === 0) {
            return res.redirect('/cart');
        }
        for (const item of cartResult.rows) {
            if (item.quantity > item.stock) {
                return res.status(400).send(`Товара "${item.name}" (арт. ${item.article}) недостаточно на складе. В наличии: ${item.stock} шт.`);
            }
        }
        const totalPrice = cartResult.rows.reduce((sum, item) => sum + item.price * item.quantity, 0);
        req.session.pendingOrder = {
            userId: userId,
            cartItems: cartResult.rows,
            totalPrice: totalPrice,
            shippingAddress: shippingAddress
        };
        const tempOrderId = Date.now().toString();
        req.session.pendingOrder.tempOrderId = tempOrderId;
        logger.info(`Данные о заказе для пользователя ${userId} сохранены в сессии, tempOrderId: ${tempOrderId}`);
        res.redirect(`/payment/${tempOrderId}`);
    } catch (err) {
        logger.error('Ошибка при подготовке заказа: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршруты оплаты
app.get('/payment/:orderId', requireAuth, async (req, res) => {
    const tempOrderId = req.params.orderId;
    const userId = req.session.userId;
    try {
        if (!req.session.pendingOrder || req.session.pendingOrder.tempOrderId !== tempOrderId || req.session.pendingOrder.userId !== userId) {
            return res.status(404).send('Заказ не найден');
        }
        const { cartItems, totalPrice, shippingAddress } = req.session.pendingOrder;
        const order = {
            id: tempOrderId,
            total_price: totalPrice,
            shipping_address: shippingAddress,
            created_at: new Date(),
            items: cartItems.map(item => ({
                name: item.name,
                article: item.article,
                quantity: item.quantity,
                price_at_time: item.price
            }))
        };
        res.render('payment', { order, user: req.session.user });
    } catch (err) {
        logger.error('Ошибка при получении заказа для оплаты: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/payment/:orderId/process', requireAuth, async (req, res) => {
    const tempOrderId = req.params.orderId;
    const userId = req.session.userId;
    try {
        if (!req.session.pendingOrder || req.session.pendingOrder.tempOrderId !== tempOrderId || req.session.pendingOrder.userId !== userId) {
            return res.status(404).send('Заказ не найден');
        }
        const { shippingAddress } = req.session.pendingOrder;
        await pool.query(`
            CALL create_order($1, $2, NULL, NULL)
        `, [userId, shippingAddress]);
        const orderResult = await pool.query(`
            SELECT id
            FROM orders
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [userId]);
        if (!orderResult.rows[0]) {
            throw new Error('Не удалось создать заказ');
        }
        const orderId = orderResult.rows[0].id;
        await pool.query(`
            UPDATE orders
            SET status = $1, payment_method = $2
            WHERE id = $3
        `, ['completed', 'card', orderId]);
        const cartItems = req.session.pendingOrder.cartItems;
        cartItems.forEach(item => {
            dailyStats.productOrders[item.article] = (dailyStats.productOrders[item.article] || 0) + item.quantity;
        });
        console.log(`Заказ обработан. Текущая статистика: ${JSON.stringify(dailyStats)}`);
        statsLogger.info(dailyStats);
        delete req.session.pendingOrder;
        logger.info(`Заказ #${orderId} оплачен и оформлен пользователем ${userId}`);
        res.redirect('/order-history');
    } catch (err) {
        logger.error('Ошибка при обработке оплаты: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршруты истории заказов
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
        logger.error('Ошибка при получении истории заказов: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Логика бота через Socket.IO
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId || null;
    logger.info(`Пользователь подключился, userId: ${userId}`);
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
    showMainMenu(true);
    let orderState = {};
    socket.on('button_click', async (buttonValue) => {
        logger.info(`Получено событие button_click: ${buttonValue}`);
        if (buttonValue === 'search') {
            socket.emit('response', 'Введи название товара или артикул для поиска (например, "Огурец Сюрприз" или "13326"):');
            socket.emit('show_input', { placeholder: 'Название товара или артикул' });
        } else if (buttonValue === 'order') {
            if (!userId) {
                socket.emit('response', 'Для оформления заказа нужно войти в систему. <a href="/login">Войти</a>');
                showMainMenu(false);
                return;
            }
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
            logger.info(`Заказ #${orderId} оформлен пользователем ${userId}`);
            orderState = {};
            showMainMenu(false);
        } else if (buttonValue === 'new_address' && orderState.step === 'address') {
            socket.emit('response', 'Укажи новый адрес доставки:');
            socket.emit('show_input', { placeholder: 'Адрес доставки' });
        }
    });
    socket.on('input_submit', async (msg) => {
        logger.info(`Получено событие input_submit: ${msg}`);
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
            logger.info(`Заказ #${orderId} оформлен пользователем ${userId}`);
            orderState = {};
            showMainMenu(false);
        } else {
            const searchQuery = msg.trim().toLowerCase();
            if (!searchQuery) {
                socket.emit('response', 'Укажи, что именно ты хочешь найти. Например: "Огурец Сюрприз" или "13326".');
                socket.emit('show_input', { placeholder: 'Название товара или артикул' });
                return;
            }
            const exactMatch = await pool.query(`
                SELECT p.*, c.name as category_name 
                FROM products p 
                LEFT JOIN categories c ON p.category_id = c.id 
                WHERE p.article = $1
            `, [searchQuery]);
            if (exactMatch.rows.length > 0) {
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
                let normalizedQuery = searchQuery;
                const endings = ['ы', 'и', 'ов', 'ами', 'ам', 'ах', 'ей', 'ой', 'а', 'я'];
                for (const ending of endings) {
                    if (normalizedQuery.endsWith(ending)) {
                        normalizedQuery = normalizedQuery.slice(0, -ending.length);
                        break;
                    }
                }
                const fullMatchRes = await pool.query(`
                    SELECT p.*, c.name as category_name, SIMILARITY(p.name, $1) as similarity_score
                    FROM products p 
                    LEFT JOIN categories c ON p.category_id = c.id 
                    WHERE SIMILARITY(LOWER(p.name), LOWER($1)) > 0.2 OR SIMILARITY(LOWER(p.name), LOWER($2)) > 0.2
                    ORDER BY SIMILARITY(LOWER(p.name), LOWER($1)) DESC
                    LIMIT 5
                `, [searchQuery, normalizedQuery]);
                const wordMatchRes = await pool.query(`
                    WITH words AS (
                        SELECT p.*, c.name as category_name, unnest(string_to_array(LOWER(p.name), ' ')) as word
                        FROM products p
                        LEFT JOIN categories c ON p.category_id = c.id
                    )
                    SELECT DISTINCT p.*, p.category_name, 
                        SIMILARITY(p.word, $1) as similarity_score
                    FROM words p
                    WHERE SIMILARITY(p.word, $1) > 0.2 
                        OR SIMILARITY(p.word, $2) > 0.2
                        OR p.word ILIKE '%' || $1 || '%'
                        OR p.word ILIKE '%' || $2 || '%'
                    ORDER BY similarity_score DESC
                    LIMIT 5
                `, [searchQuery, normalizedQuery]);
                const combinedResults = [...fullMatchRes.rows, ...wordMatchRes.rows];
                const uniqueResults = Array.from(new Map(combinedResults.map(item => [item.article, item])).values())
                    .sort((a, b) => {
                        const scoreA = a.similarity_score || 0;
                        const scoreB = b.similarity_score || 0;
                        return scoreB - scoreA;
                    });
                if (uniqueResults.length > 0) {
                    let responseText = '<b>Возможно, вы имели в виду:</b><br>';
                    uniqueResults.forEach(row => {
                        logger.info(`Найден товар: ${row.name} (арт. ${row.article}), схожесть: ${(row.similarity_score * 100).toFixed(1)}%`);
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
                    socket.emit('response', 'Ничего не найдено. Попробуй уточнить запрос.');
                }
            }
            showMainMenu(false);
        }
    });
    socket.on('cancel_action', () => {
        logger.info('Получено событие cancel_action');
        orderState = {};
        socket.emit('response', 'Действие отменено.');
        showMainMenu(false);
    });
});

// Маршруты админ-панели
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const users = (await pool.query('SELECT * FROM Users')).rows;
        const products = (await pool.query('SELECT * FROM Products')).rows;
        const categories = (await pool.query('SELECT * FROM Categories')).rows;
        const orders = (await pool.query('SELECT * FROM Orders')).rows;
        const order_items = (await pool.query('SELECT * FROM Order_Items')).rows;
        const cart = (await pool.query('SELECT * FROM Cart')).rows;
        const product_stats = (await pool.query('SELECT * FROM Product_Stats')).rows;
        const suppliers = (await pool.query('SELECT * FROM Suppliers')).rows;
        const supplies = (await pool.query('SELECT * FROM Supplies')).rows;
        res.render('admin', {
            user: req.session.user,
            users,
            products,
            categories,
            orders,
            order_items,
            cart,
            product_stats,
            suppliers,
            supplies
        });
    } catch (err) {
        logger.error('Ошибка при загрузке админской страницы: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/admin/:table/add', requireAdmin, async (req, res) => {
    const table = req.params.table;
    const data = req.body;
    const saltRounds = 10;
    try {
        if (table === 'users') {
            const { email, password, role, first_name, last_name, phone, address, birth_date, gender, newsletter } = data;
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            await pool.query(`
                INSERT INTO Users (email, password, role, first_name, last_name, phone, address, birth_date, gender, newsletter, registration_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
            `, [email, hashedPassword, role, first_name, last_name, phone, address, birth_date, gender, newsletter === 'on']);
        } else if (table === 'products') {
            const { article, name, description, category_id, image_url, price, stock } = data;
            await pool.query(`
                INSERT INTO Products (article, name, description, category_id, image_url, price, stock)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [article, name, description, category_id, image_url, price, stock]);
        } else if (table === 'categories') {
            const { name, image_url, description, parent_id } = data;
            await pool.query(`
                INSERT INTO Categories (name, image_url, description, parent_id)
                VALUES ($1, $2, $3, $4)
            `, [name, image_url, description, parent_id]);
        } else if (table === 'orders') {
            const { user_id, total_price, status, shipping_address, payment_method } = data;
            await pool.query(`
                INSERT INTO Orders (user_id, total_price, status, shipping_address, payment_method, created_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [user_id, total_price, status, shipping_address, payment_method]);
        } else if (table === 'order_items') {
            const { order_id, quantity, price_at_time, product_article } = data;
            await pool.query(`
                INSERT INTO Order_Items (order_id, quantity, price_at_time, product_article)
                VALUES ($1, $2, $3, $4)
            `, [order_id, quantity, price_at_time, product_article]);
        } else if (table === 'cart') {
            const { user_id, quantity, product_article } = data;
            await pool.query(`
                INSERT INTO Cart (user_id, quantity, product_article)
                VALUES ($1, $2, $3)
            `, [user_id, quantity, product_article]);
        } else if (table === 'product_stats') {
            const { product_article, add_to_cart_count } = data;
            await pool.query(`
                INSERT INTO Product_Stats (product_article, add_to_cart_count)
                VALUES ($1, $2)
            `, [product_article, add_to_cart_count]);
        } else if (table === 'suppliers') {
            const { name, contact_person, email, phone, address } = data;
            await pool.query(`
                INSERT INTO Suppliers (name, contact_person, email, phone, address)
                VALUES ($1, $2, $3, $4, $5)
            `, [name, contact_person, email, phone, address]);
        } else if (table === 'supplies') {
            const { supplier_id, quantity, supply_date, price_per_unit, total_cost, product_article } = data;
            await pool.query(`
                INSERT INTO Supplies (supplier_id, quantity, supply_date, price_per_unit, total_cost, product_article, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            `, [supplier_id, quantity, supply_date, price_per_unit, total_cost, product_article]);
        }
        res.redirect('/admin');
    } catch (err) {
        logger.error(`Ошибка при добавлении записи в ${table}: ` + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/admin/:table/edit', requireAdmin, async (req, res) => {
    const table = req.params.table;
    const data = req.body;
    const saltRounds = 10;
    try {
        if (table === 'users') {
            const { id, email, password, role, first_name, last_name, phone, address, birth_date, gender, newsletter } = data;
            const hashedPassword = password ? await bcrypt.hash(password, saltRounds) : (await pool.query('SELECT password FROM Users WHERE id = $1', [id])).rows[0].password;
            await pool.query(`
                UPDATE Users
                SET email = $1, password = $2, role = $3, first_name = $4, last_name = $5, phone = $6, address = $7, birth_date = $8, gender = $9, newsletter = $10
                WHERE id = $11
            `, [email, hashedPassword, role, first_name, last_name, phone, address, birth_date, gender, newsletter === 'on', id]);
        } else if (table === 'products') {
            const { article, name, description, category_id, image_url, price, stock } = data;
            await pool.query(`
                UPDATE Products
                SET name = $1, description = $2, category_id = $3, image_url = $4, price = $5, stock = $6
                WHERE article = $7
            `, [name, description, category_id, image_url, price, stock, article]);
        } else if (table === 'categories') {
            const { id, name, image_url, description, parent_id } = data;
            await pool.query(`
                UPDATE Categories
                SET name = $1, image_url = $2, description = $3, parent_id = $4
                WHERE id = $5
            `, [name, image_url, description, parent_id, id]);
        } else if (table === 'orders') {
            const { id, user_id, total_price, status, shipping_address, payment_method } = data;
            await pool.query(`
                UPDATE Orders
                SET user_id = $1, total_price = $2, status = $3, shipping_address = $4, payment_method = $5
                WHERE id = $6
            `, [user_id, total_price, status, shipping_address, payment_method, id]);
        } else if (table === 'order_items') {
            const { id, order_id, quantity, price_at_time, product_article } = data;
            await pool.query(`
                UPDATE Order_Items
                SET order_id = $1, quantity = $2, price_at_time = $3, product_article = $4
                WHERE id = $5
            `, [order_id, quantity, price_at_time, product_article, id]);
        } else if (table === 'cart') {
            const { id, user_id, quantity, product_article } = data;
            await pool.query(`
                UPDATE Cart
                SET user_id = $1, quantity = $2, product_article = $3
                WHERE id = $4
            `, [user_id, quantity, product_article, id]);
        } else if (table === 'product_stats') {
            const { product_article, add_to_cart_count } = data;
            await pool.query(`
                UPDATE Product_Stats
                SET add_to_cart_count = $1
                WHERE product_article = $2
            `, [add_to_cart_count, product_article]);
        } else if (table === 'suppliers') {
            const { id, name, contact_person, email, phone, address } = data;
            await pool.query(`
                UPDATE Suppliers
                SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5
                WHERE id = $6
            `, [name, contact_person, email, phone, address, id]);
        } else if (table === 'supplies') {
            const { id, supplier_id, quantity, supply_date, price_per_unit, total_cost, product_article } = data;
            await pool.query(`
                UPDATE Supplies
                SET supplier_id = $1, quantity = $2, supply_date = $3, price_per_unit = $4, total_cost = $5, product_article = $6
                WHERE id = $7
            `, [supplier_id, quantity, supply_date, price_per_unit, total_cost, product_article, id]);
        }
        res.redirect('/admin');
    } catch (err) {
        logger.error(`Ошибка при редактировании записи в ${table}: ` + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/admin/:table/delete', requireAdmin, async (req, res) => {
    const table = req.params.table;
    const { id } = req.body;
    try {
        if (table === 'users') {
            await pool.query('DELETE FROM Users WHERE id = $1', [id]);
        } else if (table === 'products') {
            await pool.query('DELETE FROM Products WHERE article = $1', [id]);
        } else if (table === 'categories') {
            await pool.query('DELETE FROM Categories WHERE id = $1', [id]);
        } else if (table === 'orders') {
            await pool.query('DELETE FROM Orders WHERE id = $1', [id]);
        } else if (table === 'order_items') {
            await pool.query('DELETE FROM Order_Items WHERE id = $1', [id]);
        } else if (table === 'cart') {
            await pool.query('DELETE FROM Cart WHERE id = $1', [id]);
        } else if (table === 'product_stats') {
            await pool.query('DELETE FROM Product_Stats WHERE product_article = $1', [id]);
        } else if (table === 'suppliers') {
            await pool.query('DELETE FROM Suppliers WHERE id = $1', [id]);
        } else if (table === 'supplies') {
            await pool.query('DELETE FROM Supplies WHERE id = $1', [id]);
        }
        res.status(200).send('Запись удалена');
    } catch (err) {
        logger.error(`Ошибка при удалении записи из ${table}: ` + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Маршрут статистики продаж
app.get('/admin/sales-stats', requireAdmin, async (req, res) => {
    try {
        const totalRevenue = await pool.query(`
            SELECT COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
        `);
        const totalRevenueValue = parseFloat(totalRevenue.rows[0].total);
        const todayRevenue = await pool.query(`
            SELECT COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
            AND DATE(created_at) = CURRENT_DATE
        `);
        const todayRevenueValue = parseFloat(todayRevenue.rows[0].total);
        const weekRevenue = await pool.query(`
            SELECT COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
            AND created_at >= CURRENT_DATE - INTERVAL '7 days'
        `);
        const weekRevenueValue = parseFloat(weekRevenue.rows[0].total);
        const monthRevenue = await pool.query(`
            SELECT COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
            AND created_at >= CURRENT_DATE - INTERVAL '30 days'
        `);
        const monthRevenueValue = parseFloat(monthRevenue.rows[0].total);
        const topProducts = await pool.query(`
            SELECT p.article, p.name, SUM(oi.quantity) AS total_sold
            FROM Order_Items oi
            JOIN Products p ON oi.product_article = p.article
            JOIN Orders o ON oi.order_id = o.id
            WHERE o.status = 'completed'
            GROUP BY p.article, p.name
            ORDER BY total_sold DESC
            LIMIT 5
        `);
        const orderStats = await pool.query(`
            SELECT status, COUNT(*) AS count
            FROM Orders
            GROUP BY status
        `);
        const salesByDay = await pool.query(`
            SELECT DATE(created_at) AS sale_date, COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
            AND created_at >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY sale_date
        `);
        const salesByMonth = await pool.query(`
            SELECT DATE_TRUNC('month', created_at) AS sale_month, COALESCE(SUM(total_price), 0) AS total
            FROM Orders
            WHERE status = 'completed'
            AND created_at >= CURRENT_DATE - INTERVAL '1 year'
            GROUP BY DATE_TRUNC('month', created_at)
            ORDER BY sale_month
        `);
        res.render('sales-stats', {
            user: req.session.user,
            totalRevenue: totalRevenueValue,
            todayRevenue: todayRevenueValue,
            weekRevenue: weekRevenueValue,
            monthRevenue: monthRevenueValue,
            topProducts: topProducts.rows,
            orderStats: orderStats.rows,
            salesByDay: salesByDay.rows,
            salesByMonth: salesByMonth.rows
        });
    } catch (err) {
        logger.error('Ошибка при загрузке страницы статистики продаж: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Утилитный маршрут для сброса паролей
app.get('/reset-old-passwords', async (req, res) => {
    const saltRounds = 10;
    const newPassword = '1234';
    try {
        const users = await pool.query('SELECT id, email FROM Users');
        for (const user of users.rows) {
            if (user.email === 'user9@example.com') continue;
            const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
            await pool.query('UPDATE Users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
            logger.info(`Пароль для пользователя ${user.email} (id: ${user.id}) сброшен на 1234`);
        }
        res.send('Пароли для старых пользователей сброшены на 1234');
    } catch (err) {
        logger.error('Ошибка при сбросе паролей: ' + err.stack);
        res.status(500).send('Ошибка сервера');
    }
});

// Запуск сервера
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => {
//     logger.info(`Сервер запущен на порту ${PORT}`);
// });

app.listen(process.env.PORT, ()=> console.log("Server is running on port 3000"))