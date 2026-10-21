import json, os, io, re, subprocess, time, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, '..', 'webradio', 'data', 'library.json')
FREE = os.path.join(HERE, '..', 'webradio', 'audio', 'free')

REMOVE = {'Recycle This', 'Where the Moon Shines Bright'}

NEW = [
    # (title, uploader, genres, license label, license url)
    ('Lamadio Tiado (Hot Cha Cha Mix)', 'Coruscate', ['Salsa', 'Latin'],
     'CC BY 3.0', 'http://creativecommons.org/licenses/by/3.0/'),
    ('Funk You', 'texasradiofish', ['Timba', 'Latin'],
     'CC BY-NC 3.0', 'http://creativecommons.org/licenses/by-nc/3.0/'),
]

records = {}
for name in os.listdir(HERE):
    if not name.endswith('.json'):
        continue
    try:
        data = json.load(open(os.path.join(HERE, name), encoding='utf-8'))
    except Exception:
        continue
    if isinstance(data, list):
        for x in data:
            records[(x.get('upload_name'), x.get('user_name'))] = x


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = re.sub(r'[<>:"/\\|?*]', '', s)
    return re.sub(r'\s+', ' ', s).strip()


lib = json.load(open(LIB, encoding='utf-8'))

# 1. drop country / folk guests and their audio
keep, dropped = [], []
for g in lib['freeTracks']:
    if g['title'] in REMOVE:
        dropped.append(g)
    else:
        keep.append(g)
lib['freeTracks'] = keep
for g in dropped:
    path = os.path.join(FREE, g['file'])
    if os.path.exists(path):
        os.remove(path)
    print('removed', g['title'])

# 2. add salsa + timba
for title, user, genres, license_label, license_url in NEW:
    x = records.get((title, user))
    if not x:
        print('MISSING record', title)
        continue
    files = [f for f in x.get('files', []) if f.get('download_url', '').endswith('.mp3')]
    if not files:
        print('NO MP3', title)
        continue
    f = files[0]
    filename = slug(title) + '.mp3'
    dest = os.path.join(FREE, filename)
    if not os.path.exists(dest):
        subprocess.run([
            'curl', '-sSL', '-m', '120',
            '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            '-e', 'https://ccmixter.org/',
            '-o', dest, f['download_url'],
        ], check=True)
        time.sleep(1)
    artist = x.get('user_real_name') or user
    lic_url = x.get('license_url') or license_url
    lic = x.get('license_name') or license_label
    lib['freeTracks'].append({
        'file': filename,
        'title': title,
        'artist': artist,
        'album': 'cc-sessions',
        'genres': genres,
        'license': license_label,
        'licenseUrl': lic_url,
        'source': x.get('file_page_url'),
        'credit': f'"{title}" by {artist} (ccMixter), licensed {license_label}',
    })
    print('added  %-34s %5.1f MB  %-22s %s' % (filename, os.path.getsize(dest) / 1048576, artist, lic))

with io.open(LIB, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(lib, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
print('guests now', len(lib['freeTracks']))
