#!/usr/bin/env python3
import json, re, html, urllib.request
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'event-venues-israel.json'

SEED_URLS = [
  'https://mazaltov.walla.co.il/event-place/eventsgardens/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/center/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/sharon/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/north/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/south/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/shfela/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/jerusalem_area/',
  'https://mazaltov.walla.co.il/event-place/eventsgardens/telaviv_area/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/center/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/sharon/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/north/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/south/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/shfela/',
  'https://mazaltov.walla.co.il/event-place/eventshalls/jerusalem_area/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/center/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/sharon/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/north/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/south/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/shfela/',
  'https://mazaltov.walla.co.il/event-place/boutiquehalls/jerusalem_area/',
  'https://mazaltov.walla.co.il/event-place/weddinginnature/',
  'https://mazaltov.walla.co.il/event-place/weddingonthebeach/',
  'https://mazaltov.walla.co.il/event-place/hotels/',
]

CITY_AREA = {
 'תל אביב -יפו':'מרכז','תל אביב-יפו':'מרכז','תל אביב':'מרכז','יפו':'מרכז','פתח תקווה':'מרכז','ראשון לציון':'מרכז','חולון':'מרכז','רמת גן':'מרכז','גבעתיים':'מרכז','קריית אונו':'מרכז','אור יהודה':'מרכז',
 'רעננה':'שרון','נתניה':'שרון','עמק חפר':'שרון','כפר ויתקין':'שרון','אבן יהודה':'שרון','געש':'שרון','שפיים':'שרון','משמר השרון':'שרון','נורדיה':'שרון','נחשונים':'שרון','קיסריה':'צפון','חדרה':'צפון','פרדס חנה-כרכור':'צפון',
 'שדות ים':'צפון','רגבה':'צפון','עין המפרץ':'צפון','עכו':'צפון','רמת הגולן':'צפון','יקנעם':'צפון','עפולה':'צפון','גליל':'צפון',
 'נס ציונה':'שפלה','יבנה':'שפלה','כנות':'שפלה','קריית עקרון':'שפלה','רחובות':'שפלה','מודיעין-מכבים-רעות':'שפלה','מודיעין':'שפלה','כפר אוריה':'שפלה','בית עובד':'שפלה','צומת ראם':'שפלה','קיבוץ חפץ חיים':'שפלה','שדה יואב':'שפלה',
 'ירושלים':'ירושלים','נווה אילן':'ירושלים','בית שמש':'ירושלים','עין חמד':'ירושלים',
 'אשדוד':'דרום','אשקלון':'דרום','באר שבע':'דרום','נתיבות':'דרום','אופקים':'דרום','קריית מלאכי':'דרום','בני דרום':'דרום'
}
CITY_NAMES = sorted(CITY_AREA, key=len, reverse=True)
CATEGORY_WORDS = ['גני אירועים','אולמות אירועים','מקומות','חתונה','צפון וחיפה','שרון','מרכז','שפלה','ירושלים','דרום','תל אביב','מקום לחתונה']
BAD_IN_URL = ['/article/', '/recommendations/', '#', '/event-place/$']
AREA_SLUGS = {'center','north','south','sharon','shfela','jerusalem_area','telaviv_area','petahtikva','rishonlezion'}

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0 ORMa venue research'})
    return urllib.request.urlopen(req, timeout=20).read().decode('utf-8','ignore')

def clean_text(text):
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    text = re.sub(r'\b0\d[\d\- ]{6,}\b', ' ', text)
    text = re.sub(r'\d+\s*המלצות?', ' ', text)
    text = re.sub(r'לקביעת פגישה', ' ', text)
    return re.sub(r'\s+', ' ', text).strip(' -–|')

def is_individual(url, text):
    if '/event-place/' not in url or any(b in url for b in BAD_IN_URL): return False
    parts = [p for p in url.split('/') if p]
    if len(parts) < 5: return False
    slug = parts[-1]
    prev = parts[-2] if len(parts) >= 2 else ''
    if slug in AREA_SLUGS or prev in AREA_SLUGS: return False
    if text in CATEGORY_WORDS or any(text.startswith(x+' ב') for x in ['גני אירועים','אולמות אירועים','בתי מלון לאירועים','חתונה על הים','חתונה בטבע']): return False
    if 'article/event-place' in url: return False
    return True

def infer_city(text):
    for c in CITY_NAMES:
        if c in text: return c
    return ''

def infer_area(city, text):
    if city and city in CITY_AREA: return CITY_AREA[city]
    for c,a in CITY_AREA.items():
        if c in text: return a
    if any(x in text for x in ['דרום','נגב']): return 'דרום'
    if 'ירושלים' in text: return 'ירושלים'
    if any(x in text for x in ['שרון','נתניה','רעננה']): return 'שרון'
    if any(x in text for x in ['צפון','חיפה','גליל','גולן']): return 'צפון'
    return 'מרכז'

