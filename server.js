const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.static('./'));

// Настройка пути к представлениям
app.set('views', path.join(__dirname, 'views'));


// Вызов функции для проверки подключения
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));