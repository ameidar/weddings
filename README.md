# Event Management Platform — Cloudflare Pages

מערכת ווב מלאה לניהול אירועים, לקוחות, מוזמנים, וואטסאפ, סידורי שולחנות, ספקים וארנק אירוע — כולל סוכן AI פנימי שמבין הוראות בעברית ומבצע פעולות בטוחות על נתוני האירוע.

המערכת נבנתה כ־Single Page App בעברית/RTL עם Cloudflare Pages + Worker + KV.

---

## 1. מה יש במערכת

### ממשק אדמין
- כניסת אדמין מאובטחת.
- יצירת אירוע חדש.
- יצירת שם משתמש וסיסמה ללקוח לכל אירוע.
- יצירת קישור דף לקוח ייחודי.
- שיתוף פרטי כניסה במייל/וואטסאפ/העתקת לינק.
- רשימת אירועים קיימים.
- איפוס סיסמת לקוח.
- מחיקת אירוע מרשימת האדמין.

### ממשק לקוח / דף אירוע
- כניסת לקוח לפי אירוע, שם משתמש וסיסמה.
- לקוח לא יכול לערוך פרטי אירוע בסיסיים כמו שם, תאריך ואולם.
- לקוח כן יכול לעדכן כמות משתתפים צפויה.
- תפריט מודולים:
  - סקירה כללית
  - משתתפים / מוזמנים
  - וואטסאפ
  - סידור שולחנות
  - ספקים
  - ארנק / תשלומים
  - סוכן אירועים אישי

### ניהול משתתפים
- טבלת מוזמנים בעברית.
- חיפוש וסינון לפי סטטוס אישור ותשלום.
- שדות עיקריים:
  - שם מלא / שם לקוח
  - טלפון וואטסאפ
  - קבוצה
  - כמות מוזמנים
  - סטטוס אישור השתתפות
  - סכום לתשלום
  - סטטוס תשלום
  - שולחן / אזור
  - רגישויות מזון
  - הערות
- כמות מוזמנים משפיעה על סטטיסטיקות, קיבולת שולחנות, שיבוץ אוטומטי וייצוא.

### וואטסאפ ו־RSVP
- חיבור ל־Green API.
- בחירת משתתף מתוך רשימה מחפשת.
- מילוי אוטומטי של טלפון והודעה.
- תבניות הודעה.
- שליחת הודעות דרך Worker endpoint.
- תבנית “הזמנה / אישור הגעה” מייצרת קישור RSVP אישי למוזמן.
- המוזמן פותח דף אישור הגעה עם כפתורי “מגיע/ה” ו־“לא מגיע/ה”.
- אם המוזמן מאשר הגעה, הוא מזין כמה מגיעים, והמערכת מעדכנת את `סטטוס אישור השתתפות` ואת `כמות מוזמנים` ב־KV.
- לוג שיחה לפי משתתף.
- רענון היסטוריית הודעות מ־Green API.

### סידור שולחנות ומפת אולם
- הגדרת מספר שולחנות, קיבולת ועמודות.
- העלאת תמונת מפת אולם כרקע.
- גרירת שולחנות למיקום חופשי על גבי המפה.
- גרירת משתתפים לשולחנות.
- שיבוץ אוטומטי.
- קיבולת מחושבת לפי `כמות מוזמנים`, לא לפי מספר שורות בלבד.
- ייצוא סידור שולחנות ל־CSV.

### ספקים וארנק
- ניהול ספקים: שם, תחום, טלפון, מייל, חוזה, סכום שסוכם, סטטוס תשלום והערות.
- תקשורת עם ספק בוואטסאפ/מייל.
- ארנק אירוע ותנועות כספיות.
- אין תשלום אמיתי לספקים בלי חיבור נפרד לספק סליקה/בנק.

### סוכן אירועים אישי — AI Agent
המערכת כוללת endpoint בשם `/api/event-agent` שמפעיל סוכן ביצועי פנימי.

