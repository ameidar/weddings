#!/usr/bin/env python3
"""Import venue records from public XML sitemaps.
Keeps only venue/location pages; no personal contact data is stored.
"""
import json, re, html, urllib.request, time
from pathlib import Path
from urllib.parse import urlparse, unquote, quote

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'event-venues-israel.json'
UA = 'Mozilla/5.0 ORMa venue sitemap research'

CITY_AREA = {
 'תל אביב -יפו':'מרכז','תל אביב-יפו':'מרכז','תל אביב':'מרכז','יפו':'מרכז','פתח תקווה':'מרכז','ראשון לציון':'מרכז','חולון':'מרכז','בת ים':'מרכז','רמת גן':'מרכז','גבעתיים':'מרכז','קריית אונו':'מרכז','אור יהודה':'מרכז','יהוד':'מרכז','בני ברק':'מרכז','הרצליה':'שרון','רמת השרון':'שרון','כפר סבא':'שרון','רעננה':'שרון','הוד השרון':'שרון',
 'נתניה':'שרון','עמק חפר':'שרון','כפר ויתקין':'שרון','אבן יהודה':'שרון','געש':'שרון','שפיים':'שרון','משמר השרון':'שרון','נורדיה':'שרון','נחשונים':'שרון','יקום':'שרון','בצרה':'שרון','ארסוף':'שרון',
 'חיפה':'צפון','קריות':'צפון','קריית אתא':'צפון','קריית ביאליק':'צפון','קיסריה':'צפון','חדרה':'צפון','בנימינה':'צפון','זכרון יעקב':'צפון','פרדס חנה-כרכור':'צפון','פרדס חנה':'צפון','שדות ים':'צפון','רגבה':'צפון','עין המפרץ':'צפון','עכו':'צפון','נהריה':'צפון','רמת הגולן':'צפון','קצרין':'צפון','יקנעם':'צפון','עפולה':'צפון','גליל':'צפון','יגור':'צפון','טבריה':'צפון','נצרת':'צפון','כרמיאל':'צפון','בית שאן':'צפון',
 'נס ציונה':'שפלה','יבנה':'שפלה','כנות':'שפלה','גדרה':'שפלה','מזכרת בתיה':'שפלה','קריית עקרון':'שפלה','רחובות':'שפלה','מודיעין-מכבים-רעות':'שפלה','מודיעין':'שפלה','כפר אוריה':'שפלה','בית עובד':'שפלה','צומת ראם':'שפלה','קיבוץ חפץ חיים':'שפלה','שדה יואב':'שפלה','עמק האלה':'שפלה','נצר סרני':'שפלה','לטרון':'שפלה','לוד':'שפלה','רמלה':'שפלה','ראש העין':'שפלה',
 'ירושלים':'ירושלים','נווה אילן':'ירושלים','בית שמש':'ירושלים','עין חמד':'ירושלים','שורש':'ירושלים','מעלה החמישה':'ירושלים','אבו גוש':'ירושלים',
 'אשדוד':'דרום','אשקלון':'דרום','באר שבע':'דרום','נתיבות':'דרום','אופקים':'דרום','קריית מלאכי':'דרום','בני דרום':'דרום','ירוחם':'דרום','אילת':'דרום','שדרות':'דרום','דימונה':'דרום','מצפה רמון':'דרום','ערד':'דרום','להבים':'דרום','רהט':'דרום','מבועים':'דרום'
}
CITY_NAMES = sorted(CITY_AREA, key=len, reverse=True)

SITEMAPS = [
  ('וואלה! Wedding', 'https://mazaltov.walla.co.il/sitemaps/sitemap_Business.xml'),
  ('Artika', 'https://www.artika.co.il/dynamic-venues_p_a34f9a62_d23e_4337_8ce2_9451aa0f3fce_0_5000-sitemap.xml'),
  ('All Events', 'https://all-events.co.il/product-sitemap.xml'),
  ('Save A Date', 'https://www.saveadate.co.il/service-sitemap.xml'),
  ('Event Halls', 'https://event-halls.co.il/job_listing-sitemap.xml'),
  ('מקומות', 'https://www.mekomot.co.il/places-sitemap.xml'),
]

