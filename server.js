const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const natural = require('natural');
const { NlpManager } = require('node-nlp');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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

// Проверка подключения к базе данных
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

// Инициализация инструментов natural для токенизации
const tokenizer = new natural.WordTokenizer();
const stopWords = ['и', 'в', 'на', 'с', 'по', 'для', 'что', 'где', 'как', 'это', 'мне', 'мои', 'покажи', 'семена', 'семян'];

// Инициализация node-nlp для классификации намерений
const nlpManager = new NlpManager({ languages: ['ru'], forceNER: true });

// Простая нормализация текста с лемматизацией через natasha
const normalizeText = async (text) => {
    if (!text || typeof text !== 'string') {
        console.warn('normalizeText: текст пустой или не является строкой:', text);
        return '';
    }

    // Базовая нормализация
    let normalizedText = text.toLowerCase();
    normalizedText = normalizedText.replace('истрия', 'история');
    normalizedText = normalizedText.replace('history', 'история');

    // Лемматизация через natasha
    try {
        const pythonPath = 'python'; // Или укажи полный путь, если нужно
        const { stdout } = await execPromise(`${pythonPath} lemmatize.py "${normalizedText}"`, { encoding: 'utf8' });
        const result = JSON.parse(stdout);
        normalizedText = result.lemmatized;
    } catch (err) {
        console.error('Ошибка при лемматизации с natasha:', err);
        // Если лемматизация не удалась, продолжаем с базовой нормализацией
    }

    // Токенизация и удаление стоп-слов
    const tokenized = tokenizer.tokenize(normalizedText);
    normalizedText = tokenized.filter(token => !stopWords.includes(token)).join(' ');

    return normalizedText;
};

// Функция для лемматизации текста через natasha для обучения
const lemmatizeForTraining = async (text) => {
    try {
        const pythonPath = 'python'; // Или укажи полный путь, если нужно
        const { stdout } = await execPromise(`${pythonPath} lemmatize.py "${text.toLowerCase()}"`, { encoding: 'utf8' });
        const result = JSON.parse(stdout);
        return result.lemmatized;
    } catch (err) {
        console.error('Ошибка при лемматизации для обучения:', err);
        return text.toLowerCase(); // Fallback на исходный текст
    }
};

// Обучаем node-nlp с лемматизированными примерами
(async () => {
    // Намерение: поиск
    const searchExamples = [
        'найди семена томатов',
        'ищу семена огурцов',
        'поиск семян',
        'найти что-то для сада',
        'покажи семена',
        'где семена томатов',
        'покажи мне товары для огорода',
        'где найти семена перца',
        'ищу что-нибудь для посадки'
    ];

    for (const example of searchExamples) {
        const lemmatizedExample = await lemmatizeForTraining(example);
        nlpManager.addDocument('ru', lemmatizedExample, 'поиск');
        console.log(`Добавлен лемматизированный пример для поиска: ${lemmatizedExample}`);
    }

    // Намерение: заказ
    const orderExamples = [
        'хочу заказать семена',
        'закажи A123',
        'оформить заказ на семена томатов',
        'купить семена огурцов',
        'заказать 3 пачки семян',
        'хочу купить семена моркови',
        'оформить заказ на A456',
        'закажи семена для сада',
        'купить 2 пачки семян томатов'
    ];

    for (const example of orderExamples) {
        const lemmatizedExample = await lemmatizeForTraining(example);
        nlpManager.addDocument('ru', lemmatizedExample, 'заказ');
        console.log(`Добавлен лемматизированный пример для заказа: ${lemmatizedExample}`);
    }

    // Намерение: история
    const historyExamples = [
        'покажи историю',
        'мои заказы',
        'история заказов',
        'что я заказывал',
        'покажи мои заказы',
        'посмотреть историю заказов',
        'покажи, что я покупал',
        'мои прошлые заказы',
        'история моих покупок'
    ];

    for (const example of historyExamples) {
        const lemmatizedExample = await lemmatizeForTraining(example);
        nlpManager.addDocument('ru', lemmatizedExample, 'история');
        console.log(`Добавлен лемматизированный пример для истории: ${lemmatizedExample}`);
    }

    // Обучаем node-nlp
    await nlpManager.train();
    nlpManager.save();
    console.log('node-nlp переобучен и сохранён с лемматизированными примерами');
})();

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