הסוכן יכול:
- לענות על שאלות מתוך נתוני האירוע.
- להוסיף או לעדכן משתתפים.
- לעדכן מספר טלפון.
- לעדכן RSVP / אישור הגעה.
- לשבץ משתתף לשולחן.
- לשלוח הודעת וואטסאפ כאשר יש מספיק מידע.
- לשאול שאלות המשך כשחסר פרט קריטי.

דוגמאות:

```text
מי המשתתפים באירוע?
מי עדיין לא אישר הגעה?
תכניס את משפחת כהן עם 4 נפשות, טלפון 0528746137, לשולחן 3
תוסיף מספר טלפון למשפחת ימיני 0528746137
סמן את משפחת כהן כמאושרת
שלח וואטסאפ לעמי 0528746137 ותשאל אותו אם הוא מתכוון להגיע
```

הסוכן מוגבל בכוונה לנתוני וכלי האירוע. אין לו shell, אין לו גישה חופשית לקבצי שרת, ואין לו הרשאות Cloudflare ישירות.

---

## 2. מבנה הפרויקט

```text
.
├── index.html      # כל ממשק ה-SPA: HTML, CSS, JavaScript
├── _worker.js      # Cloudflare Pages Worker: auth, API, KV, AI, WhatsApp
├── _headers        # כותרות אבטחה בסיסיות ל-Cloudflare Pages
├── README.md       # המסמך הזה
└── .gitignore      # קבצים שלא מעלים לגיט
```

המערכת כרגע אינה דורשת build step. Cloudflare Pages מגיש את `index.html`, וה־Worker נמצא ב־`_worker.js`.

---

## 3. טכנולוגיות

- Frontend: HTML/CSS/Vanilla JavaScript
- Hosting: Cloudflare Pages
- Backend/API: Cloudflare Pages Functions / `_worker.js`
- Database: Cloudflare KV
- Auth: JWT-like signed session token בעזרת HMAC SHA-256 ב־Worker
- AI:
  - Anthropic Claude אם מוגדר `ANTHROPIC_API_KEY`
  - OpenAI אם מוגדר `OPENAI_API_KEY`
- WhatsApp: Green API

---

## 4. דרישות מוקדמות להרמה במקום אחר

צריך:

1. חשבון Cloudflare.
2. פרויקט Cloudflare Pages.
3. KV namespace עבור נתוני אירועים.
4. סודות Worker / Pages Functions.
5. אופציונלי: חשבון Green API לשליחת וואטסאפ.
6. אופציונלי: מפתח Anthropic/OpenAI עבור סוכן AI.

---

## 5. יצירת Cloudflare Pages Project

אפשר להעלות ידנית דרך Cloudflare Dashboard או דרך Wrangler.

### התקנת Wrangler

```bash
npm install -g wrangler
wrangler login
```

### Deploy ידני מהתיקייה

מתוך תיקיית הפרויקט:

```bash
wrangler pages deploy . --project-name <PROJECT_NAME> --branch main
```

במערכת המקורית שם הפרויקט היה:

```text
ami-wedding
```

אבל בהרמה חדשה אפשר לבחור כל שם.

---

## 6. KV — מסד הנתונים

המערכת משתמשת ב־Cloudflare KV binding בשם:

```text
EVENTS_KV
```

### יצירת KV namespace

```bash
wrangler kv namespace create EVENTS_KV
```

לאחר מכן יש לחבר את ה־namespace לפרויקט Pages:

Cloudflare Dashboard:

```text
Pages → Your project → Settings → Functions → KV namespace bindings
```

להוסיף binding:

```text
Variable name: EVENTS_KV
KV namespace: <your namespace>
```

### מה נשמר ב־KV

- רשימת אירועים תחת key:

```text
dynamic_event_admin_events_v1
```

- מצב אירוע לפי eventId תחת prefix:

```text
dynamic_event_state_v1:<eventId>
```

מצב אירוע כולל:

```js
{
  eventSettings,
  participants,
  hall,
  vendors,
  walletTx,
  whatsappLog,
  updatedAt
}
```

