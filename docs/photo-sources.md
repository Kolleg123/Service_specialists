# Изображения

Источник — [Unsplash](https://unsplash.com), [лицензия Unsplash](https://unsplash.com/license). Портреты используются только как иллюстрации вымышленных профилей; изображённые люди не заявляются реальными исполнителями и не подтверждают указанные квалификации.

| Файл | Исходный ресурс |
|---|---|
| `1.jpg` | https://images.unsplash.com/photo-1500648767791-00dcc994a43e |
| `2.jpg` | https://images.unsplash.com/photo-1560250097-0b93528c311a |
| `3.jpg` | https://images.unsplash.com/photo-1580489944761-15a19d654956 |
| `4.jpg` | https://images.unsplash.com/photo-1438761681033-6461ffad8d80 |
| `5.jpg` | https://images.unsplash.com/photo-1519085360753-af0119f7cbe7 |
| `6.jpg` | https://images.unsplash.com/photo-1494790108377-be9c29b29330 |
| `hero.jpg` | https://raw.githubusercontent.com/codewithsadee/barber/master/assets/images/hero-banner.jpg |

Загрузка: `python scripts/download_assets.py`. Нужен HTTPS-доступ к `images.unsplash.com`. Скрипт сохраняет изображения в `static/photos/`, после чего изображения не требуют внешней сети. Не отключает TLS-проверку. Шрифт Golos Text также сохранён локально в `static/fonts/`; лицензия SIL Open Font License — в `static/fonts/OFL.txt`. Исходники: https://github.com/google/fonts/tree/main/ofl/golostext. Для обычной работы приложения внешняя сеть не нужна.

## Новый первый экран

Фото стрижки в процессе взято из [Barber demo, codewithsadee](https://github.com/codewithsadee/barber). В README источника раздел License прямо указывает: “This project is **free to use** and does not contains any license.” Это отдельный источник, не Unsplash; общая ссылка на лицензию Unsplash выше относится только к шести портретам. Оригинал сохранён без изменений в `static/photos/hero.jpg`. Для production-публикации можно заменить демонстрационный снимок собственным фото услуги.

Источник доступен через разрешённый `raw.githubusercontent.com`; загрузка нового фото с Unsplash была недоступна в текущей среде. Изображение показывает реальную работу парикмахера, текст расположен поверх затемнённой области.
