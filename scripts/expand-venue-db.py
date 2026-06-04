#!/usr/bin/env python3
"""Expand ORMa venue DB from public directory pages.

Conservative crawler: reads public listing/category pages, extracts venue names and
source URLs, infers metadata. It does not store personal contact details.
"""
import json, re, html, time, urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote, quote

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'event-venues-israel.json'

USER_AGENT = 'Mozilla/5.0 ORMa venue research (+public venue index)'

SEED_URLS = [
  'https://event-halls.co.il/',
  'https://event-halls.co.il/%d7%90%d7%95%d7%9c%d7%9e%d7%95%d7%aa-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
  'https://event-halls.co.il/קטגוריה/%d7%90%d7%95%d7%9c%d7%9e%d7%95%d7%aa-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
  'https://event-halls.co.il/קטגוריה/%d7%92%d7%a0%d7%99-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
  'https://event-halls.co.il/קטגוריה/%d7%9e%d7%a7%d7%95%d7%9e%d7%95%d7%aa-%d7%9e%d7%99%d7%95%d7%97%d7%93%d7%99%d7%9d/',
  'https://www.mekomot.co.il/',
  'https://www.mekomot.co.il/cat_mekomot/%d7%90%d7%95%d7%9c%d7%9e%d7%95%d7%aa-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
  'https://www.mekomot.co.il/cat_mekomot/%d7%92%d7%a0%d7%99-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
  'https://www.mekomot.co.il/cat_mekomot/%d7%9e%d7%a7%d7%95%d7%9e%d7%95%d7%aa-%d7%9c%d7%97%d7%aa%d7%95%d7%a0%d7%94/',
  'https://saveadate.co.il/event-hall/',
  'https://all-events.co.il/category/%d7%90%d7%95%d7%9c%d7%9e%d7%95%d7%aa-%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d/',
]

CITY_AREA = {
 'תל אביב -יפו':'מרכז','תל אביב-יפו':'מרכז','תל אביב':'מרכז','יפו':'מרכז','פתח תקווה':'מרכז','ראשון לציון':'מרכז','חולון':'מרכז','בת ים':'מרכז','רמת גן':'מרכז','גבעתיים':'מרכז','קריית אונו':'מרכז','אור יהודה':'מרכז','יהוד':'מרכז','בני ברק':'מרכז','הרצליה':'שרון','רמת השרון':'שרון','כפר סבא':'שרון','רעננה':'שרון','הוד השרון':'שרון',
 'נתניה':'שרון','עמק חפר':'שרון','כפר ויתקין':'שרון','אבן יהודה':'שרון','געש':'שרון','שפיים':'שרון','משמר השרון':'שרון','נורדיה':'שרון','נחשונים':'שרון','יקום':'שרון','בצרה':'שרון','ארסוף':'שרון',
 'חיפה':'צפון','קריות':'צפון','קריית אתא':'צפון','קריית ביאליק':'צפון','קיסריה':'צפון','חדרה':'צפון','בנימינה':'צפון','זכרון יעקב':'צפון','פרדס חנה':'צפון','פרדס חנה-כרכור':'צפון','שדות ים':'צפון','רגבה':'צפון','עין המפרץ':'צפון','עכו':'צפון','נהריה':'צפון','רמת הגולן':'צפון','קצרין':'צפון','יקנעם':'צפון','עפולה':'צפון','גליל':'צפון','יגור':'צפון','טבריה':'צפון','נצרת':'צפון','כרמיאל':'צפון','בית שאן':'צפון',
 'נס ציונה':'שפלה','יבנה':'שפלה','כנות':'שפלה','גדרה':'שפלה','מזכרת בתיה':'שפלה','קריית עקרון':'שפלה','רחובות':'שפלה','מודיעין-מכבים-רעות':'שפלה','מודיעין':'שפלה','כפר אוריה':'שפלה','בית עובד':'שפלה','צומת ראם':'שפלה','קיבוץ חפץ חיים':'שפלה','שדה יואב':'שפלה','עמק האלה':'שפלה','נצר סרני':'שפלה','לטרון':'שפלה','לוד':'שפלה','רמלה':'שפלה','ראש העין':'שפלה',
 'ירושלים':'ירושלים','נווה אילן':'ירושלים','בית שמש':'ירושלים','עין חמד':'ירושלים','שורש':'ירושלים','מעלה החמישה':'ירושלים','אבו גוש':'ירושלים',
 'אשדוד':'דרום','אשקלון':'דרום','באר שבע':'דרום','באר שבע':'דרום','נתיבות':'דרום','אופקים':'דרום','קריית מלאכי':'דרום','בני דרום':'דרום','ירוחם':'דרום','אילת':'דרום','שדרות':'דרום','דימונה':'דרום','מצפה רמון':'דרום','ערד':'דרום','להבים':'דרום','רהט':'דרום','מבועים':'דרום'
}
CITY_NAMES = sorted(CITY_AREA, key=len, reverse=True)
BAD_LABELS = {'דף הבית','עמוד הבית','צור קשר','מי אנחנו','אודות','כניסה','הרשמה','מבצעים','תנאי שימוש באתר','מדיניות פרטיות','הצהרת נגישות','מאמרים וטיפים'}
BAD_WORDS = ['טלפון:', 'מחיר משוער:', 'כתובת:', 'חוות דעת', 'להצעת מחיר', 'קרא עוד', 'עוד פרטים', 'keyboard_arrow', 'menu', 'close']
CATEGORY_WORDS = ['אולמות אירועים','גני אירועים','מקומות לחתונה','מקומות לאירועים','מסעדות לאירועים','מקומות מיוחדים','אזור המרכז','אזור הצפון','אזור הדרום','אזור השרון','אזור ירושלים','אזור השפלה','כל הארץ']


