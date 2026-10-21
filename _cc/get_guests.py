import json, os, re, subprocess, unicodedata, time

SEL = [
    ("It's Deep", "SackJo22"),
    ("Girls like you", "JeffSpeed68"),
    ("BACK FROM HOLIDAYS", "BOCrew"),
    ("PeaceLoveSoul", "VJ_Memes"),
    ("Sola Solita", "mykleanthony"),
    ("It's a Blessing", "unreal_dm"),
    ("Wayo Wayo-Summer Edition", "wellman"),
    ("Recycle This", "unreal_dm"),
    ("Strong Man", "zep_hurme"),
    ("Where the Moon Shines Bright", "mindmapthat"),
    ("Things Change", "SackJo22"),
    ("THIS IS OUR MUSIC (Thruewiddit mix)", "duckett"),
]

records = {}
for name in os.listdir('_cc'):
    if not name.endswith('.json') or name.startswith('sel'):
        continue
    try:
        data = json.load(open(os.path.join('_cc', name), encoding='utf-8'))
    except Exception:
        continue
    if not isinstance(data, list):
        continue
    for x in data:
        records[(x.get('upload_name'), x.get('user_name'))] = x


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = re.sub(r'[<>:"/\\|?*]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def duration(ps):
    m = re.match(r'(\d+):(\d+)', ps or '')
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 0


out = []
os.makedirs('../webradio/audio/free', exist_ok=True)
for title, user in SEL:
    x = records.get((title, user))
    if not x:
        print('MISSING record:', title, user)
        continue
    files = [f for f in x.get('files', []) if f.get('download_url', '').endswith('.mp3')]
    if not files:
        print('NO MP3:', title)
        continue
    f = files[0]
    filename = slug(title) + '.mp3'
    dest = os.path.join('../webradio/audio/free', filename)
    if not os.path.exists(dest):
        # ccMixter's file host 403s non-browser clients: send a browser UA + referer.
        subprocess.run([
            'curl', '-sSL', '-m', '120',
            '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            '-e', 'https://ccmixter.org/',
            '-o', dest, f['download_url'],
        ], check=True)
        time.sleep(1)
    size = os.path.getsize(dest)
    out.append({
        'file': filename,
        'title': title,
        'artist': x.get('user_real_name') or user,
        'user': user,
        'duration': duration(f.get('file_format_info', {}).get('ps')),
        'license': (x.get('license_name') or '').replace(' (3.0)', ' 3.0'),
        'licenseUrl': x.get('license_url'),
        'page': x.get('file_page_url'),
        'tags': x.get('upload_tags', '').strip(','),
        'bytes': size,
    })
    print('ok %-40s %6.1f MB  %s' % (filename, size / 1048576, x.get('license_name')))

json.dump(out, open('_cc/selected.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('downloaded', len(out))
