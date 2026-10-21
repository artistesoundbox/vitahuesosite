import json, io, os

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, '..', 'webradio', 'data', 'library.json')
SELECTED = os.path.join(HERE, 'selected.json')
lib = json.load(open(LIB, encoding='utf-8'))

# ---- branding: the artist's own songs now credit Anthonitus ----
lib['station']['artist'] = 'Anthonitus'
lib['station']['aka'] = 'Vita Hueso'

# ---- guest album: songs, not just instrumentals ----
for a in lib['albums']:
    if a['id'] == 'cc-sessions':
        a['title'] = 'Signal Sessions (CC)'
        a['description'] = ('Guest songs and instrumentals from independent artists under Creative Commons '
                            'Attribution licences — rock, pop, soul, funk, hip-hop, jazz, latin, country, '
                            'reggae, folk, blues and electronic, woven through the live rotation.')

GENRES = {
    "It's Deep": ['Rock', 'Soul'],
    'Girls like you': ['Pop', 'Rock'],
    'BACK FROM HOLIDAYS': ['Hip-Hop', 'Soul'],
    'PeaceLoveSoul': ['Funk', 'Soul'],
    'Sola Solita': ['Latin', 'Hip-Hop'],
    "It's a Blessing": ['Jazz', 'Soul'],
    'Wayo Wayo-Summer Edition': ['Latin', 'Pop'],
    'Recycle This': ['Country', 'Folk'],
    'Strong Man': ['Reggae'],
    'Where the Moon Shines Bright': ['Folk', 'Country'],
    'Things Change': ['Blues', 'Soul'],
    'THIS IS OUR MUSIC (Thruewiddit mix)': ['Electronic', 'Hip-Hop'],
}

guests = []
for x in json.load(open(SELECTED, encoding='utf-8')):
    title = x['title']
    artist = x['artist']
    guests.append({
        'file': x['file'],
        'title': title,
        'artist': artist,
        'album': 'cc-sessions',
        'genres': GENRES.get(title, ['Soul']),
        'license': 'CC BY 3.0',
        'licenseUrl': x['licenseUrl'],
        'source': x['page'],
        'credit': f'"{title}" by {artist} (ccMixter), licensed CC BY 3.0',
    })

# two instrumentals stay on the guest shelf for the quiet hours
guests.append({
    'file': 'Chill Wave.mp3',
    'title': 'Chill Wave',
    'artist': 'Kevin MacLeod',
    'album': 'cc-sessions',
    'genres': ['Lo-Fi', 'Ambient'],
    'license': 'CC BY 4.0',
    'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
    'source': 'https://incompetech.com/music/royalty-free/',
    'credit': '"Chill Wave" Kevin MacLeod (incompetech.com), licensed CC BY 4.0',
})
guests.append({
    'file': 'Water Lily.mp3',
    'title': 'Water Lily',
    'artist': 'Kevin MacLeod',
    'album': 'cc-sessions',
    'genres': ['Ambient', 'Piano'],
    'license': 'CC BY 4.0',
    'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
    'source': 'https://incompetech.com/music/royalty-free/',
    'credit': '"Water Lily" Kevin MacLeod (incompetech.com), licensed CC BY 4.0',
})

lib['freeTracks'] = guests

with io.open(LIB, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(lib, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('freeTracks:', len(guests), '| station.artist:', lib['station']['artist'])
