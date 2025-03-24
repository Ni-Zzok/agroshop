const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');


const app = express();

const server = http.createServer(app);
const io = new Server(server);

// Настройка подключения к PostgreSQL
const pool = new Pool({
    user: 'postgres', // Замените на имя пользователя PostgreSQL
    host: 'localhost',
    database: 'agroshop', // Замените на имя вашей базы данных
    password: '2264', // Замените на пароль
    port: 5433,
});

// Проверка подключения к базе данных
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Ошибка подключения к базе данных:', err.stack);
    }
    console.log('Успешно подключено к базе данных PostgreSQL');
    release();
});

// Настройка сессий
app.use(session({
    secret: 'your_secret_key', // Замените на свой секретный ключ
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // В продакшене установите secure: true при использовании HTTPS
}));

// Настройка шаблонизатора EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Настройка статических файлов (CSS, изображения и т.д.)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Middleware для проверки авторизации
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(403).send('Необходимо войти в систему. <a href="/login">Войти</a>');
    }
    next();
};

// Маршрут для главной страницы
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

// Маршрут для страницы входа
app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    res.render('login', { error: null });
});

// Маршрут для обработки входа
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
        if (password !== user.password) { // В реальном приложении используйте bcrypt.compare
            return res.render('login', { error: 'Неверный пароль' });
        }

        // Сохраняем данные пользователя в сессии
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

// Маршрут для страницы регистрации
app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    res.render('register', { error: null });
});

// Маршрут для обработки регистрации
app.post('/register', async (req, res) => {
    const { email, password, firstName, lastName } = req.body;

    try {
        // Проверяем, существует ли пользователь с таким email
        const existingUser = await pool.query(`
            SELECT id
            FROM Users
            WHERE email = $1
        `, [email]);

        if (existingUser.rows.length > 0) {
            return res.render('register', { error: 'Пользователь с таким email уже существует' });
        }

        // Добавляем нового пользователя
        const result = await pool.query(`
            INSERT INTO Users (email, password, first_name, last_name, role, registration_date)
            VALUES ($1, $2, $3, $4, 'user', CURRENT_TIMESTAMP)
            RETURNING id, email, first_name, last_name
        `, [email, password, firstName, lastName]); // В реальном приложении хэшируйте пароль

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

// Маршрут для выхода
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка при выходе:', err.stack);
            return res.status(500).send('Ошибка сервера');
        }
        res.redirect('/');
    });
});

// Маршрут для каталога товаров
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

// Маршрут для корзины
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

// Маршрут для добавления товара в корзину
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

// Маршрут для профиля
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