def infer_type(url, text):
    if '/hotels/' in url or 'מלון' in text: return 'מלון / אולם אירועים'
    if '/boutiquehalls/' in url or 'בוטיק' in text: return 'מתחם בוטיק'
    if 'יקב' in text: return 'יקב / מקום אירוח'
    if 'טבע' in text or 'שטח' in text: return 'טבע / שטח'
    if '/eventshalls/' in url or 'אולם' in text: return 'אולם אירועים'
    return 'גן אירועים'

def infer_style(vtype, text):
    if 'בוטיק' in vtype or 'אינטימי' in text: return 'אורבני / בוטיק'
    if 'טבע' in vtype or 'שטח' in vtype or 'יקב' in vtype: return 'טבע / שטח'
    if 'אולם' in vtype: return 'אולם'
    return 'גן אירועים'

def infer_capacity(text):
    nums = [int(n.replace(',','')) for n in re.findall(r'(?:עד|ועד|מכיל|לאירוח של עד|המותאם ל-|מתאים ל-)\s*(?:כ-)?\s*(\d{2,4}(?:,\d{3})?)', text)]
    ranges = re.findall(r'(\d{2,4})\s*(?:עד|ועד|-|–)\s*(\d{2,4})', text)
    if ranges:
        a,b = map(int, ranges[0]); return min(a,b), max(a,b), 'source'
    if nums:
        m=max(nums); return max(40, min(180, m//3)), m, 'source'
    if any(x in text for x in ['קטנים','אינטימי','בוטיק']): return 40, 250, 'estimated'
    if any(x in text for x in ['ענק','גדול','רחב','דונם','מפואר']): return 180, 900, 'estimated'
    return 80, 550, 'estimated'

def infer_vibe(text):
    keys=['ים','חוף','שקיעה','טבע','גן','יוקרתי','אורבני','בוטיק','אינטימי','כפרי','פסטורלי','מדברי','קולינריה','שף','משפחתי','מודרני','קונספט','הרים','נוף','ירוק','ריזורט','מלון','עסקי','חורף','קיץ','חופה']
    return [k for k in keys if k in text][:8]

def split_name(text, city):
    t=text
    if city and city in t:
        name=t.split(city,1)[0].strip()
    else:
        # if no city, take up to 4 first words, before marketing terms
        name=re.split(r' ברוכים| בואו| אולם | מתחם | גן | הינו | מזמין| מציע', t, maxsplit=1)[0].strip()
    name = re.sub(r'^(אולם|אולמי|גן אירועים|מתחם האירועים)\s+', '', name).strip()
    if not name or len(name)<2: name=t.split(' ',4)[0]
    return name[:80]

def build():
    found={}
    for seed in SEED_URLS:
        try:
            txt=fetch(seed)
        except Exception as e:
            print('ERR', seed, e); continue
        for href, label in re.findall(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', txt, re.S|re.I):
            url=urljoin(seed, href)
            text=clean_text(label)
            if not is_individual(url, text): continue
            if len(text)<3: continue
            found[url]=text
        print('seed', seed, 'found', len(found))
    existing = json.loads(OUT.read_text()) if OUT.exists() else {'venues':[],'sources':[]}
    by_url={v.get('sourceUrl'):v for v in existing.get('venues',[]) if v.get('sourceUrl')}
    venues=list(by_url.values())
    for url,text in found.items():
        if url in by_url: continue
        city=infer_city(text)
        area=infer_area(city,text)
        vtype=infer_type(url,text)
        style=infer_style(vtype,text)
        minc,maxc,conf=infer_capacity(text)
        name=split_name(text,city)
        desc=text
        if len(desc)>230: desc=desc[:227].rstrip()+'...'
        venue={
          'name': name, 'city': city, 'area': area, 'areas': [area] + ([city] if city else []),
          'type': vtype, 'style': style, 'min': minc, 'max': maxc, 'capacityConfidence': conf,
          'kosher': 'לא ידוע', 'vibe': infer_vibe(text), 'strength': desc,
          'sourceName': 'וואלה! Wedding', 'sourceUrl': url
        }
        venues.append(venue)
    # de-dupe by normalized name+city
    dedup=[]; seen=set()
    for v in venues:
        key=re.sub(r'\W+','', (v.get('name','')+v.get('city','')).lower())
        if not key or key in seen: continue
        seen.add(key); dedup.append(v)
    out={
      'updatedAt':'2026-06-03',
      'note':'Expanded public web research dataset for ORMa Dream Finder. Verify live availability, price, phone, and kosher certificate directly with venue before closing.',
      'sources': sorted(set(existing.get('sources',[]) + SEED_URLS)),
      'venues': dedup
    }
    OUT.write_text(json.dumps(out,ensure_ascii=False,indent=2))
    print('wrote', len(dedup), 'venues to', OUT)

if __name__=='__main__': build()