---

## 7. Secrets / Environment Variables

יש להגדיר סודות בפרויקט Cloudflare Pages.

Cloudflare Dashboard:

```text
Pages → Your project → Settings → Environment variables
```

או דרך Wrangler:

```bash
wrangler pages secret put SECRET_NAME --project-name <PROJECT_NAME>
```

### חובה לפרודקשן

#### `ADMIN_USERNAME`
שם משתמש אדמין.

דוגמה:

```text
admin
```

#### `ADMIN_PASSWORD_HASH`
SHA-256 hex של סיסמת האדמין.

יצירת hash:

```bash
node -e "crypto=require('crypto'); console.log(crypto.createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
```

#### `SESSION_SECRET`
מחרוזת אקראית ארוכה לחתימת session tokens.

יצירה:

```bash
openssl rand -hex 32
```

#### `EVENTS_KV`
זה binding, לא secret. חובה לחבר KV namespace בשם הזה.

### אופציונלי — AI

#### `ANTHROPIC_API_KEY`
מפתח Anthropic. אם קיים, הסוכן מעדיף Anthropic.

#### `ANTHROPIC_MODEL`
שם מודל Anthropic. אם לא מוגדר, הקוד מנסה candidates פנימיים.

#### `OPENAI_API_KEY`
מפתח OpenAI. משמש fallback אם אין Anthropic או עבור `/api/event-ai`.

#### `OPENAI_MODEL`
ברירת מחדל בקוד:

```text
gpt-4.1
```

### אופציונלי — WhatsApp / Green API

#### `GREENAPI_ID_INSTANCE`
מזהה instance של Green API.

#### `GREENAPI_API_TOKEN_INSTANCE`
Token של instance ב־Green API.

בלי שני הערכים האלה שליחת וואטסאפ והיסטוריית וואטסאפ לא יעבדו.

---

## 8. API Endpoints

כל ה־API נמצא ב־`_worker.js`.

### `POST /api/admin-login`
כניסת אדמין.

Request:

```json
{
  "username": "admin",
  "password": "plain password"
}
```

Response:

```json
{
  "ok": true,
  "token": "..."
}
```

### `GET /api/auth/me`
בדיקת session token.

Header:

```text
Authorization: Bearer <token>
```

### `/api/events`
ניהול רשימת אירועים.

- `GET /api/events` — רשימת אירועים לאדמין.
- `POST /api/events` — יצירת/עדכון אירוע.
- `DELETE /api/events?id=<eventId>` — מחיקת אירוע מרשימת האדמין.

דורש session אדמין.

### `POST /api/client-login`
כניסת לקוח לאירוע ספציפי.

Request:

```json
{
  "eventId": "...",
  "username": "...",
  "password": "..."
}
```

### `/api/event-state`
קריאה/שמירה של מצב אירוע.

- `GET /api/event-state?eventId=<id>`
- `POST /api/event-state`

דורש גישה לאותו אירוע — אדמין או לקוח מורשה.

### `POST /api/rsvp-link`
יוצר קישור RSVP אישי למשתתף. דורש הרשאת אדמין או לקוח לאותו אירוע.

Request:

```json
{
  "eventId": "...",
  "guestIndex": 0
}
```

Response:

```json
{
  "ok": true,
  "link": "https://your-domain.com/rsvp?t=..."
}
```

### `GET /rsvp?t=<token>`
דף ציבורי למוזמן עם כפתורי אישור/אי אישור ושדה כמות מגיעים.

### `POST /api/rsvp`
מקבל תשובת RSVP מהדף הציבורי ומעדכן את מצב האירוע ב־KV.

Request:

```json
{
  "token": "...",
  "status": "אישר",
  "count": 3
}
```

### `POST /api/event-ai`
סוכן Q&A בסיסי יותר, קורא מצב אירוע ושואל OpenAI.

### `POST /api/event-agent`
הסוכן הביצועי הראשי.

Request:

