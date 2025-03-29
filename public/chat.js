if (typeof io === 'undefined') {
    console.error('Socket.IO не загружен. Проверьте подключение скрипта /socket.io/socket.io.js');
} else {
    const socket = io();
    const chatContainer = document.querySelector('.chat-container');
    const chatBody = document.getElementById('chat');
    const chatToggleBtn = document.querySelector('.chat-toggle-btn');
    const chatOpenBtn = document.querySelector('.chat-open-btn');

    // Функция для открытия/закрытия чата
    function toggleChat() {
        chatContainer.classList.toggle('minimized');
    }

    // Отображение сообщений
    socket.on('response', (msg) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message', 'bot-message');
        messageElement.innerHTML = msg;
        chatBody.appendChild(messageElement);
        chatBody.scrollTop = chatBody.scrollHeight;
    });

    // Отображение кнопок
    socket.on('show_buttons', (buttons) => {
        const chatButtons = document.getElementById('chatButtons');
        const chatInput = document.getElementById('chatInput');
        chatButtons.style.display = 'flex';
        chatInput.style.display = 'none';
        chatButtons.innerHTML = ''; // Очищаем предыдущие кнопки
        buttons.forEach(button => {
            const buttonElement = document.createElement('button');
            buttonElement.textContent = button.text;
            buttonElement.onclick = () => {
                socket.emit('button_click', button.value);
            };
            chatButtons.appendChild(buttonElement);
        });
        // Добавляем кнопку "Отмена", если это не начальное меню
        if (buttons.length < 3) { // Начальное меню имеет 3 кнопки, остальные случаи — меньше
            const cancelButton = document.createElement('button');
            cancelButton.textContent = 'Отмена';
            cancelButton.classList.add('cancel-btn');
            cancelButton.onclick = () => {
                socket.emit('cancel_action');
            };
            chatButtons.appendChild(cancelButton);
        }
    });

    // Показ поля ввода
    socket.on('show_input', (options) => {
        console.log('Получено событие show_input:', options); // Отладка
        const chatButtons = document.getElementById('chatButtons');
        const chatInput = document.getElementById('chatInput');
        const inputField = document.getElementById('inputField');
        chatButtons.style.display = 'none';
        chatInput.style.display = 'flex';
        inputField.placeholder = options.placeholder || 'Введи данные...';
        inputField.focus();
    });

    // Отправка введённых данных
    function submitInput() {
        const inputField = document.getElementById('inputField');
        const message = inputField.value.trim();
        if (message) {
            console.log('Отправка input_submit:', message); // Отладка
            socket.emit('input_submit', message);
            inputField.value = '';
        }
    }

    // Отмена действия
    function cancelAction() {
        console.log('Отправка cancel_action'); // Отладка
        socket.emit('cancel_action');
    }

    // Отправка данных по нажатию Enter
    document.getElementById('inputField').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            console.log('Нажата клавиша Enter'); // Отладка
            submitInput();
        }
    });

    // Показать/скрыть чат
    chatToggleBtn.addEventListener('click', () => {
        console.log('Сворачивание/разворачивание чата');
        toggleChat();
    });

    chatOpenBtn.addEventListener('click', () => {
        console.log('Открытие чата');
        toggleChat();
    });
}