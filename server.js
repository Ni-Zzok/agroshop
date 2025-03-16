const express = require('express');
const app = express();
const path = require('path');

// Настройка EJS как шаблонизатора
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Подключение статических файлов (CSS, изображения и т.д.)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Маршрут для главной страницы
app.get('/', (req, res) => {
    res.render('index');
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});