```json
{
  "eventId": "...",
  "command": "תכניס את משפחת כהן עם 4 נפשות לשולחן 3 טלפון 052..."
}
```

Response:

```json
{
  "ok": true,
  "eventId": "...",
  "actions": [...],
  "actionsLog": [...],
  "needsFollowup": false,
  "answer": "...",
  "state": {...}
}
```

### `POST /api/send-whatsapp`
שליחת וואטסאפ דרך Green API.

Request:

```json
{
  "phone": "0528746137",
  "message": "שלום..."
}
```

### `POST /api/whatsapp-history`
שליפת היסטוריית וואטסאפ מ־Green API.

Request:

```json
{
  "phone": "0528746137",
  "count": 50
}
```

---

## 9. Authentication ו־Security

### אדמין
- משתמש וסיסמה נבדקים מול `ADMIN_USERNAME` ו־`ADMIN_PASSWORD_HASH`.
- הסיסמה הגלויה לא נשמרת בקוד.
- לאחר כניסה נוצר token חתום.

### לקוח
- לכל אירוע יש `clientUsername` ו־`clientPassword`.
- הלקוח מקבל קישור ייחודי:

```text
https://your-domain.com/?event=<eventId>#client
```

- הלקוח חייב להתחבר לפני שהוא רואה את המודולים.
- הלקוח לא יכול לערוך הגדרות אירוע בסיסיות.

### חשוב
המערכת מתאימה ל־MVP/מערכת תפעולית קטנה. אם רוצים multi-tenant production מלא, מומלץ לשדרג ל־Cloudflare D1/Auth או provider ייעודי, עם hashing לסיסמאות לקוח והרשאות מפורטות יותר.

---

## 10. הרצה מקומית

אפשר להריץ עם Wrangler:

```bash
wrangler pages dev .
```

אם רוצים לבדוק API מקומית, צריך להגדיר משתנים וקישור KV מקומי לפי Wrangler.

דוגמה לקובץ `.dev.vars` מקומי — לא להעלות לגיט:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<sha256-hex>
SESSION_SECRET=<random-secret>
OPENAI_API_KEY=<optional>
ANTHROPIC_API_KEY=<optional>
GREENAPI_ID_INSTANCE=<optional>
GREENAPI_API_TOKEN_INSTANCE=<optional>
```

`.dev.vars` כבר נמצא ב־`.gitignore`.

---

## 11. פריסה לדומיין מותאם

ב־Cloudflare Pages:

```text
Pages → Your project → Custom domains → Set up a custom domain
```

בדוגמה המקורית הדומיין היה:

```text
https://wedding.orma-ai.com
```

בהרמה חדשה אפשר לחבר כל דומיין.

---

## 12. גיבוי ושחזור

### מתוך הממשק
קיימת אפשרות ייצוא/ייבוא JSON של האירוע.

### מתוך KV
אפשר לגבות keys של KV דרך Cloudflare API/Wrangler.

ה־keys החשובים:

```text
dynamic_event_admin_events_v1
dynamic_event_state_v1:<eventId>
```

### מעבר לסביבה אחרת
כדי להעביר מערכת:

1. לפרוס את הקוד בפרויקט Cloudflare Pages חדש.
2. ליצור KV namespace חדש.
3. לחבר binding בשם `EVENTS_KV`.
4. להגדיר secrets.
5. לייצא נתונים מה־KV הישן.
6. לייבא אותם ל־KV החדש עם אותם keys.
7. לחבר דומיין חדש אם צריך.

---

## 13. Git / Deployment Flow מומלץ

```bash
git clone git@github.com:<USER>/<REPO>.git
cd <REPO>
wrangler pages deploy . --project-name <PROJECT_NAME> --branch main
```

אחרי שינוי קוד:

```bash
git add .
git commit -m "Describe change"
git push
wrangler pages deploy . --project-name <PROJECT_NAME> --branch main
```

אפשר גם לחבר את GitHub ישירות ל־Cloudflare Pages כדי שכל push ל־`main` יפרוס אוטומטית.

---

## 14. Known Limitations / דברים לשיפור

- כל ה־frontend נמצא בקובץ `index.html`; לפרויקט גדול כדאי לפצל ל־React/Vue/Svelte או modules.
- KV הוא JSON blob per event; לא DB רלציוני. לאירועים גדולים/הרבה משתמשים עדיף D1/Postgres.
- סיסמאות לקוח נשמרות כחלק מאובייקט האירוע; לפרודקשן חזק יותר מומלץ hashing והרשאות נפרדות.
- אין מערכת roles מלאה מעבר לאדמין/לקוח.
- שליחת WhatsApp היא פעולה חיצונית אמיתית — מומלץ להוסיף confirmations בצד UI לפעולות רגישות.
- אין audit log מלא לכל שינוי, חוץ מלוגים ספציפיים כמו WhatsApp.

---

## 15. Troubleshooting

### אדמין לא מצליח להתחבר
בדוק:
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- שה־hash נוצר מאותה סיסמה בדיוק.
- `SESSION_SECRET` מוגדר.

### אירועים לא נשמרים בין דפדפנים
כנראה `EVENTS_KV` לא מחובר.

בדוק ב־Cloudflare Pages:

```text
Settings → Functions → KV namespace bindings
```

### סוכן AI לא עובד
בדוק:
- `ANTHROPIC_API_KEY` או `OPENAI_API_KEY` מוגדרים.
- שם המודל תקין.
- endpoint `/api/event-agent` מחזיר JSON תקין.

### וואטסאפ לא נשלח
בדוק:
- `GREENAPI_ID_INSTANCE`
- `GREENAPI_API_TOKEN_INSTANCE`
- שה־instance ב־Green API מחובר לוואטסאפ.
- שהמספר בפורמט תקין. הקוד מנרמל מספרים ישראליים כמו `052...` ל־`97252...@c.us`.

### הלקוח רואה מסך כניסה אבל לא נכנס
בדוק:
- שהקישור כולל `?event=<eventId>#client`.
- ששם המשתמש והסיסמה הם אלו שנוצרו לאירוע.
- שהאירוע קיים ב־KV.