// Маршрут для обновления профиля
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
        if (currentPassword !== currentPasswordInDb) { // В реальном приложении используйте bcrypt.compare
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
            values.push(newPassword); // В реальном приложении нужно хэшировать пароль
        }

        values.push(userId);

        if (updateFields.length > 0) {
            await pool.query(`
                UPDATE Users
                SET ${updateFields.join(', ')}
                WHERE id = $${paramIndex}
            `, values);

            // Обновляем данные в сессии
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

// Маршрут для истории заказов
app.get('/order-history', requireAuth, async (req, res) => {
    try {
        const ordersResult = await pool.query(`
            SELECT id, total_price, status, shipping_address, payment_method, created_at
            FROM Orders
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [req.session.userId]);

        const orders = ordersResult.rows.map(order => {
            // Преобразуем total_price в число, с проверкой
            const totalPrice = parseFloat(order.total_price);
            return {
                ...order,
                total_price: isNaN(totalPrice) ? 0 : totalPrice // Если не удалось преобразовать, используем 0
            };
        });

        // Для каждого заказа получаем его элементы
        for (let order of orders) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price_at_time, p.name, p.image_url
                FROM Order_Items oi
                JOIN Products p ON oi.product_article = p.article
                WHERE oi.order_id = $1
            `, [order.id]);

            order.items = itemsResult.rows.map(item => {
                // Преобразуем price_at_time в число, с проверкой
                const priceAtTime = parseFloat(item.price_at_time);
                return {
                    ...item,
                    price_at_time: isNaN(priceAtTime) ? 0 : priceAtTime // Если не удалось преобразовать, используем 0
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
    // Получаем userId из сессии через handshake (передаем его при подключении)
    const userId = socket.handshake.session?.userId || null;

    if (!userId) {
        socket.emit('response', 'Пожалуйста, войдите в систему, чтобы использовать чат-бот. <a href="/login">Войти</a>');
        return;
    }

    socket.emit('response', 'Привет! Я бот магазина семян. Введи команду: "поиск", "заказ" или "история".');

    socket.on('message', async (msg) => {
        const input = msg.trim().toLowerCase();

        // Поиск товаров
        if (input.startsWith('поиск')) {
            const query = input.replace('поиск', '').trim();
            const res = await pool.query(
                `SELECT p.*, c.name as category_name 
                 FROM products p 
                 LEFT JOIN categories c ON p.category_id = c.id 
                 WHERE p.name ILIKE $1 OR p.article ILIKE $1`,
                [`%${query}%`]
            );
            if (res.rows.length > 0) {
                const response = res.rows.map(row => `${row.name} (арт. ${row.article}, категория: ${row.category_name || 'нет'}) - ${row.price} руб., в наличии: ${row.stock}`).join('\n');
                socket.emit('response', `Найдено:\n${response}`);
            } else {
                socket.emit('response', 'Ничего не найдено.');
            }
        }

        // Оформление заказа
        else if (input.startsWith('заказ')) {
            const article = input.replace('заказ', '').trim();
            const productRes = await pool.query('SELECT * FROM products WHERE article = $1', [article]);
            if (productRes.rows.length === 0 || productRes.rows[0].stock <= 0) {
                socket.emit('response', 'Товар не найден или отсутствует на складе.');
                return;
            }

            const product = productRes.rows[0];
            const quantity = 1; // Можно сделать настраиваемым
            const totalPrice = product.price * quantity;

            // Получаем данные пользователя для адреса доставки
            const userRes = await pool.query('SELECT address FROM users WHERE id = $1', [userId]);
            const shippingAddress = userRes.rows[0]?.address || 'Адрес не указан';

            // Создаем заказ
            const orderRes = await pool.query(
                `INSERT INTO orders (user_id, total_price, status, shipping_address, payment_method, created_at) 
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
                [userId, totalPrice, 'pending', shippingAddress, 'cash']
            );
            const orderId = orderRes.rows[0].id;

            // Добавляем детали заказа
            await pool.query(
                `INSERT INTO order_items (order_id, quantity, price_at_time, product_article) 
                 VALUES ($1, $2, $3, $4)`,
                [orderId, quantity, product.price, article]
            );

            // Обновляем количество на складе
            await pool.query('UPDATE products SET stock = stock - $1 WHERE article = $2', [quantity, article]);

            socket.emit('response', `Заказ на ${product.name} (арт. ${article}) оформлен! Сумма: ${totalPrice} руб.`);
        }

        // История заказов
        else if (input === 'история') {
            const ordersRes = await pool.query(
                `SELECT o.id, o.total_price, o.created_at, oi.quantity, oi.price_at_time, p.name, p.article 
                 FROM orders o 
                 JOIN order_items oi ON o.id = oi.order_id 
                 JOIN products p ON oi.product_article = p.article 
                 WHERE o.user_id = $1`,
                [userId]
            );

            if (ordersRes.rows.length > 0) {
                const response = ordersRes.rows.map(row => 
                    `Заказ #${row.id} от ${row.created_at}: ${row.name} (арт. ${row.article}) - ${row.quantity} шт., цена: ${row.price_at_time} руб. Итого: ${row.total_price} руб.`
                ).join('\n');
                socket.emit('response', `Ваши заказы:\n${response}`);
            } else {
                socket.emit('response', 'У вас пока нет заказов.');
            }
        }

        else {
            socket.emit('response', 'Не понял. Используй "поиск <название>", "заказ <артикул>" или "история".');
        }
    });
});
  
// Middleware для передачи сессии в Socket.IO
io.use((socket, next) => {
    const session = socket.request.session;
    socket.handshake.session = session;
    next();
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});