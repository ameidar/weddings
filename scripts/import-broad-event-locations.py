#!/usr/bin/env python3
"""Broad import of public event-location sitemap pages.
Adds venue/location leads for ORMa Dream Finder without storing personal contact data.
"""
import json, re, html, urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse, quote

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data'/'event-venues-israel.json'
UA='Mozilla/5.0 ORMa broad venue research'

CITY_AREA={
 'תל אביב':'מרכז','יפו':'מרכז','רמת גן':'מרכז','גבעתיים':'מרכז','פתח תקווה':'מרכז','חולון':'מרכז','בת ים':'מרכז','ראשון לציון':'מרכז','אור יהודה':'מרכז','יהוד':'מרכז','בית דגן':'מרכז','הרצליה':'שרון','רעננה':'שרון','כפר סבא':'שרון','הוד השרון':'שרון','נתניה':'שרון','אבן יהודה':'שרון','שפיים':'שרון','געש':'שרון','יקום':'שרון','קיסריה':'צפון','חדרה':'צפון','חיפה':'צפון','עכו':'צפון','נהריה':'צפון','כרמיאל':'צפון','טבריה':'צפון','כנרת':'צפון','גליל':'צפון','גולן':'צפון','עפולה':'צפון','נצרת':'צפון','זכרון יעקב':'צפון','בנימינה':'צפון','נס ציונה':'שפלה','רחובות':'שפלה','יבנה':'שפלה','גדרה':'שפלה','מודיעין':'שפלה','לטרון':'שפלה','בית שמש':'ירושלים','ירושלים':'ירושלים','אבו גוש':'ירושלים','ממילא':'ירושלים','עיר דוד':'ירושלים','אשדוד':'דרום','אשקלון':'דרום','באר שבע':'דרום','אילת':'דרום','שדרות':'דרום','נתיבות':'דרום','אופקים':'דרום','דימונה':'דרום','ערד':'דרום','ים המלח':'דרום','מצפה רמון':'דרום','להבים':'דרום'
}
CITIES=sorted(CITY_AREA,key=len,reverse=True)
BAD_WORDS=['צלם','צילום','שמלות','איפור','שיער','דיגיי','dj','מגנטים','אטרקציות','בר אקטיבי','קייטרינג','השכרת ציוד','רב לחתונה','טבעות','מעצב','הפקה וניהול','מפיק','מפיקת']

SOURCES=[
 ('Hafakot - מקומות לאירועים','https://www.hafakot.co.il/location-sitemap.xml','hafakot'),
 ('Hafakot - מקומות לאירועים','https://www.hafakot.co.il/location-sitemap2.xml','hafakot'),
 ('חתן כלה','http://www.hatankala.co.il/sitemap.xml','hatankala'),
]

def safe_url(u):
 p=urlparse(u)
 return p._replace(path=quote(unquote(p.path),safe='/%'),query=quote(unquote(p.query),safe='=&?/%')).geturl()

def fetch(u):
 return urllib.request.urlopen(urllib.request.Request(safe_url(u),headers={'User-Agent':UA,'Accept-Encoding':'identity'}),timeout=35).read().decode('utf-8','ignore')

def locs(sm):
 try: return [html.unescape(x) for x in re.findall(r'<loc>(.*?)</loc>',fetch(sm))]
 except Exception as e:
  print('ERR',sm,e); return []

def slug(url):
 parts=[p for p in unquote(urlparse(url).path).split('/') if p]
 return parts[-1] if parts else ''

def clean_name(s):
 s=unquote(s).replace('_',' ').replace('-',' ')
 s=re.sub(r'\s+',' ',s).strip(' /-–|')
 s=re.sub(r'^(ad|location)\s+','',s,flags=re.I)
 s=re.sub(r'\b(אולם|אולמי|אולמות|גן|גני|מתחם|מקום)\s+(אירועים|לאירועים)\b','',s).strip()
 return s[:90]

