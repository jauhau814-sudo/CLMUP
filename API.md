# Соответствие интерфейса и API

Успех: `{data: ...}`. Ошибка: `{error:{code,message,details?}}`.
422 — поля, 401 — вход, 403 — права/CSRF, 404 — недоступный объект,
409 — конфликт состояния/баланса, 413 — размер, 415 — формат,
429 — ограничения. Внешние не подключённые выплаты — 503.
Мутации — cookie + X-CSRF-Token; получение CSRF доступно гостю.

| HTML / действие | API | Данные и ограничения |
|---|---|---|
| Регистрация | POST /api/auth/register | firstName, lastName, phone, password; role запрещён |
| Вход / выход | POST /api/auth/login, /logout | ID сессии обновляется / удаляется |
| Сессия | GET /api/auth/csrf, GET /api/me | CSRF и свой профиль |
| Поиск, категории, страницы | GET /api/tasks?q=&category=&page=&limit= | ACTIVE, не просроченные; до 50 на страницу |
| Детали | GET /api/tasks/:id | приватные предложения видны владельцу/модератору |
| Создать задание | POST /api/tasks | title,description,location,reward,category,difficulty,deadline,photoId?,latitude?,longitude?,clientKey |
| Принять задание | POST /api/tasks/:id/claim | одна запись Claim на Task; чужая занятость 409 |
| Активные задания | GET /api/me/claims | только свои, со статусом и заданием |
| Предложения автора | GET /api/me/tasks | PENDING/ACTIVE/… и причина отказа |
| Фотоотчёт | POST /api/tasks/:id/complete | photoId,description; владелец Claim; REVIEW без награды |
| Фото | POST /api/uploads | multipart field file, JPEG/PNG/WebP, 10 МБ |
| Просмотр фото | GET /api/uploads/:id | проверка владельца / модератора / опубликованности |
| Сообщить о мусоре | POST /api/reports | photoId,description,category,address,suggestedPoints,coordinates?,clientKey |
| Сообщения пользователя | GET /api/me/reports | свои статусы и причины |
| История | GET /api/me/activities | собственные неизменяемые события |
| Рейтинг | GET /api/rating?period=all|month|year&page=&limit= | только начисления принятых уборок, без телефонов |
| Настройки | PATCH /api/me/settings | language ru/en, reminders,verification,points — boolean |
| Уведомления | GET /api/me/notifications, POST /api/me/notifications/read | личная история с учётом настроек |
| Вывод | POST /api/withdrawals | amount>=100, clientKey; резерв средств, не банковский перевод |
| Отмена вывода | POST /api/withdrawals/:id/cancel | свой PENDING; возврат один раз |
| История вывода | GET /api/me/withdrawals | собственные заявки |
| Карта | GET /api/config + GET /api/tasks | Leaflet + настраиваемые HTTPS тайлы; координаты не выдумываются |
| Проверка | GET /api/moderation/queue | MODERATOR/ADMIN; page/limit; три очереди и счётчики |
| Публикация предложения | POST /api/moderation/tasks/:id | decision accept/reject, reason при reject |
| Приёмка фотоотчёта | POST /api/moderation/completions/:claimId | транзакция: claim + task + balance + activity + review |
| Проверка сообщения | POST /api/moderation/reports/:id | статус + аудит; награда отсутствует |
| Финансы администратора | GET /api/moderation/withdrawals | ADMIN, только pending, page/limit |
| Отказ в выводе | POST /api/moderation/withdrawals/:id | ADMIN; reject с причиной возвращает сумму |
| Готовность | GET /api/health | проверяет соединение с БД |

Пагинированные ответы: `{items,total,page,limit}`. `queue` возвращает
`{tasks,completions,reports,totals,page,limit}`.
`clientKey` — случайный UUID браузера для повтора одного создания;
сохраняется на сервере уникально. Запросы другого владельца с чужим ключом
не получают чужую запись. Повторная приёмка награды отклоняется и не начисляет
баллы. Резерв вывода защищён транзакцией, а не только блокировкой кнопки.

Нет API, позволяющего пользователю устанавливать баланс, статус приёмки или роль.
Старые get*/save*ToServer(localStorage) из HTML удалены целиком.
