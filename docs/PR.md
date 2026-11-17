# Редизайн записи: этапы, актуальная доступность и мобильный каталог

Base: `ai_version` → head: `redesign-booking-flow`.

При смене услуги или занятости последнего места интерфейс мог сохранять устаревший выбор, а длинный профиль и скрытая прокрутка дат затрудняли запись. Теперь запись состоит из трёх этапов: услуга, дата/время, проверка условий. Смена услуги сбрасывает выбор и загружает новое расписание; конфликт бронирования показывает актуальные альтернативы.

- Проверка доступности и создание записи вынесены в `booking_service.py`. Сохранены маршруты и формат ответов API; дополнительные параметры необязательны. Длительность, пересечения, остаток мест и снимок условий проверяются внутри транзакции SQLite.
- Добавлены явные переходы по датам и календарное поле, загрузка с таймаутом, пустое состояние, ошибка и повтор. Защита от запоздавших ответов, повторная проверка перед POST, клавиатурная навигация и доступные подписи.
- Фото первого экрана показывает услугу; портреты помещаются в единый формат без обрезки. Помощник находится над фильтрами и не перекрывает карточки. Исправлены русские формы количества отзывов.
- Добавлена `tzdata==2025.2`, обновлены команды запуска и тестирования в README.

## Проверка

- `.venv/bin/pytest -q` — 26 тестов: смена услуги/длительности, недоступные даты, индивидуальная и групповая конкуренция, превышение вместимости, отмена, права и совместимость старых запросов.
- `node --check static/app.js` и `node --check static/booking.js` — успешно.
- `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e` — 12 сценариев: полный цикл кабинетов, сброс выбора, реальные конкурирующие клиенты, запоздавшие ответы, восстановление после ошибок, клавиатура и ширины 390/1280 px.
- `PYTHONTZPATH='' .venv/bin/python -c "from datetime import datetime; from zoneinfo import ZoneInfo; print(datetime.now(ZoneInfo('Europe/Kirov')).utcoffset())"` — `3:00:00` без системной базы часовых поясов.

## Макеты и скриншоты

[Описание и все 18 изображений](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/README.md) · [HTML-галерея](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/index.html).

| Экран | 390 px | 1280 px |
|---|---|---|
| До | [Каталог](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/before/catalog-390.png) | [Каталог](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/before/catalog-1280.png) |
| После | [Каталог](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/after/catalog-390.png) | [Каталог](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/after/catalog-1280.png) |
| Запись | [Время](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/after/time-390.png) | [Подтверждение](https://github.com/Kolleg123/Service_specialists/blob/redesign-booking-flow/docs/design/after/confirmation-1280.png) |

Загрузка, пустое состояние и ошибка воспроизводятся управляемыми ответами API в браузерных тестах. Снимки «до» сделаны на `a2ea466`, до изменения файлов. Тестовые базы изолированы от пользовательских данных. Источники фото указаны в `docs/photo-sources.md`.