def norm(s): return re.sub(r'[^א-תa-z0-9]+','',s.lower())

def city_area(text):
 for c in CITIES:
  if c in text: return c,CITY_AREA[c]
 if any(x in text for x in ['דרום','נגב','מדבר']): return '', 'דרום'
 if any(x in text for x in ['צפון','גליל','גולן']): return '', 'צפון'
 if 'ירושלים' in text: return 'ירושלים','ירושלים'
 if 'שרון' in text: return '', 'שרון'
 if 'שפלה' in text: return '', 'שפלה'
 return '', 'מרכז'

def typestyle(text):
 t=text.lower()
 if 'מלון' in text or 'hotel' in t: return 'מלון / אולם אירועים','אולם'
 if 'וילה' in text or 'villa' in t: return 'וילה לאירועים','אורבני / בוטיק'
 if 'לופט' in text or 'loft' in t: return 'לופט / חלל אירועים','אורבני / בוטיק'
 if 'יקב' in text: return 'יקב / מקום אירוח','טבע / שטח'
 if any(x in text for x in ['חווה','חוף','ים','יער','טבע','בריכה','חאן']): return 'טבע / שטח לאירועים','טבע / שטח'
 if any(x in text for x in ['מסעדת','מסעדה','בר ','קפה']): return 'מסעדה / בר לאירועים','אורבני / בוטיק'
 if 'גן' in text or 'גני' in text: return 'גן אירועים','גן אירועים'
 if 'אולם' in text or 'אולמי' in text: return 'אולם אירועים','אולם'
 return 'מקום לאירועים','אורבני / בוטיק'

def is_candidate(u,kind):
 d=unquote(u)
 low=d.lower()
 if any(b.lower() in low for b in BAD_WORDS): return False
 if kind=='hafakot':
  s=slug(u)
  return '/location/' in low and s and not s.isdigit() and s not in ['מקומות']
 if kind=='hatankala':
  if '/ad/' not in low: return False
  return any(k in d for k in ['גני_אירועים','אולמות_אירועים','גן_אירועים','אולם_אירועים','אולמי','אולם','מלון','חוות','חווה','יקב'])
 return False

def make(u,src):
 name=clean_name(slug(u))
 city,area=city_area(name)
 typ,style=typestyle(name)
 maxcap=220 if typ.startswith(('וילה','לופט','מסעדה')) else (350 if 'טבע' in typ else 550)
 return {'name':name,'city':city,'area':area,'areas':[area]+([city] if city else []),'type':typ,'style':style,'min':40,'max':maxcap,'capacityConfidence':'estimated','kosher':'לא ידוע','vibe':[],'strength':f'נוסף כמקום אירוח/אירועים ממפת אתר ציבורית של {src}; מתאים כיעד עסקי ראשוני, דורש אימות מול המקום לפני המלצה/שיתוף פעולה.','sourceName':src,'sourceUrl':u}

def main():
 data=json.loads(OUT.read_text(encoding='utf-8'))
 venues=data['venues']; before=len(venues)
 seen_url={v.get('sourceUrl') for v in venues}
 seen_name={norm(v.get('name','')) for v in venues}
 sources=set(data.get('sources',[]))
 added=[]
 for src,sm,kind in SOURCES:
  urls=[u for u in locs(sm) if is_candidate(u,kind)]
  print(src,len(urls),'candidates')
  sources.add(sm)
  for u in urls:
   if u in seen_url: continue
   v=make(u,src); k=norm(v['name'])
   if not k or len(k)<3 or k in seen_name: continue
   seen_name.add(k); seen_url.add(u); venues.append(v); added.append(v)
 data['venues']=venues; data['sources']=sorted(sources); data['updatedAt']='2026-06-04'
 OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
 print('before',before,'added',len(added),'after',len(venues))
 for v in added[:160]: print('+',v['name'],'|',v['area'],'|',v['type'])
if __name__=='__main__': main()