app.post('/webhook', express.json(), async (req, res) => {
    const intent = req.body.queryResult.intent.displayName;
    const parameters = req.body.queryResult.parameters;

    let responseText = '';

    if (intent === 'SearchIntent') {
        let query = parameters.product || req.body.queryResult.queryText.replace(/(поиск|найди|найти|ищу|покажи|где)/i, '').trim();
        if (!query) {
            responseText = 'Укажи, что именно ты хочешь найти. Например: "найди семена томатов".';
        } else {
            const queryWords = query.split(/\s+/);
            let conditions = [];
            let values = [];
            let paramIndex = 1;

            for (let word of queryWords) {
                if (word) {
                    conditions.push(`(p.name ILIKE $${paramIndex} OR p.article ILIKE $${paramIndex})`);
                    values.push(`%${word}%`);
                    paramIndex++;
                }
            }

            const sqlQuery = `
                SELECT p.*, c.name as category_name 
                FROM products p 
                LEFT JOIN categories c ON p.category_id = c.id 
                WHERE ${conditions.join(' AND ')}
            `;

            const result = await pool.query(sqlQuery, values);
            if (result.rows.length > 0) {
                responseText = 'Вот что я нашел:\n' + result.rows.map(row => `${row.name} (арт. ${row.article}, категория: ${row.category_name || 'нет'}) - ${row.price} руб., в наличии: ${row.stock}`).join('\n');
            } else {
                responseText = 'Ничего не найдено.';
            }
        }
    } else if (intent === 'OrderIntent') {
        // Логика для заказа (аналогично)
        responseText = 'Оформляю заказ...';
    } else if (intent === 'HistoryIntent') {
        // Логика для истории заказов (аналогично)
        responseText = 'Показываю историю заказов...';
    }

    // Формируем ответ для Dialogflow
    res.json({
        fulfillmentText: responseText
    });
});

