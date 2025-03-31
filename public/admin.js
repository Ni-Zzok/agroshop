// Управление вкладками
function openTab(tabName) {
    const tabs = document.getElementsByClassName('tab-content');
    const buttons = document.getElementsByClassName('tab-btn');
    for (let i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('active');
        buttons[i].classList.remove('active');
    }
    document.getElementById(tabName).classList.add('active');
    document.querySelector(`button[onclick="openTab('${tabName}')"]`).classList.add('active');
}

// Открытие модального окна для добавления
function openAddModal(table) {
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modal-title');
    const modalFields = document.getElementById('modal-fields');
    const modalForm = document.getElementById('modal-form');

    modalTitle.textContent = `Добавить запись в ${table}`;
    modalFields.innerHTML = '';
    modalForm.action = `/admin/${table}/add`;

    const fields = {
        users: [
            { name: 'email', type: 'email', required: true },
            { name: 'password', type: 'password', required: true },
            { name: 'role', type: 'select', options: ['user', 'admin'], required: true },
            { name: 'first_name', type: 'text' },
            { name: 'last_name', type: 'text' },
            { name: 'phone', type: 'text' },
            { name: 'address', type: 'textarea' },
            { name: 'birth_date', type: 'date' },
            { name: 'gender', type: 'select', options: ['male', 'female'] },
            { name: 'newsletter', type: 'checkbox' }
        ],
        products: [
            { name: 'article', type: 'text', required: true },
            { name: 'name', type: 'text', required: true },
            { name: 'description', type: 'textarea' },
            { name: 'category_id', type: 'number' },
            { name: 'image_url', type: 'text' },
            { name: 'price', type: 'number', step: '0.01', required: true },
            { name: 'stock', type: 'number', required: true }
        ],
        categories: [
            { name: 'name', type: 'text', required: true },
            { name: 'image_url', type: 'text' },
            { name: 'description', type: 'textarea' },
            { name: 'parent_id', type: 'number' }
        ],
        orders: [
            { name: 'user_id', type: 'number', required: true },
            { name: 'total_price', type: 'number', step: '0.01', required: true },
            { name: 'status', type: 'text', required: true },
            { name: 'shipping_address', type: 'textarea', required: true },
            { name: 'payment_method', type: 'text' }
        ],
        order_items: [
            { name: 'order_id', type: 'number', required: true },
            { name: 'quantity', type: 'number', required: true },
            { name: 'price_at_time', type: 'number', step: '0.01', required: true },
            { name: 'product_article', type: 'text', required: true }
        ],
        cart: [
            { name: 'user_id', type: 'number', required: true },
            { name: 'quantity', type: 'number', required: true },
            { name: 'product_article', type: 'text', required: true }
        ],
        product_stats: [
            { name: 'product_article', type: 'text', required: true },
            { name: 'add_to_cart_count', type: 'number', required: true }
        ],
        suppliers: [
            { name: 'name', type: 'text', required: true },
            { name: 'contact_person', type: 'text' },
            { name: 'email', type: 'email', required: true },
            { name: 'phone', type: 'text' },
            { name: 'address', type: 'textarea' }
        ],
        supplies: [
            { name: 'supplier_id', type: 'number', required: true },
            { name: 'quantity', type: 'number', required: true },
            { name: 'supply_date', type: 'date', required: true },
            { name: 'price_per_unit', type: 'number', step: '0.01', required: true },
            { name: 'total_cost', type: 'number', step: '0.01', required: true },
            { name: 'product_article', type: 'text', required: true }
        ]
    };

    fields[table].forEach(field => {
        const div = document.createElement('div');
        div.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = field.name.replace('_', ' ').toUpperCase();
        div.appendChild(label);

        if (field.type === 'select') {
            const select = document.createElement('select');
            select.name = field.name;
            if (field.required) select.required = true;
            field.options.forEach(option => {
                const opt = document.createElement('option');
                opt.value = option;
                opt.textContent = option;
                select.appendChild(opt);
            });
            div.appendChild(select);
        } else if (field.type === 'textarea') {
            const textarea = document.createElement('textarea');
            textarea.name = field.name;
            if (field.required) textarea.required = true;
            div.appendChild(textarea);
        } else if (field.type === 'checkbox') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = field.name;
            div.appendChild(input);
        } else {
            const input = document.createElement('input');
            input.type = field.type;
            input.name = field.name;
            if (field.step) input.step = field.step;
            if (field.required) input.required = true;
            div.appendChild(input);
        }
        modalFields.appendChild(div);
    });

    modal.style.display = 'block';
}

