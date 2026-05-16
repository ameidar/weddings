# Event Management Platform — Cloudflare Pages

מערכת ווב לניהול אירועים, לקוחות, מוזמנים, וואטסאפ, אישורי הגעה, סידורי שולחנות, ספקים וארנק אירוע.

המערכת בנויה כ־Single Page App בעברית/RTL עם Cloudflare Pages + Worker + KV.

---

## מה יש במערכת

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
- מודולים: סקירה כללית, משתתפים, וואטסאפ, סידור שולחנות, ספקים וארנק.

### ניהול משתתפים
- טבלת מוזמנים בעברית.
- חיפוש וסינון לפי סטטוס אישור ותשלום.
- שדות עיקריים: שם, טלפון וואטסאפ, קבוצה, כמות מוזמנים, סטטוס אישור, סטטוס תשלום, שולחן/אזור, רגישויות והערות.
- כמות מוזמנים משפיעה על סטטיסטיקות, קיבולת שולחנות, שיבוץ אוטומטי וייצוא.

### וואטסאפ ו־RSVP
- חיבור ל־Green API.
- בחירת משתתף מתוך רשימה מחפשת.
- תבניות הודעה.
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
- קיבולת מחושבת לפי `כמות מוזמנים`.
- ייצוא סידור שולחנות ל־CSV.

### ספקים וארנק
- ניהול ספקים: שם, תחום, טלפון, מייל, חוזה, סכום שסוכם, סטטוס תשלום והערות.
- תקשורת עם ספק בוואטסאפ/מייל.
- ארנק אירוע ותנועות כספיות.

---

## מבנה הפרויקט

```text
.
├── index.html      # כל ממשק ה-SPA: HTML, CSS, JavaScript
├── _worker.js      # Cloudflare Pages Worker: auth, API, KV, RSVP, WhatsApp
├── _headers        # כותרות אבטחה בסיסיות ל-Cloudflare Pages
├── README.md
└── .gitignore
```

אין build step. Cloudflare Pages מגיש את `index.html`, וה־Worker נמצא ב־`_worker.js`.

---

## דרישות להרמה במקום אחר

1. חשבון Cloudflare.
2. פרויקט Cloudflare Pages.
3. KV namespace עבור נתוני אירועים.
4. Secrets עבור auth ו־Green API אם משתמשים בוואטסאפ.

---

## Cloudflare KV

חובה לחבר KV binding בשם המדויק:

```text
EVENTS_KV
```

יצירת namespace:

```bash
wrangler kv namespace create EVENTS_KV
```

חיבור ב־Cloudflare Dashboard:

```text
Pages → Your project → Settings → Functions → KV namespace bindings
Variable name: EVENTS_KV
```

### Keys חשובים

```text
dynamic_event_admin_events_v1
event_state_v1:<eventId>
```

---

## Secrets / Environment Variables

להגדיר ב־Cloudflare Pages → Settings → Environment variables, או דרך Wrangler:

```bash
wrangler pages secret put SECRET_NAME --project-name <PROJECT_NAME>
```

### חובה

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH` — SHA-256 hex של סיסמת האדמין, לא הסיסמה עצמה.
- `SESSION_SECRET` — מחרוזת רנדומלית חזקה.

יצירת hash לסיסמה:

```bash
node -e "crypto=require('crypto'); console.log(crypto.createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
```

יצירת session secret:

```bash
openssl rand -hex 32
```

### וואטסאפ / Green API

- `GREENAPI_ID_INSTANCE`
- `GREENAPI_API_TOKEN_INSTANCE`

בלי שני הערכים האלה, שליחת וואטסאפ והיסטוריית וואטסאפ לא יעבדו.

---

## API Endpoints

### `POST /api/admin-login`
כניסת אדמין.

### `GET /api/auth/me`
בדיקת session token.

### `/api/events`
- `GET /api/events` — רשימת אירועים לאדמין.
- `POST /api/events` — יצירת/עדכון אירוע.
- `DELETE /api/events?id=<eventId>` — מחיקה מרשימת האדמין.

### `POST /api/client-login`
כניסת לקוח לאירוע ספציפי.

### `/api/event-state`
- `GET /api/event-state?eventId=<id>`
- `POST /api/event-state`

### `POST /api/rsvp-link`
יוצר קישור RSVP אישי למשתתף.

```json
{
  "eventId": "...",
  "guestIndex": 0
}
```

### `GET /rsvp?t=<token>`
דף ציבורי למוזמן עם כפתורי אישור/אי אישור ושדה כמות מגיעים.

### `POST /api/rsvp`
מקבל תשובת RSVP ומעדכן את מצב האירוע ב־KV.

### `POST /api/send-whatsapp`
שליחת וואטסאפ דרך Green API.

### `POST /api/whatsapp-history`
שליפת היסטוריית וואטסאפ מ־Green API.

---

## הרצה מקומית

```bash
wrangler pages dev .
```

דוגמה ל־`.dev.vars` מקומי — לא להעלות לגיט:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<sha256-hex>
SESSION_SECRET=<random-secret>
GREENAPI_ID_INSTANCE=<optional>
GREENAPI_API_TOKEN_INSTANCE=<optional>
```

---

## Deploy

```bash
wrangler pages deploy . --project-name <PROJECT_NAME> --branch main
```

אפשר גם לחבר את GitHub ישירות ל־Cloudflare Pages כדי שכל push ל־`main` יפרוס אוטומטית.

---

## גיבוי ושחזור

אפשר לייצא/לייבא JSON מתוך הממשק, או לגבות KV keys:

```text
dynamic_event_admin_events_v1
event_state_v1:<eventId>
```

למעבר לסביבה אחרת:
1. לפרוס את הקוד בפרויקט Pages חדש.
2. ליצור KV namespace חדש.
3. לחבר binding בשם `EVENTS_KV`.
4. להגדיר secrets.
5. לייצא/לייבא את ה־KV keys.
6. לחבר דומיין אם צריך.

---

## Production Checklist

- [ ] להגדיר `ADMIN_USERNAME`.
- [ ] להגדיר `ADMIN_PASSWORD_HASH`.
- [ ] להגדיר `SESSION_SECRET` חזק.
- [ ] לחבר KV בשם `EVENTS_KV`.
- [ ] להגדיר Green API אם רוצים וואטסאפ.
- [ ] לחבר דומיין.
- [ ] לבדוק כניסת אדמין.
- [ ] ליצור אירוע בדיקה.
- [ ] לבדוק כניסת לקוח.
- [ ] לבדוק שמירת משתתפים.
- [ ] לבדוק סידור שולחנות.
- [ ] לבדוק קישור RSVP.
- [ ] לבדוק וואטסאפ רק עם מספר בדיקה מאושר.
- [ ] לוודא שאין secrets בקוד או בגיט.

---

## קבצים שלא אמורים להיכנס לגיט

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