def safe_url(url):
    p=urlparse(url)
    path=quote(unquote(p.path), safe='/%')
    query=quote(unquote(p.query), safe='=&?/%')
    return p._replace(path=path, query=query).geturl()

def fetch(url):
    req = urllib.request.Request(safe_url(url), headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity'})
    return urllib.request.urlopen(req, timeout=25).read().decode('utf-8', 'ignore')

def clean_text(text):
    text = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', text, flags=re.S|re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    text = re.sub(r'\b0\d[\d\- ]{6,}\b', ' ', text)
    text = re.sub(r'\b\d+\s*(?:חוות דעת|המלצות?|רשומות)\b', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip(' -–|,')
    return text

def norm_key(text):
    text = re.sub(r'\([^)]*\)', '', text)
    text = re.sub(r'(אולם|אולמי|גן|גני|מתחם|אירועים|לאירועים|חתונה|לחתונה|כשר|מהדרין|אולם אירועים|גן אירועים)', '', text)
    return re.sub(r'[^א-תA-Za-z0-9]+', '', text).lower()

def infer_city(text):
    for c in CITY_NAMES:
        if c in text:
            return c
    return ''

def infer_area(city, text):
    if city and city in CITY_AREA: return CITY_AREA[city]
    if any(x in text for x in ['דרום','נגב','אילת']): return 'דרום'
    if 'ירושלים' in text: return 'ירושלים'
    if any(x in text for x in ['שרון','נתניה','רעננה','הרצליה']): return 'שרון'
    if any(x in text for x in ['צפון','חיפה','גליל','גולן','קריות']): return 'צפון'
    if any(x in text for x in ['שפלה','רחובות','נס ציונה','אשדוד','גדרה']): return 'שפלה'
    return 'מרכז'

def infer_type(url, text):
    if any(x in text for x in ['מלון','ריזורט']): return 'מלון / אולם אירועים'
    if any(x in text for x in ['מסעדה','בר ', 'בר-']): return 'מסעדה / בר לאירועים'
    if any(x in text for x in ['יקב']): return 'יקב / מקום אירוח'
    if any(x in text for x in ['בוטיק','קטנים','אינטימי']): return 'מתחם בוטיק'
    if any(x in text for x in ['חווה','טבע','יער','חוף','ים','שטח']): return 'טבע / שטח'
    if any(x in text for x in ['גן','גני']): return 'גן אירועים'
    return 'אולם אירועים'

def infer_style(vtype, text):
    if 'בוטיק' in vtype or 'אינטימי' in text: return 'אורבני / בוטיק'
    if 'טבע' in vtype or 'יקב' in vtype or 'חווה' in text: return 'טבע / שטח'
    if 'מסעדה' in vtype: return 'קולינרי / אורבני'
    if 'גן' in vtype: return 'גן אירועים'
    return 'אולם'

def infer_capacity(text):
    ranges = re.findall(r'(\d{2,4})\s*(?:עד|ועד|-|–)\s*(\d{2,4})', text)
    if ranges:
        a,b = map(int, ranges[0]); return min(a,b), max(a,b), 'source'
    nums = [int(n.replace(',','')) for n in re.findall(r'(?:עד|מכיל|מתאים ל|מותאם ל|אירועים של עד)\s*(?:כ-)?\s*(\d{2,4}(?:,\d{3})?)', text)]
    if nums:
        m = max(nums); return max(30, min(180, m//3)), m, 'source'
    if any(x in text for x in ['קטנים','אינטימי','בוטיק']): return 30, 250, 'estimated'
    if any(x in text for x in ['ענק','גדול','רחב','דונם','מפואר']): return 180, 900, 'estimated'
    return 80, 550, 'estimated'

def infer_vibe(text):
    keys=['ים','חוף','שקיעה','טבע','גן','יוקרתי','אורבני','בוטיק','אינטימי','כפרי','פסטורלי','מדברי','קולינריה','שף','משפחתי','מודרני','קונספט','הרים','נוף','ירוק','ריזורט','מלון','עסקי','חורף','קיץ','חופה','בריכה']
    return [k for k in keys if k in text][:8]

def source_name(url):
    host = urlparse(url).netloc.replace('www.','')
    return {'event-halls.co.il':'Event Halls','mekomot.co.il':'מקומות','saveadate.co.il':'Save A Date','all-events.co.il':'All Events'}.get(host, host)

def is_venue_url(url):
    p = unquote(urlparse(url).path)
    return any(x in p for x in ['/רשומה/', '/places/'])

def is_category_url(url):
    p = unquote(urlparse(url).path)
    return any(x in p for x in ['/קטגוריה/', '/אזור/', '/cat_mekomot/', '/category/'])

def candidate_from_link(url, label):
    label = clean_text(label)
    if not label or label in BAD_LABELS: return None
    if any(w in label for w in BAD_WORDS):
        # keep beginning if it includes a meaningful name before phone/kosher/etc
        label = re.split(r'(?:\b0\d[\d\- ]{6,}|טלפון:|מחיר משוער:|כתובת:|כשר)', label)[0].strip(' -–|,')
    if len(label) < 2 or len(label) > 120: return None
    if label in CATEGORY_WORDS or any(label.startswith(x+' ') for x in CATEGORY_WORDS): return None
    if not is_venue_url(url): return None
    return label

def extract_title(html_text):
    m = re.search(r'<h1[^>]*>(.*?)</h1>', html_text, re.S|re.I) or re.search(r'<title[^>]*>(.*?)</title>', html_text, re.S|re.I)
    return clean_text(m.group(1)) if m else ''

def crawl():
    queue=list(SEED_URLS); seen_pages=set(); found={}
    max_pages=220
    while queue and len(seen_pages) < max_pages:
        url=queue.pop(0)
        if url in seen_pages: continue
        seen_pages.add(url)
        try:
            page=fetch(url)
        except Exception as e:
            print('ERR', url, e); continue
        host=urlparse(url).netloc
        links=re.findall(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', page, re.S|re.I)
        for href,label in links:
            link=urljoin(url, href.split('#',1)[0])
            if urlparse(link).netloc != host: continue
            if is_category_url(link) and link not in seen_pages and len(queue) < 350:
                queue.append(link)
            cand=candidate_from_link(link, label)
            if cand:
                found.setdefault(link, cand)
        # If the current page itself is a venue page, use its h1.
        if is_venue_url(url):
            title=extract_title(page)
            if title: found.setdefault(url, title)
        print('page', len(seen_pages), source_name(url), 'found', len(found), 'queue', len(queue))
        time.sleep(0.15)
    return found, seen_pages

def make_venue(url, title):
    text=title
    city=infer_city(text)
    area=infer_area(city, text)
    vtype=infer_type(url, text)
    style=infer_style(vtype, text)
    minc,maxc,conf=infer_capacity(text)
    # Clean marketing suffixes but preserve recognized brand names.
    name=text
    name=re.split(r'\s+[–-]\s+(?:אולם|אולמות|גן|גני|מקום|מתחם|אירועים|חתונה|בר|בת|חיפה|תל אביב|באר שבע|פתח תקווה|ראשון לציון|אשדוד|ירושלים)', name, maxsplit=1)[0].strip()
    name=re.sub(r'\s+(?:אולם|אולמות|גן|גני|מתחם|מקום)\s+(?:אירועים|לאירועים|בוטיק|לחתונה).*$', '', name).strip()
    name=re.sub(r'\s+(?:כשר|כשר למהדרין).*$', '', name).strip()
    name=re.sub(r'^(אולם|אולמי|גן אירועים|מתחם האירועים|מתחם)\s+', '', name).strip()
    if city and name.endswith(city): name=name[:-len(city)].strip(' -–,')
    if len(name) < 2: name=text[:80]
    desc=text if len(text) <= 230 else text[:227].rstrip()+'...'
    kosher = 'כשר למהדרין' if 'מהדרין' in text else ('כשר' if 'כשר' in text else 'לא ידוע')
    return {
      'name': name[:80], 'city': city, 'area': area, 'areas': [area] + ([city] if city else []),
      'type': vtype, 'style': style, 'min': minc, 'max': maxc, 'capacityConfidence': conf,
      'kosher': kosher, 'vibe': infer_vibe(text), 'strength': desc,
      'sourceName': source_name(url), 'sourceUrl': url
    }

def main():
    data=json.loads(OUT.read_text(encoding='utf-8'))
    venues=data.get('venues',[])
    before=len(venues)
    by_url={v.get('sourceUrl'): v for v in venues if v.get('sourceUrl')}
    seen_keys={norm_key(v.get('name','') + ' ' + v.get('city','')) for v in venues}
    found, pages = crawl()
    added=[]
    for url,title in sorted(found.items()):
        if url in by_url: continue
        venue=make_venue(url,title)
        key=norm_key(venue['name'] + ' ' + venue.get('city',''))
        loose=norm_key(venue['name'])
        if not key or key in seen_keys or loose in {norm_key(v.get('name','')) for v in venues}:
            continue
        seen_keys.add(key)
        venues.append(venue); added.append(venue)
    data['venues']=venues
    data['updatedAt']='2026-06-04'
    data['note']='Expanded public web research dataset for ORMa Dream Finder. Business outreach use: verify availability, price, phone, kosher certificate, and partnership consent directly with venue before commercial onboarding.'
    data['sources']=sorted(set(data.get('sources',[]) + list(SEED_URLS) + sorted(pages)))
    OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('before', before, 'added', len(added), 'after', len(venues))
    for v in added[:80]:
        print('+', v['name'], '|', v.get('city'), '|', v['area'], '|', v['sourceName'])

if __name__ == '__main__':
    main()