// Открытие модального окна для редактирования
function openEditModal(table, record) {
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modal-title');
    const modalFields = document.getElementById('modal-fields');
    const modalForm = document.getElementById('modal-form');

    modalTitle.textContent = `Редактировать запись в ${table}`;
    modalFields.innerHTML = '';
    modalForm.action = `/admin/${table}/edit`;

    const fields = {
        users: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'email', type: 'email', value: record.email },
            { name: 'password', type: 'password' },
            { name: 'role', type: 'select', options: ['user', 'admin'], value: record.role },
            { name: 'first_name', type: 'text', value: record.first_name },
            { name: 'last_name', type: 'text', value: record.last_name },
            { name: 'phone', type: 'text', value: record.phone },
            { name: 'address', type: 'textarea', value: record.address },
            { name: 'birth_date', type: 'date', value: record.birth_date },
            { name: 'gender', type: 'select', options: ['male', 'female'], value: record.gender },
            { name: 'newsletter', type: 'checkbox', checked: record.newsletter }
        ],
        products: [
            { name: 'article', type: 'hidden', value: record.article },
            { name: 'name', type: 'text', value: record.name },
            { name: 'description', type: 'textarea', value: record.description },
            { name: 'category_id', type: 'number', value: record.category_id },
            { name: 'image_url', type: 'text', value: record.image_url },
            { name: 'price', type: 'number', step: '0.01', value: record.price },
            { name: 'stock', type: 'number', value: record.stock }
        ],
        categories: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'name', type: 'text', value: record.name },
            { name: 'image_url', type: 'text', value: record.image_url },
            { name: 'description', type: 'textarea', value: record.description },
            { name: 'parent_id', type: 'number', value: record.parent_id }
        ],
        orders: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'user_id', type: 'number', value: record.user_id },
            { name: 'total_price', type: 'number', step: '0.01', value: record.total_price },
            { name: 'status', type: 'text', value: record.status },
            { name: 'shipping_address', type: 'textarea', value: record.shipping_address },
            { name: 'payment_method', type: 'text', value: record.payment_method }
        ],
        order_items: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'order_id', type: 'number', value: record.order_id },
            { name: 'quantity', type: 'number', value: record.quantity },
            { name: 'price_at_time', type: 'number', step: '0.01', value: record.price_at_time },
            { name: 'product_article', type: 'text', value: record.product_article }
        ],
        cart: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'user_id', type: 'number', value: record.user_id },
            { name: 'quantity', type: 'number', value: record.quantity },
            { name: 'product_article', type: 'text', value: record.product_article }
        ],
        product_stats: [
            { name: 'product_article', type: 'hidden', value: record.product_article },
            { name: 'add_to_cart_count', type: 'number', value: record.add_to_cart_count }
        ],
        suppliers: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'name', type: 'text', value: record.name },
            { name: 'contact_person', type: 'text', value: record.contact_person },
            { name: 'email', type: 'email', value: record.email },
            { name: 'phone', type: 'text', value: record.phone },
            { name: 'address', type: 'textarea', value: record.address }
        ],
        supplies: [
            { name: 'id', type: 'hidden', value: record.id },
            { name: 'supplier_id', type: 'number', value: record.supplier_id },
            { name: 'quantity', type: 'number', value: record.quantity },
            { name: 'supply_date', type: 'date', value: record.supply_date },
            { name: 'price_per_unit', type: 'number', step: '0.01', value: record.price_per_unit },
            { name: 'total_cost', type: 'number', step: '0.01', value: record.total_cost },
            { name: 'product_article', type: 'text', value: record.product_article }
        ]
    };

    fields[table].forEach(field => {
        const div = document.createElement('div');
        div.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = field.name.replace('_', ' ').toUpperCase();
        div.appendChild(label);

        if (field.type === 'select') {
            const select = document.createElement('select');
            select.name = field.name;
            field.options.forEach(option => {
                const opt = document.createElement('option');
                opt.value = option;
                opt.textContent = option;
                if (option === field.value) opt.selected = true;
                select.appendChild(opt);
            });
            div.appendChild(select);
        } else if (field.type === 'textarea') {
            const textarea = document.createElement('textarea');
            textarea.name = field.name;
            textarea.value = field.value || '';
            div.appendChild(textarea);
        } else if (field.type === 'checkbox') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = field.name;
            if (field.checked) input.checked = true;
            div.appendChild(input);
        } else {
            const input = document.createElement('input');
            input.type = field.type;
            input.name = field.name;
            if (field.step) input.step = field.step;
            input.value = field.value || '';
            div.appendChild(input);
        }
        modalFields.appendChild(div);
    });

    modal.style.display = 'block';
}

// Закрытие модального окна
function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

// Удаление записи
function deleteRecord(table, id) {
    if (confirm(`Вы уверены, что хотите удалить запись из ${table}?`)) {
        fetch(`/admin/${table}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        }).then(response => {
            if (response.ok) {
                location.reload();
            } else {
                alert('Ошибка при удалении записи');
            }
        });
    }
}