ALL_EVENTS_KEYWORDS = ['אולמי','אולם','אולמות','גן','גארדן','garden','hall','hotel','אחוז','חוות','חווה','טרמינל','היכל','קאלה','בת-הגלבוע','אדם-וחווה','עדן']

SLUG_NAME_OVERRIDES = {
 'aria':'אריא', 'solana':'סולאנה', 'duplex':'דופלקס', 'ronit-farm':'חוות רונית', 'maarava':'מערבה', 'valley':'ואלי', 'jonah':'יונה', 'tel-ya':'תל-יה', 'hagan-beshfayim':'הגן בשפיים', 'citrus':'סיטרוס', 'bayit':'בית', 'q':'Q', 'amado':'אמדו', 'tzel-hahoresh':'צל החורש', 'bayaar':'ביער', 'alma':'אלמה', 'cassiopeia':'קסיופאה', 'eden-al-hamaim':'עדן על המים', 'gan-hapekan':'גן הפקאן',
 'colonia':'קולוניה', 'say':'SAY', 'kinurut':'כינורות', 'vasco':'Vasco', 'terminal':'טרמינל', 'troya-garden':'טרויה', 'harmonygarden':'הרמוניה בגן', 'agadata':'אגדתא', 'blue-castle':'בלו קאסל', 'hotelyehuda':'מלון יהודה', 'narnia':'נרניה', 'odeon':'אודאון', 'alegria':'אלגריה', 'davidintercontinental':'דייויד אינטרקונטיננטל', 'ronit-farm':'חוות רונית', 'lara':'לארה', 'vasco':'ואסקו'
}

def safe_url(url):
    p=urlparse(url)
    return p._replace(path=quote(unquote(p.path), safe='/%'), query=quote(unquote(p.query), safe='=&?/%')).geturl()

def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(safe_url(url),headers={'User-Agent':UA,'Accept-Encoding':'identity'}),timeout=25).read().decode('utf-8','ignore')

def locs(sm):
    try:
        data=fetch(sm)
    except Exception as e:
        print('ERR sitemap', sm, e); return []
    return [html.unescape(x) for x in re.findall(r'<loc>(.*?)</loc>', data)]

def clean(text):
    text=re.sub(r'<script.*?</script>|<style.*?</style>',' ',text,flags=re.S|re.I)
    text=re.sub(r'<[^>]+>',' ',text)
    text=html.unescape(text)
    text=re.sub(r'\b0\d[\d\- ]{6,}\b',' ',text)
    return re.sub(r'\s+',' ',text).strip(' -–|,')

def title_from_page(url):
    try:
        page=fetch(url)
        m=re.search(r'<h1[^>]*>(.*?)</h1>',page,re.S|re.I) or re.search(r'<title[^>]*>(.*?)</title>',page,re.S|re.I)
        if m: return clean(m.group(1))
    except Exception:
        pass
    return ''

def slug_to_name(url):
    parts=[p for p in unquote(urlparse(url).path).split('/') if p]
    slug=parts[-1] if parts else ''
    if slug in SLUG_NAME_OVERRIDES: return SLUG_NAME_OVERRIDES[slug]
    slug=re.sub(r'^\d+-','',slug)
    slug=slug.replace('-', ' ')
    slug=re.sub(r'\b(event|events|garden|hall|hotel|ciel)\b',' ',slug,flags=re.I)
    return clean(slug)

def good_url(source, url):
    d=unquote(url).lower()
    if source == 'וואלה! Wedding':
        return '/event-place/' in d and '/gallery/' not in d and not any(x in d for x in ['/shabbatchatan/'])
    if source == 'Artika': return '/venues/' in d
    if source == 'Save A Date': return '/event-hall/' in d
    if source == 'Event Halls': return '/רשומה/' in d or '/%d7%a8%d7%a9%d7%95%d7%9e%d7%94/' in url.lower()
    if source == 'מקומות': return '/places/' in d
    if source == 'All Events':
        if '/biz/' not in d: return False
        return any(k.lower() in d for k in ALL_EVENTS_KEYWORDS)
    return False