// Логика бота через Socket.IO
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId || null;
    console.log('Пользователь подключился, userId:', userId);

    if (!userId) {
        socket.emit('response', 'Пожалуйста, войдите в систему, чтобы использовать чат-бот. <a href="/login">Войти</a>');
    } else {
        socket.emit('response', 'Привет! Я бот магазина семян. Можешь попросить меня найти товар, оформить заказ или показать историю заказов. Например: "найди семена томатов", "закажи семена огурцов", "покажи историю".');
    }

    socket.on('message', async (msg) => {
        if (!userId) {
            socket.emit('response', 'Пожалуйста, войдите в систему, чтобы использовать чат-бот. <a href="/login">Войти</a>');
            return;
        }

        const normalizedInput = await normalizeText(msg.trim());
        console.log('Получено сообщение (после нормализации):', normalizedInput);

        // Определяем намерение с помощью node-nlp
        const response = await nlpManager.process('ru', normalizedInput);
        const intent = response.intent;
        const classifications = response.classifications;
        console.log('Распознанное намерение (node-nlp):', intent);
        console.log('Вероятности (node-nlp):', classifications);

        // Уточнение намерения, если вероятности близки
        const topClassifications = classifications.slice(0, 2);
        if (topClassifications.length > 1 && topClassifications[0].score - topClassifications[1].score < 0.1) {
            const topIntent = topClassifications[0].intent;
            const secondIntent = topClassifications[1].intent;
            let clarificationMessage = 'Я не уверен, что ты хочешь. ';
            if (topIntent === 'поиск' && secondIntent === 'история') {
                clarificationMessage += 'Ты хочешь найти товар или посмотреть историю заказов?';
            } else if (topIntent === 'поиск' && secondIntent === 'заказ') {
                clarificationMessage += 'Ты хочешь найти товар или оформить заказ?';
            } else if (topIntent === 'заказ' && secondIntent === 'история') {
                clarificationMessage += 'Ты хочешь оформить заказ или посмотреть историю заказов?';
            } else {
                clarificationMessage += 'Попробуй уточнить, например: "найди семена томатов", "закажи A123" или "покажи историю".';
            }
            socket.emit('response', clarificationMessage);
            return;
        }

        if (intent === 'поиск') {
            // Извлекаем запрос для поиска
            const queryMatch = normalizedInput.match(/(?:поиск|найди|найти|ищу|покажи|где)\s+(.+)/i);
            let query = queryMatch ? queryMatch[1].trim() : normalizedInput.replace(/(поиск|найди|найти|ищу|покажи|где)/i, '').trim();

            if (!query) {
                socket.emit('response', 'Укажи, что именно ты хочешь найти. Например: "найди семена томатов".');
                return;
            }

            // Разбиваем запрос на слова и ищем по каждому слову
            const queryWords = query.split(/\s+/);
            let conditions = [];
            let values = [];
            let paramIndex = 1;

            for (let word of queryWords) {
                if (word) {
                    conditions.push(`(p.name ILIKE $${paramIndex} OR p.article ILIKE $${paramIndex})`);
                    values.push(`%${word}%`);
                    paramIndex++;
                }
            }

            if (conditions.length === 0) {
                socket.emit('response', 'Укажи, что именно ты хочешь найти. Например: "найди семена томатов".');
                return;
            }

            const sqlQuery = `
                SELECT p.*, c.name as category_name 
                FROM products p 
                LEFT JOIN categories c ON p.category_id = c.id 
                WHERE ${conditions.join(' AND ')}
            `;

            const res = await pool.query(sqlQuery, values);
            if (res.rows.length > 0) {
                const response = res.rows.map(row => `${row.name} (арт. ${row.article}, категория: ${row.category_name || 'нет'}) - ${row.price} руб., в наличии: ${row.stock}`).join('\n');
                socket.emit('response', `Вот что я нашел:\n${response}`);
            } else {
                socket.emit('response', 'Ничего не найдено.');
            }
        } else if (intent === 'заказ') {
            // Извлекаем название товара или артикул
            const articleMatch = normalizedInput.match(/(?:заказ|закажи|хочу заказать|оформить заказ|купить)\s+(.+)/i);
            let article;

            if (articleMatch) {
                const productName = articleMatch[1].trim();
                // Ищем товар по названию
                const productRes = await pool.query(
                    `SELECT * FROM products WHERE name ILIKE $1 LIMIT 1`,
                    [`%${productName}%`]
                );

                if (productRes.rows.length === 0) {
                    // Проверяем, есть ли артикул в формате "A123"
                    const articleDirectMatch = normalizedInput.match(/\b[A-Z]\d{3}\b/i);
                    if (articleDirectMatch) {
                        article = articleDirectMatch[0];
                    } else {
                        socket.emit('response', 'Товар не найден. Попробуй уточнить название или укажи артикул, например: "закажи A123".');
                        return;
                    }
                } else {
                    article = productRes.rows[0].article;
                }
            } else {
                const articleDirectMatch = normalizedInput.match(/\b[A-Z]\d{3}\b/i);
                if (articleDirectMatch) {
                    article = articleDirectMatch[0];
                } else {
                    socket.emit('response', 'Укажи, что именно ты хочешь заказать. Например: "закажи семена томатов" или "закажи A123".');
                    return;
                }
            }

            const productRes = await pool.query('SELECT * FROM products WHERE article = $1', [article]);
            if (productRes.rows.length === 0 || productRes.rows[0].stock <= 0) {
                socket.emit('response', 'Товар не найден или отсутствует на складе.');
                return;
            }

            const product = productRes.rows[0];
            const quantity = 1;
            const totalPrice = product.price * quantity;

            const userRes = await pool.query('SELECT address FROM users WHERE id = $1', [userId]);
            const shippingAddress = userRes.rows[0]?.address || 'Адрес не указан';

            const orderRes = await pool.query(
                `INSERT INTO orders (user_id, total_price, status, shipping_address, payment_method, created_at) 
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
                [userId, totalPrice, 'pending', shippingAddress, 'cash']
            );
            const orderId = orderRes.rows[0].id;

            await pool.query(
                `INSERT INTO order_items (order_id, quantity, price_at_time, product_article) 
                 VALUES ($1, $2, $3, $4)`,
                [orderId, quantity, product.price, article]
            );

            await pool.query('UPDATE products SET stock = stock - $1 WHERE article = $2', [quantity, article]);

            socket.emit('response', `Заказ на ${product.name} (арт. ${article}) оформлен! Сумма: ${totalPrice} руб.`);
        } else if (intent === 'история') {
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
        } else {
            socket.emit('response', 'Не понял, что ты хочешь. Попробуй сказать, например: "найди семена томатов", "закажи A123" или "покажи историю".');
        }
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});