---

## 16. Production Checklist

לפני שימוש אמיתי:

- [ ] להגדיר `ADMIN_USERNAME`.
- [ ] להגדיר `ADMIN_PASSWORD_HASH`.
- [ ] להגדיר `SESSION_SECRET` חזק.
- [ ] לחבר KV בשם `EVENTS_KV`.
- [ ] להגדיר Anthropic/OpenAI אם רוצים סוכן AI.
- [ ] להגדיר Green API אם רוצים וואטסאפ.
- [ ] לחבר דומיין.
- [ ] לבדוק כניסת אדמין.
- [ ] ליצור אירוע בדיקה.
- [ ] לבדוק כניסת לקוח.
- [ ] לבדוק שמירת משתתפים.
- [ ] לבדוק סידור שולחנות.
- [ ] לבדוק סוכן AI עם הוראות בעברית.
- [ ] לבדוק וואטסאפ רק עם מספר בדיקה מאושר.
- [ ] לבדוק קישור RSVP: פתיחת `/rsvp`, לחיצה על מגיע/לא מגיע, ועדכון הסטטוס והכמות במערכת.
- [ ] לוודא שאין secrets בקוד או בגיט.

---

## 17. קבצים שלא אמורים להיכנס לגיט

כבר מוגדר ב־`.gitignore`:

```text
.wrangler/
.dev.vars
.env
.env.*
node_modules/
dist/
.DS_Store
*.log
.openclaw/
```

אין לשמור API keys, tokens או סיסמאות גלויות בתוך הקוד או README.

---

## 18. מצב מקור ידוע

המערכת פותחה במקור עבור פרויקט Cloudflare Pages בשם:

```text
ami-wedding
```

ודומיין:

```text
https://wedding.orma-ai.com
```

בעת הרמה במקום אחר יש להחליף project name, domain, KV namespace ו־secrets בהתאם לסביבה החדשה.