def norm(text):
    text=re.sub(r'(אולם|אולמי|אולמות|גן|גני|מתחם|אירועים|לאירועים|בית|לחתונה|חתונה|כשר|מהדרין)','',text)
    return re.sub(r'[^א-תa-z0-9]+','',text.lower())

def infer_city(text):
    for c in CITY_NAMES:
        if c in text: return c
    return ''

def infer_area(city,text):
    if city in CITY_AREA: return CITY_AREA[city]
    if any(x in text for x in ['דרום','נגב','אילת']): return 'דרום'
    if 'ירושלים' in text: return 'ירושלים'
    if any(x in text for x in ['שרון','נתניה','רעננה','הרצליה']): return 'שרון'
    if any(x in text for x in ['צפון','חיפה','גליל','גולן','קריות']): return 'צפון'
    if any(x in text for x in ['שפלה','רחובות','נס ציונה','אשדוד','גדרה']): return 'שפלה'
    return 'מרכז'

def infer_type(url,text):
    d=unquote(url).lower()+' '+text
    if 'hotel' in d or 'מלון' in d: return 'מלון / אולם אירועים'
    if 'boutique' in d or 'בוטיק' in d: return 'מתחם בוטיק'
    if 'יקב' in d: return 'יקב / מקום אירוח'
    if any(x in d for x in ['חווה','טבע','ים','חוף','יער']): return 'טבע / שטח'
    if 'garden' in d or 'גן' in d or 'גני' in d: return 'גן אירועים'
    return 'אולם אירועים'

def make(url, source):
    title=title_from_page(url)
    base=title or slug_to_name(url)
    base=re.sub(r'\s*[-|–]\s*(וואלה.*|Save A Date.*|Artika.*|All Events.*|פורטל.*|מקומות.*)$','',base,flags=re.I)
    base=re.sub(r'\s+(?:אולם|אולמות|גן|גני|מתחם|מקום)\s+(?:אירועים|לאירועים|בוטיק|לחתונה).*$', '', base).strip()
    base=re.sub(r'^(אולם|אולמי|אולמות|גן אירועים|מתחם האירועים|מתחם)\s+', '', base).strip()
    city=infer_city(base)
    area=infer_area(city,base)
    typ=infer_type(url,base)
    style='גן אירועים' if 'גן' in typ else ('טבע / שטח' if 'טבע' in typ else ('אורבני / בוטיק' if 'בוטיק' in typ else 'אולם'))
    return {
      'name': base[:80], 'city': city, 'area': area, 'areas': [area]+([city] if city else []),
      'type': typ, 'style': style, 'min': 80, 'max': 550, 'capacityConfidence': 'estimated',
      'kosher': 'לא ידוע', 'vibe': [], 'strength': f'נוסף ממפת אתר ציבורית של {source}; נתונים מסחריים דורשים אימות מול המקום.',
      'sourceName': source, 'sourceUrl': url
    }

def main():
    data=json.loads(OUT.read_text(encoding='utf-8'))
    venues=data['venues']
    before=len(venues)
    seen_urls={v.get('sourceUrl') for v in venues}
    seen_names={norm(v.get('name','')) for v in venues}
    sources=set(data.get('sources',[]))
    added=[]
    for source, sm in SITEMAPS:
        urls=[u for u in locs(sm) if good_url(source,u)]
        print(source, len(urls), 'candidate urls')
        sources.add(sm)
        for url in urls:
            if url in seen_urls: continue
            v=make(url,source)
            k=norm(v['name'])
            if not k or len(k)<2 or k in seen_names: continue
            seen_names.add(k); seen_urls.add(url)
            venues.append(v); added.append(v)
            time.sleep(0.08)
    data['venues']=venues
    data['sources']=sorted(sources)
    data['updatedAt']='2026-06-04'
    data['note']='Expanded public web research dataset for ORMa Dream Finder. Business outreach use: verify availability, price, phone, kosher certificate, and partnership consent directly with venue before commercial onboarding.'
    OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('before', before, 'added', len(added), 'after', len(venues))
    for v in added[:120]: print('+',v['name'],'|',v['area'],'|',v['sourceName'])

if __name__=='__main__': main()
