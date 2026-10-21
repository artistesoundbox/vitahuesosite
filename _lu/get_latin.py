import json, os, re, subprocess, unicodedata, time, io

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, '..', 'webradio', 'data', 'library.json')
FREE = os.path.join(HERE, '..', 'webradio', 'audio', 'free')

SEL = [
    ('LA TRIPLETA', 'virtualdjmax', ['Reggaeton', 'Latin']),
    ('SACUDETE', 'yuyomc', ['Reggaeton', 'Dembow']),
    ('Me robo el Show', 'Reiswerk', ['Reggaeton', 'Latin']),
    ('Beat down Babylon', 'Reiswerk', ['Dancehall', 'Reggae']),
    ('I Rebel want new Stile', 'Reiswerk', ['Dancehall', 'Reggae']),
    ('Minha Sombra Teu Sorriso (My Shadow, Your Smile)', 'Reiswerk', ['Latin', 'Pop']),
    ('Put your hands up', 'Reiswerk', ['Moombahton', 'Latin']),
    ('Hands Up (cdk Island Mix)', 'cdk', ['Reggaeton', 'Dancehall']),
    ('Don\u2019t worry (original mix \u201912)', 'DanScrew', ['Dancehall', 'Reggae']),
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


def seconds(ps):
    m = re.match(r'(\d+):(\d+)', ps or '')
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 0


lib = json.load(open(LIB, encoding='utf-8'))
known = {g['title'] for g in lib['freeTracks']}
added = 0

for title, user, genres in SEL:
    x = records.get((title, user))
    if not x:
        # tolerate curly-quote differences in the title
        for (t, u), v in records.items():
            if u == user and t and t.replace('\u2019', "'").lower() == title.replace('\u2019', "'").lower():
                x = v
                title = t
                break
    if not x:
        print('MISSING', title, user)
        continue
    if title in known:
        print('already have', title)
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
    lib['freeTracks'].append({
        'file': filename,
        'title': title,
        'artist': artist,
        'album': 'cc-sessions',
        'genres': genres,
        'license': 'CC BY 3.0',
        'licenseUrl': x.get('license_url') or 'http://creativecommons.org/licenses/by/3.0/',
        'source': x.get('file_page_url'),
        'credit': f'"{title}" by {artist} (ccMixter), licensed CC BY 3.0',
    })
    known.add(title)
    added += 1
    print('ok %-46s %5.1f MB  %s' % (filename, os.path.getsize(dest) / 1048576, artist))

with io.open(LIB, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(lib, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
print('added', added, '| guests now', len(lib['freeTracks']))
